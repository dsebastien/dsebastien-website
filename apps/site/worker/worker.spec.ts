import { describe, expect, test } from 'bun:test'
import { resolverMapOf, type SiteFiles } from '@dsebastien-website/resolver'
import { createWorker, type Environment, type ObjectStorage, type StaticFiles } from './worker.ts'

// The Worker of the host (HOST-01, HOST-03, issue 21): an adapter of the
// handler of the site. These tests give it static files and an object
// storage in memory, and check what it asks of them. The URL table runs
// against it in `../src/urls-page.spec.ts`, on a built site.

const ORIGIN = 'https://notes.example'

const FILES: SiteFiles = {
    home: 'index.html',
    notFound: '404.html',
    gone: '410.html',
    robots: 'robots.txt',
    page: (path) => `-/note/${String(path.length)}.html`,
    markdown: (path) => `-/md/${path}`,
    folder: (path) => `-/folder/${String(path.length)}.html`,
    choice: (paths) => `-/choice/${String(paths.length)}.html`
}

const KEY = 'cd'.repeat(32)
const SONG = `/-/attachments/${KEY}/song.mp3`
// A name with the characters that a URL gives a meaning to.
const ODD = '20 Library/100% rain + sun? #1 & more.md'

const map = resolverMapOf(
    [
        { path: 'Welcome.md', aliases: [] },
        { path: ODD, aliases: [] }
    ],
    FILES,
    { [SONG]: KEY }
)

type AskedFiles = StaticFiles & { asked: string[] }
type AskedStorage = ObjectStorage & { asked: string[] }

/** The text of a static file for which the host fails. */
const BROKEN = 'the host fails for this file'
/** The text of a static file that the host gives with no tag. */
const UNTAGGED = 'a file with no tag'

/** Static files in memory, by the path of their URL as the Worker asks it. */
function staticFiles(files: Record<string, string>): AskedFiles {
    const asked: string[] = []
    return {
        asked,
        fetch(request) {
            const { pathname } = new URL(request.url)
            asked.push(pathname)
            const body = files[pathname]
            if (body === undefined) {
                return Promise.resolve(new Response('', { status: 404 }))
            }
            if (body === BROKEN) {
                return Promise.resolve(new Response('upstream detail', { status: 500 }))
            }
            return Promise.resolve(
                new Response(body, {
                    headers: {
                        ...(body === UNTAGGED ? {} : { etag: `"tag of ${pathname}"` }),
                        'content-type': 'application/x-host-guess'
                    }
                })
            )
        }
    }
}

/** An object storage in memory. */
function objectStorage(objects: Record<string, string>): AskedStorage {
    const asked: string[] = []
    return {
        asked,
        head(key) {
            asked.push(`head ${key}`)
            const text = objects[key]
            return Promise.resolve(
                text === undefined
                    ? null
                    : {
                          size: new TextEncoder().encode(text).length,
                          httpEtag: `"etag of ${key}"`
                      }
            )
        },
        get(key, options) {
            asked.push(
                options === undefined
                    ? key
                    : `${key} ${String(options.range.offset)}+${String(options.range.length)}`
            )
            const text = objects[key]
            if (text === undefined) {
                return Promise.resolve(null)
            }
            const bytes = new TextEncoder().encode(text)
            const part =
                options === undefined
                    ? bytes
                    : bytes.slice(options.range.offset, options.range.offset + options.range.length)
            return Promise.resolve({
                size: bytes.length,
                httpEtag: `"etag of ${key}"`,
                body: new Response(part).body ?? new ReadableStream<Uint8Array>()
            })
        }
    }
}

const SITE = {
    '/-/resolver-map.json': JSON.stringify(map),
    '/500.html': '<h1>Server error</h1>',
    '/404.html': '<h1>Not found</h1>',
    '/-/note/10.html': '<h1>Welcome</h1>',
    '/-/md/20%20Library/100%25%20rain%20%2B%20sun%3F%20%231%20%26%20more.md': '# Rain',
    '/_astro/site.abc.css': 'body{}'
}

interface Host {
    files: AskedFiles
    storage: AskedStorage
    /** The failures that the Worker reported. */
    reported: unknown[]
    /** Moves the clock of the Worker forward. */
    wait(milliseconds: number): void
    get(path: string, headers?: Record<string, string>, method?: string): Promise<Response>
}

