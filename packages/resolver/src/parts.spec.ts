import { describe, expect, test } from 'bun:test'
import {
    MAP_HEAD_FILE,
    mapHeadFrom,
    mapOfParts,
    mapPartFile,
    mapPartFrom,
    mapPartsOf,
    partedResolver,
    partOfKey,
    type MapPart
} from './parts.ts'
import { applyRedirectList } from './redirects.ts'
import { resolve, type ResolverMap } from './resolver.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'
import { VARIANT_WIDTHS, variantPath } from './variants.ts'

// The resolver map in parts (issue 121, R94): the build cuts the map by a
// hash of each key, and a host reads only the parts that a request needs.
// The answers must be the answers of the whole map.

const FILES: SiteFiles = {
    home: 'index.html',
    notFound: '404.html',
    gone: '410.html',
    robots: 'robots.txt',
    icon: 'favicon.ico',
    page: (path) => `-/note/${String(path.length)}.html`,
    markdown: (path) => `-/md/${String(path.length)}.md`,
    folder: (path) => `-/folder/${String(path.length)}.html`,
    choice: (paths) => `-/choice/${String(paths.length)}.html`
}

const KEY = 'ab'.repeat(32)

/** A map with every part that the resolver reads. */
function fullMap(): ResolverMap {
    const notes = [
        { path: 'Welcome.md', aliases: ['Hello', 'Shared'] },
        { path: '10 Garden/Mint.md', aliases: ['Shared'], formerPaths: ['Herbs/Mint.md'] },
        { path: '10 Garden/Basil.md', aliases: [] },
        { path: '20 Library/100% rain + sun? #1 & more.md', aliases: [] },
        { path: '20 Library/Rain.md', aliases: ['Drops'] },
        { path: '30 Kitchen/Rain.md', aliases: [] },
        ...Array.from({ length: 60 }, (_, index) => ({
            path: `40 Many/Note ${String(index)}.md`,
            aliases: index % 3 === 0 ? [`Other name ${String(index)}`] : []
        }))
    ]
    const base = resolverMapOf(
        notes,
        FILES,
        { [`/-/attachments/${KEY}/photo.png`]: KEY },
        { '/-/backlinks/abc': '-/backlinks/abc.html' },
        [{ path: '10 Garden/Rain barrel.md', aliases: ['Barrel'] }]
    )
    return applyRedirectList(base, {
        redirects: [{ from: 'Old/Mint', to: '/10+Garden/Mint' }],
        gone: ['Old/Stats'],
        prefixes: [{ from: 'Old docs/', to: '/Welcome' }]
    }).map
}

/** The requests of each kind of answer, and some that lead nowhere. */
const REQUESTS = [
    '/',
    '/Welcome',
    '/welcome',
    '/Welcome/',
    '/Welcome.md',
    '/10+Garden/Mint',
    '/10%20Garden/mint',
    '/Mint',
    '/Hello',
    '/Shared',
    '/Rain',
    '/Herbs/Mint',
    '/-/md/Herbs/Mint.md',
    '/Old/Mint',
    '/Old/Stats',
    '/Old+docs/anything/below',
    '/10+Garden/Rain+barrel',
    '/Barrel',
    '/Welcome%3Fref%3Dsite',
    '/20+Library/100%25+rain+%2B+sun%3F+%231+%26+more',
    '/robots.txt',
    '/favicon.ico',
    `/-/attachments/${KEY}/photo.png`,
    '/-/backlinks/abc',
    '/-/nothing',
    '/constructor',
    '/__proto__',
    '/Nothing+here',
    '/40+Many/Note+7',
    '/note 12',
    '/Other+name+9'
]

/** The parts of a map, as a release holds them, with the reads that a resolver made. */
function stored(map: ResolverMap, bytes?: number) {
    const { head, parts } = mapPartsOf(map, bytes)
    const reads: number[] = []
    const text = parts.map((part) => JSON.stringify(part))
    return {
        head: mapHeadFrom(JSON.parse(JSON.stringify(head))),
        parts,
        reads,
        load: (index: number): Promise<MapPart> => {
            reads.push(index)
            const part = text[index]
            return part === undefined
                ? Promise.reject(new Error(`no part ${String(index)}`))
                : Promise.resolve(mapPartFrom(JSON.parse(part), head, index))
        }
    }
}

