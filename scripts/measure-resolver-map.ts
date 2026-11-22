import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import {
    canonicalPath,
    resolve,
    resolverMapOf,
    type SiteFiles,
    type SiteNote
} from '@dsebastien-website/resolver'
import { sourceOf } from '../apps/plugin/src/publishing/clean.ts'
import { aliasesOf } from '../apps/plugin/src/publishing/frontmatter.ts'

// Measures the resolver map of a vault as if every note of it were published
// (issue 43, which holds the measure of the prototype of issue 20): its size,
// its size with gzip, the time to read it, and the time of one resolution.
//
//   bun scripts/measure-resolver-map.ts [--vault <folder>]
//
// The default vault is the invented corpus of `bun run corpus`. The script
// prints numbers only, never a name of a note: it can run on the export of the
// published notes of the author (`.cache/published/vault`), whose numbers stay
// out of this repository.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The vault paths of the notes of a vault: every `.md` file, without names that start with a dot. */
async function notePaths(vault: string): Promise<string[]> {
    const entries = await readdir(vault, { recursive: true, withFileTypes: true })
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => relative(vault, join(entry.parentPath, entry.name)).split(sep).join('/'))
        .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
}

function shortHash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** The median of the times of a function, in milliseconds. */
function median(runs: number, work: () => void): number {
    const times: number[] = []
    for (let run = 0; run < runs; run += 1) {
        const start = performance.now()
        work()
        times.push(performance.now() - start)
    }
    times.sort((one, two) => one - two)
    return times[Math.floor(times.length / 2)] ?? 0
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: { vault: { type: 'string', default: join(ROOT, '.cache', 'corpus', 'vault') } },
        strict: true
    })
    const vault = resolvePath(values.vault)
    const paths = await notePaths(vault)
    const notes: SiteNote[] = []
    for (const path of paths) {
        const text = await readFile(join(vault, path), 'utf8')
        notes.push({ path, aliases: aliasesOf(sourceOf(text)).aliases })
    }
    // File names of the same length as the ones of the build.
    const files: SiteFiles = {
        home: 'index.html',
        notFound: '404.html',
        gone: '410.html',
        robots: 'robots.txt',
        page: (path) => `-/note/${shortHash(path)}.html`,
        markdown: (path) => `-/md/${shortHash(path)}.md`,
        folder: (path) => `-/folder/${shortHash(path)}.html`,
        choice: (list) => `-/choice/${shortHash(list.join('\n'))}.html`
    }
    const built = performance.now()
    const map = resolverMapOf(notes, files)
    const buildTime = performance.now() - built
    const text = `${JSON.stringify(map)}\n`
    const bytes = Buffer.byteLength(text)
    const gzip = Bun.gzipSync(Buffer.from(text)).byteLength
    const readTime = median(5, () => JSON.parse(text) as unknown)

    // One request of each kind, for each of 1,000 notes.
    const sample = notes.slice(0, 1000)
    const requests = sample.flatMap((note) => {
        const path = canonicalPath(note.path)
        const name = note.path.slice(note.path.lastIndexOf('/') + 1, -'.md'.length)
        return [
            path,
            path.toLowerCase(),
            `${path}/`,
            `/${encodeURIComponent(name).replaceAll('%20', '+')}`,
            ...note.aliases.slice(0, 1).map((alias) => `/${encodeURIComponent(alias)}`)
        ]
    })
    const resolveTime = median(5, () => {
        for (const request of requests) {
            resolve(request, map)
        }
    })
    const count = (record: object | undefined): number => Object.keys(record ?? {}).length
    process.stdout.write(
        `${JSON.stringify(
            {
                notes: notes.length,
                notesWithAliases: notes.filter((note) => note.aliases.length > 0).length,
                pages: count(map.pages),
                files: count(map.files),
                folded: count(map.folded),
                names: count(map.names),
                aliases: count(map.aliases),
                choices: count(map.choices),
                bytes,
                gzipBytes: gzip,
                buildMilliseconds: Math.round(buildTime),
                readMilliseconds: Math.round(readTime * 10) / 10,
                requests: requests.length,
                microsecondsPerResolution:
                    Math.round(((resolveTime * 1000) / Math.max(requests.length, 1)) * 10) / 10
            },
            null,
            2
        )}\n`
    )
}

await main()
