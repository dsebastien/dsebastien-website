import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { canonicalPath } from '@dsebastien-website/resolver'
import * as pagefind from 'pagefind'
import { sourceOf } from '../apps/plugin/src/publishing/clean.ts'
import { aliasesOf } from '../apps/plugin/src/publishing/frontmatter.ts'
import { brotliSize, FIRST_SEARCH_BROTLI } from '../apps/site/src/budgets.ts'
import { createSearch } from '../apps/site/src/search/engine.ts'
import { pagefindEngine } from '../apps/site/src/search/full-text.ts'
import { createSession, type SearchView } from '../apps/site/src/search/session.ts'
import {
    foldedWords,
    partFile,
    titleIndexOf,
    type TitleEntry,
    type TitleRow
} from '../apps/site/src/search/titles.ts'

/** The file of the keys of the title index. */
interface TitleKeys {
    keys: Record<string, boolean>
}

// The budget of the first search at full size (issue 51, R57, PERF-21): the
// title index and the full-text index of a vault, as if every note of it were
// published, and the bytes that a first search loads for the most frequent
// words of the vault and for pairs of them. The measure runs the code of the
// search page (`createSearch`, `createSession`) over the files of the indexes
// and counts what it reads. One search (the budget, as the author decided in
// R63): the reader types the query, the titles answer at each key, and the
// full text answers the query. A typing session (reported, not a gate): the
// reader stops after each letter, so each prefix runs the full text too.
// Each measure runs in a process of its own, as a reader who searches for
// the first time.
//
//   bun run budgets:search [--vault <folder>]
//
// The default vault is the invented corpus of `bun run corpus`. The script
// prints numbers only, never a word or a name of a note: it can run on the
// export of the published notes of the author (`.cache/published/vault`),
// whose numbers stay out of this repository. It stops with an error when one
// search is above the budget.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The most frequent words that the measure searches for, then pairs of them. */
const WORDS = 12

/** The bytes of a file on the wire: as it is when it is compressed already, else with Brotli. */
function wireSize(bytes: Uint8Array): number {
    const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b
    return gzip ? bytes.byteLength : brotliSize(bytes)
}

/** A promise and the function that settles it. */
function signal(): { done: Promise<void>; fire(): void } {
    let fire: () => void = () => undefined
    const done = new Promise<void>((resolveSignal) => {
        fire = resolveSignal
    })
    return { done, fire }
}

/**
 * The bytes that the search page loads for a query, in a process of its own:
 * the reader types it letter by letter, and the full text answers the query
 * alone, or each prefix of it when the reader stops after each letter.
 */
async function measureQuery(folder: string, query: string, typing: boolean): Promise<number> {
    let bytes = 0
    const fetchFile = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const answer = await fetchFile(input, init)
        bytes += wireSize(new Uint8Array(await answer.clone().arrayBuffer()))
        return answer
    }) as typeof fetch
    const read = async (file: string): Promise<unknown> => {
        const data = await readFile(file)
        bytes += brotliSize(data)
        return JSON.parse(new TextDecoder().decode(data)) as unknown
    }
    const fullText = join(folder, 'pagefind')
    const search = createSearch({
        keys: async () => ((await read(join(folder, 'titles.json'))) as TitleKeys).keys,
        part: async (key) =>
            (await read(join(folder, 'titles', `${partFile(key)}.json`))) as TitleRow[],
        fullText: async () => {
            bytes += wireSize(await readFile(join(fullText, 'pagefind.js')))
            return pagefindEngine(`${pathToFileURL(fullText).href}/`)()
        }
    })
    let titles = signal()
    let said = signal()
    let message = ''
    const view: SearchView = {
        showTitles: () => {
            titles.fire()
        },
        showText: () => undefined,
        clearText: () => undefined,
        textPending: () => undefined,
        say: (text) => {
            message = text
            said.fire()
        },
        setQuery: () => undefined
    }
    let waiting: (() => void) | undefined
    const session = createSession(search, view, {
        set: (callback) => {
            waiting = callback
            return 1
        },
        clear: () => {
            waiting = undefined
        }
    })
    /** Runs the full text that waits for its pause, and waits for its answer. */
    const answer = async (): Promise<void> => {
        said = signal()
        const run = waiting
        waiting = undefined
        run?.()
        await said.done
        if (message.startsWith('The search could not load')) {
            throw new Error('the search failed')
        }
    }
    const letters = Array.from(query)
    for (let size = 1; size <= letters.length; size += 1) {
        const typed = letters.slice(0, size).join('')
        titles = signal()
        session.type(typed)
        await titles.done
        if (typing && waiting !== undefined) await answer()
    }
    if (!typing) await answer()
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
            folder: { type: 'string' },
            query: { type: 'string' },
            typing: { type: 'boolean', default: false }
        },
        strict: true
    })
    if (values.folder !== undefined && values.query !== undefined) {
        process.stdout.write(
            `${String(await measureQuery(values.folder, values.query, values.typing))}\n`
        )
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
            // The type label of a real note page goes into each fragment too.
            meta: { title, type: 'Permanent note' }
        })
    }
    await index.writeFiles({ outputPath: join(output, 'pagefind') })
    await pagefind.close()

    // The files of the title index, as the build writes them.
    const titles = titleIndexOf(entries)
    const keysText = JSON.stringify({ v: 1, keys: titles.keys })
    await writeFile(join(output, 'titles.json'), keysText)
    await mkdir(join(output, 'titles'))
    const partSize: number[] = []
    for (const [key, rows] of titles.parts) {
        const text = JSON.stringify(rows)
        await writeFile(join(output, 'titles', `${partFile(key)}.json`), text)
        partSize.push(brotliSize(new TextEncoder().encode(text)))
    }
    const frequent = [...counts]
        .sort((one, two) => two[1] - one[1])
        .slice(0, WORDS)
        .map(([word]) => word)
    const queries = [
        ...frequent,
        ...frequent.slice(0, WORDS / 2).map((word, index) => `${word} ${frequent[index + 1] ?? ''}`)
    ]
    const measure = async (query: string, typing: boolean): Promise<number> => {
        const child = Bun.spawn(
            [
                'bun',
                fileURLToPath(import.meta.url),
                '--folder',
                output,
                '--query',
                query,
                ...(typing ? ['--typing'] : [])
            ],
            { stdout: 'pipe', stderr: 'inherit' }
        )
        const bytes = Number((await new Response(child.stdout).text()).trim())
        if ((await child.exited) !== 0 || !Number.isFinite(bytes)) {
            throw new Error('a measure of a query failed')
        }
        return bytes
    }
    const searches: number[] = []
    const sessions: number[] = []
    for (const query of queries) {
        searches.push(await measure(query, false))
        sessions.push(await measure(query, true))
    }
    const ordered = (values: number[]): number[] => [...values].sort((one, two) => one - two)
    const median = (values: number[]): number => ordered(values)[Math.floor(values.length / 2)] ?? 0
    const worst = Math.max(...searches)
    process.stdout.write(
        `${JSON.stringify(
            {
                notes: entries.length,
                titleParts: titles.parts.size,
                titleKeysBrotli: brotliSize(new TextEncoder().encode(keysText)),
                largestTitlePartBrotli: Math.max(...partSize),
                queries: queries.length,
                firstSearchMedian: median(searches),
                firstSearchWorst: worst,
                budget: FIRST_SEARCH_BROTLI,
                typingSessionMedian: median(sessions),
                typingSessionWorst: Math.max(...sessions),
                typingSessionsAboveBudget: sessions.filter((bytes) => bytes > FIRST_SEARCH_BROTLI)
                    .length
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
