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
    icon: 'favicon.ico',
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
    loop: number
    hidesNameOrAlias: number
    prefixOnLiveFolder: number
    rowFallback: number
    prefixFallback: number
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
        loop: applied.dropped.loop,
        hidesNameOrAlias: applied.kept.hidesNameOrAlias,
        prefixOnLiveFolder: applied.kept.prefixOnLiveFolder,
        rowFallback: applied.kept.rowFallback,
        prefixFallback: applied.kept.prefixFallback
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
const TEMPORARY = (location: string): Resolution => ({
    kind: 'redirect',
    status: 302,
    location,
    cacheControl: 'no-store'
})

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
    test('names no unknown key', () => {
        const message = refusalOf({ 'version': 1, 'Secret folder': [] })
        expect(message).toContain('a key is not known')
        expect(message).not.toContain('Secret')
    })

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
        const { map, rowFallback } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Old/Variant', to: '/garden/compost' },
                { from: 'Old/Former', to: '/Beds/Thyme+plant' },
                { from: 'Old/Name', to: '/Compost?lang=en' }
            ],
            prefixes: [{ from: 'Old docs/', to: '/Garden/Compost/' }]
        })
        expect(rowFallback).toBe(0)
        expect(resolve('/Old/Variant', map)).toEqual(REDIRECT('/Garden/Compost'))
        expect(resolve('/Old/Former', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Old/Name', map)).toEqual(REDIRECT('/Garden/Compost?lang=en'))
        expect(resolve('/Old+docs/Any', map)).toEqual(REDIRECT('/Garden/Compost'))
    })

    test('a target on the host of the site is a path of the site', () => {
        const { map, rowFallback } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Old/Own', to: 'https://notes.dsebastien.net/garden/compost' },
                { from: 'Old/Own dead', to: 'https://notes.dsebastien.net/Nothing' }
            ]
        })
        expect(rowFallback).toBe(1)
        expect(resolve('/Old/Own', map)).toEqual(REDIRECT('/Garden/Compost'))
        expect(resolve('/Old/Own+dead', map)).toEqual(REDIRECT('/'))
    })

    test('a published note, a folder and a former path win: the build drops the row', () => {
        const { map, shadowed, prefixOnLiveFolder } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Garden/compost', to: '/-/recent/added' },
                { from: 'Garden', to: '/-/recent/added' },
                { from: 'Beds/Thyme plant', to: '/-/recent/added' }
            ],
            gone: ['GARDEN/THYME'],
            prefixes: [{ from: 'garden/', to: '/-/recent/added' }]
        })
        expect(shadowed).toBe(4)
        expect(prefixOnLiveFolder).toBe(1)
        expect(resolve('/Garden/compost', map)).toEqual(REDIRECT('/Garden/Compost'))
        expect(resolve('/Beds/Thyme+plant', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Garden/Thyme', map)).toEqual({
            kind: 'page',
            file: 'page:Garden/Thyme.md',
            markdown: 'markdown:Garden/Thyme.md'
        })
        // The prefix of a folder that is live again is kept, and counted: it
        // comes after every exact address, so it only leads an old path that
        // nothing else has.
        expect(resolve('/Garden/Missing', map)).toEqual(REDIRECT('/-/recent/added'))
        expect(resolve('/Garden', map)).toEqual({ kind: 'page', file: 'folder:Garden' })
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

    // Decision 1 of the author: no 410 unless he writes "gone", else the
    // nearest public note.
    test('a row whose target leads nowhere, with no prefix rule over it, goes to the hub of its folder', () => {
        const { map, rowFallback } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Old/Nowhere', to: '/Garden/No+such+note' },
                { from: 'Garden/Old name', to: '/Garden/No+such+note' }
            ]
        })
        expect(rowFallback).toBe(2)
        expect(resolve('/Old/Nowhere', map)).toEqual(REDIRECT('/'))
        expect(resolve('/Garden/Old+name', map)).toEqual(REDIRECT('/Garden'))
    })

    // Every old URL keeps working (R79): a row whose target is gone or leads
    // nowhere leads where the prefix rule over its old path leads.
    test('a row whose target is gone or dead falls back to the prefix rule over it', () => {
        const { map, rowFallback } = mapOf({
            redirects: [
                { from: 'Old docs/Gone page', to: '/Garden/Trellis' },
                { from: 'Old docs/Dead page', to: '/Garden/No+such+note' }
            ],
            gone: [],
            prefixes: [{ from: 'Old docs/', to: '/Garden/Thyme' }]
        })
        expect(rowFallback).toBe(0)
        expect(resolve('/Old+docs/Gone+page', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Old+docs/Dead+page', map)).toEqual(REDIRECT('/Garden/Thyme'))
    })

    // A prefix rule is never dropped: its target that is gone or dead falls
    // back to the next shorter prefix rule, then the hub of its parent
    // folder, then the home page.
    test('a prefix rule whose target is gone or dead falls back, and is counted', () => {
        const { map, prefixFallback } = mapOf({
            ...EMPTY,
            prefixes: [
                { from: 'Old docs/', to: '/Garden/Thyme' },
                { from: 'Old docs/How-to/', to: '/Garden/Trellis' },
                { from: 'Garden/Old part/', to: '/Garden/No+such+note' },
                { from: 'Nowhere/', to: '/No+such+note' }
            ]
        })
        expect(prefixFallback).toBe(3)
        expect(resolve('/Old+docs/How-to/Any', map)).toEqual(REDIRECT('/Garden/Thyme'))
        expect(resolve('/Garden/Old+part/Any', map)).toEqual(REDIRECT('/Garden'))
        expect(resolve('/Nowhere/Any', map)).toEqual(REDIRECT('/'))
        expect(map.redirects?.counts).toEqual({
            hidesNameOrAlias: 0,
            loop: 0,
            prefixFallback: 3,
            prefixOnLiveFolder: 0,
            rowFallback: 0,
            shadowed: 0
        })
    })

    // The build answers as a request would: a row of the list wins over a
    // file name and an alias of a live note.
    test('a target that is an old path of the list and an alias follows the row', () => {
        const { map } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Humus', to: '/Garden/Thyme' },
                { from: 'Old/To humus', to: '/Humus' }
            ]
        })
        expect(resolve('/Old/To+humus', map)).toEqual(REDIRECT('/Garden/Thyme'))
    })

    // R47: an alias is not kept, as a note can take it later.
    test('a chain through an alias keeps the answer of an alias', () => {
        const { map } = mapOf({
            ...EMPTY,
            redirects: [{ from: 'Old/Via alias', to: '/Humus' }],
            prefixes: [{ from: 'Old docs/', to: '/humus' }]
        })
        expect(resolve('/Old/Via+alias', map)).toEqual(TEMPORARY('/Garden/Compost'))
        expect(resolve('/Old+docs/Any', map)).toEqual(TEMPORARY('/Garden/Compost'))
    })

    // A loop is the same row or prefix rule used twice; a redirect of the
    // release is no step.
    test('a chain of nine renames works, and a real loop is dropped', () => {
        const renames = Array.from({ length: 9 }, (_, index) => ({
            from: `Old/Name ${String(index)}`,
            to: index === 8 ? '/garden/COMPOST' : `/old/name+${String(index + 1)}`
        }))
        const { map, loop } = mapOf({
            ...EMPTY,
            redirects: [
                ...renames,
                { from: 'Old/Ring one', to: '/Old/Ring+two' },
                { from: 'Old/Ring two', to: '/Old/Ring+three' },
                { from: 'Old/Ring three', to: '/OLD/RING+ONE' }
            ]
        })
        for (let index = 0; index < 9; index++) {
            expect(resolve(`/Old/Name+${String(index)}`, map)).toEqual(REDIRECT('/Garden/Compost'))
        }
        expect(loop).toBe(3)
        expect(resolve('/Old/Ring+one', map)).toEqual(NOT_FOUND)
    })

    // The target of a row was unpublished: the old path leads to the nearest
    // public note, as the author did not write "gone".
    test('a row whose target is gone goes to the hub of its folder', () => {
        const { map, rowFallback } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Old/Trellis', to: '/Garden/Trellis' },
                { from: 'Old/Frame', to: '/Bean+frame' }
            ]
        })
        expect(rowFallback).toBe(2)
        expect(resolve('/Old/Trellis', map)).toEqual(REDIRECT('/'))
        expect(resolve('/old/FRAME', map)).toEqual(REDIRECT('/'))
        // The map holds nothing of the row but its key.
        expect(JSON.stringify(map).toLowerCase()).not.toContain('trellis')
    })

    // A row can lead to the old path of another row, or to a path under an
    // old folder: the build follows them and keeps the last page (URL-05).
    test('a chain inside the list ends at its page, in one redirect', () => {
        const { map, loop, rowFallback } = mapOf({
            redirects: [
                { from: 'Old/A', to: '/Old/B' },
                { from: 'Old/B', to: '/old/c?lang=en' },
                { from: 'Old/C', to: '/garden/compost' },
                { from: 'Old/Docs link', to: '/Old+docs/Any/page' },
                { from: 'Old/To gone', to: '/Old/Removed' },
                { from: 'Old/Loop one', to: '/Old/Loop+two' },
                { from: 'Old/Loop two', to: '/Old/Loop+one' }
            ],
            gone: ['Old/Removed'],
            prefixes: [{ from: 'Old docs/', to: 'https://notes.dsebastien.net/Garden/Thyme' }]
        })
        expect(resolve('/Old/A', map)).toEqual(REDIRECT('/Garden/Compost?lang=en'))
        expect(resolve('/Old/B', map)).toEqual(REDIRECT('/Garden/Compost?lang=en'))
        expect(resolve('/Old/Docs+link', map)).toEqual(REDIRECT('/Garden/Thyme'))
        // A row that leads to a row that the author says is gone is no gone row of his.
        expect(resolve('/Old/To+gone', map)).toEqual(REDIRECT('/'))
        expect(resolve('/Old/Removed', map)).toEqual(GONE)
        expect(loop).toBe(2)
        expect(rowFallback).toBe(1)
        expect(resolve('/Old/Loop+one', map)).toEqual(NOT_FOUND)
    })

    test('a prefix rule keeps a query that is encoded into the path', () => {
        const { map } = mapOf({ ...EMPTY, prefixes: [{ from: 'Old docs/', to: '/' }] })
        expect(resolve('/Old+docs/Any%3Fref%3Dexample.org', map)).toEqual(
            REDIRECT('/?ref=example.org')
        )
    })

    test('an address of the host of the site in another form is a path of the site', () => {
        const { map } = mapOf({
            ...EMPTY,
            redirects: [
                { from: 'Old/Own', to: 'https://NOTES.dsebastien.net:443/garden/compost?x=1' },
                { from: 'Old/Other', to: 'https://notes.dsebastien.net.example.org/a' }
            ]
        })
        expect(resolve('/Old/Own', map)).toEqual(REDIRECT('/Garden/Compost?x=1'))
        expect(resolve('/Old/Other', map)).toEqual(
            REDIRECT('https://notes.dsebastien.net.example.org/a')
        )
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

    // The limit of a chain: every row and every prefix rule of the list, one time each.
    test('a chain that uses every row and every prefix rule of the list works', () => {
        const { map, loop } = mapOf({
            redirects: [
                { from: 'Old/One', to: '/Old/Two' },
                { from: 'Old/Two', to: '/Old/Three' },
                { from: 'Old/Three', to: '/Old+docs/Four' }
            ],
            gone: [],
            prefixes: [{ from: 'Old docs/', to: '/Compost' }]
        })
        expect(loop).toBe(0)
        expect(resolve('/Old/One', map)).toEqual(REDIRECT('/Garden/Compost'))
    })

    test('the text before a query encoded into the path can be gone', () => {
        const { map } = mapOf(EMPTY, NOTES, [{ path: 'Garden/Shed.md', aliases: [] }])
        expect(resolve('/Garden/Shed%3Fref%3Dx', map)).toEqual(GONE)
    })

    test('a map without a redirect list answers as before', () => {
        const base = resolverMapOf(NOTES, FILES, {}, {}, REMOVED)
        expect(applyRedirectList(base, EMPTY).map).toEqual({
            ...base,
            redirects: {
                longest: 0,
                folded: {},
                prefixes: {},
                prefixLengths: [],
                temporary: {},
                counts: {
                    hidesNameOrAlias: 0,
                    loop: 0,
                    prefixFallback: 0,
                    prefixOnLiveFolder: 0,
                    rowFallback: 0,
                    shadowed: 0
                }
            }
        })
    })
})
