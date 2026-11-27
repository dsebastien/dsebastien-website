import { describe, expect, test } from 'bun:test'
import {
    MAP_HEAD_FILE,
    PAGE_POLICY_FILE,
    mapPartFile,
    mapPartsOf,
    partOfKey,
    resolverMapOf,
    variantKey,
    variantPath,
    type SiteFiles
} from '@dsebastien-website/resolver'
import {
    createWorker,
    NEW_INSTANCE_TIMING,
    type Environment,
    type ObjectStorage,
    type StaticFiles
} from './worker.ts'

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
    icon: 'favicon.ico',
    page: (path) => `-/note/${String(path.length)}.html`,
    markdown: (path) => `-/md/${path}`,
    folder: (path) => `-/folder/${String(path.length)}.html`,
    choice: (paths) => `-/choice/${String(paths.length)}.html`
}

const KEY = 'cd'.repeat(32)
const SONG = `/-/attachments/${KEY}/song.mp3`
const COVER = `/-/attachments/${KEY}/cover.jpg`
// A name with the characters that a URL gives a meaning to.
const ODD = '20 Library/100% rain + sun? #1 & more.md'

const map = resolverMapOf(
    [
        { path: 'Welcome.md', aliases: [] },
        { path: ODD, aliases: [] }
    ],
    FILES,
    { [SONG]: KEY, [COVER]: KEY }
)

type AskedFiles = StaticFiles & {
    asked: string[]
    cancelled: string[]
    /**
     * Settles the reads that wait (`'hold'`): with their file, or with a failed
     * fetch. With `count`, only the first ones, in the order of their start.
     */
    settle(outcome: 'answer' | 'reject', count?: number): void
}
type AskedStorage = ObjectStorage & { asked: string[] }

/** The text of a static file for which the host fails. */
const BROKEN = 'the host fails for this file'
/** The text of a static file that the host gives with no tag. */
const UNTAGGED = 'a file with no tag'

/**
 * A failure of the host for one read of a file: a fetch that rejects, a fetch
 * that never settles, a fetch that waits until the test settles it, a body
 * that breaks while it is read, a body whose cancel rejects, or a status.
 */
type Failure = 'reject' | 'hang' | 'hold' | 'break' | 'refuse-cancel' | number

/**
 * Static files in memory, by the path of their URL as the Worker asks it. The
 * first reads of a path of `failures` fail, one failure per read, as a host
 * that fails for a short time. A body that the Worker cancels is noted.
 */
