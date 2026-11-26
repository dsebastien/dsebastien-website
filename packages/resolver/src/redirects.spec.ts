import { describe, expect, test } from 'bun:test'
import { applyRedirectList, redirectListFrom, type RedirectList } from './redirects.ts'
import { resolve, type Resolution, type ResolverMap } from './resolver.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'

// The redirect list (issue 44, section 10.3 of the spec): the rows that the
// content store holds in `redirects.json`, read strictly, and put into the
// resolver map by the build. The URL table has the answers of each kind of
// row (`fixtures/urls.json`); this file has the reader and the rules of the
// build.

const FILES: SiteFiles = {
    home: 'index.html',
    notFound: '404.html',
    gone: '410.html',
    robots: 'robots.txt',
    page: (path) => `page:${path}`,
    markdown: (path) => `markdown:${path}`,
    folder: (path) => `folder:${path}`,
    choice: (paths) => `choice:${paths.join('|')}`
}

const NOTES = [
    { path: 'Garden/Compost.md', aliases: [] },
    { path: 'Garden/Thyme.md', aliases: [], formerPaths: ['Beds/Thyme plant.md'] }
]
const REMOVED = [{ path: 'Garden/Trellis.md', aliases: ['Bean frame'] }]

function mapOf(list: RedirectList): { map: ResolverMap; shadowed: number; deadTarget: number } {
    const base = resolverMapOf(NOTES, FILES, {}, { '/-/recent/added': 'recent.html' }, REMOVED)
    const applied = applyRedirectList(base, list)
    // Through JSON, as the build writes the map and the server reads it.
    return {
        map: JSON.parse(JSON.stringify(applied.map)) as ResolverMap,
        shadowed: applied.dropped.shadowed,
        deadTarget: applied.dropped.deadTarget
    }
}

const EMPTY: RedirectList = { redirects: [], gone: [], prefixes: [] }
const REDIRECT = (location: string): Resolution => ({
    kind: 'redirect',
    status: 301,
    location,
    cacheControl: 'public, max-age=3600'
})

describe('reader of the redirect list', () => {
    test('reads the three parts, each one optional', () => {
        expect(redirectListFrom({ version: 1 })).toEqual(EMPTY)
        expect(
            redirectListFrom({
                version: 1,
                redirects: [{ from: 'Old/Name', to: '/Garden/Compost' }],
                gone: ['Old/Gone'],
                prefixes: [{ from: 'Old docs/', to: 'https://example.org/docs' }]
            })
        ).toEqual({
            redirects: [{ from: 'Old/Name', to: '/Garden/Compost' }],
            gone: ['Old/Gone'],
            prefixes: [{ from: 'Old docs/', to: 'https://example.org/docs' }]
        })
    })

    test.each([
        ['a value that is no object', []],
        ['another version', { version: 2 }],
        ['no version', {}],
        ['an unknown key', { version: 1, extra: [] }],
        ['a row with an unknown key', { version: 1, redirects: [{ from: 'A', to: '/B', x: 1 }] }],
        ['a row with no target', { version: 1, redirects: [{ from: 'A' }] }],
        [
            'an old path with a slash at its start',
            { version: 1, redirects: [{ from: '/A', to: '/B' }] }
        ],
        [
            'an old path with a slash at its end',
            { version: 1, redirects: [{ from: 'A/', to: '/B' }] }
        ],
        ['an old path with an empty part', { version: 1, gone: ['A//B'] }],
        ['an old path under the generated prefix', { version: 1, gone: ['-/recent'] }],
        ['an empty old path', { version: 1, gone: [''] }],
        ['a target that is no path', { version: 1, redirects: [{ from: 'A', to: 'B' }] }],
        ['a target with a fragment', { version: 1, redirects: [{ from: 'A', to: '/B#c' }] }],
        [
            'a target on a host without TLS',
            { version: 1, redirects: [{ from: 'A', to: 'http://example.org/' }] }
        ],
        [
            'a prefix without a slash at its end',
            { version: 1, prefixes: [{ from: 'Old', to: '/B' }] }
        ],
        [
            'two rows with one folded old path',
            { version: 1, redirects: [{ from: 'Old/Name', to: '/B' }], gone: ['old/NAME'] }
        ],
        [
            'two prefix rules with one folded prefix',
            {
                version: 1,
                prefixes: [
                    { from: 'Old/', to: '/B' },
                    { from: 'OLD/', to: '/C' }
                ]
            }
        ]
    ])('refuses %s', (_name, value) => {
        expect(() => redirectListFrom(value)).toThrow(/redirects\.json/u)
    })
})

