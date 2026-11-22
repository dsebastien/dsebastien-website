import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath, folderPath } from '@dsebastien-website/resolver'
import {
    FIXTURE_NOTE_TYPES,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'

// The URL table of the site over HTTP (issue 43, SEAM-04 of the spec): the
// publishing tool publishes the notes of the table from a copy of the fixture
// vault, the site is built from that content store, and the plain local
// server answers each request of the table. The resolver alone runs the same
// table (`packages/resolver/src/table.spec.ts`).
const SITE = fileURLToPath(new URL('..', import.meta.url))
const TABLE = fileURLToPath(new URL('../../../fixtures/urls.json', import.meta.url))
const ORIGIN = 'https://notes.dsebastien.net'

interface Case {
    name: string
    request: string
    status: number
    page?: string
    canonical?: string
    file?: string
    location?: string
    cacheControl?: string
    suggestions?: string[]
    accept?: string
    format?: 'html' | 'markdown'
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const table = (await Bun.file(TABLE).json()) as {
    notes: Note[]
    removed: Note[]
    cases: Case[]
}

/** A note of the table: a note with former paths was published at the first one. */
interface Note {
    path: string
    aliases: string[]
    formerPaths?: string[]
}

let stores: TestStores | undefined
let contentStore: string | undefined
let outDir: string | undefined
let server: Server | undefined
let exitCode = -1

function serverUrl(): string {
    if (server === undefined) {
        throw new Error('the server does not run')
    }
    return server.url
}

function store(): string {
    if (contentStore === undefined) {
        throw new Error('the content store does not exist')
    }
    return contentStore
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return await fetch(`${serverUrl()}${path}`, { redirect: 'manual', headers })
}

/** The canonical link of a page: `<link rel="canonical" href="...">`. */
function canonicalLinkOf(html: string): string | undefined {
    return /<link rel="canonical" href="([^"]*)"/u.exec(html)?.[1]
}

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const removed = table.removed.map((note) => note.path)
    // A note with former paths is published at its first one, then moved by
    // a line of a rename journal, as the plugin writes it (R66).
    const moved = [...table.notes, ...table.removed].flatMap((note) => {
        const [former] = note.formerPaths ?? []
        return former === undefined ? [] : [{ from: former, to: note.path }]
    })
    const move = async (from: string, to: string): Promise<void> => {
        await mkdir(dirname(join(vault, to)), { recursive: true })
        await rename(join(vault, from), join(vault, to))
    }
    for (const { from, to } of moved) {
        await move(to, from)
    }
    const first = (note: Note): string => note.formerPaths?.[0] ?? note.path
    const planned = await plan(device, {
        include: [...table.notes.map(first), ...table.removed.map(first)]
    })
    await publish(device, planned.id, {
        time: '2031-04-01T08:00:00Z',
        device: 'garden-shed',
        face: 'plugin'
    })
    const journals = join(vault, '.obsidian', 'plugins', 'dsebastien-vault-publish', 'renames')
    await mkdir(journals, { recursive: true })
    for (const { from, to } of moved) {
        await move(from, to)
    }
    await writeFile(
        join(journals, '00000000000000ab.jsonl'),
        moved
            .map(({ from, to }) =>
                JSON.stringify({ from, kind: 'note', time: '2031-04-01T09:00:00Z', to })
            )
            .map((line) => `${line}\n`)
            .join('')
    )
    // The notes of `removed` are unpublished by a second publication (URL-27),
    // which also applies the moves.
    const unpublish = await plan(device, { include: [], remove: removed })
    await publish(device, unpublish.id, {
        time: '2031-04-02T08:00:00Z',
        device: 'garden-shed',
        face: 'plugin'
    })
    // The output folder is inside the site, in a folder that git ignores: Astro
    // moves files into it, and a move to another file system fails.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'urls-page-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'ignore'
    })
    exitCode = await child.exited
    if (exitCode === 0) {
        server = await startServer({ dist: outDir, port: 0 })
    }
}, 180_000)

