import { appendFile, chmod, cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gitEnvironment } from '@dsebastien-website/testing'
import { NO_NOTE_TYPES, nodeDevice } from '../apps/plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../apps/plugin/src/publishing/tool.ts'
import { prepareOutputFolder, writeMarker, type OutputOptions } from './output-folder.ts'
import {
    ceilingOf,
    impliedFactor,
    machineFactor,
    median,
    REFERENCE_SECONDS,
    TOOL_BUDGETS,
    type ToolBudget
} from './tool-budgets-rule.ts'

// The automated budgets of the publishing tool on the invented corpus of full
// size (issue 59, R97, PERF-15, TEST-06), for both implementations.
//
//   bun run corpus
//   bun run budgets:tool [--corpus <vault>] [--rust <program>] [--runs <count>] [--reuse]
//
// `--reuse` keeps the setup of an earlier run with `--reuse` (in `--out`,
// default `.cache/tool-budgets/`) and edits the notes again after the
// publication of PERF-04, so that the next run on the same machine skips
// the setup, which takes minutes.
//
// The setup publishes every note of a copy of the corpus once, with the
// TypeScript logic, into a content store of its own in `.cache/`, and edits a
// few notes. Then each command runs in a process of its own, as the author
// runs it: `status` (PERF-03, a full check with no stored state: the tool
// keeps no state of the scan between two runs) and `plan` with no selection
// (PERF-02). The Rust program is the release build (built here when
// `--rust` is not given), with a stand-in Starter Kit that gives no note a
// type; the TypeScript logic runs with Bun.
//
// The gate of a budget is the median of `--runs` runs against its ceiling:
// the budget × (notes of the corpus / notes of the real vault) × the factor
// of the machine (`tool-budgets-rule.ts`). A median above its ceiling gets a
// second set of runs, and the budget fails only when the second median is
// above it too: one busy moment of a runner does not fail the job. The start
// of a publication of the command line program (PERF-04) is measured and
// shown, with no gate. The script prints numbers only.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OPTIONS: OutputOptions = { marker: 'tool-budgets.json', tool: 'budgets:tool' }
const PACKAGE = 'dsebastien-vault-publish'
const RUN_TIME = '2031-04-01T08:00:00Z'
const DEVICE = 'budgets'

/** The notes that the setup edits after the publication, for the plan. */
const EDITED_NOTES = 5

/** The reference workload: files that it reads and hashes, and how many runs. */
const REFERENCE_FILES = 2000
const REFERENCE_FILE_BYTES = 8192
const REFERENCE_PASSES = 4
const REFERENCE_RUNS = 5

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The environment of git and of the tool: no global and no system
 * configuration of the machine (`core.autocrlf` of Git for Windows, for
 * example), so that the copy is the same on each machine. `useWorkFolder`
 * puts the empty global configuration file into the work folder.
 */
let toolEnvironment: Record<string, string> = gitEnvironment()

async function useWorkFolder(work: string): Promise<void> {
    const empty = join(work, 'empty.gitconfig')
    await Bun.write(empty, '')
    toolEnvironment = { ...gitEnvironment(), GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' }
}

async function run(
    command: readonly string[],
    cwd: string,
    environment: Record<string, string> = toolEnvironment
): Promise<string> {
    const child = Bun.spawn([...command], { cwd, env: environment, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
    ])
    if ((await child.exited) !== 0) {
        throw new Error(`${command[0] ?? ''} ${command[1] ?? ''} failed: ${stderr.trim()}`)
    }
    return stdout
}

/** Builds the release program with cargo and returns its path: cargo says where it is. */
async function buildRelease(): Promise<string> {
    const output = await run(
        [
            'cargo',
            'build',
            '--release',
            '--locked',
            '--package',
            PACKAGE,
            '--message-format=json-render-diagnostics'
        ],
        ROOT,
        { ...process.env } as Record<string, string>
    )
    for (const line of output.split('\n')) {
        if (!line.startsWith('{')) continue
        const message: unknown = JSON.parse(line)
        if (!isRecord(message) || message['reason'] !== 'compiler-artifact') continue
        const target = message['target']
        const executable = message['executable']
        if (isRecord(target) && target['name'] === PACKAGE && typeof executable === 'string') {
            return executable
        }
    }
    throw new Error('cargo did not say where the Rust program is')
}

async function notePaths(vault: string): Promise<string[]> {
    const entries = await readdir(vault, { recursive: true, withFileTypes: true })
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => relative(vault, join(entry.parentPath, entry.name)).split(sep).join('/'))
        .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
        .sort()
}

