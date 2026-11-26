import { describe, expect, test } from 'bun:test'
import { applyRedirectList, redirectListFrom, type RedirectList } from './redirects.ts'
import { foldedForm, resolve, type Resolution, type ResolverMap } from './resolver.ts'
import { resolverMapOf, type SiteFiles, type SiteNote } from './site.ts'

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

const NOTES: SiteNote[] = [
    { path: 'Garden/Compost.md', aliases: ['Humus'] },
    { path: 'Garden/Thyme.md', aliases: [], formerPaths: ['Beds/Thyme plant.md'] }
]
const REMOVED: SiteNote[] = [{ path: 'Garden/Trellis.md', aliases: ['Bean frame'] }]

interface Applied {
    map: ResolverMap
    shadowed: number
    deadTarget: number
    hidesNameOrAlias: number
}

function mapOf(
    list: RedirectList,
    notes: readonly SiteNote[] = NOTES,
    removed: readonly SiteNote[] = REMOVED
): Applied {
    const base = resolverMapOf(notes, FILES, {}, { '/-/recent/added': 'recent.html' }, removed)
    const applied = applyRedirectList(base, list)
    // Through JSON, as the build writes the map and the server reads it.
    return {
        map: JSON.parse(JSON.stringify(applied.map)) as ResolverMap,
        shadowed: applied.dropped.shadowed,
        deadTarget: applied.dropped.deadTarget,
        hidesNameOrAlias: applied.hidesNameOrAlias
    }
}

const EMPTY: RedirectList = { redirects: [], gone: [], prefixes: [] }
const REDIRECT = (location: string): Resolution => ({
    kind: 'redirect',
    status: 301,
    location,
    cacheControl: 'public, max-age=3600'
})
const NOT_FOUND: Resolution = { kind: 'not-found', suggestions: [], file: '404.html' }
const GONE: Resolution = { kind: 'gone', file: '410.html' }