function staticFiles(
    files: Record<string, string>,
    failures: Record<string, Failure[]> = {}
): AskedFiles {
    const asked: string[] = []
    const cancelled: string[] = []
    const left = new Map(Object.entries(failures).map(([path, list]) => [path, [...list]]))
    const held: ((outcome: 'answer' | 'reject') => void)[] = []
    function answer(pathname: string, failure?: 'break' | 'refuse-cancel'): Promise<Response> {
        const body = files[pathname]
        if (body === undefined) {
            return Promise.resolve(new Response('', { status: 404 }))
        }
        if (body === BROKEN) {
            return Promise.resolve(new Response('upstream detail', { status: 500 }))
        }
        const bytes = new TextEncoder().encode(body)
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                if (failure === 'break') {
                    controller.enqueue(bytes.slice(0, 1))
                    return
                }
                controller.enqueue(bytes)
                controller.close()
            },
            pull(controller) {
                if (failure === 'break') {
                    controller.error(new Error('the body breaks'))
                }
            },
            cancel() {
                cancelled.push(pathname)
                if (failure === 'refuse-cancel') {
                    throw new Error('the host refuses the cancel')
                }
            }
        })
        return Promise.resolve(
            new Response(stream, {
                headers: {
                    ...(body === UNTAGGED ? {} : { etag: `"tag of ${pathname}"` }),
                    'content-type': 'application/x-host-guess'
                }
            })
        )
    }
    return {
        asked,
        cancelled,
        settle(outcome, count) {
            for (const settle of held.splice(0, count ?? held.length)) {
                settle(outcome)
            }
        },
        fetch(request) {
            const { pathname } = new URL(request.url)
            asked.push(pathname)
            const failure = left.get(pathname)?.shift()
            if (failure === 'reject') {
                return Promise.reject(new Error('the host fails for a short time'))
            }
            if (failure === 'hang') {
                return new Promise<Response>(() => undefined)
            }
            if (failure === 'hold') {
                return new Promise<Response>((resolve, reject) => {
                    held.push((outcome) => {
                        if (outcome === 'reject') {
                            reject(new Error('the host fails for a short time'))
                        } else {
                            resolve(answer(pathname))
                        }
                    })
                })
            }
            if (failure === 'break' || failure === 'refuse-cancel') {
                return answer(pathname, failure)
            }
            if (failure !== undefined) {
                return Promise.resolve(new Response('upstream detail', { status: failure }))
            }
            return answer(pathname)
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

/** The static files of the resolver map in parts (issue 121), by their paths. */
function partFiles(bytes?: number): Record<string, string> {
    const { head, parts } = mapPartsOf(map, bytes)
    const files: Record<string, string> = { [`/${MAP_HEAD_FILE}`]: JSON.stringify(head) }
    for (const [index, part] of parts.entries()) {
        files[`/${mapPartFile(index)}`] = JSON.stringify(part)
    }
    return files
}

/** The one part of the map of the site: the map is small. */
const PART = `/${mapPartFile(0)}`

/** The policy of the pages of the release (SEC-01, issue 79). */
const POLICY = "default-src 'self'; script-src 'self' 'sha256-abc'; frame-ancestors 'none'"
const POLICY_PATH = `/${PAGE_POLICY_FILE}`

const SITE: Record<string, string> = {
    ...partFiles(),
    '/500.html': '<h1>Server error</h1>',
    [POLICY_PATH]: `${POLICY}
`,
    '/404.html': '<h1>Not found</h1>',
    '/-/note/10.html': '<h1>Welcome</h1>',
    '/-/md/20%20Library/100%25%20rain%20%2B%20sun%3F%20%231%20%26%20more.md': '# Rain',
    '/_astro/site.abc.css': 'body{}'
}

const MAP = `/${MAP_HEAD_FILE}`

/** A timer that the Worker started. The test fires it. */
interface Timer {
    readonly milliseconds: number
    readonly fire: () => void
    stopped: boolean
}

interface Host {
    files: AskedFiles
    storage: AskedStorage
    /** The failures that the Worker reported. */
    reported: unknown[]
    /** The pauses that the Worker asked for, in milliseconds. */
    paused: number[]
    /** The timers that the Worker started, in the order of their start. */
    timers: Timer[]
    /** The promises that the Worker gave to `waitUntil()` of the context of its requests. */
    keptAlive: Promise<unknown>[]
    /** Moves the clock of the Worker forward. */
    wait(milliseconds: number): void
    get(path: string, headers?: Record<string, string>, method?: string): Promise<Response>
}

/** How many times the Worker read the resolver map. */
function mapReads(site: Host): number {
    return site.files.asked.filter((path) => path === MAP).length
}

/** A Worker of its own (one isolate) with its static files and its object storage. */
function host(
    files: Record<string, string> = SITE,
    withStorage = true,
    variables: Pick<Environment, 'NOINDEX' | 'MAP_PARTS'> = {},
    failures: Record<string, Failure[]> = {},
    /** True for a pause that never ends. */
    hangingPause = false
): Host {
    const assets = staticFiles(files, failures)
    const storage = objectStorage({ [KEY]: '0123456789' })
    const env: Environment = {
        ASSETS: assets,
        ...(withStorage ? { ATTACHMENTS: storage } : {}),
        ...variables
    }
    const reported: unknown[] = []
    let time = 1_000_000
    const paused: number[] = []
    const timers: Timer[] = []
    const keptAlive: Promise<unknown>[] = []
    const context = {
        waitUntil: (promise: Promise<unknown>) => {
            keptAlive.push(promise)
        }
    }
    const worker = createWorker({
        report: (error) => reported.push(error),
        now: () => time,
        pause: (milliseconds) => {
            paused.push(milliseconds)
            return hangingPause ? new Promise<void>(() => undefined) : Promise.resolve()
        },
        startTimer: (milliseconds, expire) => {
            const timer: Timer = { milliseconds, fire: expire, stopped: false }
            timers.push(timer)
            return () => {
                timer.stopped = true
            }
        }
    })
    return {
        files: assets,
        storage,
        reported,
        paused,
        timers,
        keptAlive,
        wait: (milliseconds) => {
            time += milliseconds
        },
        get: (path, headers = {}, method = 'GET') =>
            worker.fetch(new Request(`${ORIGIN}${path}`, { headers, method }), env, context)
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
        const { [MAP]: _map, ...rest } = SITE
        const response = await host(rest, true, { NOINDEX: 'true' }).get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('x-robots-tag')).toBe('noindex')
    })

    test('adds no robots header without the variable of a preview host', async () => {
        const response = await host(SITE, true, { NOINDEX: '' }).get('/Welcome')
        expect(response.status).toBe(200)
        expect(response.headers.get('x-robots-tag')).toBeNull()
    })

    // STORE-08, issue 32: the deployment reads it until it names its own build.
    test('gives the deployment record from the static files, never kept, also on a preview host', async () => {
        const record = '{"contentRevision":"c"}'
        const site = host({ ...SITE, '/-/deployment.json': record }, true, { NOINDEX: 'true' })
        const response = await site.get('/-/deployment.json')
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('x-robots-tag')).toBe('noindex')
        expect(await response.text()).toBe(record)
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
            POLICY_PATH,
            PART,
            MAP,
            '/500.html'
        ])
    })

    test('gives a page the policy of its release, read one time (SEC-01)', async () => {
        const site = host()
        const page = await site.get('/Welcome')
        expect(page.headers.get('content-security-policy')).toBe(POLICY)
        expect(page.headers.get('x-content-type-options')).toBe('nosniff')
        await site.get('/Welcome')
        expect(site.files.asked.filter((path) => path === POLICY_PATH)).toHaveLength(1)
    })

    test('gives the pages of a release without a policy a policy that only refuses frames', async () => {
        const { [POLICY_PATH]: _policy, ...older } = SITE
        const page = await host(older).get('/Welcome')
        expect(page.status).toBe(200)
        expect(page.headers.get('content-security-policy')).toBe(
            "frame-ancestors 'none'; object-src 'none'; base-uri 'none'"
        )
    })

    test('answers 500 for a release whose policy does not refuse frames', async () => {
        const site = host({ ...SITE, [POLICY_PATH]: "default-src 'self'" })
        const page = await site.get('/Welcome')
        expect(page.status).toBe(500)
        expect(page.headers.get('x-frame-options')).toBe('DENY')
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

    // Issue 87, R92: a variant that the object storage lacks never breaks a page.
    test('gives the image of a variant that the object storage lacks', async () => {
        const site = host()
        const response = await site.get(variantPath(COVER, 480))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/jpeg')
        expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
        expect(await response.text()).toBe('0123456789')
        expect(site.storage.asked).toEqual([variantKey(KEY, 480), KEY])
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
                (asked) => ![MAP, PART, POLICY_PATH, '/500.html', '/404.html'].includes(asked)
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

    // Issue 117: the static files redirect a path only when the host handles
    // the HTML paths or the folders by itself. The configuration of the host
    // sets `html_handling` to `none`; a redirect that still comes is a failure.
    test('answers 500 and passes no redirect on when the static files redirect a file that the pages load', async () => {
        const site = host(SITE, true, {}, { '/_astro/sub/': [307] })
        const response = await site.get('/_astro/sub/')
        expect(response.status).toBe(500)
        expect(response.headers.get('location')).toBeNull()
        expect(await response.text()).toBe('<h1>Server error</h1>')
    })

    test('does not start, and does not read again after 50 ms, when the static files redirect the server error page', async () => {
        const site = host(SITE, true, {}, { '/500.html': [308] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('location')).toBeNull()
        expect((site.reported[0] as Error).message).toBe('the host answers 308 for 500.html')
        expect(mapReads(site)).toBe(1)
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
        const { [MAP]: _map, ...rest } = SITE
        const response = await host(rest).get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(await response.text()).toStartWith('# Server error\n')
    })

    test('answers 500 when the resolver map of the release is not a resolver map', async () => {
        const response = await host({ ...SITE, [MAP]: '{"pages":[1]}' }).get('/Welcome')
        expect(response.status).toBe(500)
    })

    // NAV-21: also when the Worker cannot read its release.
    test('answers a short Markdown text to an agent when the release has no resolver map', async () => {
        const { [MAP]: _map, ...rest } = SITE
        const response = await host(rest).get('/-/md/Welcome.md')
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    })

    test('does not start when the host fails for the server error page', async () => {
        const site = host({ ...SITE, '/500.html': BROKEN })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        // The first read and the second read.
        expect(site.reported).toHaveLength(2)
    })

    test('reads a release that failed two reads in a row again after ten seconds, not at each request', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject', 'reject'] })
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(site.reported).toHaveLength(2)
        // The release is fine now, but the Worker waits before it reads again.
        site.wait(9_000)
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(mapReads(site)).toBe(2)
        site.wait(1_000)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(site.reported).toHaveLength(2)
    })

    test('does not read a second time a resolver map that is not JSON', async () => {
        const site = host({ ...SITE, [MAP]: 'not JSON' })
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(mapReads(site)).toBe(1)
        expect(site.reported).toHaveLength(1)
    })

    test('does not read a second time a release with no resolver map', async () => {
        const { [MAP]: _map, ...rest } = SITE
        const site = host(rest)
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(mapReads(site)).toBe(1)
        expect(site.reported).toHaveLength(1)
    })

    test('does not read a second time a resolver map that is not a resolver map', async () => {
        const site = host({ ...SITE, [MAP]: '{"pages":[1]}' })
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(mapReads(site)).toBe(1)
        expect(site.reported).toHaveLength(1)
    })

    // Issue 128: a short failure of the host at the start of an isolate.
    test('reads the release again after 50 ms when its first read fails, and gives the page', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject'] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('<h1>Welcome</h1>')
        expect(site.reported).toHaveLength(1)
        expect(mapReads(site)).toBe(2)
        expect(site.paused).toEqual([50])
    })

    test('reads the release again after 50 ms when the host answers 500 for the resolver map', async () => {
        const site = host(SITE, true, {}, { [MAP]: [500] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('<h1>Welcome</h1>')
        expect(mapReads(site)).toBe(2)
    })

    test('reads the release again after 50 ms when the host answers 503 for the server error page', async () => {
        const site = host(SITE, true, {}, { '/500.html': [503] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('<h1>Welcome</h1>')
        expect(site.files.asked.filter((path) => path === '/500.html')).toHaveLength(2)
        // The resolver map of the failed read is not read: its body is cancelled.
        expect(site.files.cancelled).toEqual([MAP])
    })

    test.each([MAP, '/500.html'])(
        'reads the release again after 50 ms when the body of %s breaks while it is read',
        async (path) => {
            const site = host(SITE, true, {}, { [path]: ['break'] })
            const response = await site.get('/Welcome')
            expect(response.status).toBe(200)
            expect(site.files.asked.filter((asked) => asked === path)).toHaveLength(2)
            expect(site.reported).toHaveLength(1)
            expect(site.paused).toEqual([50])
        }
    )

    test('keeps the short failure when the cancel of a body that it does not read rejects', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['refuse-cancel'], '/500.html': [503] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(200)
        expect(site.files.cancelled).toEqual([MAP])
        expect(mapReads(site)).toBe(2)
        const [first] = site.reported
        expect(((first as Error).cause as Error).message).toBe('the host answers 503 for 500.html')
    })

    test('tells the first failure apart and puts no detail into the answer', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject', 'reject'] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(500)
        expect(await response.text()).not.toContain('short time')
        const [first, second] = site.reported
        expect(first).toBeInstanceOf(Error)
        expect((first as Error).message).toBe('first read of the release failed, reading it again')
        const cause = (first as Error).cause as Error
        expect(cause.message).toBe('the host fails to give a file of the release')
        expect((cause.cause as Error).message).toBe('the host fails for a short time')
        expect(second).not.toBe(first)
    })

    test('answers 500 after two failed reads, and does not read again within ten seconds', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject', 'reject'] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(500)
        expect(await response.text()).toStartWith('# Server error\n')
        expect(site.reported).toHaveLength(2)
        site.wait(9_999)
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(mapReads(site)).toBe(2)
        expect(site.reported).toHaveLength(2)
    })

    test('gives the read after ten seconds its second read after 50 ms too', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject', 'reject', 'reject'] })
        expect((await site.get('/Welcome')).status).toBe(500)
        site.wait(10_000)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(mapReads(site)).toBe(4)
        expect(site.reported).toHaveLength(3)
    })

    test('reads the release one time for requests that wait for the same read', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject'] })
        const answers = await Promise.all([site.get('/Welcome'), site.get('/Welcome')])
        expect(answers.map((answer) => answer.status)).toEqual([200, 200])
        expect(mapReads(site)).toBe(2)
        expect(site.reported).toHaveLength(1)
    })

    test('reports two failed reads one time each for requests that wait for them', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject', 'reject'] })
        const answers = await Promise.all([site.get('/Welcome'), site.get('/Welcome')])
        expect(answers.map((answer) => answer.status)).toEqual([500, 500])
        expect(mapReads(site)).toBe(2)
        expect(site.reported).toHaveLength(2)
    })

    // Issue 129: a read of the release that never settles.
    test('answers 500 when the read of the release takes more than five seconds', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hang'] })
        let settled = false
        const answer = site.get('/Welcome').finally(() => {
            settled = true
        })
        await Bun.sleep(0)
        expect(settled).toBe(false)
        expect(site.timers.map((timer) => timer.milliseconds)).toEqual([5_000])
        site.wait(5_000)
        site.timers[0]?.fire()
        const response = await answer
        expect(response.status).toBe(500)
        expect(await response.text()).toStartWith('# Server error\n')
        expect(site.reported).toHaveLength(1)
        expect((site.reported[0] as Error).message).toBe(
            'the read of the release takes more than 5000 ms'
        )
    })

    test('reads the release again at once after a read that took too long', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hang'] })
        const answer = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(5_000)
        site.timers[0]?.fire()
        expect((await answer).status).toBe(500)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(mapReads(site)).toBe(2)
        expect(site.reported).toHaveLength(1)
    })

    test('keeps the result of a read that settles after the time limit of one request', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hold'] })
        const first = site.get('/Welcome')
        await Bun.sleep(0)
        const second = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(5_000)
        site.timers[0]?.fire()
        expect((await first).status).toBe(500)
        site.files.settle('answer')
        expect((await second).status).toBe(200)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(mapReads(site)).toBe(1)
        expect(site.reported).toHaveLength(1)
    })

    // Issue 131: a host that stays hung.
    test('reads the release again after ten seconds, not at once, after two time-outs in a row', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hang', 'hang'] })
        for (const index of [0, 1]) {
            const answer = site.get('/Welcome')
            await Bun.sleep(0)
            site.wait(5_000)
            site.timers[index]?.fire()
            expect((await answer).status).toBe(500)
        }
        expect(site.reported).toHaveLength(2)
        site.wait(9_999)
        expect((await site.get('/Welcome')).status).toBe(500)
        expect(mapReads(site)).toBe(2)
        site.wait(1)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(mapReads(site)).toBe(3)
    })

    test('keeps the result of a read that settles after its time limit when no request waits', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hold'] })
        const answer = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(5_000)
        site.timers[0]?.fire()
        expect((await answer).status).toBe(500)
        site.files.settle('answer')
        await Bun.sleep(0)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(mapReads(site)).toBe(1)
        expect(site.reported).toHaveLength(1)
    })

    test('keeps a read that settles after its time limit while a newer read is still open', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hold', 'hold'] })
        const first = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(5_000)
        site.timers[0]?.fire()
        expect((await first).status).toBe(500)
        void site.get('/Welcome')
        await Bun.sleep(0)
        expect(mapReads(site)).toBe(2)
        site.files.settle('answer', 1)
        await Bun.sleep(0)
        let status: number | undefined
        void site.get('/Welcome').then((response) => {
            status = response.status
        })
        await Bun.sleep(0)
        expect(status).toBe(200)
        expect(mapReads(site)).toBe(2)
        expect(site.timers).toHaveLength(2)
        site.files.settle('answer')
    })

    test('reads again at once after a time-out that follows a lasting failure', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hang', 404, 'hang'] })
        const first = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(5_000)
        site.timers[0]?.fire()
        expect((await first).status).toBe(500)
        // A missing resolver map: a lasting failure, which resets the count of time-outs.
        expect((await site.get('/Welcome')).status).toBe(500)
        site.wait(10_000)
        const third = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(5_000)
        site.timers[2]?.fire()
        expect((await third).status).toBe(500)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(mapReads(site)).toBe(4)
    })

    test('starts no timer for a request once the read of the release has settled', async () => {
        const site = host()
        expect((await site.get('/Welcome')).status).toBe(200)
        expect((await site.get('/Welcome')).status).toBe(200)
        expect(site.timers).toHaveLength(1)
    })

    test('does not go on with a read after its time limit', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hold'] })
        const answer = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(5_000)
        site.timers[0]?.fire()
        expect((await answer).status).toBe(500)
        site.files.settle('reject')
        await Bun.sleep(0)
        // No report of a first failure, no pause, no second read.
        expect(site.reported).toHaveLength(1)
        expect(site.paused).toEqual([])
        expect(mapReads(site)).toBe(1)
    })

    test('answers 500 after the time limit when the pause between the two reads never ends', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject'] }, true)
        const answer = site.get('/Welcome')
        await Bun.sleep(0)
        expect(site.paused).toEqual([50])
        site.wait(5_000)
        site.timers[0]?.fire()
        expect((await answer).status).toBe(500)
        expect(mapReads(site)).toBe(1)
        expect(site.reported).toHaveLength(2)
    })

    test('gives a request that comes after the end of a pending read no time to wait', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hang'] })
        void site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(6_000)
        const late = site.get('/Welcome')
        await Bun.sleep(0)
        expect(site.timers.map((timer) => timer.milliseconds)).toEqual([5_000, 0])
        site.timers[1]?.fire()
        expect((await late).status).toBe(500)
        expect(site.reported).toHaveLength(1)
    })

    test('keeps the shared read alive with the context of the request that starts it', async () => {
        const site = host()
        await Promise.all([site.get('/Welcome'), site.get('/Welcome')])
        await site.get('/Welcome')
        expect(site.keptAlive).toHaveLength(1)
    })

    test('gives requests that wait for the same read one time limit', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['hang'] })
        const first = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(2_000)
        const second = site.get('/Welcome')
        await Bun.sleep(0)
        // Each request waits until the same end: the later one, for less time.
        expect(site.timers.map((timer) => timer.milliseconds)).toEqual([5_000, 3_000])
        site.wait(3_000)
        for (const timer of site.timers) {
            timer.fire()
        }
        const answers = await Promise.all([first, second])
        expect(answers.map((answer) => answer.status)).toEqual([500, 500])
        expect(mapReads(site)).toBe(1)
        expect(site.reported).toHaveLength(1)
    })

    test('covers the second read with the time limit', async () => {
        const site = host(SITE, true, {}, { [MAP]: ['reject', 'hang'] })
        const answer = site.get('/Welcome')
        await Bun.sleep(0)
        site.wait(5_000)
        site.timers[0]?.fire()
        expect((await answer).status).toBe(500)
        expect(mapReads(site)).toBe(2)
        expect(site.timers).toHaveLength(1)
    })

    test('stops the timer of the time limit when the read of the release settles', async () => {
        const site = host()
        expect((await site.get('/Welcome')).status).toBe(200)
        const failed = host({ ...SITE, [MAP]: 'not JSON' })
        expect((await failed.get('/Welcome')).status).toBe(500)
        expect([...site.timers, ...failed.timers].map((timer) => timer.stopped)).toEqual([
            true,
            true
        ])
    })
})

