import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    checkKnownUrls,
    isPrivatePlace,
    knownUrlsFromLines,
    knownUrlsFromList,
    knownUrlsFromSitemap,
    mergeKnownUrls,
    requestPathOf,
    samePath,
    type KnownUrl
} from './url-parity.ts'
import type { Ask } from './url-table.ts'

// The URL parity test (story 161, RES-06, issue 60): every URL that is known
// of the current site, from several sources, asked of a host, with each
// mismatch put in a class. Every path here is invented.

describe('decoded comparison of two paths (RES-06)', () => {
    test.each([
        ['+ and %20 for a space', '/Old+notes/A+b', '/Old%20notes/A%20b'],
        ['a decoded path with spaces', '/Old notes/A b', '/Old+notes/A+b'],
        ['a literal + read as + or as a space', '/Salt+%2B+pepper', '/Salt + pepper'],
        ['the composed and the decomposed Unicode form', '/Cr%C3%A8me', '/Cre%CC%80me'],
        ['a decoded path with a non-ASCII letter', '/Crème', '/Cr%C3%A8me'],
        ['a query that one of them has', '/A?ref=x', '/A'],
        ['a decoded report that shows a + and a space as +', '/25++Years', '/25%2B+Years']
    ])('%s are one path', (_name, one, two) => {
        expect(samePath(one, two)).toBe(true)
    })

    test.each([
        ['two names', '/A', '/B'],
        ['another letter case', '/Notes/A', '/notes/a'],
        ['a percent-encoding that is not UTF-8 and a path', '/%FF', '/A']
    ])('%s are two paths', (_name, one, two) => {
        expect(samePath(one, two)).toBe(false)
    })
})

describe('the path of a request', () => {
    test.each([
        ['an encoded path, as it is', '/Old+notes/A%20b', '/Old+notes/A%20b'],
        ['a decoded path with a space and a letter', '/Old notes/Crème', '/Old%20notes/Cr%C3%A8me'],
        ['a question mark and a hash of a name', '/What?/A#b', '/What%3F/A%23b'],
        ['a percent sign that starts no encoding', '/100% rye', '/100%25%20rye']
    ])('keeps %s', (_name, path, request) => {
        expect(requestPathOf(path)).toBe(request)
    })
})