/** A Worker of its own (one isolate) with its static files and its object storage. */
function host(
    files: Record<string, string> = SITE,
    withStorage = true,
    variables: Pick<Environment, 'NOINDEX'> = {}
): Host {
    const assets = staticFiles(files)
    const storage = objectStorage({ [KEY]: '0123456789' })
    const env: Environment = {
        ASSETS: assets,
        ...(withStorage ? { ATTACHMENTS: storage } : {}),
        ...variables
    }
    const reported: unknown[] = []
    let time = 1_000_000
    const worker = createWorker({ report: (error) => reported.push(error), now: () => time })
    return {
        files: assets,
        storage,
        reported,
        wait: (milliseconds) => {
            time += milliseconds
        },
        get: (path, headers = {}, method = 'GET') =>
            worker.fetch(new Request(`${ORIGIN}${path}`, { headers, method }), env)
    }
}

describe('the Worker', () => {
    // IDX-26, issue 30: the preview host is never indexed.
    test('marks every answer noindex on a preview host: pages, files, attachments and errors', async () => {
        const site = host(SITE, true, { NOINDEX: 'true' })
        const answers = [
            await site.get('/Welcome'),
            await site.get('/Welcome', { 'if-none-match': '"tag of /-/note/10.html"' }),
            await site.get('/_astro/site.abc.css'),
            await site.get(SONG, { range: 'bytes=2-5' }),
            await site.get('/no-such-note'),
            await site.get('/-/md/no-such-note.md', { accept: 'text/markdown' })
        ]
        expect(answers.map((answer) => answer.status)).toEqual([200, 304, 200, 206, 404, 404])
        for (const answer of answers) {
            expect(answer.headers.get('x-robots-tag')).toBe('noindex')
        }
    })

    test('marks noindex the answer of a release that it cannot read', async () => {
        const { '/-/resolver-map.json': _map, ...rest } = SITE
        const response = await host(rest, true, { NOINDEX: 'true' }).get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('x-robots-tag')).toBe('noindex')
    })

    test('adds no robots header without the variable of a preview host', async () => {
        const response = await host(SITE, true, { NOINDEX: '' }).get('/Welcome')
        expect(response.status).toBe(200)
        expect(response.headers.get('x-robots-tag')).toBeNull()
    })

    test('gives a page from the static files, by the file that the resolver map names', async () => {
        const response = await host().get('/Welcome')
        expect(response.status).toBe(200)
        // The type is the one of the URL contract, not the guess of the host.
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('etag')).toBe('"tag of /-/note/10.html"')
        expect(await response.text()).toBe('<h1>Welcome</h1>')
    })

    test('reads the resolver map and the server error page one time for many requests', async () => {
        const site = host()
        await site.get('/Welcome')
        await site.get('/Welcome')
        expect(site.files.asked.toSorted()).toEqual([
            '/-/note/10.html',
            '/-/note/10.html',
            '/-/resolver-map.json',
            '/500.html'
        ])
    })

    test('asks for a file with an odd name by its percent-encoded path', async () => {
        const response = await host().get(
            '/-/md/20+Library/100%25+rain+%2B+sun%3F+%231+%26+more.md'
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
        expect(await response.text()).toBe('# Rain')
    })

    test('gives a file that the pages load, and the "not found" page for one that does not exist', async () => {
        const site = host()
        const style = await site.get('/_astro/site.abc.css')
        expect(style.status).toBe(200)
        expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
        expect(await style.text()).toBe('body{}')
        const missing = await site.get('/_astro/other.css')
        expect(missing.status).toBe(404)
        expect(await missing.text()).toBe('<h1>Not found</h1>')
    })

    test('never asks the static files for a path of the request that the resolver map does not name', async () => {
        const site = host()
        const response = await site.get('/500.html')
        expect(response.status).toBe(404)
        // One time, at the start, as the server error page: not for the request.
        expect(site.files.asked.filter((path) => path === '/500.html')).toHaveLength(1)
    })

    test('gives an attachment from the object storage with one read', async () => {
        const site = host()
        const response = await site.get(SONG)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('audio/mpeg')
        expect(await response.text()).toBe('0123456789')
        expect(site.storage.asked).toEqual([KEY])
    })

    // HOST-05: a player asks for parts of a file.
    test('gives a part of an attachment for a range request', async () => {
        const site = host()
        const response = await site.get(SONG, { range: 'bytes=2-5' })
        expect(response.status).toBe(206)
        expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
        expect(await response.text()).toBe('2345')
        // The size first, then the part: the whole file is never opened.
        expect(site.storage.asked).toEqual([`head ${KEY}`, `${KEY} 2+4`])
    })

    test('opens no file of the object storage for a range outside the file', async () => {
        const site = host()
        const response = await site.get(SONG, { range: 'bytes=10-' })
        expect(response.status).toBe(416)
        expect(site.storage.asked).toEqual([`head ${KEY}`])
    })

    test('opens no file of the object storage for a request of the headers only', async () => {
        const site = host()
        const response = await site.get(SONG, {}, 'HEAD')
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('audio/mpeg')
        expect(site.storage.asked).toEqual([`head ${KEY}`])
    })

    // Only a file of the two folders of the pages is given by the path of the
    // request, and only by a plain path: nothing that the host could read as
    // a way out of the folder.
    test.each([
        '/_astro/..%2f-%2fresolver-map.json',
        '/-/search/..%2f..%2f500.html',
        '/_astro/%2e%2e%2f500.html',
        '/_astro//site.abc.css',
        '/_astro/..\\500.html',
        '/_astro/site.abc.css%00'
    ])('never asks the static files for the path %s', async (path) => {
        const site = host()
        const response = await site.get(path)
        expect(response.status).toBe(404)
        expect(await response.text()).toBe('<h1>Not found</h1>')
        expect(
            site.files.asked.filter(
                (asked) => !['/-/resolver-map.json', '/500.html', '/404.html'].includes(asked)
            )
        ).toEqual([])
    })

    test('answers 500 when the host fails for a file that the pages load', async () => {
        const response = await host({ ...SITE, '/_astro/site.abc.css': BROKEN }).get(
            '/_astro/site.abc.css'
        )
        expect(response.status).toBe(500)
        expect(await response.text()).toBe('<h1>Server error</h1>')
    })

    test('gives a page with no tag when the host gives none, and never 304 for it', async () => {
        const response = await host({ ...SITE, '/-/note/10.html': UNTAGGED }).get('/Welcome', {
            'if-none-match': '""'
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('etag')).toBeNull()
    })

    test('answers 404 for an attachment when it has no object storage', async () => {
        const response = await host(SITE, false).get(SONG)
        expect(response.status).toBe(404)
    })

    // URL-33, NAV-20.
    test('answers 500 with the server error page when the release lacks a page of the map', async () => {
        const { '/-/note/10.html': _page, ...rest } = SITE
        const response = await host(rest).get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.text()).toBe('<h1>Server error</h1>')
    })

    test('answers 500 with a short text when the release has no resolver map', async () => {
        const { '/-/resolver-map.json': _map, ...rest } = SITE
        const response = await host(rest).get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(await response.text()).toStartWith('# Server error\n')
    })

    test('answers 500 when the resolver map of the release is not a resolver map', async () => {
        const response = await host({ ...SITE, '/-/resolver-map.json': '{"pages":[1]}' }).get(
            '/Welcome'
        )
        expect(response.status).toBe(500)
    })

    // NAV-21: also when the Worker cannot read its release.
    test('answers a short Markdown text to an agent when the release has no resolver map', async () => {
        const { '/-/resolver-map.json': _map, ...rest } = SITE
        const response = await host(rest).get('/-/md/Welcome.md')
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    })

    test('does not start when the host fails for the server error page', async () => {
        const site = host({ ...SITE, '/500.html': BROKEN })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(site.reported).toHaveLength(1)
    })

    test('reads a release that it could not read again after ten seconds, not at each request', async () => {
        const files: Record<string, string> = { ...SITE }
        const map = files['/-/resolver-map.json'] ?? ''
        files['/-/resolver-map.json'] = 'not JSON'
        const site = host(files)
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(site.reported).toHaveLength(1)
        files['/-/resolver-map.json'] = map
        // The release is fine now, but the Worker waits before it reads again.
        site.wait(9_000)
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(site.files.asked.filter((path) => path === '/-/resolver-map.json')).toHaveLength(1)
        site.wait(1_000)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(site.reported).toHaveLength(1)
    })
})