/** The places of the run inside the work folder. */
interface Places {
    readonly vault: string
    readonly copy: string
    readonly attachments: string
    readonly starterKit: string
}

function placesOf(work: string): Places {
    const windows = process.platform === 'win32'
    return {
        vault: join(work, 'vault'),
        copy: join(work, 'copy'),
        attachments: join(work, 'attachments'),
        starterKit: join(work, windows ? 'osk-cli.cmd' : 'osk-cli')
    }
}

function deviceOf(places: Places): ReturnType<typeof nodeDevice> {
    return nodeDevice({
        vault: places.vault,
        contentStore: places.copy,
        attachmentStorage: places.attachments,
        noteTypes: NO_NOTE_TYPES
    })
}

/**
 * A stand-in for the program of the Starter Kit (`osk-cli recognize`): it
 * gives no note a type, as `NO_NOTE_TYPES` does on the TypeScript side.
 */
async function writeStarterKit(work: string, places: Places): Promise<void> {
    const script = join(work, 'osk-cli.ts')
    await Bun.write(
        script,
        [
            'const text = await new Response(Bun.stdin.stream()).text()',
            "const paths = text.split('\\n').filter((path) => path !== '')",
            'const notes = paths.map((path) => ({ path, noteType: null }))',
            'process.stdout.write(JSON.stringify({ noteTypes: [], notes }))',
            ''
        ].join('\n')
    )
    if (process.platform === 'win32') {
        await Bun.write(places.starterKit, `@"${process.execPath}" "${script}" %*\r\n`)
    } else {
        await Bun.write(
            places.starterKit,
            `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`
        )
        await chmod(places.starterKit, 0o755)
    }
}

/** The setup: a content store in which every note of the corpus is published, then a few edits. */
async function setUp(corpus: string, work: string, places: Places): Promise<{ notes: number }> {
    await cp(corpus, places.vault, { recursive: true })
    await mkdir(places.attachments)
    const store = join(work, 'content-store.git')
    await run(
        ['git', 'init', '--quiet', '--bare', '--initial-branch=main', '--template=', store],
        work
    )
    await run(['git', 'clone', '--quiet', store, places.copy], work)
    for (const [key, value] of [
        ['user.name', 'Budgets'],
        ['user.email', 'budgets@example.invalid'],
        ['commit.gpgsign', 'false']
    ] as const) {
        await run(['git', 'config', key, value], places.copy)
    }
    await run(['git', 'checkout', '--quiet', '-B', 'main'], places.copy)
    await Bun.write(join(places.copy, 'configuration.json'), '{ "denyList": [] }\n')
    await run(['git', 'add', 'configuration.json'], places.copy)
    await run(['git', 'commit', '--quiet', '--message', 'Add the configuration'], places.copy)
    await run(['git', 'push', '--quiet', 'origin', 'HEAD:main'], places.copy)
    await writeStarterKit(work, places)

    const paths = await notePaths(places.vault)
    const device = deviceOf(places)
    let start = performance.now()
    const first = await plan(device, { include: paths })
    const planned = (performance.now() - start) / 1000
    start = performance.now()
    const report = await publish(device, first.id, {
        time: RUN_TIME,
        device: DEVICE,
        face: 'command-line'
    })
    const published = (performance.now() - start) / 1000
    if (report.failed.length > 0) {
        throw new Error(`the setup could not publish ${String(report.failed.length)} notes`)
    }
    console.error(
        `setup: ${String(paths.length)} notes published, ` +
            `first-publication plan ${planned.toFixed(2)} s (no budget), ` +
            `publication ${published.toFixed(2)} s`
    )
    await editNotes(places)
    await writeMarker(work, OPTIONS, { notes: paths.length, ready: 1 })
    return { notes: paths.length }
}