describe('the sources of known URLs', () => {
    test('the redirect list gives what each row expects', () => {
        const csv = [
            'source_url_path,source,class,target_path,status_code,confidence,note',
            '/A,reports,canonical,/A,200,high,',
            '/Old/B,reports,moved,/New/B,301,high,"a note, with a comma"',
            '/Old/C,reports,dead,,410,,',
            '/Old/D,reports,dead,,,,',
            '/404,reports,generated,,404,high,',
            '/Salt++pepper,reports,canonical,/Salt%2B+pepper,200,high,'
        ].join('\n')
        expect(knownUrlsFromList(csv, 'list')).toEqual([
            { path: '/A', sources: ['list'], expect: { kind: 'page' } },
            { path: '/Old/B', sources: ['list'], expect: { kind: 'redirect', to: '/New/B' } },
            { path: '/Old/C', sources: ['list'], expect: { kind: 'gone' } },
            { path: '/Old/D', sources: ['list'], expect: { kind: 'pending' } },
            { path: '/404', sources: ['list'], expect: { kind: 'not-found' } },
            // A path that a report shows decoded is asked in its canonical form.
            { path: '/Salt%2B+pepper', sources: ['list'], expect: { kind: 'page' } }
        ])
    })

    test('a list without the columns of the redirect list is refused', () => {
        expect(() => knownUrlsFromList('path,status\n/A,200\n', 'list')).toThrow(
            'the columns source_url_path, target_path and status_code'
        )
    })

    test('a sitemap and a list of lines give URLs that must work', () => {
        const xml =
            '<urlset><url><loc>https://notes.example.org/A+b</loc></url>' +
            '<url><loc>https://notes.example.org/C?x=1&amp;y=2</loc></url></urlset>'
        expect(knownUrlsFromSitemap(xml, 'sitemap')).toEqual([
            { path: '/A+b', sources: ['sitemap'], expect: { kind: 'works' } },
            { path: '/C', sources: ['sitemap'], expect: { kind: 'works' } }
        ])
        expect(
            knownUrlsFromLines('# a comment\n/D\n\nhttps://notes.example.org/E%20f\n', 'crawl')
        ).toEqual([
            { path: '/D', sources: ['crawl'], expect: { kind: 'works' } },
            { path: '/E%20f', sources: ['crawl'], expect: { kind: 'works' } }
        ])
    })

    test('one path of several sources is asked one time, with the most precise expectation', () => {
        const merged = mergeKnownUrls([
            knownUrlsFromLines('/A\n/B\n', 'crawl'),
            [{ path: '/A', sources: ['list'], expect: { kind: 'redirect', to: '/C' } }]
        ])
        expect(merged).toEqual([
            { path: '/A', sources: ['crawl', 'list'], expect: { kind: 'redirect', to: '/C' } },
            { path: '/B', sources: ['crawl'], expect: { kind: 'works' } }
        ])
    })

    test('two paths that share any decoded form are one URL', () => {
        // A literal + and two spaces: the third reading of the first path is
        // the only form of the second.
        const merged = mergeKnownUrls([
            knownUrlsFromLines('/Salt+%2B+pepper\n', 'crawl'),
            knownUrlsFromLines('/Salt%20%20%20pepper\n', 'report')
        ])
        expect(merged).toEqual([
            { path: '/Salt+%2B+pepper', sources: ['crawl', 'report'], expect: { kind: 'works' } }
        ])
    })

    test('two exact expectations of one URL that differ are a conflict', () => {
        const merged = mergeKnownUrls([
            [
                { path: '/Old/A', sources: ['list'], expect: { kind: 'redirect', to: '/New/A' } },
                { path: '/Old/B', sources: ['list'], expect: { kind: 'page' } },
                { path: '/Old/C', sources: ['list'], expect: { kind: 'redirect', to: '/New/C' } }
            ],
            [
                { path: '/Old/A', sources: ['other'], expect: { kind: 'redirect', to: '/New/Z' } },
                { path: '/Old/B', sources: ['other'], expect: { kind: 'gone' } },
                { path: '/Old/C', sources: ['other'], expect: { kind: 'redirect', to: '/New%2FC' } }
            ]
        ])
        expect(merged.map((url) => url.conflict === true)).toEqual([true, true, false])
    })

    // The canonical form of a URL is a page, and another form of it leads
    // there: both can hold.
    test('a page and a redirect of another form of it to the page are no conflict', () => {
        const merged = mergeKnownUrls([
            [
                { path: '/A+b', sources: ['list'], expect: { kind: 'page' } },
                { path: '/A%20b', sources: ['list'], expect: { kind: 'redirect', to: '/A+b' } }
            ]
        ])
        expect(merged).toEqual([{ path: '/A+b', sources: ['list'], expect: { kind: 'page' } }])
    })

    test('two encodings of one decoded path are one URL', () => {
        const merged = mergeKnownUrls([
            knownUrlsFromLines('/Old+notes/A+b\n', 'crawl'),
            [{ path: '/Old%20notes/A%20b', sources: ['list'], expect: { kind: 'page' } }],
            knownUrlsFromSitemap('<loc>https://notes.example.org/Old notes/A b</loc>', 'sitemap')
        ])
        expect(merged).toEqual([
            {
                path: '/Old+notes/A+b',
                sources: ['crawl', 'list', 'sitemap'],
                expect: { kind: 'page' }
            }
        ])
    })

    // A source says that a URL works and the list says that it is gone or
    // not found: one of them is wrong, and the run says so.
    test('a URL that must work and that the list says is gone is a conflict', async () => {
        const merged = mergeKnownUrls([
            knownUrlsFromLines('/Old/A\n/Old/B\n', 'crawl'),
            [
                { path: '/Old/A', sources: ['list'], expect: { kind: 'gone' } },
                { path: '/Old/B', sources: ['list'], expect: { kind: 'not-found' } }
            ]
        ])
        const result = await checkKnownUrls(merged, hostOf({}), { concurrency: 1 })
        expect(result.checks.map((check) => check.verdict)).toEqual(['conflict', 'conflict'])
        expect(result.failed).toBe(2)
    })
})

