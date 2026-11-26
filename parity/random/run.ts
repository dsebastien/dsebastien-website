import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gitEnvironment, makeTestStores, type TestStores } from '@dsebastien-website/testing'
import { toCanonicalJson } from '../../apps/plugin/src/publishing/canonical.ts'
import { fileNoteTypes, nodeDevice } from '../../apps/plugin/src/publishing/node/device.ts'
import { compareCodePoints } from '../../apps/plugin/src/publishing/order.ts'
import type { Selection } from '../../apps/plugin/src/publishing/plan.ts'
import {
    edit,
    guards,
    plan,
    publish,
    status,
    takedown,
    unpublish
} from '../../apps/plugin/src/publishing/tool.ts'
import type { Device } from '../../apps/plugin/src/publishing/ports.ts'
import { runRustProgram } from '../harness.ts'
import { caseOf, type Action, type Case, type FileContent } from './case.ts'

// The run of a random case on both implementations (issue 112). Each one runs
// the steps on stores of its own and gives, for each step, what the step gave
// (the queue, the plan, the lists of a report, an event, or a refusal) and
// every file that it left behind (the vault, the content store, the
// attachment storage and the stored plans). The two runs must be equal, step
// by step.

const DEVICE = 'garden-shed'

/** What a step gave: data in the canonical form, or a refusal with its message. */
export type Outcome = { value: unknown } | { refused: string }

/** Every file that a run left behind after a step, each as text, by its path. */
export interface Files {
    vault: Record<string, string>
    store: Record<string, string>
    storage: Record<string, string>
    /** The stored plans: the records, sorted. Their ids are their file names, which are left out. */
    plans: string[]
}

export interface StepResult {
    /** The plan of a publication step, which the step makes before it applies it. */
    plan?: Outcome
    /** What the step gave. A publication whose plan is refused gives no outcome. */
    outcome?: Outcome
    files: Files
}

/** The places of one run: a vault, a copy of the content store and an attachment storage. */
interface Places {
    vault: string
    copy: string
    storage: string
    answers: string
}

/** One implementation, on the places of one run. */
interface Tool {
    status(): Promise<Outcome>
    /** The plan of a selection, with the id that a publication of it needs. */
    plan(selection: Selection): Promise<{ outcome: Outcome; id?: string }>
    publish(id: string, time: string): Promise<Outcome>
    unpublish(paths: readonly string[], time: string, accept: readonly string[]): Promise<Outcome>
    takedown(paths: readonly string[], time: string): Promise<Outcome>
    edit(action: string, path: string, time: string): Promise<Outcome>
    guards(): Promise<Outcome>
}