/** Edits a few published notes, so that the plan with no selection has work. */
async function editNotes(places: Places): Promise<void> {
    for (const path of (await notePaths(places.vault)).slice(0, EDITED_NOTES)) {
        await appendFile(join(places.vault, path), '\nAn edit for the budgets.\n')
    }
}

/** The number of notes of the setup of an earlier run that `--reuse` can take, else undefined. */
async function readySetup(work: string): Promise<number | undefined> {
    try {
        const marker: unknown = await Bun.file(join(work, OPTIONS.marker)).json()
        const ready = isRecord(marker) && marker['tool'] === OPTIONS.tool && marker['ready'] === 1
        const notes = isRecord(marker) ? marker['notes'] : undefined
        return ready && typeof notes === 'number' && notes > 0 ? notes : undefined
    } catch {
        return undefined
    }
}

/** The time of a short fixed workload of reads, hashes and JSON, the twin of the work of a scan. */
async function referenceWorkload(work: string): Promise<number> {
    const folder = join(work, 'reference')
    await mkdir(folder)
    const bytes = new Uint8Array(REFERENCE_FILE_BYTES)
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = 32 + ((index * 7919) % 95)
    }
    for (let index = 0; index < REFERENCE_FILES; index += 1) {
        await Bun.write(join(folder, `${String(index).padStart(4, '0')}.md`), bytes)
    }
    const times: number[] = []
    // The first run warms the cache of the files, and does not count.
    for (let runIndex = 0; runIndex <= REFERENCE_RUNS; runIndex += 1) {
        const start = performance.now()
        for (let pass = 0; pass < REFERENCE_PASSES; pass += 1) {
            const names = await readdir(folder)
            const hashes: string[] = []
            for (const name of names.sort()) {
                const data = await readFile(join(folder, name))
                const text = new TextDecoder().decode(data)
                const lines = text.split(' ').map((word) => word.toLowerCase())
                hashes.push(new Bun.CryptoHasher('sha256').update(lines.join('\n')).digest('hex'))
            }
            JSON.parse(JSON.stringify({ hashes }))
        }
        if (runIndex > 0) times.push((performance.now() - start) / 1000)
    }
    return median(times)
}

/** The command of one measure, run in a process of its own. */
function commandOf(budget: ToolBudget, places: Places, rust: string | undefined): string[] {
    if (budget.implementation === 'typescript') {
        return [
            process.execPath,
            fileURLToPath(import.meta.url),
            '--run',
            budget.command,
            '--places',
            placesJson(places)
        ]
    }
    if (rust === undefined) {
        throw new Error('the Rust program is missing')
    }
    return [
        rust,
        budget.command,
        '--vault',
        places.vault,
        '--content-store',
        places.copy,
        '--osk-cli',
        places.starterKit
    ]
}

function placesJson(places: Places): string {
    return JSON.stringify(places)
}

async function timeOf(command: readonly string[]): Promise<{ seconds: number; output: string }> {
    const start = performance.now()
    const output = await run(command, ROOT, toolEnvironment)
    return { seconds: (performance.now() - start) / 1000, output }
}

async function medianOf(command: readonly string[], runs: number): Promise<number> {
    const times: number[] = []
    for (let index = 0; index < runs; index += 1) {
        times.push((await timeOf(command)).seconds)
    }
    return median(times)
}