describe('redirect list in the resolver map', () => {
    test('an old path leads to its target in one redirect, in every reading', () => {
        const { map } = mapOf({
            ...EMPTY,
            redirects: [{ from: 'Old Beds/Compost heap', to: '/Garden/Compost' }]
        })
        for (const path of [
            '/Old+Beds/Compost+heap',
            '/old%20beds/COMPOST%20HEAP.md',
            '/Old+Beds/Compost+heap/'
        ]) {
            expect(resolve(path, map)).toEqual(REDIRECT('/Garden/Compost'))
        }
        expect(resolve('/Old+Beds/Compost+heap', map, '?ref=letter')).toEqual(
            REDIRECT('/Garden/Compost?ref=letter')
        )
    })

    test('a target with a query of its own gets the query of the request after it', () => {
        const { map } = mapOf({
            ...EMPTY,
            redirects: [{ from: 'Shop', to: 'https://example.org/shop?lang=en' }]
        })
        expect(resolve('/Shop', map, '?ref=letter')).toEqual(
            REDIRECT('https://example.org/shop?lang=en&ref=letter')
        )
    })

    test('a published note, a folder and a former path win: the build drops the row', () => {
        const { map, shadowed } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Garden/compost', to: '/-/recent/added' },
                { from: 'Garden', to: '/-/recent/added' },
                { from: 'Beds/Thyme plant', to: '/-/recent/added' }
            ],
            gone: ['GARDEN/THYME']
        })
        expect(shadowed).toBe(4)
        expect(resolve('/Garden/compost', map)).toEqual(REDIRECT('/Garden/Compost'))
        expect(resolve('/Beds/Thyme+plant', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Garden/Thyme', map)).toEqual({
            kind: 'page',
            file: 'page:Garden/Thyme.md'
        })
    })

    test('a row whose target is not live is dropped', () => {
        const { map, deadTarget } = mapOf({
            ...EMPTY,
            redirects: [{ from: 'Old/Trellis', to: '/Garden/Trellis' }],
            prefixes: [{ from: 'Old docs/', to: '/Garden/No+such+note' }]
        })
        expect(deadTarget).toBe(2)
        expect(resolve('/Old/Trellis', map)).toEqual({
            kind: 'not-found',
            suggestions: [],
            file: '404.html'
        })
        expect(resolve('/Old+docs/Any', map)).toEqual({
            kind: 'not-found',
            suggestions: [],
            file: '404.html'
        })
        // The map holds nothing of a dropped row.
        expect(JSON.stringify(map)).not.toContain('Trellis')
    })

    test('a row wins over an address of an unpublished note', () => {
        expect(resolve('/Bean+frame', mapOf(EMPTY).map)).toEqual({ kind: 'gone', file: '410.html' })
        const { map } = mapOf({
            ...EMPTY,
            redirects: [{ from: 'Bean frame', to: '/Garden/Compost' }]
        })
        expect(resolve('/Bean+frame', map)).toEqual(REDIRECT('/Garden/Compost'))
    })

    test('a gone row answers 410 in every reading, and the map holds only its key', () => {
        const { map } = mapOf({ ...EMPTY, gone: ['Publish/Old stats'] })
        for (const path of [
            '/Publish/Old+stats',
            '/publish/old%20STATS',
            '/Publish/Old+stats.md'
        ]) {
            expect(resolve(path, map)).toEqual({ kind: 'gone', file: '410.html' })
        }
        expect(JSON.stringify(map).toLowerCase()).not.toContain('old stats')
    })

    test('the longest prefix wins, after every exact row and after gone', () => {
        const { map } = mapOf({
            redirects: [{ from: 'Old docs/How-to/Known', to: '/Garden/Thyme' }],
            gone: ['Old docs/Removed'],
            prefixes: [
                { from: 'Old docs/', to: '/' },
                { from: 'Old docs/How-to/', to: '/Garden/Compost' }
            ]
        })
        expect(resolve('/Old+docs/How-to/Anything', map)).toEqual(REDIRECT('/Garden/Compost'))
        expect(resolve('/Old+docs/How-to/Known', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Old+docs/Other', map)).toEqual(REDIRECT('/'))
        expect(resolve('/Old+docs/Removed', map)).toEqual({ kind: 'gone', file: '410.html' })
        expect(resolve('/Old+docs/', map)).toEqual({
            kind: 'not-found',
            suggestions: [],
            file: '404.html'
        })
        expect(resolve('/Old+docs', map)).toEqual({
            kind: 'not-found',
            suggestions: [],
            file: '404.html'
        })
    })

    test('a query encoded into the path goes back into a real query', () => {
        const { map } = mapOf(EMPTY)
        expect(resolve('/Garden/Compost%3Fref%3Dexample.org', map)).toEqual(
            REDIRECT('/Garden/Compost?ref=example.org')
        )
        expect(resolve('/Garden/Compost%3Fref%3Da%20b', map, '?utm=x')).toEqual(
            REDIRECT('/Garden/Compost?ref=a+b&utm=x')
        )
        expect(resolve('/Nothing%3Fref%3Dexample.org', map).kind).toBe('not-found')
    })

    test('a map without a redirect list answers as before', () => {
        const base = resolverMapOf(NOTES, FILES, {}, {}, REMOVED)
        expect(applyRedirectList(base, EMPTY).map).toEqual({
            ...base,
            redirects: { folded: {}, prefixes: [] }
        })
    })
})