describe('the place of a report', () => {
    const root = join(fileURLToPath(new URL('..', import.meta.url)), '.cache')
    let clone = ''
    let outside = ''

    beforeAll(async () => {
        await mkdir(root, { recursive: true })
        clone = await mkdtemp(join(root, 'report-place-spec-'))
        outside = await mkdtemp(join(root, 'report-place-outside-'))
        await mkdir(join(clone, '.private'))
        await mkdir(join(clone, '..dots'))
    })

    afterAll(async () => {
        await rm(clone, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
    })

    test.each([
        ['outside the clone', () => join(outside, 'report.json'), true],
        ['in the private folder of the clone', () => join(clone, '.private', 'report.json'), true],
        ['in the clone', () => join(clone, 'report.json'), false],
        [
            'in a folder of the clone whose name starts with two dots',
            () => join(clone, '..dots', 'report.json'),
            false
        ],
        ['in a folder that does not exist', () => join(clone, 'missing', 'report.json'), false],
        ['named as the private folder itself', () => join(clone, '.private'), false]
    ])('%s', async (_name, file, allowed) => {
        expect(await isPrivatePlace(file(), clone)).toBe(allowed)
    })
})

/** A host of answers by path, as `Ask` gives them. */
function hostOf(answers: Record<string, () => Response>): Ask {
    return (path) => Promise.resolve(answers[path]?.() ?? new Response(null, { status: 404 }))
}

const PAGE = (): Response =>
    new Response('<main><h1>A note</h1></main>', {
        headers: { 'content-type': 'text/html; charset=utf-8' }
    })
const MOVED = (location: string) => (): Response =>
    new Response(null, { status: 301, headers: { location } })

describe('the check of known URLs against a host', () => {
    const host = hostOf({
        '/A': PAGE,
        '/A%20b': MOVED('/A+b'),
        '/A+b': PAGE,
        '/Old/B': MOVED('/New/B'),
        '/New/B': PAGE,
        '/Old/Wrong': MOVED('/New/B'),
        '/Old/Chain': MOVED('/Old/B'),
        '/Gone': () => new Response(null, { status: 410 }),
        '/Shell': () => new Response('<main></main>', { headers: { 'content-type': 'text/html' } }),
        '/Broken': () => new Response(null, { status: 500 }),
        '/Away': MOVED('https://shop.example.org/a'),
        '/Q%3Fref%3Dx': MOVED('/Q?ref=x'),
        '/Q?ref=x': PAGE,
        '/-/md/A.md': () =>
            new Response('# A', { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
    })
    const urls: KnownUrl[] = [
        { path: '/A', sources: ['list'], expect: { kind: 'page' } },
        { path: '/A%20b', sources: ['list'], expect: { kind: 'page' } },
        { path: '/Old/B', sources: ['list'], expect: { kind: 'redirect', to: '/New/B' } },
        { path: '/Old/Wrong', sources: ['list'], expect: { kind: 'redirect', to: '/Other' } },
        { path: '/Old/Chain', sources: ['crawl'], expect: { kind: 'works' } },
        { path: '/Gone', sources: ['list'], expect: { kind: 'gone' } },
        { path: '/Gone', sources: ['sitemap'], expect: { kind: 'works' } },
        { path: '/Missing', sources: ['sitemap'], expect: { kind: 'works' } },
        { path: '/Missing', sources: ['list'], expect: { kind: 'not-found' } },
        { path: '/Shell', sources: ['list'], expect: { kind: 'page' } },
        { path: '/Broken', sources: ['crawl'], expect: { kind: 'works' } },
        { path: '/Pending', sources: ['list'], expect: { kind: 'pending' } },
        {
            path: '/Away',
            sources: ['list'],
            expect: { kind: 'redirect', to: 'https://shop.example.org/a' }
        },
        { path: '/Q%3Fref%3Dx', sources: ['list'], expect: { kind: 'redirect', to: '/Q' } },
        { path: '/-/md/A.md', sources: ['list'], expect: { kind: 'page' } }
    ]

    test('puts each URL in a class, and counts the classes of each source', async () => {
        const result = await checkKnownUrls(urls, host, { concurrency: 3 })
        expect(result.checks.map((check) => [check.url.path, check.verdict])).toEqual([
            ['/A', 'ok'],
            ['/A%20b', 'ok'],
            ['/Old/B', 'ok'],
            ['/Old/Wrong', 'wrong-target'],
            ['/Old/Chain', 'chain'],
            ['/Gone', 'ok'],
            ['/Gone', 'gone'],
            ['/Missing', 'not-found'],
            ['/Missing', 'ok'],
            ['/Shell', 'no-content'],
            ['/Broken', 'server-error'],
            ['/Pending', 'pending'],
            ['/Away', 'ok'],
            ['/Q%3Fref%3Dx', 'ok'],
            ['/-/md/A.md', 'ok']
        ])
        expect(result.counts).toEqual({
            list: { 'ok': 8, 'wrong-target': 1, 'no-content': 1, 'pending': 1 },
            crawl: { 'chain': 1, 'server-error': 1 },
            sitemap: { 'gone': 1, 'not-found': 1 }
        })
        expect(result.failed).toBe(6)
        expect(result.pending).toBe(1)
    })

    test('a host that does not answer is a class of its own', async () => {
        const silent: Ask = () => Promise.reject(new Error('refused'))
        const result = await checkKnownUrls(urls.slice(0, 1), silent, { concurrency: 1 })
        expect(result.checks[0]?.verdict).toBe('no-answer')
    })
})
