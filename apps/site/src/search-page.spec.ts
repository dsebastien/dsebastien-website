import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { select, selectAll } from 'hast-util-select'
import { toText } from 'hast-util-to-text'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
    FIXTURE_NOTE_TYPES,
    FIXTURE_VAULT,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { canonicalPath, resolve, type ResolverMap } from '@dsebastien-website/resolver'
import { fileMainSite, fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../../plugin/src/publishing/tool.ts'
import { brotliSize, FIRST_PALETTE_BROTLI, PAGE_BUDGET } from './budgets.ts'
import { createSearch } from './search/engine.ts'
import { pagefindEngine } from './search/full-text.ts'
import { foldedWords, partFile, type TitleRow } from './search/titles.ts'
import { startServer } from '../server/serve.ts'

// The search on the built site (issue 51, SRCH-01, SRCH-02, decision R63):
// the search page, the links and the forms that lead to it, the title index
// and the full-text index. The tool publishes the fixture vault but one note,
// the site is built, and the tests read the output and search its indexes
// with the code of the page. Only published notes are in an index.
const SITE = fileURLToPath(new URL('..', import.meta.url))

/** The note that the author did not select: it stays in the vault. */
const NOT_SELECTED = '10 Garden/Winter plan (draft).md'
/** The notes that a guard keeps in the vault (the deny list, `publish_ignore`). */
const GUARDED = [
    '10 Garden/Neighbour dispute.md',
    '90 Locked Shed/Greenhouse alarm code.md',
    '90 Locked Shed/Shed inventory.md'
]
const BARREL = '10 Garden/Rain barrel.md'
const FILM = '20 Library/20.01 Films/The Lantern Keeper (2019).md'
/** The note with `publish_noindex: true` (IDX-20). */
const NOINDEX = '10 Garden/Seed swap draft.md'
/** The notes of the noindex folder of the configuration (R103). */
const NOINDEX_FOLDER = '20 Library/20.01 Films'
const IN_NOINDEX_FOLDER = [FILM, '20 Library/20.01 Films/The Quiet Orchard (2021).md']
/** A noindex folder that covers no note: a part of a folder name is no folder (R103). */
const UNUSED_FOLDER = '20 Library/20.0'
/** A noindex folder in another letter case: the warning names the folder that it means. */
const OTHER_CASE_FOLDER = '20 library/20.04 BOOKS'
/** The notes that also exist on the main site: it answers for none, so none has a verified original (IDX-13). */
const NOT_VERIFIED = [
    '40 Writing/Garden news, week 12.md',
    '40 Writing/Le potager en hiver.md',
    '40 Writing/Letters/Garden letter 1 (Newsletter).md',
    '40 Writing/Letters/Garden letter 2 (Newsletter).md',
    '40 Writing/The vegetable garden in winter.md',
    '40 Writing/Why I keep a garden journal.md'
]

let stores: TestStores | undefined
let outDir: string | undefined
let exitCode = -1
/** The error output of the build. */
let buildErrors = ''
let map: ResolverMap | undefined
/** The vault paths of the published notes. */
const published = new Set<string>()
/** The notes of the publication whose original is not verified. */
let notVerified: string[] = []

function built(): { dir: string; map: ResolverMap } {
    if (outDir === undefined || map === undefined) {
        throw new Error('the site was not built')
    }
    return { dir: outDir, map }
}

/** The page that the resolver serves for a path of the site. */
async function served(path: string): Promise<Root> {
    const { dir, map: resolver } = built()
    const resolution = resolve(path, resolver)
    if (resolution.kind !== 'page' && resolution.kind !== 'not-found') {
        throw new Error(`"${path}" is no page: ${resolution.kind}`)
    }
    if (resolution.file === undefined) {
        throw new Error(`"${path}" has no file`)
    }
    return fromHtml(await readFile(join(dir, resolution.file), 'utf8'))
}

/** A file of the output, as JSON. */
async function json(file: string): Promise<unknown> {
    return JSON.parse(await readFile(join(built().dir, file), 'utf8')) as unknown
}

/** The search of the page, over the files of the output. */
function searchOfOutput(): ReturnType<typeof createSearch> {
    const dir = built().dir
    return createSearch({
        keys: async () => {
            const index = (await json('-/search/titles.json')) as { keys: Record<string, boolean> }
            return index.keys
        },
        part: async (key) => (await json(`-/search/titles/${partFile(key)}.json`)) as TitleRow[],
        fullText: pagefindEngine(pathToFileURL(join(dir, '-', 'search', 'pagefind')).href + '/')
    })
}

/** The answer of the server to a request line sent as it is, with no URL parser between. */
async function rawGet(base: string, path: string): Promise<string> {
    const { hostname, port } = new URL(base)
    return new Promise((resolveAnswer, reject) => {
        let answer = ''
        const socket = connect({ host: hostname, port: Number(port) }, () => {
            socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`)
        })
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => {
            answer += chunk
        })
        socket.on('end', () => {
            resolveAnswer(answer)
        })
        socket.on('error', reject)
    })
}

/** The words of the notes that stay in the vault and of no published note. */
async function wordsOfNotesInTheVault(): Promise<string[]> {
    const publishedWords = new Set<string>()
    for (const path of published) {
        for (const word of foldedWords(await readFile(join(FIXTURE_VAULT, path), 'utf8'))) {
            publishedWords.add(word)
        }
    }
    const words = new Set<string>()
    for (const path of [NOT_SELECTED, ...GUARDED]) {
        for (const word of foldedWords(await readFile(join(FIXTURE_VAULT, path), 'utf8'))) {
            if (!publishedWords.has(word) && /^\p{L}{4,}$/u.test(word)) words.add(word)
        }
    }
    return [...words]
}

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const contentStore = await makeContentStoreCopy(stores)
    // The main site of the test answers for no post: the check of the
    // originals opens no connection, and its result is the same on each machine.
    const posts = join(stores.root, 'main-site.json')
    await writeFile(posts, JSON.stringify({ answers: {} }))
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage,
        mainSite: fileMainSite(posts)
    })
    const queue = await status(device)
    const include = queue.new.filter((path) => path !== NOT_SELECTED)
    for (const path of include) published.add(path)
    const planned = await plan(device, { include })
    const run = await publish(device, planned.id, {
        time: '2031-05-01T00:00:00Z',
        device: 'garden-shed',
        face: 'command-line'
    })
    notVerified = run.originalsNotVerified.map((entry) => entry.path)
    // The author adds the noindex folders by hand (R103): the build reads them.
    const configuration = JSON.parse(
        await readFile(join(contentStore, 'configuration.json'), 'utf8')
    ) as Record<string, unknown>
    await writeFile(
        join(contentStore, 'configuration.json'),
        JSON.stringify({
            ...configuration,
            noindexFolders: [NOINDEX_FOLDER, UNUSED_FOLDER, OTHER_CASE_FOLDER]
        })
    )
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'search-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'pipe'
    })
    buildErrors = await new Response(child.stderr).text()
    process.stderr.write(buildErrors)
    exitCode = await child.exited
    if (exitCode !== 0) return
    map = JSON.parse(await readFile(join(outDir, '-', 'resolver-map.json'), 'utf8')) as ResolverMap
}, 300_000)

afterAll(async () => {
    // Remove only the folders that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

describe('build of the fixture vault with the search', () => {
    test('completes, and the vault holds notes that are not published', () => {
        expect(exitCode).toBe(0)
        expect(published.has(NOT_SELECTED)).toBe(false)
        for (const path of GUARDED) expect(published.has(path)).toBe(false)
    })
})

describe('the search page (SRCH-01)', () => {
    test('is under the reserved prefix, with its title, and search engines do not index it', async () => {
        const page = await served('/-/search')
        expect(toText(select('title', page) ?? page)).toBe('Search · Sébastien’s Notes')
        expect(select('meta[name="robots"]', page)?.properties['content']).toBe('noindex, follow')
        expect(select('h1', page)).toBeDefined()
    })

    test('has a search field that works with the query of its address', async () => {
        const page = await served('/-/search')
        const form = select('form[role="search"]', page)
        expect(form?.properties['action']).toBe('/-/search')
        const field = select('input[type="search"][name="q"]', form ?? page)
        expect(field).toBeDefined()
        // The field has a label.
        const id = field?.properties['id'] ?? ''
        expect(select(`label[for="${id}"]`, page)).toBeDefined()
        // The counts show in a line that is no live region, and a hidden polite
        // live region says them, so a reader hears each count one time.
        expect(select('[data-search-status]', page)?.properties['ariaLive']).toBeUndefined()
        const announcer = select('[data-search-announce][aria-live="polite"]', page)
        expect(announcer?.properties['className']).toContain('sr-only')
    })

    test('loads its own script and the loader of the palette only, within the script budget of a page', async () => {
        const { dir } = built()
        const page = await served('/-/search')
        const scripts = selectAll('script[src]', page).map((script) =>
            String(script.properties['src'])
        )
        expect(scripts).toHaveLength(2)
        expect(scripts.filter((src) => src.includes('PaletteLoader'))).toHaveLength(1)
        let bytes = 0
        for (const src of scripts) {
            bytes += brotliSize(await readFile(join(dir, src)))
        }
        expect(bytes).toBeLessThanOrEqual(PAGE_BUDGET.scriptBrotli)
    })
})

describe('the ways to the search page', () => {
    test('the header of every page links to it', async () => {
        for (const path of ['/', canonicalPath(BARREL), '/-/search', '/no/such/page']) {
            const page = await served(path)
            expect(select('header a[href="/-/search"]', page), path).toBeDefined()
        }
    })

    test('the link of the header does not move when the switch of the mode shows (CLS, R57)', async () => {
        // The switch is hidden until its script runs at the end of the page:
        // nothing may stand after it in the row that it widens.
        const page = await served(canonicalPath(BARREL))
        const link = select('header [data-search-link]', page)
        const row = selectAll('header div', page).find((element) =>
            element.children.some((child) => child === link)
        )
        const items = (row?.children ?? []).filter((child) => child.type === 'element')
        // The switch of the theme (DES-10) is hidden in the same way, before it.
        expect(items.map((item) => item.tagName)).toEqual(['select', 'button', 'a'])
        expect(select('header [data-design-switch]', page)?.properties['hidden']).toBe(true)
        expect(select('header [data-mode-switch]', page)?.properties['hidden']).toBe(true)
    })

    test('the style sheet keeps the space of the scroll bar from the first paint (CLS, R57)', async () => {
        const page = await served(canonicalPath(BARREL))
        const sheet = String(select('link[rel="stylesheet"]', page)?.properties['href'])
        const css = await readFile(join(built().dir, sheet), 'utf8')
        expect(css).toMatch(/html\{[^}]*scrollbar-gutter:stable/u)
    })

    test('the home page and the "not found" page have a search form that opens it', async () => {
        for (const path of ['/', '/no/such/page']) {
            const form = select('main form[role="search"]', await served(path))
            expect(form?.properties['action'], path).toBe('/-/search')
            expect(form?.properties['method'], path).toBe('get')
            expect(select('input[name="q"]', form ?? fromHtml('')), path).toBeDefined()
        }
    })

    test('only the form of the home page opens the palette, and it stays a plain form (R101)', async () => {
        const home = select('main form[role="search"]', await served('/'))
        expect(home?.properties['dataPaletteForm']).toBe('')
        // With no script: a GET of the search page with `q`, a label, a submit button.
        expect(home?.properties['action']).toBe('/-/search')
        expect(home?.properties['method']).toBe('get')
        const field = select('input[type="search"][name="q"]', home ?? fromHtml(''))
        expect(
            select(`label[for="${String(field?.properties['id'])}"]`, home ?? fromHtml(''))
        ).toBeDefined()
        expect(select('button[type="submit"]', home ?? fromHtml(''))).toBeDefined()
        const notFound = select('main form[role="search"]', await served('/no/such/page'))
        expect(notFound?.properties['dataPaletteForm']).toBeUndefined()
    })

    test('the "not found" page fills its field with the words of the missing address', async () => {
        const page = await served('/no/such/page')
        expect(select('#not-found-search', page)?.properties['value']).toBeUndefined()
        // The raw text of the script: a text of the page folds its line ends.
        const scripts = selectAll('main script:not([src])', page).map((script) =>
            script.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
        )
        expect(scripts).toHaveLength(1)
        // The script of the page, run alone with a field and an address.
        const field = { value: '' }
        const run = (document: unknown, location: unknown): void => {
            runInNewContext(scripts[0] ?? '', { document, location })
        }
        run(
            { getElementById: (id: string) => (id === 'not-found-search' ? field : null) },
            { pathname: '/10+Garden/Compost+basics.md' }
        )
        expect(field.value).toBe('Compost basics')
        // A query of the reader stays.
        field.value = 'tomato'
        run({ getElementById: () => field }, { pathname: '/x' })
        expect(field.value).toBe('tomato')
    })

    test('a note page loads nothing of the search (R57)', async () => {
        const { dir } = built()
        const page = await served(canonicalPath(BARREL))
        const loads = [
            ...selectAll('script[src]', page).map((element) => element.properties['src']),
            ...selectAll('link[href]', page).map((element) => element.properties['href'])
        ].map(String)
        expect(loads.filter((url) => url.includes('search') || url.includes('pagefind'))).toEqual(
            []
        )
        // Nor does any script of the page name the search, inline or in a file of a shared name.
        const texts = selectAll('script:not([src])', page).map((script) => toText(script))
        for (const src of selectAll('script[src]', page).map((script) =>
            String(script.properties['src'])
        )) {
            texts.push(await readFile(join(dir, src), 'utf8'))
        }
        for (const text of texts) {
            expect(text).not.toContain('pagefind')
            expect(text).not.toContain('data-search')
            expect(text).not.toContain('/-/search')
        }
    })
})

/** The files that a module file imports with a static import: they load with it. */
function staticImports(code: string): string[] {
    return [...code.matchAll(/\b(?:from|import)\s*"\.\/([^"]+\.js)"/gu)].map(
        ([, file = '']) => file
    )
}

// The command palette (issue 122, SRCH-05 to SRCH-08, R93): a page holds its
// loader only; the palette, its style and the code of the search load at the
// first opening, within their budget, and the indexes after.
describe('the command palette', () => {
    test('a note page loads its loader alone, with a link to the search page for a reader with no script', async () => {
        const { dir } = built()
        const page = await served(canonicalPath(BARREL))
        const control = select('header a[data-palette]', page)
        expect(control?.properties['href']).toBe('/-/search')
        const loaders = selectAll('script[src]', page)
            .map((script) => String(script.properties['src']))
            .filter((src) => src.includes('PaletteLoader'))
        expect(loaders).toHaveLength(1)
        const loader = await readFile(join(dir, loaders[0] ?? ''), 'utf8')
        // What loads with the loader holds nothing of the palette or of the search.
        for (const file of staticImports(loader)) {
            const code = await readFile(join(dir, '_astro', file), 'utf8')
            expect(code, file).not.toContain('combobox')
            expect(code, file).not.toContain('pagefind')
        }
        expect(loader).not.toContain('combobox')
        expect(brotliSize(new TextEncoder().encode(loader))).toBeLessThan(1_500)
    })

    test('loads at its first opening, within its budget, and the indexes only after', async () => {
        const { dir } = built()
        const page = await served(canonicalPath(BARREL))
        const src = selectAll('script[src]', page)
            .map((script) => String(script.properties['src']))
            .find((file) => file.includes('PaletteLoader'))
        const loader = await readFile(join(dir, src ?? ''), 'utf8')
        // The files of the dynamic import, as the build lists them for the first opening.
        const listed = /m\.f=\[([^\]]*)\]/u.exec(loader)?.[1] ?? ''
        const withPage = new Set(staticImports(loader).map((file) => `_astro/${file}`))
        const files = [...listed.matchAll(/"([^"]+)"/gu)]
            .map(([, file = '']) => file)
            .filter((file) => !withPage.has(file))
        const palette = files.find((file) => file.includes('palette-bundle')) ?? ''
        // The style of the palette is in its module: no page links a style sheet of it.
        expect(files.filter((file) => file.endsWith('.css'))).toEqual([])
        expect(await readFile(join(dir, palette), 'utf8')).toContain('.palette-option')
        expect(selectAll('link[rel="stylesheet"]', page)).toHaveLength(1)
        let bytes = 0
        for (const file of files) {
            expect(file, file).not.toContain('pagefind')
            expect(file, file).not.toContain('titles')
            bytes += brotliSize(await readFile(join(dir, file)))
        }
        expect(bytes).toBeGreaterThan(2_000)
        expect(bytes).toBeLessThanOrEqual(FIRST_PALETTE_BROTLI)
    })

    test('the server error page has no loader: it runs no script (NAV-20)', async () => {
        const html = await readFile(join(built().dir, '500.html'), 'utf8')
        expect(html).not.toContain('<script')
        expect(html).toContain('href="/-/search"')
    })
})

describe('the title index (SRCH-02)', () => {
    // The random note of the palette never opens such a note (issue 122, R85):
    // a note with publish_noindex, and a note on the main site without a
    // verified original (IDX-13, R90).
    test('names the notes that search engines must not index, and no other', async () => {
        expect([...notVerified].sort()).toEqual(NOT_VERIFIED)
        const index = (await json('-/search/titles.json')) as { noindex: string[] }
        expect(index.noindex).toEqual(
            [NOINDEX, ...NOT_VERIFIED, ...IN_NOINDEX_FOLDER].map(canonicalPath).sort()
        )
    })

    test('answers with the display title, the type and an alias', async () => {
        const search = searchOfOutput()
        expect(await search.titles('lantern keep')).toEqual([
            { text: 'The Lantern Keeper (2019)', path: canonicalPath(FILM), type: 'Movie' }
        ])
        expect(await search.titles('water butt')).toEqual([
            {
                text: 'Water butt',
                path: canonicalPath(BARREL),
                type: 'Permanent note',
                aliasOf: 'Rain barrel'
            }
        ])
    })

    test('holds published notes only', async () => {
        const { dir, map: resolver } = built()
        const parts = await readdir(join(dir, '-', 'search', 'titles'))
        expect(parts.length).toBeGreaterThan(10)
        const paths = new Set<string>()
        const texts = new Set<string>()
        for (const part of parts) {
            for (const row of (await json(`-/search/titles/${part}`)) as TitleRow[]) {
                paths.add(row[1])
                texts.add(row[0])
            }
        }
        expect([...paths].sort()).toEqual([...published].map(canonicalPath).sort())
        for (const path of paths) expect(resolver.pages[path], path).toBeDefined()
        for (const text of ['Winter plan', 'Neighbour dispute', 'Shed inventory']) {
            expect(
                [...texts].some((one) => one.includes(text)),
                text
            ).toBe(false)
        }
    })
})

describe('the full-text index (SRCH-01)', () => {
    test('finds a word of the text of a note, with its display title and its type', async () => {
        const results = await searchOfOutput().fullText('gutter')
        const hits = await results.hits(0, 10)
        expect(hits.map((hit) => hit.path)).toContain(canonicalPath(BARREL))
        const barrel = hits.find((hit) => hit.path === canonicalPath(BARREL))
        expect(barrel?.title).toBe('Rain barrel')
        expect(barrel?.type).toBe('Permanent note')
        expect(barrel?.excerpt.some((part) => part.marked && /gutter/iu.test(part.text))).toBe(true)
    })

    test('holds published notes only', async () => {
        const entry = (await json('-/search/pagefind/pagefind-entry.json')) as {
            languages: Record<string, { page_count: number }>
        }
        expect(Object.values(entry.languages).map((language) => language.page_count)).toEqual([
            published.size
        ])
        // The words of the notes that stay in the vault: a result is a
        // published note with a word of the same start, never one of them.
        const words = await wordsOfNotesInTheVault()
        expect(words).toContain('spades')
        const search = searchOfOutput()
        const found = new Set<string>()
        for (const word of [...words, 'the', 'garden', 'water', 'notes']) {
            const results = await search.fullText(word)
            for (const hit of await results.hits(0, results.total)) found.add(hit.path)
        }
        const publishedPaths = new Set([...published].map(canonicalPath))
        expect(found.size).toBeGreaterThan(20)
        expect([...found].filter((path) => !publishedPaths.has(path))).toEqual([])
    })

    test('holds no file of the interface of Pagefind, which the page does not use', async () => {
        const files = await readdir(join(built().dir, '-', 'search', 'pagefind'))
        expect(files).toContain('pagefind.js')
        expect(files).toContain('pagefind-worker.js')
        expect(files.filter((file) => /-ui\.|highlight/u.test(file))).toEqual([])
    })

    test('indexes the title, the values of the properties and the text of a note page only', async () => {
        const dir = join(built().dir, '-', 'search', 'pagefind')
        const pagefind = (await import(join(dir, 'pagefind.js'))) as {
            options(options: { basePath: string; baseUrl: string }): Promise<void>
            search(query: string): Promise<{ results: { data(): Promise<unknown> }[] }>
        }
        await pagefind.options({ basePath: pathToFileURL(dir).href + '/', baseUrl: '/' })
        const { results } = await pagefind.search('gutter')
        const pages = (await Promise.all(results.map((result) => result.data()))) as {
            url: string
            content: string
        }[]
        const barrel = pages.find((page) => page.url === canonicalPath(BARREL))
        const content = barrel?.content ?? ''
        // The page shows the parts that the index leaves out.
        const page = await served(canonicalPath(BARREL))
        expect(select('[data-backlinks]', page)).toBeDefined()
        expect(select('[data-properties]', page)).toBeDefined()
        expect(content).toStartWith('Rain barrel.')
        expect(content).toContain('A barrel of 200 liters under the gutter of the shed.')
        // A value of a property: the alias.
        expect(content).toContain('Water butt')
        for (const text of [
            '#type/',
            'Notes that link here',
            'On this page',
            'Sébastien',
            'Properties',
            'Aliases',
            'Skip to'
        ]) {
            expect(content, text).not.toContain(text)
        }
    })
})

describe('the files of the search on the plain server', () => {
    test('are served with their types, and nothing else of the folder', async () => {
        const { dir } = built()
        const server = await startServer({ dist: dir, port: 0 })
        try {
            const keys = await fetch(`${server.url}/-/search/titles.json`)
            expect(keys.status).toBe(200)
            expect(keys.headers.get('content-type')).toStartWith('application/json')
            const script = await fetch(`${server.url}/-/search/pagefind/pagefind.js`)
            expect(script.status).toBe(200)
            expect(script.headers.get('content-type')).toStartWith('text/javascript')
            expect((await fetch(`${server.url}/-/search/titles/zz.json`)).status).toBe(404)
            // A folder and a way out of the folder are no files of it. The way
            // out goes as a raw request line: a URL parser would remove the dots.
            expect((await fetch(`${server.url}/-/search/titles`)).status).toBe(404)
            for (const path of [
                '/-/search/../resolver-map.json',
                '/-/search/%2E%2E/resolver-map.json',
                '/-/search/titles/..%2F..%2Fresolver-map.json'
            ]) {
                const answer = await rawGet(server.url, path)
                expect(answer.split('\r\n')[0], path).toBe('HTTP/1.1 404 Not Found')
                expect(answer, path).not.toContain('"pages"')
            }
        } finally {
            await server.stop()
        }
    })
})

// R103: a note under a noindex folder of the configuration is noindex as a
// note with publish_noindex is, and stays on the site.
describe('the noindex folders of the configuration', () => {
    test('a note under one says noindex, and stays on the site', async () => {
        for (const path of IN_NOINDEX_FOLDER) {
            const page = await served(canonicalPath(path))
            expect(select('meta[name="robots"]', page)?.properties['content']).toBe(
                'noindex, follow'
            )
        }
        const other = await served(canonicalPath(BARREL))
        expect(select('meta[name="robots"]', other)).toBeUndefined()
    })

    test('a note under one leaves the sitemaps', async () => {
        const dir = built().dir
        const files = (await readdir(dir)).filter((name) => /^sitemap-.+\.xml$/u.test(name))
        const sitemaps = (
            await Promise.all(files.map((name) => readFile(join(dir, name), 'utf8')))
        ).join(' ')
        expect(sitemaps).toContain(encodeURI(canonicalPath(BARREL)))
        for (const path of IN_NOINDEX_FOLDER) {
            expect(sitemaps).not.toContain(encodeURI(canonicalPath(path)))
        }
    })

    test('the build warns about a folder that covers no published note', () => {
        expect(buildErrors).toContain(`"${UNUSED_FOLDER}" of configuration.json`)
        expect(buildErrors).toContain(
            `"${OTHER_CASE_FOLDER}" of configuration.json covers no published note: did you mean "20 Library/20.04 Books"?`
        )
        expect(buildErrors).not.toContain(`"${NOINDEX_FOLDER}" of configuration.json`)
    })
})