afterAll(async () => {
    await server?.stop()
    // Remove only the folders that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

describe('site of the URL table', () => {
    test('is built', () => {
        expect(exitCode).toBe(0)
    })

    // The aliases of the table are the ones that the tool reads from the
    // fixture vault: the table cannot drift from the notes.
    test('has the aliases of the table in its manifest', async () => {
        const folder = join(store(), 'manifest')
        const entries = await Promise.all(
            (await readdir(folder)).map(
                async (file) =>
                    JSON.parse(await readFile(join(folder, file), 'utf8')) as {
                        path: string
                        aliases: string[]
                        state: string
                    }
            )
        )
        const aliasesOf = (state: string): Record<string, string[]> =>
            Object.fromEntries(
                entries
                    .filter((entry) => entry.state === state)
                    .map((entry) => [entry.path, entry.aliases])
            )
        expect(aliasesOf('published')).toEqual(
            Object.fromEntries(table.notes.map((note) => [note.path, note.aliases]))
        )
        expect(aliasesOf('unpublished')).toEqual(
            Object.fromEntries(table.removed.map((note) => [note.path, note.aliases]))
        )
    })

    // The moves of the journal gave the former paths of the table (R66).
    test('has the former paths of the table in its manifest', async () => {
        const folder = join(store(), 'manifest')
        const entries = await Promise.all(
            (await readdir(folder)).map(
                async (file) =>
                    JSON.parse(await readFile(join(folder, file), 'utf8')) as {
                        path: string
                        formerPaths: string[]
                    }
            )
        )
        expect(
            Object.fromEntries(
                entries
                    .filter((entry) => entry.formerPaths.length > 0)
                    .map((entry) => [entry.path, entry.formerPaths])
            )
        ).toEqual(
            Object.fromEntries(
                [...table.notes, ...table.removed]
                    .map((note) => [note.path, note.formerPaths ?? []] as const)
                    .filter(([, formerPaths]) => formerPaths.length > 0)
            )
        )
    })
})

describe('URL table over HTTP', () => {
    test.each(table.cases.map((entry) => [entry.name, entry] as const))(
        '%s',
        async (_name, entry) => {
            const response = await get(
                entry.request,
                entry.accept === undefined ? {} : { accept: entry.accept }
            )
            expect(response.status).toBe(entry.status)
            if (entry.location !== undefined) {
                expect(response.headers.get('location')).toBe(entry.location)
                expect(response.headers.get('cache-control')).toBe(entry.cacheControl ?? '')
                // URL-05: the target is a page, reached in one hop, with a
                // clean canonical link.
                const target = await get(entry.location)
                expect(target.status).toBe(200)
                // The Markdown of a note has no canonical link.
                if (!entry.location.startsWith('/-/md/')) {
                    expect(canonicalLinkOf(await target.text())).toBe(
                        `${ORIGIN}${entry.location.split('?')[0] ?? ''}`
                    )
                }
                return
            }
            const body = await response.text()
            if (entry.status === 404 || entry.status === 410) {
                // An error answer is never kept, and its form follows the
                // header or the path (NAV-21).
                expect(response.headers.get('cache-control')).toBe('no-store')
                expect(response.headers.get('vary')).toBe('Accept')
                if (entry.format === 'markdown') {
                    expect(response.headers.get('content-type')).toBe(
                        'text/markdown; charset=utf-8'
                    )
                    expect(body).toStartWith(
                        entry.status === 410 ? '# Removed\n\n' : '# Not found\n\n'
                    )
                    for (const path of entry.suggestions ?? []) {
                        expect(body).toContain(`- ${path}\n`)
                    }
                    return
                }
                expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
                expect(body).toContain(
                    entry.status === 410 ? '>This note was removed</h1>' : '>Not found</h1>'
                )
                for (const path of entry.suggestions ?? []) {
                    expect(body).toContain(`href="${path}"`)
                }
                // The gone page shows nothing of the removed note (NAV-19).
                for (const note of table.removed) {
                    for (const text of [note.path, ...note.aliases]) {
                        const name = text.replace(/\.md$/u, '').split('/').at(-1) ?? ''
                        expect(body).not.toContain(name)
                        expect(body).not.toContain(canonicalPath(note.path))
                    }
                }
                return
            }
            if (entry.file !== undefined) {
                const [kind = '', path = ''] = entry.file.split(/:(.*)/su)
                if (kind === 'markdown') {
                    expect(response.headers.get('content-type')).toBe(
                        'text/markdown; charset=utf-8'
                    )
                    expect(body).toBe(await readFile(join(store(), 'notes', path), 'utf8'))
                } else {
                    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
                    expect(body).toContain('User-agent: *')
                }
                return
            }
            expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
            // A query gives the same page, with a clean canonical link (URL-12).
            expect(canonicalLinkOf(body)).toBe(`${ORIGIN}${entry.canonical ?? ''}`)
        }
    )
})

// Nothing of a removed note reaches the output of the build (NAV-19, R64):
// no title, no path, in no page, no file and no index. The note "Bean
// trellis" has no backlink, so no other note names it either (a link to an
// unpublished note shows its text, by rule 5 of the business rules).
describe('output of the build after an unpublication', () => {
    test('holds no name of a removed note that no note links to', async () => {
        const folder = outDir ?? ''
        const files = (await readdir(folder, { recursive: true, withFileTypes: true })).filter(
            (entry) => entry.isFile()
        )
        expect(files.length).toBeGreaterThan(20)
        const forms = ['Bean trellis', 'Bean+trellis', 'Bean%20trellis', 'bean trellis']
        const found: string[] = []
        for (const entry of files) {
            const bytes = await readFile(join(entry.parentPath, entry.name))
            const text = bytes.toString('utf8').toLowerCase()
            for (const form of forms) {
                if (text.includes(form.toLowerCase())) {
                    found.push(`${entry.name}: ${form}`)
                }
            }
        }
        expect(found).toEqual([])
    })
})

describe('plain local server', () => {
    // URL-18: an unchanged page or Markdown answers 304 to a conditional request.
    test.each([
        ['a page', '/Welcome'],
        ['the Markdown of a note', '/-/md/Welcome.md']
    ])('answers 304 for %s that did not change', async (_name, path) => {
        const first = await get(path)
        const tag = first.headers.get('etag')
        expect(tag).not.toBeNull()
        const second = await get(path, { 'if-none-match': tag ?? '' })
        expect(second.status).toBe(304)
        expect(await second.text()).toBe('')
        const other = await get(path, { 'if-none-match': '"another"' })
        expect(other.status).toBe(200)
    })

    test('lists the notes and the folders of a folder without a folder note', async () => {
        const html = await (await get('/10+Garden')).text()
        expect(html).toContain(`href="${canonicalPath('10 Garden/Compost basics.md')}"`)
        // A folder with a folder note leads to that note.
        expect(html).toContain(`href="${canonicalPath('10 Garden/Herb bed/Herb bed.md')}"`)
        // A note inside a folder below is not listed here.
        expect(html).not.toContain(`href="${canonicalPath('10 Garden/Herb bed/Mint.md')}"`)
    })

    test('lists a folder below in the list of its parent', async () => {
        const html = await (await get('/20+Library')).text()
        expect(html).toContain(`href="${folderPath('20 Library/20.02 Recipes')}"`)
        expect(html).toContain(`href="${canonicalPath('20 Library/Sprout.js.md')}"`)
    })

    test('keeps no answer for a path that no note has', async () => {
        const response = await get('/Nothing+here')
        expect(response.headers.get('cache-control')).toBe('no-store')
    })
})

// URL-33: a file that the resolver map names and that the output of the build
// does not have is a failure of the release, never "not found". The answer
// names no file and no folder (NAV-20). It runs last: it removes files of the
// build.
describe('plain local server with a broken release', () => {
    function output(): string {
        if (outDir === undefined) {
            throw new Error('the output folder does not exist')
        }
        return outDir
    }

    let serverErrorPage = ''

    // The page as the build wrote it, read before a test removes a file.
    beforeAll(async () => {
        serverErrorPage = await readFile(join(output(), '500.html'), 'utf8')
    })

    // The server error page, or its short text for an agent (NAV-20, NAV-21).
    // An agent that asks for the Markdown of an error answer gets the text of
    // that answer: it needs no page of the release.
    async function expectServerError(
        path: string,
        agentStatus: 404 | 410 | 500 = 500
    ): Promise<void> {
        const response = await get(path)
        expect(response.status, path).toBe(500)
        expect(response.headers.get('cache-control'), path).toBe('no-store')
        expect(response.headers.get('vary'), path).toBe('Accept')
        expect(response.headers.get('content-type'), path).toBe('text/html; charset=utf-8')
        const html = await response.text()
        expect(html, path).toBe(serverErrorPage)
        expect(html, path).toContain('>Server error</h1>')
        const agent = await get(path, { accept: 'text/markdown' })
        expect(agent.status, path).toBe(agentStatus)
        expect(agent.headers.get('content-type'), path).toBe('text/markdown; charset=utf-8')
        const first = { 404: '# Not found\n', 410: '# Removed\n', 500: '# Server error\n' }
        expect(await agent.text(), path).toStartWith(first[agentStatus])
    }

    test('answers 500 when a file of the map is missing', async () => {
        await rm(join(output(), 'robots.txt'))
        await expectServerError('/robots.txt')
    })

    test('answers 500 when a page, the "not found" page or a page of choices is missing', async () => {
        // The build output is test data of this test: the cast is the boundary.
        const map = (await Bun.file(join(output(), '-', 'resolver-map.json')).json()) as {
            pages: Record<string, string>
            choices: Record<string, string>
            notFound: string
            gone: { file: string }
        }
        const choices = table.cases.find((entry) => entry.name === 'an alias of two notes')
        const choice = map.choices[(choices?.suggestions ?? []).join('\n')]
        const page = map.pages['/Welcome']
        expect(choice).toBeDefined()
        expect(page).toBeDefined()
        for (const file of [page, map.notFound, choice, map.gone.file]) {
            await rm(join(output(), file ?? ''))
        }
        await expectServerError('/Welcome')
        await expectServerError('/Nothing+here', 404)
        await expectServerError(choices?.request ?? '', 404)
        await expectServerError('/10+Garden/Rain+barrel', 410)
    })

    // The server read the page at its start: a release that lost it still
    // gives it, and a page that it never had gives a short text.
    test('answers with the server error page that it read at its start', async () => {
        await rm(join(output(), '500.html'))
        await expectServerError('/Welcome')
        const without = await startServer({ dist: output(), port: 0 })
        try {
            const response = await fetch(`${without.url}/Welcome`)
            expect(response.status).toBe(500)
            expect(response.headers.get('cache-control')).toBe('no-store')
            expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
            expect(await response.text()).toStartWith('# Server error\n')
        } finally {
            await without.stop()
        }
    })

    test('answers 500 with no detail when a file that the pages load is missing', async () => {
        const [name] = await readdir(join(output(), '_astro'))
        expect(name).toBeDefined()
        await rm(join(output(), '_astro', name ?? ''))
        await expectServerError(`/_astro/${name ?? ''}`)
    })
})