describe('the first request of an instance (issue 121)', () => {
    test('the first answer says that it comes from a new instance, and no later one', async () => {
        const site = host(SITE, true, { NOINDEX: 'true' })
        const first = await site.get('/Welcome')
        const second = await site.get('/Welcome')
        expect(first.headers.get('server-timing')).toBe(NEW_INSTANCE_TIMING)
        expect(first.headers.get('x-robots-tag')).toBe('noindex')
        expect(second.headers.get('server-timing')).toBeNull()
    })

    test('also an answer 500 of a release that it cannot read', async () => {
        const { [MAP]: _map, ...rest } = SITE
        const response = await host(rest).get('/Welcome')
        expect(response.status).toBe(500)
        expect(response.headers.get('server-timing')).toBe(NEW_INSTANCE_TIMING)
    })
})

describe('the resolver map in parts (issue 121)', () => {
    /** The site with its map in many small parts. */
    const MANY = { ...SITE, ...partFiles(64) }
    const parts = Object.keys(MANY).filter(
        (path) => path.startsWith('/-/resolver-map/') && path !== MAP
    )

    test('the map of the test has several parts', () => {
        expect(parts.length).toBeGreaterThan(4)
    })

    test('a page reads the head and the one part of its path', async () => {
        const site = host(MANY)
        const response = await site.get('/Welcome')
        expect(response.status).toBe(200)
        const count = parts.length
        expect(site.files.asked.filter((path) => path.startsWith('/-/resolver-map/'))).toEqual([
            MAP,
            `/${mapPartFile(partOfKey('/Welcome', count))}`
        ])
    })

    test('a part is read one time for many requests', async () => {
        const site = host(MANY)
        await site.get('/Welcome')
        await site.get('/Welcome')
        await site.get('/welcome')
        const asked = site.files.asked.filter((path) => parts.includes(path))
        expect(asked.length).toBe(new Set(asked).size)
    })

    test('a variant reads the parts that it needs, and gives the answer of the whole map', async () => {
        const response = await host(MANY).get('/welcome?ref=site')
        expect(response.status).toBe(301)
        expect(response.headers.get('location')).toBe('/Welcome?ref=site')
    })

    test('a part that the host fails to give is read again after a short pause', async () => {
        const part = `/${mapPartFile(partOfKey('/Welcome', parts.length))}`
        const site = host(MANY, true, {}, { [part]: ['reject'] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(200)
        expect(site.paused).toEqual([50])
        expect((site.reported[0] as Error).message).toBe(
            `first read of ${part.slice(1)} failed, reading it again`
        )
    })

    test('a part that fails twice answers 500, and the next request reads it again', async () => {
        const part = `/${mapPartFile(partOfKey('/Welcome', parts.length))}`
        const site = host(MANY, true, {}, { [part]: [503, 503] })
        const failed = await site.get('/Welcome')
        expect(failed.status).toBe(500)
        expect(await failed.text()).toBe('<h1>Server error</h1>')
        const again = await site.get('/Welcome')
        expect(again.status).toBe(200)
        expect(site.files.asked.filter((path) => path === part)).toHaveLength(3)
        // The head is read one time: a failed part is not a failed release.
        expect(mapReads(site)).toBe(1)
    })

    test('a part that is not right answers 500 and is not read again after a pause', async () => {
        const part = `/${mapPartFile(partOfKey('/Welcome', parts.length))}`
        const site = host({ ...MANY, [part]: '{"pages":{"/Welcome":1}}' })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(500)
        expect(site.paused).toEqual([])
        expect((site.reported[0] as Error).message).toBe(
            `${part.slice(1)} is not a part of the resolver map`
        )
    })
})

describe('the part of the first request (issue 121)', () => {
    const MANY = { ...SITE, ...partFiles(64) }
    const count = Object.keys(MANY).filter(
        (path) => path.startsWith('/-/resolver-map/') && path !== MAP
    ).length
    const part = `/${mapPartFile(partOfKey('/Welcome', count))}`

    test('is read while the head is read, when the Worker knows the count of the parts', async () => {
        const site = host(MANY, true, { MAP_PARTS: String(count) }, { [MAP]: ['hold'] })
        const answer = site.get('/Welcome')
        await Promise.resolve()
        expect(site.files.asked).toContain(part)
        site.files.settle('answer')
        const response = await answer
        expect(response.status).toBe(200)
        expect(site.files.asked.filter((path) => path === part)).toHaveLength(1)
    })

    test('does not use an early read with a count that is not the one of the head', async () => {
        const site = host(MANY, true, { MAP_PARTS: String(count * 2) })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('<h1>Welcome</h1>')
        // The part of the head is read for the request, whatever the early read asked.
        expect(site.files.asked.filter((path) => path === part).length).toBeGreaterThanOrEqual(1)
    })

    test.each(['', '3', 'many', '0'])('is not read early with the count %p', async (value) => {
        const site = host(MANY, true, { MAP_PARTS: value }, { [MAP]: ['hold'] })
        const answer = site.get('/Welcome')
        await Promise.resolve()
        expect(
            site.files.asked.some((path) => path.startsWith('/-/resolver-map/') && path !== MAP)
        ).toBe(false)
        site.files.settle('answer')
        expect((await answer).status).toBe(200)
    })

    test('an early read that fails is read again, as any part', async () => {
        const site = host(MANY, true, { MAP_PARTS: String(count) }, { [part]: ['reject'] })
        const response = await site.get('/Welcome')
        expect(response.status).toBe(200)
        expect(site.files.asked.filter((path) => path === part)).toHaveLength(2)
    })
})
