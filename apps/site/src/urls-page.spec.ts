import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
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
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const table = (await Bun.file(TABLE).json()) as {
    notes: { path: string; aliases: string[] }[]
    cases: Case[]
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
    const planned = await plan(device, { include: table.notes.map((note) => note.path) })
    await publish(device, planned.id, {
        time: '2031-04-01T08:00:00Z',
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
                    }
            )
        )
        const aliases = Object.fromEntries(entries.map((entry) => [entry.path, entry.aliases]))
        expect(aliases).toEqual(
            Object.fromEntries(table.notes.map((note) => [note.path, note.aliases]))
        )
    })
})

describe('URL table over HTTP', () => {
    test.each(table.cases.map((entry) => [entry.name, entry] as const))(
        '%s',
        async (_name, entry) => {
            const response = await get(entry.request)
            expect(response.status).toBe(entry.status)
            if (entry.location !== undefined) {
                expect(response.headers.get('location')).toBe(entry.location)
                expect(response.headers.get('cache-control')).toBe(entry.cacheControl ?? '')
                // URL-05: the target is a page, reached in one hop, with a
                // clean canonical link.
                const target = await get(entry.location)
                expect(target.status).toBe(200)
                expect(canonicalLinkOf(await target.text())).toBe(
                    `${ORIGIN}${entry.location.split('?')[0] ?? ''}`
                )
                return
            }
            const body = await response.text()
            if (entry.status === 404) {
                expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
                for (const path of entry.suggestions ?? []) {
                    expect(body).toContain(`href="${path}"`)
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

    async function expectServerError(path: string): Promise<void> {
        const response = await get(path)
        expect(response.status, path).toBe(500)
        expect(response.headers.get('cache-control'), path).toBe('no-store')
        expect(await response.text(), path).toBe('Server error\n')
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
        }
        const choices = table.cases.find((entry) => entry.name === 'an alias of two notes')
        const choice = map.choices[(choices?.suggestions ?? []).join('\n')]
        const page = map.pages['/Welcome']
        expect(choice).toBeDefined()
        expect(page).toBeDefined()
        for (const file of [page, map.notFound, choice]) {
            await rm(join(output(), file ?? ''))
        }
        await expectServerError('/Welcome')
        await expectServerError('/Nothing+here')
        await expectServerError(choices?.request ?? '')
    })

    test('answers 500 with no detail when a file that the pages load is missing', async () => {
        const [name] = await readdir(join(output(), '_astro'))
        expect(name).toBeDefined()
        await rm(join(output(), '_astro', name ?? ''))
        await expectServerError(`/_astro/${name ?? ''}`)
    })
})