/** The face of a TypeScript measure: the child process runs one command of the tool. */
async function runChild(command: string, given: string): Promise<void> {
    const parsed: unknown = JSON.parse(given)
    if (!isRecord(parsed)) throw new Error('--places is not an object')
    const places = parsed as unknown as Places
    const device = deviceOf(places)
    if (command === 'status') {
        const queue = await status(device)
        process.stdout.write(`${String(queue.counts.unchanged)}\n`)
    } else if (command === 'plan') {
        const stored = await plan(device, { include: [] })
        process.stdout.write(`${stored.id}\n`)
    } else {
        throw new Error(`unknown command "${command}"`)
    }
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            corpus: { type: 'string', default: join(ROOT, '.cache', 'corpus', 'vault') },
            out: { type: 'string', default: join(ROOT, '.cache', 'tool-budgets') },
            rust: { type: 'string' },
            runs: { type: 'string', default: '3' },
            run: { type: 'string' },
            places: { type: 'string' },
            reuse: { type: 'boolean', default: false }
        },
        strict: true
    })
    if (values.run !== undefined) {
        await runChild(values.run, values.places ?? '')
        return
    }
    const runs = Number(values.runs)
    if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) {
        throw new Error('--runs must be a whole number from 1 to 20')
    }
    const corpus = resolve(values.corpus)
    if ((await notePaths(corpus).catch(() => [])).length === 0) {
        throw new Error(`no corpus in ${corpus}: run \`bun run corpus\` first`)
    }
    const rust = values.rust === undefined ? await buildRelease() : resolve(values.rust)
    const out = resolve(values.out)
    const reused = values.reuse ? await readySetup(out) : undefined
    let work = out
    let notes = reused ?? 0
    if (reused === undefined) {
        work = await prepareOutputFolder(out, { ...OPTIONS, inputs: [corpus] })
        await useWorkFolder(work)
        notes = (await setUp(corpus, work, placesOf(work))).notes
    } else {
        console.error(`setup: ${String(notes)} published notes of an earlier run (--reuse)`)
        await rm(join(work, 'reference'), { recursive: true, force: true })
        await useWorkFolder(work)
    }
    const places = placesOf(work)

    const reference = await referenceWorkload(work)
    const factor = machineFactor(reference)
    console.error(
        `reference workload: ${reference.toFixed(3)} s ` +
            `(calibration ${REFERENCE_SECONDS.toFixed(3)} s), ` +
            `factor of the machine ${factor.toFixed(2)}`
    )

    const failed: string[] = []
    const implied: number[] = []
    for (const budget of TOOL_BUDGETS) {
        const command = commandOf(budget, places, rust)
        const ceiling = ceilingOf(budget, notes, factor)
        let time = await medianOf(command, runs)
        let verdict = time <= ceiling ? 'pass' : 'second set'
        if (time > ceiling) {
            time = await medianOf(command, runs)
            verdict = time <= ceiling ? 'pass at the second set' : 'FAIL'
        }
        implied.push(impliedFactor(budget, notes, time))
        const name = `${budget.id} ${budget.command} ${budget.implementation}`
        console.error(
            `${name}: median ${time.toFixed(2)} s, ceiling ${ceiling.toFixed(2)} s ` +
                `(budget ${String(budget.seconds)} s on the real vault): ${verdict}`
        )
        if (verdict === 'FAIL') failed.push(name)
    }

    // What a calibration on this machine would be: the reference time over
    // the largest ratio of a measure to the measure of the author scaled to
    // the corpus. It is for the author, to calibrate again on his machine.
    console.error(
        `calibration that this machine gives: ${(reference / Math.max(...implied)).toFixed(3)} s`
    )

    // PERF-04, no gate: the publication of the plan of the edited notes, with
    // no deploy. The command line program writes its report at the end, so
    // the measure is the whole run.
    const planned = await timeOf([
        rust,
        'plan',
        '--vault',
        places.vault,
        '--content-store',
        places.copy,
        '--osk-cli',
        places.starterKit
    ])
    const id: unknown = JSON.parse(planned.output)
    const planId = isRecord(id) && typeof id['id'] === 'string' ? id['id'] : undefined
    if (planId === undefined) throw new Error('the plan of the Rust program has no id')
    const started = await timeOf([
        rust,
        'publish',
        '--vault',
        places.vault,
        '--content-store',
        places.copy,
        '--osk-cli',
        places.starterKit,
        '--attachment-storage',
        places.attachments,
        '--plan',
        planId,
        '--no-deploy',
        '--time',
        RUN_TIME,
        '--device',
        DEVICE
    ])
    console.error(
        `PERF-04 publish rust, ${String(EDITED_NOTES)} notes, no deploy: ` +
            `${started.seconds.toFixed(2)} s (no gate)`
    )

    // The publication took the edits: new ones keep the setup ready for `--reuse`.
    if (values.reuse) {
        await editNotes(places)
    } else {
        await rm(work, { recursive: true, force: true })
    }
    if (failed.length > 0) {
        throw new Error(`budgets above their ceiling: ${failed.join(', ')}`)
    }
}

try {
    await main()
} catch (error) {
    console.error(error instanceof Error ? `error: ${error.message}` : error)
    process.exitCode = 1
}