/** The message of the refusal of a value. */
function refusalOf(value: unknown): string {
    try {
        redirectListFrom(value)
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
    return ''
}

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
        ['an old path that is still encoded', { version: 1, gone: ['Old%20notes/A'] }],
        ['an old path with a .md ending', { version: 1, gone: ['Old/A.md'] }],
        [
            'an old path with a .MD ending',
            { version: 1, redirects: [{ from: 'Old/A.MD', to: '/B' }] }
        ],
        [
            'a prefix that is still encoded',
            { version: 1, prefixes: [{ from: 'Old%2Fdocs/', to: '/B' }] }
        ],
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
        expect(refusalOf(value)).toContain('redirects.json')
    })

    // The message of the build can reach a report: it names the row, never its path.
    test('names the row and the part of a refusal, never its path', () => {
        const slash = refusalOf({
            version: 1,
            redirects: [
                { from: 'Fine/Row', to: '/B' },
                { from: 'Secret folder/', to: '/B' }
            ]
        })
        expect(slash).toContain('row 2 of redirects')
        expect(slash).not.toContain('Secret')
        const twice = refusalOf({
            version: 1,
            redirects: [{ from: 'Secret/Name', to: '/B' }],
            gone: ['secret/NAME']
        })
        expect(twice).toContain('row 1 of gone')
        expect(twice).toContain('row 1 of redirects')
        expect(twice.toLowerCase()).not.toContain('secret')
        const target = refusalOf({ version: 1, prefixes: [{ from: 'Secret/', to: 'B secret' }] })
        expect(target).toContain('row 1 of prefixes')
        expect(target.toLowerCase()).not.toContain('secret')
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

    // The map holds no old path as text: a release that leaks the map shows
    // no title (as the gone part, R64).
    test('the map holds the keys of the old paths, never their texts', () => {
        const list: RedirectList = {
            redirects: [{ from: 'Old Beds/Compost heap', to: '/Garden/Compost' }],
            gone: ['Old Beds/Removed bed'],
            prefixes: [{ from: 'Old docs/How-to/', to: '/Garden/Thyme' }]
        }
        const text = JSON.stringify(mapOf(list).map).toLowerCase()
        for (const from of ['old beds', 'compost heap', 'removed bed', 'old docs', 'how-to']) {
            expect(text).not.toContain(from)
        }
        for (const row of [...list.redirects, ...list.prefixes]) {
            expect(text).not.toContain(foldedForm(row.from))
        }
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

    // URL-05: a target never redirects. The build resolves each target and
    // keeps the canonical location of a target that redirects one time.
    test('a target that redirects one time is kept as its canonical location', () => {
        const { map, deadTarget } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Old/Variant', to: '/garden/compost' },
                { from: 'Old/Former', to: '/Beds/Thyme+plant' },
                { from: 'Old/Name', to: '/Compost?lang=en' }
            ],
            prefixes: [{ from: 'Old docs/', to: '/Garden/Compost/' }]
        })
        expect(deadTarget).toBe(0)
        expect(resolve('/Old/Variant', map)).toEqual(REDIRECT('/Garden/Compost'))
        expect(resolve('/Old/Former', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Old/Name', map)).toEqual(REDIRECT('/Garden/Compost?lang=en'))
        expect(resolve('/Old+docs/Any', map)).toEqual(REDIRECT('/Garden/Compost'))
    })

    test('a target on the host of the site is a path of the site', () => {
        const { map, deadTarget } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Old/Own', to: 'https://notes.dsebastien.net/garden/compost' },
                { from: 'Old/Own dead', to: 'https://notes.dsebastien.net/Nothing' }
            ]
        })
        expect(deadTarget).toBe(1)
        expect(resolve('/Old/Own', map)).toEqual(REDIRECT('/Garden/Compost'))
        expect(resolve('/Old/Own+dead', map)).toEqual(NOT_FOUND)
    })

    test('a published note, a folder and a former path win: the build drops the row', () => {
        const { map, shadowed } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Garden/compost', to: '/-/recent/added' },
                { from: 'Garden', to: '/-/recent/added' },
                { from: 'Beds/Thyme plant', to: '/-/recent/added' }
            ],
            gone: ['GARDEN/THYME'],
            prefixes: [{ from: 'garden/', to: '/-/recent/added' }]
        })
        expect(shadowed).toBe(5)
        expect(resolve('/Garden/compost', map)).toEqual(REDIRECT('/Garden/Compost'))
        expect(resolve('/Beds/Thyme+plant', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Garden/Thyme', map)).toEqual({
            kind: 'page',
            file: 'page:Garden/Thyme.md'
        })
        // The prefix of a live folder is dropped: a missing note of the
        // folder stays "not found".
        expect(resolve('/Garden/Missing', map)).toEqual(NOT_FOUND)
    })

    test('a row that hides a file name or an alias of a live note wins, and is counted', () => {
        const { map, hidesNameOrAlias, shadowed } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'compost', to: '/Garden/Thyme' },
                { from: 'HUMUS', to: '/Garden/Thyme' },
                { from: 'Old/Compost', to: '/Garden/Thyme' }
            ]
        })
        expect(hidesNameOrAlias).toBe(2)
        expect(shadowed).toBe(0)
        expect(resolve('/Compost', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Humus', map)).toEqual(REDIRECT('/Garden/Thyme'))
    })

    test('a row whose target is not live is dropped', () => {
        const { map, deadTarget } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Old/Trellis', to: '/Garden/Trellis' },
                { from: 'Old/Frame', to: '/Bean+frame' }
            ],
            prefixes: [{ from: 'Old docs/', to: '/Garden/No+such+note' }]
        })
        expect(deadTarget).toBe(3)
        expect(resolve('/Old/Trellis', map)).toEqual(NOT_FOUND)
        expect(resolve('/Old+docs/Any', map)).toEqual(NOT_FOUND)
        // The map holds nothing of a dropped row.
        expect(JSON.stringify(map)).not.toContain('Trellis')
    })

    test('a row wins over an address of an unpublished note', () => {
        expect(resolve('/Bean+frame', mapOf(EMPTY).map)).toEqual(GONE)
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
            expect(resolve(path, map)).toEqual(GONE)
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
        expect(resolve('/old+docs/HOW-TO/deeper/Anything', map)).toEqual(
            REDIRECT('/Garden/Compost')
        )
        expect(resolve('/Old+docs/How-to/Known', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Old+docs/Other', map)).toEqual(REDIRECT('/'))
        expect(resolve('/Old+docs/Removed', map)).toEqual(GONE)
        expect(resolve('/Old+docs/', map)).toEqual(NOT_FOUND)
        expect(resolve('/Old+docs', map)).toEqual(NOT_FOUND)
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

    // A name with a question mark is a name: an unpublished note "Why?" is
    // gone, also when a published note "Why" exists.
    test('the address of an unpublished note wins over a query encoded into the path', () => {
        const { map } = mapOf(
            EMPTY,
            [{ path: 'Garden/Why.md', aliases: [] }],
            [{ path: 'Garden/Why?.md', aliases: [] }]
        )
        expect(resolve('/Garden/Why%3F', map)).toEqual(GONE)
        expect(resolve('/Garden/Why%3Fref%3Dx', map)).toEqual(REDIRECT('/Garden/Why?ref=x'))
    })

    test('a map without a redirect list answers as before', () => {
        const base = resolverMapOf(NOTES, FILES, {}, {}, REMOVED)
        expect(applyRedirectList(base, EMPTY).map).toEqual({
            ...base,
            redirects: { longest: 0, folded: {}, prefixes: {} }
        })
    })
})