async function git(cwd: string, ...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', ...args], {
        cwd,
        env: gitEnvironment(),
        stdout: 'ignore',
        stderr: 'pipe'
    })
    const errors = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${errors.trim()}`)
    }
}

async function writeFiles(folder: string, files: Record<string, FileContent>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(folder, path)), { recursive: true })
        await writeFile(
            join(folder, path),
            typeof content === 'string' ? content : Buffer.from(content.bytes, 'hex')
        )
    }
}

/** Another device: it writes files into the content store and pushes them. */
async function pushToStore(copy: string, files: Record<string, string>): Promise<void> {
    await writeFiles(copy, files)
    await git(copy, 'add', '--', ...Object.keys(files))
    await git(copy, 'commit', '--quiet', '--message', 'A change of another device')
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
}

/**
 * The content stores that every case starts from, one for each deny list: a
 * bare repository with the configuration, and a copy of it. A case copies
 * them, which is much faster than the git commands that make them.
 */
class Templates {
    private readonly made = new Map<string, Promise<{ bare: string; copy: string }>>()

    constructor(private readonly stores: TestStores) {}

    of(denyList: readonly string[]): Promise<{ bare: string; copy: string }> {
        const key = JSON.stringify(denyList)
        let template = this.made.get(key)
        if (template === undefined) {
            template = this.make(denyList, String(this.made.size))
            this.made.set(key, template)
        }
        return template
    }

    private async make(denyList: readonly string[], name: string) {
        const bare = join(this.stores.root, `store-${name}.git`)
        await cp(this.stores.contentStore, bare, { recursive: true })
        const copy = join(this.stores.root, `copy-${name}`)
        await git(this.stores.root, 'clone', '--quiet', bare, copy)
        await git(copy, 'config', 'user.name', 'Test')
        await git(copy, 'config', 'user.email', 'test@example.invalid')
        await git(copy, 'config', 'commit.gpgsign', 'false')
        await git(copy, 'checkout', '--quiet', '-B', 'main')
        await pushToStore(copy, { 'configuration.json': JSON.stringify({ denyList }) })
        return { bare, copy }
    }
}

/**
 * The places of a case in a folder of its own: the vault, the content store
 * with the deny list of the case and its copy, an empty attachment storage,
 * and the answers of a Starter Kit with no type.
 */
async function placesOf(root: string, templates: Templates, given: Case): Promise<Places> {
    const vault = join(root, 'vault')
    await mkdir(vault)
    await writeFiles(vault, given.vault)
    const template = await templates.of(given.denyList)
    const bare = join(root, 'content-store.git')
    await cp(template.bare, bare, { recursive: true })
    const copy = join(root, 'copy')
    await cp(template.copy, copy, { recursive: true })
    // The copy pushes to the content store of the case. The file is written
    // here, not with git: each process that a case starts costs time.
    const config = join(copy, '.git', 'config')
    const text = await Bun.file(config).text()
    const origin = /^\turl = .*$/mu
    if (!origin.test(text)) {
        throw new Error('the copy of the template has no address of its content store')
    }
    // Git reads a path with forward slashes on every system, with no escape.
    await writeFile(config, text.replace(origin, `\turl = ${bare.replaceAll('\\', '/')}`))
    const storage = join(root, 'attachment-storage')
    await mkdir(storage)
    const answers = join(root, 'note-types.json')
    await writeFile(answers, JSON.stringify({ noteTypes: [], notes: {} }))
    return { vault, copy, storage, answers }
}

function sorted(entries: [string, string][]): Record<string, string> {
    return Object.fromEntries(entries.sort(([one], [two]) => compareCodePoints(one, two)))
}

/** Every file of a folder as text, the git folder left out. An image is its bytes in hexadecimal. */
async function filesOf(folder: string): Promise<Record<string, string>> {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true })
    const files: [string, string][] = []
    for (const entry of entries) {
        const path = join(entry.parentPath, entry.name)
        const name = path.slice(folder.length + 1).replaceAll('\\', '/')
        if (entry.isFile() && !name.startsWith('.git/')) {
            const bytes = await Bun.file(path).bytes()
            files.push([
                name,
                name.endsWith('.png')
                    ? bytes.toHex()
                    : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
            ])
        }
    }
    return sorted(files)
}

async function filesLeft(places: Places): Promise<Files> {
    const plansFolder = join(places.copy, '.git', 'vault-publish', 'plans')
    const plans = await readdir(plansFolder).catch(() => [])
    const records = await Promise.all(plans.map((name) => Bun.file(join(plansFolder, name)).text()))
    const storage: [string, string][] = []
    for (const name of await readdir(places.storage)) {
        storage.push([name, (await Bun.file(join(places.storage, name)).bytes()).toHex()])
    }
    return {
        vault: await filesOf(places.vault),
        store: await filesOf(places.copy),
        storage: sorted(storage),
        plans: records.sort(compareCodePoints)
    }
}

/** Data as the canonical form writes it, read back: a plain value that both sides can compare. */
function canonical(value: unknown): unknown {
    return JSON.parse(toCanonicalJson(value as never))
}

/** The paths of a list of a report whose items are objects with a path (`failed`, `warnings`). */
function pathsOf(list: unknown): unknown {
    return Array.isArray(list)
        ? list.map((item: unknown) =>
              typeof item === 'object' && item !== null && 'path' in item ? item.path : item
          )
        : list
}

/** The lists of a report as the shared scenarios state them. */
export function reportLists(report: unknown): unknown {
    const lists = { ...(canonical(report) as Record<string, unknown>) }
    for (const key of ['failed', 'storageWarnings', 'warnings']) {
        if (key in lists) {
            lists[key] = pathsOf(lists[key])
        }
    }
    return lists
}

async function outcomeOf(
    work: () => Promise<unknown>,
    shape: (value: unknown) => unknown = canonical
): Promise<Outcome> {
    try {
        return { value: shape(await work()) }
    } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) }
    }
}

/** The parts of a plan that the parity rule compares: not its id, not the texts for the author. */
function planParts(planned: unknown): unknown {
    const { plan, offline, listsNotRefreshed, liveQueries, tooLarge } = planned as Record<
        string,
        unknown
    >
    return canonical({ plan, offline, listsNotRefreshed, liveQueries, tooLarge })
}

function typescriptTool(places: Places): Tool {
    const device: Device = nodeDevice({
        vault: places.vault,
        contentStore: places.copy,
        attachmentStorage: places.storage,
        noteTypes: fileNoteTypes(places.answers)
    })
    const runAt = (time: string) => ({ time, device: DEVICE, face: 'command-line' }) as const
    return {
        status: () => outcomeOf(() => status(device)),
        async plan(selection) {
            let id: string | undefined
            const outcome = await outcomeOf(async () => {
                const planned = await plan(device, selection)
                id = planned.id
                return planned
            }, planParts)
            return id === undefined ? { outcome } : { outcome, id }
        },
        publish: (id, time) => outcomeOf(() => publish(device, id, runAt(time)), reportLists),
        unpublish: (paths, time, accept) =>
            outcomeOf(() => unpublish(device, paths, runAt(time), accept), reportLists),
        takedown: (paths, time) =>
            outcomeOf(() => takedown(device, paths, runAt(time)), reportLists),
        edit: (action, path, time) =>
            outcomeOf(() => edit(device, { action: action as never, path }, runAt(time))),
        guards: () => outcomeOf(() => guards(device))
    }
}

function rustTool(program: string, places: Places): Tool {
    const run = async (
        command: string,
        args: readonly string[],
        shape: (value: unknown) => unknown = canonical
    ): Promise<Outcome> => {
        const writes = ['publish', 'takedown', 'unpublish'].includes(command)
            ? ['--attachment-storage', places.storage, '--no-deploy']
            : []
        const result = await runRustProgram(
            program,
            [command, '--vault', places.vault, '--content-store', places.copy, ...writes, ...args],
            { DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES: places.answers }
        )
        if (result.exitCode !== 0) {
            return { refused: result.stderr.trim().replace(/^error: /u, '') }
        }
        return { value: shape(JSON.parse(new TextDecoder().decode(result.stdout))) }
    }
    const at = (time: string) => ['--time', time, '--device', DEVICE]
    // With `=`: a path can start with a hyphen.
    const paths = (key: string, list: readonly string[] = []) =>
        list.map((path) => `--${key}=${path}`)
    return {
        status: () => run('status', []),
        async plan(selection) {
            let id: string | undefined
            const outcome = await run(
                'plan',
                [
                    ...paths('include', selection.include),
                    ...paths('hold', selection.hold),
                    ...paths('remove', selection.remove),
                    ...paths('accept', selection.accept),
                    ...(selection.pair ?? []).flatMap((pairing) => [
                        '--pair',
                        pairing.from,
                        pairing.to
                    ])
                ],
                (value) => {
                    id = (value as { id: string }).id
                    return planParts(value)
                }
            )
            return id === undefined ? { outcome } : { outcome, id }
        },
        publish: (id, time) => run('publish', ['--plan', id, ...at(time)], reportLists),
        unpublish: (list, time, accept) =>
            run(
                'unpublish',
                [...paths('path', list), ...paths('accept', accept), ...at(time)],
                reportLists
            ),
        takedown: (list, time) =>
            run('takedown', [...paths('path', list), ...at(time)], reportLists),
        edit: async (action, path, time) => {
            const outcome = await run(action, [`--path=${path}`, ...at(time)])
            return 'value' in outcome
                ? { value: (outcome.value as { edit: unknown }).edit }
                : outcome
        },
        guards: () => run('guards', [])
    }
}

/** Runs one step. A publication makes its plan first, and applies it only when the plan is made. */
async function runStep(
    tool: Tool,
    places: Places,
    step: Action
): Promise<Omit<StepResult, 'files'>> {
    switch (step.do) {
        case 'write':
            await writeFiles(places.vault, step.files)
            return {}
        case 'delete':
            for (const path of step.paths) {
                await rm(join(places.vault, path), { recursive: true })
            }
            return {}
        case 'store':
            await pushToStore(places.copy, step.files)
            return {}
        case 'status':
            return { outcome: await tool.status() }
        case 'plan':
            return { outcome: (await tool.plan(step.selection)).outcome }
        case 'publish': {
            const planned = await tool.plan(step.selection)
            return planned.id === undefined
                ? { plan: planned.outcome }
                : { plan: planned.outcome, outcome: await tool.publish(planned.id, step.time) }
        }
        case 'unpublish':
            return { outcome: await tool.unpublish(step.paths, step.time, step.accept ?? []) }
        case 'takedown':
            return { outcome: await tool.takedown(step.paths, step.time) }
        case 'edit':
            return { outcome: await tool.edit(step.action, step.path, step.time) }
        case 'guards':
            return { outcome: await tool.guards() }
    }
}

export type Side = 'typescript' | 'rust'

/** Runs cases on both implementations. Declare it with `await using`: its templates are removed at the end. */
export interface Runner extends AsyncDisposable {
    /** Runs every step of a case on one implementation, on stores of its own. */
    run(given: Case, side: Side): Promise<StepResult[]>
}

/** A runner of cases; `program` is the Rust program (see `buildRustProgram`). */
export async function makeRunner(program: string): Promise<Runner> {
    const stores = await makeTestStores()
    const templates = new Templates(stores)
    return {
        async run(given, side) {
            const root = await mkdtemp(join(stores.root, 'case-'))
            const places = await placesOf(root, templates, given)
            const tool = side === 'typescript' ? typescriptTool(places) : rustTool(program, places)
            const results: StepResult[] = []
            for (const step of given.steps) {
                const result = await runStep(tool, places, step)
                results.push({ ...result, files: await filesLeft(places) })
            }
            await rm(root, { recursive: true, force: true })
            return results
        },
        [Symbol.asyncDispose]: () => stores.remove()
    }
}

/** The first step where the two runs differ, and what differs; undefined when they agree. */
export interface Difference {
    step: number
    part: string
    typescript: string
    rust: string
}

/** An outcome with the message of a refusal left out. */
function withoutMessage(outcome: Outcome | undefined): unknown {
    return outcome !== undefined && 'refused' in outcome ? { refused: true } : outcome
}

/**
 * Compares the two runs step by step. A refusal is compared as a refusal:
 * the texts of the messages are for a person, outside the parity rule.
 */
export function compareRuns(typescript: StepResult[], rust: StepResult[]): Difference | undefined {
    const show = (value: unknown) =>
        value === undefined ? 'nothing' : JSON.stringify(value, null, 2)
    for (const [index, ours] of typescript.entries()) {
        const theirs = rust[index]
        if (theirs === undefined) {
            return { step: index, part: 'the step', typescript: 'ran', rust: 'did not run' }
        }
        for (const part of ['plan', 'outcome'] as const) {
            if (show(withoutMessage(ours[part])) !== show(withoutMessage(theirs[part]))) {
                return {
                    step: index,
                    part: `the ${part}`,
                    typescript: show(ours[part]),
                    rust: show(theirs[part])
                }
            }
        }
        for (const part of ['vault', 'store', 'storage', 'plans'] as const) {
            if (show(ours.files[part]) !== show(theirs.files[part])) {
                return {
                    step: index,
                    part: `the files: ${part}`,
                    typescript: show(ours.files[part]),
                    rust: show(theirs.files[part])
                }
            }
        }
    }
    return undefined
}

/** The run of one case on both implementations, and the first difference, when there is one. */
export interface CaseRun {
    given: Case
    typescript: StepResult[]
    rust: StepResult[]
    difference?: Difference
}

/**
 * Runs the cases of the seeds on both implementations, `parallel` cases at a
 * time, and gives their runs in the order of the seeds. `onRun` sees each run
 * as it ends.
 */
export async function runSeeds(
    runner: Runner,
    seeds: readonly number[],
    parallel: number,
    onRun: (run: CaseRun) => void = () => undefined
): Promise<CaseRun[]> {
    const runs: CaseRun[] = []
    let next = 0
    const worker = async (): Promise<void> => {
        for (let index = next++; index < seeds.length; index = next++) {
            const given = caseOf(seeds[index] ?? 0)
            const [typescript, rust] = await Promise.all([
                runner.run(given, 'typescript'),
                runner.run(given, 'rust')
            ])
            const difference = compareRuns(typescript, rust)
            const run =
                difference === undefined
                    ? { given, typescript, rust }
                    : { given, typescript, rust, difference }
            runs[index] = run
            onRun(run)
        }
    }
    await Promise.all(Array.from({ length: parallel }, worker))
    return runs
}
