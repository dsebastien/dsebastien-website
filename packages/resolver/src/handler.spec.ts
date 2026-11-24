import { describe, expect, test } from 'bun:test'
import { siteHandler, type Release, type StoredFile } from './handler.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'

// The answer of a request (HOST-02 of the spec, issue 21): one handler that
// knows no host, with the files of a release and of the attachment storage
// behind a port. The plain local server and the Worker are adapters of it.
// These tests give it a release in memory.

const ORIGIN = 'https://notes.example'

const FILES: SiteFiles = {
    home: 'index.html',
    notFound: '404.html',
    gone: '410.html',
    robots: 'robots.txt',
    page: (path) => `page/${path}.html`,
    markdown: (path) => `-/md/${path}`,
    folder: (path) => `folder/${path}.html`,
    choice: (paths) => `choice/${paths.join('+')}.html`
}

const KEY = 'ab'.repeat(32)
const PHOTO = `/-/attachments/${KEY}/photo.png`

const map = resolverMapOf(
    [
        { path: 'Welcome.md', aliases: [] },
        { path: '10 Garden/Compost basics.md', aliases: ['Compost'] }
    ],
    FILES,
    { [PHOTO]: KEY, [`/-/attachments/${KEY}/plan.pdf`]: KEY },
    {},
    [{ path: '10 Garden/Rain barrel.md', aliases: [] }]
)

/** A stored file with a text, and a tag from its text. */
function stored(text: string, tag = `"${text.length.toString(16)}"`): StoredFile {
    const bytes = new TextEncoder().encode(text)
    return {
        size: bytes.length,
        tag,
        read: (range) => (range === undefined ? bytes : bytes.slice(range.start, range.end + 1))
    }
}

/** A release in memory: every file of the map, with its name as its text. */
function release(overrides: Partial<Release> = {}): Release {
    return {
        map,
        file: (name) => Promise.resolve(stored(`file ${name}`)),
        asset: (path) =>
            Promise.resolve(path === '/_astro/site.css' ? stored('body{}') : undefined),
        attachment: (key) => Promise.resolve(key === KEY ? stored('0123456789') : undefined),
        serverErrorPage: '<h1>Server error</h1>',
        ...overrides
    }
}

function get(
    path: string,
    headers: Record<string, string> = {},
    overrides: Partial<Release> = {}
): Promise<Response> {
    return siteHandler(release(overrides))(new Request(`${ORIGIN}${path}`, { headers }))
}

describe('a page', () => {
    test('is the file that the resolver map names, as HTML that a client checks again', async () => {
        const response = await get('/Welcome')
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
        expect(response.headers.get('etag')).toBe('"19"')
        expect(await response.text()).toBe('file page/Welcome.md.html')
    })

    // URL-18: an unchanged page answers 304 to a conditional request.
    test('answers 304 with no body when the request names its tag', async () => {
        const response = await get('/Welcome', { 'if-none-match': 'W/"x", "19"' })
        expect(response.status).toBe(304)
        expect(response.headers.get('etag')).toBe('"19"')
        expect(await response.text()).toBe('')
        expect((await get('/Welcome', { 'if-none-match': '"another"' })).status).toBe(200)
    })

    test('is the same page with a query', async () => {
        const response = await get('/Welcome?utm_source=letter')
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('file page/Welcome.md.html')
    })
})

describe('a file of the site that is not a page', () => {
    test('is Markdown for the Markdown of a note', async () => {
        const response = await get('/-/md/Welcome.md')
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
        expect(await response.text()).toBe('file -/md/Welcome.md')
    })

    test('is plain text for robots.txt', async () => {
        const response = await get('/robots.txt')
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(await response.text()).toBe('file robots.txt')
    })
})

describe('a variant of a path', () => {
    test('answers one redirect to the canonical path, with the cache time of the resolver', async () => {
        const response = await get('/welcome')
        expect(response.status).toBe(301)
        expect(response.headers.get('location')).toBe('/Welcome')
        expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
        expect(await response.text()).toBe('')
    })
})

describe('a path that no note has', () => {
    test('answers 404 with the "not found" page, never kept', async () => {
        const response = await get('/Nothing+here')
        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('vary')).toBe('Accept')
        expect(response.headers.get('etag')).toBeNull()
        expect(await response.text()).toBe('file 404.html')
    })

    test('answers 404 also when the request names the tag of the "not found" page', async () => {
        const response = await get('/Nothing+here', { 'if-none-match': '"d"' })
        expect(response.status).toBe(404)
    })

    // NAV-21: an agent that asks for Markdown gets a short text.
    test('answers a short Markdown text to an agent', async () => {
        const response = await get('/Nothing+here', { accept: 'text/markdown' })
        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('vary')).toBe('Accept')
        const text = await response.text()
        expect(text).toStartWith('# Not found\n\n')
        expect(text).toContain(`[${ORIGIN}/](${ORIGIN}/)`)
    })

    test('answers plain text when the release has no "not found" page', async () => {
        const { notFound: _notFound, ...rest } = map
        const response = await get('/Nothing+here', {}, { map: rest })
        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.text()).toBe('Not found\n')
    })
})

