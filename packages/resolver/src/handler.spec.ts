import { describe, expect, test } from 'bun:test'
import { failureResponse, siteHandler, type Release, type StoredFile } from './handler.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'
import { SITE_ORIGIN } from './url.ts'
import { variantKey, variantPath } from './variants.ts'

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
    icon: 'favicon.ico',
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

    // A host or a proxy that compresses a page makes its tag weak, and a
    // client can ask for any version (RFC 9110, section 13.1.2).
    test.each(['W/"19"', '*', '"a", W/"19"'])(
        'answers 304 for the weak form of its tag: %s',
        async (wanted) => {
            expect((await get('/Welcome', { 'if-none-match': wanted })).status).toBe(304)
        }
    )

    test('answers 304 when the host gives a weak tag and the request names its strong form', async () => {
        const weak = { file: () => Promise.resolve(stored('page', 'W/"abc"')) }
        expect((await get('/Welcome', { 'if-none-match': '"abc"' }, weak)).status).toBe(304)
        expect((await get('/Welcome', { 'if-none-match': '"abcd"' }, weak)).status).toBe(200)
    })

    // Issue 117: the header is read by its quoted tags, not cut at each comma.
    test.each(['"a,b"', '"x", "a,b"', 'W/"a,b"', '"x",W/"a,b" , "y"'])(
        'answers 304 for a tag that holds a comma: %s',
        async (wanted) => {
            const comma = { file: () => Promise.resolve(stored('page', '"a,b"')) }
            expect((await get('/Welcome', { 'if-none-match': wanted }, comma)).status).toBe(304)
        }
    )

    test.each(['"a"', '"b"', '"a", "b"', 'a,b'])(
        'does not answer 304 for a part of a tag that holds a comma: %s',
        async (wanted) => {
            const comma = { file: () => Promise.resolve(stored('page', '"a,b"')) }
            expect((await get('/Welcome', { 'if-none-match': wanted }, comma)).status).toBe(200)
        }
    )

    // A header that is not a list of quoted tags names no tag; `*` counts only as the whole header.
    test.each(['foo*bar', '"x"*', 'x"abc"', 'w/"abc"', '"x", *', '"abc" x'])(
        'does not answer 304 for a header that is not a list of tags: %s',
        async (wanted) => {
            const plain = { file: () => Promise.resolve(stored('page', '"abc"')) }
            expect((await get('/Welcome', { 'if-none-match': wanted }, plain)).status).toBe(200)
        }
    )

    test('has no tag and never answers 304 when the host gives none', async () => {
        const untagged = {
            file: () => {
                const { tag: _tag, ...rest } = stored('page')
                return Promise.resolve(rest)
            }
        }
        const response = await get('/Welcome', { 'if-none-match': '""' }, untagged)
        expect(response.status).toBe(200)
        expect(response.headers.get('etag')).toBeNull()
        expect((await get('/Welcome', { 'if-none-match': '*' }, untagged)).status).toBe(200)
    })

    test('lets go of a file that it does not read', async () => {
        let discarded = 0
        const counted = {
            file: () =>
                Promise.resolve({
                    ...stored('page', '"p"'),
                    discard: () => {
                        discarded += 1
                    }
                })
        }
        await get('/Welcome', { 'if-none-match': '"p"' }, counted)
        expect(discarded).toBe(1)
        await (await get('/Welcome', {}, counted)).text()
        expect(discarded).toBe(1)
    })

    test('reads no byte of a file for a request of the headers only', async () => {
        let read = 0
        let discarded = 0
        const counted: Partial<Release> = {
            file: () =>
                Promise.resolve({
                    size: 4,
                    tag: '"p"',
                    read: () => {
                        read += 1
                        return 'page'
                    },
                    discard: () => {
                        discarded += 1
                    }
                })
        }
        const response = await siteHandler(release(counted))(
            new Request(`${ORIGIN}/Welcome`, { method: 'HEAD' })
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('etag')).toBe('"p"')
        expect(response.headers.get('content-length')).toBe('4')
        expect(await response.text()).toBe('')
        expect([read, discarded]).toEqual([0, 1])
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

    // IDX-16: the Markdown form stays out of the index and names its page.
    test('says noindex for the Markdown of a note, with a canonical link to its page', async () => {
        for (const path of ['/-/md/Welcome.md', '/-/md/10+Garden/Compost+basics.md']) {
            const response = await get(path)
            expect(response.headers.get('x-robots-tag')).toBe('noindex')
            expect(response.headers.get('link')).toBe(
                `<${new URL(path.slice('/-/md'.length, -'.md'.length), SITE_ORIGIN).href}>; rel="canonical"`
            )
        }
        const head = await siteHandler(release())(
            new Request(`${ORIGIN}/-/md/Welcome.md`, { method: 'HEAD' })
        )
        expect(head.headers.get('x-robots-tag')).toBe('noindex')
    })

    test('is XML for a sitemap, and plain text for the IndexNow key file', async () => {
        const root = resolverMapOf([], {
            ...FILES,
            root: {
                '/sitemap.xml': { file: 'sitemap.xml', type: 'xml' },
                '/0123abcd.txt': { file: '0123abcd.txt', type: 'text' }
            }
        })
        const sitemap = await get('/sitemap.xml', {}, { map: root })
        expect(sitemap.status).toBe(200)
        expect(sitemap.headers.get('content-type')).toBe('application/xml; charset=utf-8')
        expect(sitemap.headers.get('x-robots-tag')).toBeNull()
        const key = await get('/0123abcd.txt', {}, { map: root })
        expect(key.status).toBe(200)
        expect(key.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    })

    test('says nothing of the index for robots.txt and the icon', async () => {
        for (const path of ['/robots.txt', '/favicon.ico']) {
            const response = await get(path)
            expect(response.headers.get('x-robots-tag')).toBeNull()
            expect(response.headers.get('link')).toBeNull()
        }
    })

    test('is plain text for robots.txt', async () => {
        const response = await get('/robots.txt')
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(await response.text()).toBe('file robots.txt')
    })

    // Issue 133: a client that asks for the icon without a link gets it, and
    // checks it again at each use, as every file of the release.
    test('is an icon for favicon.ico, with its tag', async () => {
        const response = await get('/favicon.ico')
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/x-icon')
        expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
        expect(response.headers.get('etag')).toBe('"10"')
        expect(await response.text()).toBe('file favicon.ico')
        expect((await get('/favicon.ico', { 'if-none-match': '"10"' })).status).toBe(304)
    })
})

// STORE-08: the record of the deployment says what is live. The deployment
// writes it after the build, so the resolver map never names it.
describe('the deployment record', () => {
    test('is the JSON file of the release, never kept', async () => {
        const response = await get('/-/deployment.json')
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('etag')).toBeNull()
        expect(await response.text()).toBe('file -/deployment.json')
    })

    test('is never 304, also when the request names its tag', async () => {
        const response = await get('/-/deployment.json', { 'if-none-match': '*' })
        expect(response.status).toBe(200)
    })

    test('has its size and no byte for a request of the headers only', async () => {
        const response = await siteHandler(release())(
            new Request(`${ORIGIN}/-/deployment.json`, { method: 'HEAD' })
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('content-length')).toBe('22')
        expect(await response.text()).toBe('')
    })

    test('answers "not found" when the release has none', async () => {
        const response = await get(
            '/-/deployment.json',
            {},
            {
                file: (name) =>
                    Promise.resolve(name === '-/deployment.json' ? undefined : stored(name))
            }
        )
        expect(response.status).toBe(404)
        expect(response.headers.get('cache-control')).toBe('no-store')
    })

    test('has no variant', async () => {
        expect((await get('/-/Deployment.json')).status).toBe(404)
        expect((await get('/-/deployment.json/')).status).toBe(404)
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
        expect(text).toContain(`[${ORIGIN}/](<${ORIGIN}/>)`)
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

    test('lets go of a file when the range is outside of it', async () => {
        let discarded = 0
        const response = await get(
            PHOTO,
            { range: 'bytes=10-' },
            {
                attachment: () =>
                    Promise.resolve({
                        ...stored('0123456789'),
                        discard: () => {
                            discarded += 1
                        }
                    })
            }
        )
        expect(response.status).toBe(416)
        expect(discarded).toBe(1)
    })

    test.each([
        [{}, 200, '10'],
        [{ range: 'bytes=2-5' }, 206, '4']
    ])(
        'says the size of what a request of the headers only asks for: %j',
        async (headers, status, length) => {
            const response = await siteHandler(release())(
                new Request(`${ORIGIN}${PHOTO}`, { method: 'HEAD', headers })
            )
            expect(response.status).toBe(status)
            expect(response.headers.get('content-length')).toBe(length)
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

    // Astro names a file of `/_astro/` with a hash of its bytes; the files of
    // the search keep their names. The host gives the same headers.
    test.each([
        ['/_astro/icon.abc.svg', 'image/svg+xml', 'public, max-age=31536000, immutable'],
        ['/_astro/touch.abc.png', 'image/png', 'public, max-age=31536000, immutable'],
        [
            '/-/search/titles.json',
            'application/json; charset=utf-8',
            'public, max-age=0, must-revalidate'
        ]
    ])('%s has its type and its cache time', async (path, type, cache) => {
        const response = await get(path, {}, { asset: () => Promise.resolve(stored('x')) })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(type)
        expect(response.headers.get('cache-control')).toBe(cache)
    })
})

describe('a file that the pages load, by the end of its name', () => {
    // The names of the build are in small letters: another letter case is no known kind.
    test('is plain bytes when the end of its name is in capital letters', async () => {
        const response = await get(
            '/_astro/ODD.CSS',
            {},
            {
                asset: () => Promise.resolve(stored('body{}'))
            }
        )
        expect(response.headers.get('content-type')).toBe('application/octet-stream')
    })
})

describe('the answer of a failure outside of the handler', () => {
    test('is the server error page, or a short Markdown text for an agent', async () => {
        const page = failureResponse(new Request(`${ORIGIN}/Welcome`), '<h1>Server error</h1>')
        expect(page.status).toBe(500)
        expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(page.headers.get('cache-control')).toBe('no-store')
        expect(page.headers.get('vary')).toBe('Accept')
        expect(await page.text()).toBe('<h1>Server error</h1>')
        const agent = failureResponse(new Request(`${ORIGIN}/-/md/Welcome.md`), '<h1>x</h1>')
        expect(agent.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
        expect(await agent.text()).toStartWith('# Server error\n')
        const plain = failureResponse(new Request(`${ORIGIN}/Welcome`))
        expect(plain.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(await plain.text()).toStartWith('# Server error\n')
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

    // Issue 87, R92: a variant never fails a page. The map does not say the
    // width of an image, and a variant that could not be made is missing:
    // the host gives the file of the image, kept one hour only.
    test('gives a variant of an image in WebP, and the image when the storage lacks the variant', async () => {
        const variants = {
            attachment: (key: string) =>
                Promise.resolve(
                    key === variantKey(KEY, 480)
                        ? stored('webp')
                        : key === KEY
                          ? stored('png')
                          : undefined
                )
        }
        const response = await get(variantPath(PHOTO, 480), {}, variants)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/webp')
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        expect(await response.text()).toBe('webp')

        const image = await get(variantPath(PHOTO, 1600), {}, variants)
        expect(image.status).toBe(200)
        expect(image.headers.get('content-type')).toBe('image/png')
        expect(image.headers.get('cache-control')).toBe('public, max-age=3600')
        expect(await image.text()).toBe('png')
    })

    test('answers 500 when the storage lacks a variant and its image', async () => {
        const response = await get(
            variantPath(PHOTO, 480),
            {},
            { attachment: () => Promise.resolve(undefined) }
        )
        expect(response.status).toBe(500)
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

// Issue 102: the origin of the Markdown texts is the origin of the host,
// never a header of the request, and a request URL that does not parse is
// the fault of the client.
describe('the origin of the error texts', () => {
    const SITE = 'https://site.example'

    test('is the origin of the release when it has one', async () => {
        for (const path of ['/Nothing+here', '/10+Garden/Rain+barrel']) {
            const text = await (
                await get(path, { accept: 'text/markdown' }, { origin: SITE })
            ).text()
            expect(text).toContain(`[${SITE}/](<${SITE}/>)`)
            expect(text).not.toContain(ORIGIN)
        }
        const failure = await (
            await get(
                '/Welcome',
                { accept: 'text/markdown' },
                { origin: SITE, file: () => Promise.resolve(undefined) }
            )
        ).text()
        expect(failure).toContain(`[${SITE}/](<${SITE}/>)`)
    })

    test('is the origin of the release for a failure outside of the handler', async () => {
        const text = await failureResponse(
            new Request(`${ORIGIN}/-/md/Welcome.md`),
            undefined,
            SITE
        ).text()
        expect(text).toContain(`[${SITE}/](<${SITE}/>)`)
        expect(text).not.toContain(ORIGIN)
    })

    // A plain server builds the URL from the `Host` header: `[bad` gives a
    // URL that does not parse.
    test('answers 400 to a request URL that does not parse', async () => {
        const request = { url: 'http://[bad/Welcome', headers: new Headers() } as Request
        for (const response of [
            await siteHandler(release())(request),
            failureResponse(request, '<h1>Server error</h1>', SITE)
        ]) {
            expect(response.status).toBe(400)
            expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
            expect(response.headers.get('cache-control')).toBe('no-store')
            expect(await response.text()).toBe('Bad request\n')
        }
    })
})

describe('a release with its map in parts (issue 121)', () => {
    test('answers through the lookup of the release, with the query of the request', async () => {
        const asked: string[] = []
        const response = await get(
            '/welcome?ref=site',
            {},
            {
                map: (path, query) => {
                    asked.push(`${path}${query}`)
                    return Promise.resolve({ kind: 'page', file: 'page/Welcome.md.html' })
                }
            }
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('file page/Welcome.md.html')
        expect(asked).toEqual(['/welcome?ref=site'])
    })

    test('a lookup that fails gives the server error page', async () => {
        const reported: unknown[] = []
        const response = await get(
            '/Welcome',
            {},
            {
                map: () => Promise.reject(new Error('a part of the map fails to load')),
                report: (error) => reported.push(error)
            }
        )
        expect(response.status).toBe(500)
        expect(await response.text()).toBe('<h1>Server error</h1>')
        expect(reported).toHaveLength(1)
    })
})
