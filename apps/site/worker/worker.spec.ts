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

/** Static files in memory, by the path of their URL as the Worker asks it. */
function staticFiles(files: Record<string, string>): AskedFiles {
    const asked: string[] = []
    return {
        asked,
        fetch(request) {
            const { pathname } = new URL(request.url)
            asked.push(pathname)
            const body = files[pathname]
            return Promise.resolve(
                body === undefined
                    ? new Response('', { status: 404 })
                    : new Response(body, {
                          headers: {
                              'etag': `"tag of ${pathname}"`,
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
    get(path: string, headers?: Record<string, string>): Promise<Response>
}

/** A Worker of its own (one isolate) with its static files and its object storage. */
function host(files: Record<string, string> = SITE, withStorage = true): Host {
    const assets = staticFiles(files)
    const storage = objectStorage({ [KEY]: '0123456789' })
    const env: Environment = { ASSETS: assets, ...(withStorage ? { ATTACHMENTS: storage } : {}) }
    const worker = createWorker(() => undefined)
    return {
        files: assets,
        storage,
        get: (path, headers = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env)
    }
}

describe('the Worker', () => {
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
        expect(site.storage.asked).toEqual([KEY, `${KEY} 2+4`])
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

    test('reads the release again after a failed start, so one failure does not stay', async () => {
        const files: Record<string, string> = { ...SITE }
        const map = files['/-/resolver-map.json'] ?? ''
        files['/-/resolver-map.json'] = 'not JSON'
        const assets = staticFiles(files)
        const reported: unknown[] = []
        const worker = createWorker((error) => reported.push(error))
        const get = (): Promise<Response> =>
            worker.fetch(new Request(`${ORIGIN}/Welcome`), { ASSETS: assets })
        expect((await get()).status).toBe(500)
        expect(reported).toHaveLength(1)
        files['/-/resolver-map.json'] = map
        expect((await get()).status).toBe(200)
    })
})