// URL-27: an unpublished note.
describe('the address of an unpublished note', () => {
    test('answers 410 with the gone page, never kept', async () => {
        const response = await get('/10+Garden/Rain+barrel')
        expect(response.status).toBe(410)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('vary')).toBe('Accept')
        expect(await response.text()).toBe('file 410.html')
    })

    test('answers a short Markdown text to an agent', async () => {
        const response = await get('/10+Garden/Rain+barrel', { accept: 'text/markdown' })
        expect(response.status).toBe(410)
        expect(await response.text()).toStartWith('# Removed\n\n')
    })
})

// HOST-05, issue 35.
describe('an attachment', () => {
    test('is the whole file, kept for a year, and it runs no script', async () => {
        const response = await get(PHOTO)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('accept-ranges')).toBe('bytes')
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('content-security-policy')).toBe(
            "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        )
        expect(await response.text()).toBe('0123456789')
    })

    test('has no sandbox when it is a PDF', async () => {
        const response = await get(`/-/attachments/${KEY}/plan.pdf`)
        expect(response.headers.get('content-type')).toBe('application/pdf')
        expect(response.headers.get('content-security-policy')).toBeNull()
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    })

    test.each([
        ['bytes=2-5', '2345', 'bytes 2-5/10'],
        ['bytes=7-', '789', 'bytes 7-9/10'],
        ['bytes=-3', '789', 'bytes 7-9/10'],
        ['bytes=8-99', '89', 'bytes 8-9/10']
    ])('answers 206 with the part of the range %s', async (range, body, contentRange) => {
        const response = await get(PHOTO, { range })
        expect(response.status).toBe(206)
        expect(response.headers.get('content-range')).toBe(contentRange)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(await response.text()).toBe(body)
    })

    test.each(['bytes=10-', 'bytes=5-2', 'bytes=-0'])(
        'answers 416 for the range %s, which is outside the file',
        async (range) => {
            const response = await get(PHOTO, { range })
            expect(response.status).toBe(416)
            expect(response.headers.get('content-range')).toBe('bytes */10')
            expect(await response.text()).toBe('')
        }
    )

    test('is the whole file for several ranges', async () => {
        const response = await get(PHOTO, { range: 'bytes=0-1, 4-5' })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('0123456789')
    })

    test('answers a plain 404 when the host has no attachment storage', async () => {
        const { attachment: _attachment, ...rest } = release()
        const response = await siteHandler(rest)(new Request(`${ORIGIN}${PHOTO}`))
        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
    })
})

describe('a file that the pages load', () => {
    test('comes before the resolver, with the type of its name', async () => {
        const response = await get('/_astro/site.css')
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
        expect(await response.text()).toBe('body{}')
    })
})

// URL-33, NAV-20: a file that the map names and that the release lacks is a
// failure of the release, never "not found" that a cache keeps.
describe('a failure of the release', () => {
    const missing = { file: () => Promise.resolve(undefined) }

    test.each([
        ['a page', '/Welcome'],
        ['a text file', '/robots.txt'],
        ['the "not found" page', '/Nothing+here'],
        ['the gone page', '/10+Garden/Rain+barrel']
    ])('answers 500 with the server error page when %s is missing', async (_name, path) => {
        const response = await get(path, {}, missing)
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('vary')).toBe('Accept')
        expect(await response.text()).toBe('<h1>Server error</h1>')
    })

    test('answers a short Markdown text to an agent that asks for a missing file', async () => {
        const response = await get('/-/md/Welcome.md', {}, missing)
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
        expect(await response.text()).toStartWith('# Server error\n')
    })

    test('answers a short text when the release has no server error page', async () => {
        const { serverErrorPage: _page, ...rest } = release(missing)
        const response = await siteHandler(rest)(new Request(`${ORIGIN}/Welcome`))
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(await response.text()).toStartWith('# Server error\n')
    })

    test('answers 500 when the storage lacks an attachment of the map', async () => {
        const response = await get(PHOTO, {}, { attachment: () => Promise.resolve(undefined) })
        expect(response.status).toBe(500)
        expect(await response.text()).toBe('<h1>Server error</h1>')
    })

    test('answers 500 when a file that the pages load is missing', async () => {
        const response = await get(
            '/_astro/site.css',
            {},
            {
                asset: () => Promise.resolve('missing' as const)
            }
        )
        expect(response.status).toBe(500)
    })

    test('answers 500 with no detail when the host fails, and reports the failure', async () => {
        const reported: unknown[] = []
        const failure = new Error('disk /srv/secret is gone')
        const response = await get(
            '/Welcome',
            {},
            {
                file: () => Promise.reject(failure),
                report: (error) => reported.push(error)
            }
        )
        expect(response.status).toBe(500)
        expect(await response.text()).toBe('<h1>Server error</h1>')
        expect(reported).toEqual([failure])
    })
})
