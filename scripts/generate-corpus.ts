import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_NOTES, generateCorpus } from './corpus.ts'

// The command that writes the invented corpus of full size (issue 18).
//
//   bun run corpus                      20,735 notes into `.cache/corpus/`
//   bun run corpus --seed 7 --notes 500 --out .cache/small
//
// The corpus is never committed: the command refuses a folder of the clone
// that git does not ignore. It writes over its own earlier output only.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The file that marks a folder as the output of this command. */
const MARKER = 'corpus.json'

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        seed: { type: 'string', default: '1' },
        notes: { type: 'string', default: String(DEFAULT_NOTES) },
        out: { type: 'string', default: join(ROOT, '.cache', 'corpus') }
    },
    strict: true
})

function wholeNumber(text: string, name: string): number {
    const value = Number(text)
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`--${name} must be a whole number, and "${text}" is not`)
    }
    return value
}

/** True when the folder is inside the clone and git does not ignore it. */
async function couldBeCommitted(folder: string): Promise<boolean> {
    const fromRoot = relative(ROOT, folder)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        return false
    }
    const child = Bun.spawn(['git', 'check-ignore', '--quiet', join(folder, MARKER)], {
        cwd: ROOT,
        stdout: 'ignore',
        stderr: 'ignore'
    })
    return (await child.exited) !== 0
}

async function prepare(out: string): Promise<void> {
    if (await couldBeCommitted(out)) {
        throw new Error(
            `git does not ignore "${out}". The corpus is never committed: choose a folder that git ignores, for example inside .cache/`
        )
    }
    let entries: string[]
    try {
        entries = await readdir(out)
    } catch {
        entries = []
    }
    // Remove only a folder that this command made.
    if (entries.length > 0 && !entries.includes(MARKER)) {
        throw new Error(
            `"${out}" holds files and is not the output of an earlier run. Choose another folder`
        )
    }
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
}

async function main(): Promise<void> {
    const seed = wholeNumber(values.seed, 'seed')
    const notes = wholeNumber(values.notes, 'notes')
    const out = resolve(values.out)
    await prepare(out)
    // The marker comes first: a run that stops halfway leaves a folder that
    // the next run can write over.
    await Bun.write(join(out, MARKER), `${JSON.stringify({ seed, notes }, null, 4)}\n`)

    const folders = new Set<string>()
    let noteCount = 0
    let attachmentCount = 0
    for (const file of generateCorpus({ seed, notes })) {
        const path = join(out, 'vault', file.path)
        const folder = dirname(path)
        if (!folders.has(folder)) {
            await mkdir(folder, { recursive: true })
            folders.add(folder)
        }
        await Bun.write(path, file.bytes)
        if (file.path.endsWith('.md')) {
            noteCount += 1
        } else {
            attachmentCount += 1
        }
    }
    console.error(
        `Wrote ${String(noteCount)} notes and ${String(attachmentCount)} attachments to ${join(out, 'vault')} (seed ${String(seed)})`
    )
}

try {
    await main()
} catch (error) {
    console.error(error instanceof Error ? `error: ${error.message}` : error)
    process.exitCode = 1
}
