import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath, folderPath } from '@dsebastien-website/resolver'
import { startServer, type Server } from '../server/serve.ts'
import { createWorker, type StaticFiles } from '../worker/worker.ts'
import { checkNotModified, checkUrlCase, readUrlTable } from './url-table.ts'
import { buildUrlTableSite, type BuiltUrlTableSite } from './url-table-site.ts'

// The URL table of the site over HTTP (issue 43, SEAM-04 of the spec): the
// publishing tool publishes the notes of the table from a copy of the fixture
// vault, the site is built from that content store, and the plain local
// server answers each request of the table. The Worker of the host answers
// the same requests from the same output, with static files that stand for
// the ones of the host (issue 21, HOST-02). The resolver alone runs the same
// table (`packages/resolver/src/table.spec.ts`).
const SITE = fileURLToPath(new URL('..', import.meta.url))
const ORIGIN = 'https://notes.dsebastien.net'

const table = await readUrlTable()

let site: BuiltUrlTableSite | undefined
let outDir: string | undefined
let server: Server | undefined
let exitCode = -1

function serverUrl(): string {
    if (server === undefined) {
        throw new Error('the server does not run')
    }
    return server.url
}

function built(): BuiltUrlTableSite {
    if (site === undefined) {
        throw new Error('the site of the table does not exist')
    }
    return site
}

function store(): string {
    return built().contentStore
}

/** The two hosts of the built site: both are adapters of one handler. */
type Host = 'the plain local server' | 'the Worker'
const HOSTS: [Host][] = [['the plain local server'], ['the Worker']]

/**
 * The static files of a Worker version, from the output of the build: a file
 * by the exact path of its name, as the host gives it with no handling of
 * HTML, and 404 for every other path.
 */
function staticFilesOf(folder: () => string): StaticFiles {
    return {
        async fetch(request) {
            const name = new URL(request.url).pathname
                .split('/')
                .map((part) => decodeURIComponent(part))
                .join('/')
            const file = Bun.file(join(folder(), name))
            return (await file.exists())
                ? new Response(file, {
                      headers: {
                          etag: `"${file.size.toString(16)}-${file.lastModified.toString(16)}"`
                      }
                  })
                : new Response(null, { status: 404 })
        }
    }
}

/** A Worker on the output of the build. A test that removes files makes its own. */
function workerOf(): (request: Request) => Promise<Response> {
    const worker = createWorker({ report: () => undefined })
    const files = staticFilesOf(() => outDir ?? '')
    return (request) => worker.fetch(request, { ASSETS: files })
}

const worker = workerOf()

async function get(
    path: string,
    headers: Record<string, string> = {},
    host: Host = 'the plain local server'
): Promise<Response> {
    return host === 'the Worker'
        ? await worker(new Request(`${ORIGIN}${path}`, { headers }))
        : await fetch(`${serverUrl()}${path}`, { redirect: 'manual', headers })
}

beforeAll(async () => {
    // The output folder is inside the site, in a folder that git ignores: Astro
    // moves files into it, and a move to another file system fails.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'urls-page-spec-'))
    site = await buildUrlTableSite(table, outDir)
    exitCode = site.exitCode
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
    await site?.remove()
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

describe.each(HOSTS)('URL table over HTTP on %s', (host: Host) => {
    test.each(table.cases.map((entry) => [entry.name, entry] as const))(
        '%s',
        async (_name, entry) => {
            const findings = await checkUrlCase(
                entry,
                (path, headers = {}) => get(path, headers, host),
                { table, markdownOf: built().markdownOf }
            )
            expect(findings).toEqual([])
        }
    )
})

// Nothing of a removed note reaches the output of the build (NAV-19, R64):
// no title, no path, in no page, no file and no index. The note "Bean
// trellis" has no backlink, so no other note names it either (a link to an
// unpublished note shows its text, by rule 5 of the business rules). "Rain
// butt" is the former name of an unpublished note: it is gone too (R66).
describe('output of the build after an unpublication', () => {
    test('holds no name of a removed note that no note links to', async () => {
        const folder = outDir ?? ''
        const files = (await readdir(folder, { recursive: true, withFileTypes: true })).filter(
            (entry) => entry.isFile()
        )
        expect(files.length).toBeGreaterThan(20)
        const forms = [
            'Bean trellis',
            'Bean+trellis',
            'Bean%20trellis',
            'bean trellis',
            'Rain butt',
            'Rain+butt',
            'Rain%20butt'
        ]
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

// URL-18: an unchanged page or Markdown answers 304 to a conditional request.
describe.each(HOSTS)('a file that did not change on %s', (host: Host) => {
    test.each([
        ['a page', '/Welcome'],
        ['the Markdown of a note', '/-/md/Welcome.md']
    ])('answers 304 for %s', async (_name, path) => {
        expect(
            await checkNotModified(path, (asked, headers = {}) => get(asked, headers, host))
        ).toEqual([])
    })
})

// HOST-02: the command that checks a host by its address runs the same
// table. Here the host is the plain local server.
describe('the command that checks a host', () => {
    test('finds nothing on the plain local server', async () => {
        const child = Bun.spawn(
            [
                'bun',
                'scripts/url-table.ts',
                'check',
                '--base',
                `${serverUrl()}/`,
                '--notes',
                join(store(), 'notes')
            ],
            { cwd: join(SITE, '..', '..'), stdout: 'ignore', stderr: 'pipe' }
        )
        const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()])
        expect(output).toEndWith(
            `${String(table.cases.length)} cases and 2 files that did not change, 0 with a finding\n`
        )
        expect(code).toBe(0)
    })

    test('ends with the code 1 and names the cases when the host answers nothing', async () => {
        const child = Bun.spawn(
            [
                'bun',
                'scripts/url-table.ts',
                'check',
                '--base',
                'http://127.0.0.1:9',
                '--notes',
                join(store(), 'notes')
            ],
            { cwd: join(SITE, '..', '..'), stdout: 'ignore', stderr: 'pipe' }
        )
        const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()])
        expect(output).toContain('    no answer: ')
        expect(output).toEndWith(
            `${String(table.cases.length)} cases and 2 files that did not change, ${String(table.cases.length + 2)} with a finding\n`
        )
        expect(code).toBe(1)
    })
})

// The command removes only a folder that it made (a finding of the first
// review: a folder with files of another origin was written over).
describe('the command that builds the site of the table', () => {
    test('refuses a folder with files of another origin, and removes nothing', async () => {
        const root = join(SITE, '..', '..')
        await mkdir(join(root, '.cache'), { recursive: true })
        const folder = await mkdtemp(join(root, '.cache', 'urls-out-spec-'))
        try {
            await Bun.write(join(folder, 'keep.txt'), 'a file of another origin\n')
            const child = Bun.spawn(['bun', 'scripts/url-table.ts', 'build', '--out', folder], {
                cwd: root,
                stdout: 'ignore',
                stderr: 'pipe'
            })
            const [code, output] = await Promise.all([
                child.exited,
                new Response(child.stderr).text()
            ])
            expect(code).not.toBe(0)
            expect(output).toContain('is not the output of an earlier run of this command')
            expect(await readdir(folder)).toEqual(['keep.txt'])
            expect(await Bun.file(join(folder, 'keep.txt')).text()).toBe(
                'a file of another origin\n'
            )
        } finally {
            await rm(folder, { recursive: true, force: true })
        }
    })
})

describe('plain local server', () => {
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