describe('the part of a key', () => {
    test('is the same at each run, below the count of the parts', () => {
        expect(partOfKey('/Welcome', 64)).toBe(partOfKey('/Welcome', 64))
        expect(partOfKey('', 1)).toBe(0)
        for (const key of REQUESTS) {
            const part = partOfKey(key, 16)
            expect(part).toBeGreaterThanOrEqual(0)
            expect(part).toBeLessThan(16)
        }
    })

    test('is pinned: the build and every host cut a map the same way', () => {
        // FNV-1a over the UTF-16 units of the key.
        expect(partOfKey('a', 2 ** 31)).toBe(0xe40c292c % 2 ** 31)
        expect(partOfKey('/Welcome', 1024)).toBe(partOfKey('/Welcome', 2 ** 31) % 1024)
    })
})

describe('a map in parts', () => {
    test('the parts and the head give the whole map again', () => {
        const map = fullMap()
        const { head, parts } = mapPartsOf(map, 200)
        expect(parts.length).toBe(head.parts)
        expect(mapOfParts(head, parts)).toEqual(JSON.parse(JSON.stringify(map)) as ResolverMap)
    })

    test('each key is in the part of its hash, and in no other part', () => {
        const { head, parts } = mapPartsOf(fullMap(), 200)
        for (const [index, part] of parts.entries()) {
            for (const record of Object.values(part)) {
                for (const key of Object.keys(record)) {
                    expect(partOfKey(key, head.parts)).toBe(index)
                }
            }
        }
    })

    test('the count of the parts is a power of two that keeps a part near the size asked for', () => {
        const map = fullMap()
        const whole = JSON.stringify(map).length
        const { head } = mapPartsOf(map, 200)
        expect(Math.log2(head.parts) % 1).toBe(0)
        expect(head.parts).toBeGreaterThanOrEqual(whole / 200)
        expect(head.parts).toBeLessThan((2 * whole) / 200)
        expect(mapPartsOf(map, 10_000_000).head.parts).toBe(1)
    })

    test('the head holds no key of a lookup: its size does not grow with the notes', () => {
        const { head } = mapPartsOf(fullMap(), 200)
        expect(JSON.stringify(head)).not.toContain('Welcome')
        expect(JSON.stringify(head)).not.toContain(KEY)
    })

    test('the files are under one folder of the output', () => {
        expect(MAP_HEAD_FILE).toBe('-/resolver-map/head.json')
        expect(mapPartFile(7)).toBe('-/resolver-map/7.json')
    })
})

describe('the reader of a map in parts', () => {
    test('takes the head and the parts that the build wrote', () => {
        const { head, parts } = mapPartsOf(fullMap(), 200)
        const read = mapHeadFrom(JSON.parse(JSON.stringify(head)))
        expect(read).toEqual(head)
        for (const [index, part] of parts.entries()) {
            expect(mapPartFrom(JSON.parse(JSON.stringify(part)), read, index)).toEqual(part)
        }
    })

    test.each([
        ['a list', []],
        ['no count of parts', { version: 1, records: [], map: { pages: {} } }],
        ['a count that is not a power of two', { version: 1, parts: 3, records: [], map: {} }],
        ['another version', { version: 2, parts: 1, records: [], map: {} }],
        ['an unknown record', { version: 1, parts: 1, records: ['pages', 'other'], map: {} }]
    ])('refuses a head that is %s', (_name, value) => {
        expect(() => mapHeadFrom(value)).toThrow('-/resolver-map/head.json is not the head')
    })

    test('refuses a part with a key of another part', () => {
        const { head, parts } = mapPartsOf(fullMap(), 200)
        const index = parts.findIndex((part) => Object.keys(part.pages ?? {}).length > 0)
        const part = parts[index]
        expect(part).toBeDefined()
        const other = (index + 1) % head.parts
        expect(() => mapPartFrom(JSON.parse(JSON.stringify(part)), head, other)).toThrow(
            `-/resolver-map/${String(other)}.json is not a part of the resolver map`
        )
    })

    test('refuses a part whose values are not those of a resolver map', () => {
        const { head } = mapPartsOf(fullMap(), 200)
        const key = '/Welcome'
        const index = partOfKey(key, head.parts)
        expect(() => mapPartFrom({ pages: { [key]: 1 } }, head, index)).toThrow(
            'is not a part of the resolver map'
        )
        expect(() => mapPartFrom({ unknown: {} }, head, index)).toThrow(
            'is not a part of the resolver map'
        )
    })
})

