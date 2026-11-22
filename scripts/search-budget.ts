import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { canonicalPath } from '@dsebastien-website/resolver'
import * as pagefind from 'pagefind'
import { sourceOf } from '../apps/plugin/src/publishing/clean.ts'
import { aliasesOf } from '../apps/plugin/src/publishing/frontmatter.ts'
import { brotliSize, FIRST_SEARCH_BROTLI } from '../apps/site/src/budgets.ts'
import {
    foldedWords,
    partOf,
    titleIndexOf,
    type TitleEntry
} from '../apps/site/src/search/titles.ts'

// The budget of the first search at full size (issue 51, R57, PERF-21): the
// title index and the full-text index of a vault, as if every note of it were
// published, and the bytes that a first search loads for the most frequent
// words of the vault and for pairs of them. Each query is measured in a
// process of its own, as a reader who searches for the first time.
//
//   bun run budgets:search [--vault <folder>]
//
// The default vault is the invented corpus of `bun run corpus`. The script
// prints numbers only, never a word or a name of a note: it can run on the
// export of the published notes of the author (`.cache/published/vault`),
// whose numbers stay out of this repository. It stops with an error when a
// first search is above the budget.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The full-text results that a first search shows. */
const SHOWN = 10
/** The most frequent words that the measure searches for, then pairs of them. */
const WORDS = 12

/** The bytes of a file on the wire: as it is when it is compressed already, else with Brotli. */
function wireSize(bytes: Uint8Array): number {
    const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b
    return gzip ? bytes.byteLength : brotliSize(bytes)
}

/** The bytes that one first search loads from the full-text index; run in a process of its own. */
async function measureQuery(index: string, query: string): Promise<number> {
    let bytes = 0
    const fetchFile = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const answer = await fetchFile(input, init)
        bytes += wireSize(new Uint8Array(await answer.clone().arrayBuffer()))
        return answer
    }) as typeof fetch
    const script = join(index, 'pagefind.js')
    bytes += wireSize(await readFile(script))
    const module = (await import(pathToFileURL(script).href)) as {
        options(options: { basePath: string; baseUrl: string }): Promise<void>
        search(query: string): Promise<{ results: { data(): Promise<unknown> }[] }>
    }
    await module.options({ basePath: `${pathToFileURL(index).href}/`, baseUrl: '/' })
    const { results } = await module.search(query)
    await Promise.all(results.slice(0, SHOWN).map((result) => result.data()))
    return bytes
}

async function notePaths(vault: string): Promise<string[]> {
    const entries = await readdir(vault, { recursive: true, withFileTypes: true })
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => relative(vault, join(entry.parentPath, entry.name)).split(sep).join('/'))
        .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
}

/** The text of a note without its properties. */
function bodyOf(source: string): string {
    return source.startsWith('---\n') ? source.slice(source.indexOf('\n---', 4) + 4) : source
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            vault: { type: 'string', default: join(ROOT, '.cache', 'corpus', 'vault') },
            index: { type: 'string' },
            query: { type: 'string' }
        },
        strict: true
    })
    if (values.index !== undefined && values.query !== undefined) {
        process.stdout.write(`${String(await measureQuery(values.index, values.query))}\n`)
        return
    }
    const vault = resolvePath(values.vault)
    const output = join(ROOT, '.cache', 'search-budget')
    await rm(output, { recursive: true, force: true })
    await mkdir(output, { recursive: true })
    const entries: TitleEntry[] = []
    const counts = new Map<string, number>()
    const { index } = await pagefind.createIndex({ forceLanguage: 'en' })
    if (index === undefined) {
        throw new Error('Pagefind did not start')
    }
    for (const path of await notePaths(vault)) {
        const source = sourceOf(await readFile(join(vault, path), 'utf8'))
        const title = path.slice(path.lastIndexOf('/') + 1, -'.md'.length)
        const url = canonicalPath(path)
        entries.push({ path: url, title, aliases: aliasesOf(source).aliases, type: 'Note' })
        const body = bodyOf(source)
        for (const word of new Set(foldedWords(body))) {
            if (/^\p{L}{4,}$/u.test(word)) counts.set(word, (counts.get(word) ?? 0) + 1)
        }
        await index.addCustomRecord({
            url,
            content: `${title}. ${body}`,
            language: 'en',
            meta: { title }
        })
    }
    await index.writeFiles({ outputPath: join(output, 'pagefind') })
    await pagefind.close()

    const titles = titleIndexOf(entries)
    const keys = brotliSize(new TextEncoder().encode(JSON.stringify({ v: 1, keys: titles.keys })))
    const partSize = new Map(
        [...titles.parts].map(([key, rows]) => [
            key,
            brotliSize(new TextEncoder().encode(JSON.stringify(rows)))
        ])
    )
    const frequent = [...counts]
        .sort((one, two) => two[1] - one[1])
        .slice(0, WORDS)
        .map(([word]) => word)
    const queries = [
        ...frequent,
        ...frequent.slice(0, WORDS / 2).map((word, index) => `${word} ${frequent[index + 1] ?? ''}`)
    ]
    const totals: number[] = []
    for (const query of queries) {
        const child = Bun.spawn(
            [
                'bun',
                fileURLToPath(import.meta.url),
                '--index',
                join(output, 'pagefind'),
                '--query',
                query
            ],
            { stdout: 'pipe', stderr: 'inherit' }
        )
        const fullText = Number((await new Response(child.stdout).text()).trim())
        if ((await child.exited) !== 0 || !Number.isFinite(fullText)) {
            throw new Error('a measure of a query failed')
        }
        const part = partOf(query, titles.keys)
        totals.push(keys + (part === undefined ? 0 : (partSize.get(part.key) ?? 0)) + fullText)
    }
    const largestPart = Math.max(...partSize.values())
    const worst = Math.max(...totals)
    process.stdout.write(
        `${JSON.stringify(
            {
                notes: entries.length,
                titleParts: titles.parts.size,
                titleKeysBrotli: keys,
                largestTitlePartBrotli: largestPart,
                queries: queries.length,
                firstSearchMedian: [...totals].sort((one, two) => one - two)[
                    Math.floor(totals.length / 2)
                ],
                firstSearchWorst: worst,
                budget: FIRST_SEARCH_BROTLI
            },
            null,
            2
        )}\n`
    )
    await rm(output, { recursive: true, force: true })
    if (worst > FIRST_SEARCH_BROTLI) {
        throw new Error(
            `a first search loads ${String(worst)} bytes, the budget is ${String(FIRST_SEARCH_BROTLI)} (R57)`
        )
    }
}

await main()
