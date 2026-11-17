import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_NOTES, generateCorpus } from './corpus.ts'
import { prepareOutputFolder, writeMarker, type OutputOptions } from './output-folder.ts'

// The command that writes the invented corpus of full size (issue 18).
//
//   bun run corpus                      20,735 notes into `.cache/corpus/`
//   bun run corpus --seed 7 --notes 500 --out .cache/small
//
// The corpus is never committed: inside the clone, the command writes below
// the private folders that git ignores only. It writes over its own earlier
// output only.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const OPTIONS: OutputOptions = { marker: 'corpus.json', tool: 'corpus' }

/** The largest seed: the generator keeps 32 bits of it. */
const LARGEST_SEED = 2 ** 32 - 1

function wholeNumber(text: string, name: string, smallest: number, largest: number): number {
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(value) || value < smallest || value > largest) {
        throw new Error(
            `--${name} must be a whole number from ${String(smallest)} to ${String(largest)}, and "${text}" is not`
        )
    }
    return value
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            seed: { type: 'string', default: '1' },
            notes: { type: 'string', default: String(DEFAULT_NOTES) },
            out: { type: 'string', default: join(ROOT, '.cache', 'corpus') }
        },
        strict: true
    })
    // Every input is checked before the earlier output is removed.
    const seed = wholeNumber(values.seed, 'seed', 0, LARGEST_SEED)
    const notes = wholeNumber(values.notes, 'notes', 1, 10_000_000)
    const out = await prepareOutputFolder(resolve(values.out), OPTIONS)

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
    await writeMarker(out, OPTIONS, { seed, notes })
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