describe('the resolver of a map in parts', () => {
    test.each([200, 2_000, 10_000_000])(
        'gives the answer of the whole map for each request (parts of %d bytes)',
        async (bytes) => {
            const map = fullMap()
            const parts = stored(map, bytes)
            const lookup = partedResolver(parts.head, parts.load)
            for (const path of REQUESTS) {
                for (const query of ['', '?ref=site']) {
                    expect({ path, query, answer: await lookup(path, query) }).toEqual({
                        path,
                        query,
                        answer: resolve(path, map, query)
                    })
                }
            }
        }
    )

    test('a canonical path reads one part', async () => {
        const parts = stored(fullMap(), 200)
        const lookup = partedResolver(parts.head, parts.load)
        expect(await lookup('/Welcome', '')).toEqual({ kind: 'page', file: '-/note/10.html' })
        expect(parts.reads).toEqual([partOfKey('/Welcome', parts.head.parts)])
    })

    test('a part is read one time while it is kept', async () => {
        const parts = stored(fullMap(), 200)
        const lookup = partedResolver(parts.head, parts.load)
        await Promise.all([lookup('/Welcome', ''), lookup('/Welcome', '')])
        await lookup('/Welcome', '')
        expect(parts.reads.length).toBe(1)
    })

    test('keeps a limited count of parts: the memory does not grow with the site', async () => {
        const map = fullMap()
        const parts = stored(map, 200)
        const lookup = partedResolver(parts.head, parts.load, { keep: 2 })
        const pages = Object.keys(map.pages).slice(0, 40)
        for (const path of pages) {
            expect(await lookup(path, '')).toEqual(resolve(path, map, ''))
        }
        const before = parts.reads.length
        // The first path's part was dropped since: it is read again.
        await lookup(pages[0] ?? '/', '')
        expect(parts.reads.length).toBe(before + 1)
    })

    test('a part that fails to load fails the request, and is read again by the next one', async () => {
        const map = fullMap()
        const good = stored(map, 200)
        let failures = 1
        const lookup = partedResolver(good.head, (index) => {
            if (failures > 0) {
                failures -= 1
                return Promise.reject(new Error('the host fails for a short time'))
            }
            return good.load(index)
        })
        expect(lookup('/Welcome', '')).rejects.toThrow('the host fails for a short time')
        expect(await lookup('/Welcome', '')).toEqual(resolve('/Welcome', map, ''))
    })
})

describe('a key that is a name of the prototype of an object', () => {
    const map = (): ResolverMap =>
        resolverMapOf(
            [
                { path: 'Docs/__proto__.md', aliases: ['__proto__'] },
                { path: 'Welcome.md', aliases: ['constructor'] }
            ],
            FILES
        )

    test('is kept in the parts, and the parts give the whole map again', () => {
        const whole = map()
        const { head, parts } = mapPartsOf(whole, 50)
        expect(mapOfParts(head, parts)).toEqual(JSON.parse(JSON.stringify(whole)) as ResolverMap)
        const text = parts.map((part) => JSON.stringify(part)).join('')
        expect(text).toContain('"__proto__"')
    })

    test.each([
        '/Docs/__proto__',
        '/docs/__proto__',
        '/__proto__',
        '/constructor',
        '/-/md/Docs/__proto__.md'
    ])('gives the answer of the whole map for %s', async (path) => {
        const whole = map()
        const parts = stored(whole, 50)
        const lookup = partedResolver(parts.head, parts.load)
        expect(await lookup(path, '')).toEqual(resolve(path, whole, ''))
    })

    test('the answers are not "not found"', async () => {
        const whole = map()
        expect(resolve('/Docs/__proto__', whole, '').kind).toBe('page')
        const parts = stored(whole, 50)
        expect((await partedResolver(parts.head, parts.load)('/__proto__', '')).kind).toBe(
            'redirect'
        )
    })
})

// Issue 87: a variant of an image is found by the address of its image in
// the attachments of the map, also when the map is in parts.
describe('a variant of an image over the parts', () => {
    const image = `/-/attachments/${KEY}/photo.png`

    test.each(VARIANT_WIDTHS.map((width) => [width]))(
        'gives the answer of the whole map for the variant of %d pixels',
        async (width) => {
            const whole = fullMap()
            const parts = stored(whole, 200)
            const lookup = partedResolver(parts.head, parts.load)
            const path = variantPath(image, width)
            const answer = await lookup(path, '')
            expect(answer).toEqual(resolve(path, whole, ''))
            expect(answer.kind).toBe('attachment')
        }
    )

    test.each([
        ['a width that is not a step', image.replace('/photo.png', '/w123-1/photo.png.webp')],
        [
            'an image that the map does not have',
            variantPath(`/-/attachments/${'cd'.repeat(32)}/x.png`, VARIANT_WIDTHS[0])
        ]
    ])('gives the answer of the whole map for %s', async (_name, path) => {
        const whole = fullMap()
        const parts = stored(whole, 200)
        expect(await partedResolver(parts.head, parts.load)(path, '')).toEqual(
            resolve(path, whole, '')
        )
    })
})
