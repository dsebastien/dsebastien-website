import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import {
    applyRedirectList,
    canonicalPath,
    redirectListFrom,
    resolve,
    resolverMapFrom,
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
//   bun scripts/measure-resolver-map.ts [--vault <folder> | --paths <file>]
//       [--redirects <file>] [--former-paths <count>]
//
// The default vault is the invented corpus of `bun run corpus`. `--paths`
// reads the vault paths of the notes from a file, one per line, with no
// alias (the list of the notes that are published today). `--redirects`
// adds a redirect list (`redirects.json` of a content store, issue 44) and
// measures the map with it, and the cost of the first request of a host
// that reads it: the read of the text, the check of its shape, and one
// resolution of an old path of the list. A vault has no former path:
// `--former-paths <count>` gives every note that many invented former paths
// (`<folder>/Former <n> of <name>.md`), so the measure counts the part
// `former` of the map, which grows with every move and never loses a path
// (issue 105, URL rule 1 of the business rules). The script
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
        options: {
            'vault': { type: 'string', default: join(ROOT, '.cache', 'corpus', 'vault') },
            'paths': { type: 'string' },
            'redirects': { type: 'string' },
            'former-paths': { type: 'string', default: '0' }
        },
        strict: true
    })
    const formerCount = Number(values['former-paths'])
    if (!Number.isInteger(formerCount) || formerCount < 0) {
        throw new Error('--former-paths takes a whole number, 0 or more')
    }
    const notes: SiteNote[] = []
    const formerPathsOf = (path: string): string[] => {
        const slash = path.lastIndexOf('/') + 1
        return Array.from(
            { length: formerCount },
            (_, index) =>
                `${path.slice(0, slash)}Former ${String(index + 1)} of ${path.slice(slash)}`
        )
    }
    if (values.paths === undefined) {
        const vault = resolvePath(values.vault)
        for (const path of await notePaths(vault)) {
            const text = await readFile(join(vault, path), 'utf8')
            notes.push({
                path,
                aliases: aliasesOf(sourceOf(text)).aliases,
                formerPaths: formerPathsOf(path)
            })
        }
    } else {
        const lines = (await readFile(resolvePath(values.paths), 'utf8')).split(/\r?\n/u)
        for (const path of lines.filter((line) => line.endsWith('.md'))) {
            notes.push({ path, aliases: [], formerPaths: formerPathsOf(path) })
        }
    }
    // File names of the same length as the ones of the build.
    const files: SiteFiles = {
        home: 'index.html',
        notFound: '404.html',
        gone: '410.html',
        robots: 'robots.txt',
        icon: 'favicon.ico',
        page: (path) => `-/note/${shortHash(path)}.html`,
        markdown: (path) => `-/md/${shortHash(path)}.md`,
        folder: (path) => `-/folder/${shortHash(path)}.html`,
        choice: (list) => `-/choice/${shortHash(list.join('\n'))}.html`
    }
    const built = performance.now()
    const base = resolverMapOf(notes, files)
    const list =
        values.redirects === undefined
            ? undefined
            : redirectListFrom(JSON.parse(await readFile(resolvePath(values.redirects), 'utf8')))
    const applied = list === undefined ? undefined : applyRedirectList(base, list)
    const map = applied?.map ?? base
    const buildTime = performance.now() - built
    const baseBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`)
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
    // The first request of a host: the read of the text, the check of its
    // shape and one resolution of an old path of the list, with no warm-up.
    const old = list?.redirects[0]?.from ?? ''
    const first = performance.now()
    const read = resolverMapFrom(JSON.parse(text))
    resolve(`/${old.split('/').map(encodeURIComponent).join('/')}`, read)
    const firstRequestTime = performance.now() - first
    const oldRequests = (list?.redirects ?? [])
        .slice(0, 1000)
        .map((row) => `/${row.from.split('/').map(encodeURIComponent).join('/')}`)
    const oldTime = median(5, () => {
        for (const request of oldRequests) {
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
                formerPaths: notes.reduce((sum, note) => sum + (note.formerPaths?.length ?? 0), 0),
                formerTexts: count(map.former?.folded),
                formerNames: count(map.former?.names),
                formerMarkdown: count(map.former?.markdown),
                bytes,
                gzipBytes: gzip,
                ...(list === undefined
                    ? {}
                    : {
                          bytesWithoutRedirects: baseBytes,
                          redirectRows: list.redirects.length,
                          goneRows: list.gone.length,
                          prefixRules: list.prefixes.length,
                          redirectsInMap: count(map.redirects?.folded),
                          droppedShadowed: applied?.dropped.shadowed ?? 0,
                          droppedLoop: applied?.dropped.loop ?? 0,
                          rowFallback: applied?.kept.rowFallback ?? 0,
                          prefixOnLiveFolder: applied?.kept.prefixOnLiveFolder ?? 0,
                          prefixFallback: applied?.kept.prefixFallback ?? 0,
                          hidesNameOrAlias: applied?.kept.hidesNameOrAlias ?? 0,
                          firstRequestMilliseconds: Math.round(firstRequestTime * 10) / 10,
                          microsecondsPerOldPath:
                              Math.round(
                                  ((oldTime * 1000) / Math.max(oldRequests.length, 1)) * 10
                              ) / 10
                      }),
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
