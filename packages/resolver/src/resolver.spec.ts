import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { foldedForm, resolve, type Resolution, type ResolverMap } from './resolver.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'

// The resolver (MOD-05 of the spec): a pure function that turns a requested
// path into the page to serve, or "not found". The first slice knows the
// canonical path of a published note. The variants, the redirects and the
// addresses of an unpublished note are in the URL table (`table.spec.ts`).
const MAP: ResolverMap = {
    pages: { '/10+Garden/Frost+dates+explained': '-/note/203d446940c02032.html' }
}

describe('resolver', () => {
    test('gives the page of a canonical path', () => {
        expect(resolve('/10+Garden/Frost+dates+explained', MAP)).toEqual({
            kind: 'page',
            file: '-/note/203d446940c02032.html'
        })
    })

    test('does not find a path that no note has', () => {
        expect(resolve('/10+Garden/No+such+note', MAP)).toEqual({
            kind: 'not-found',
            suggestions: []
        })
        expect(resolve('/', MAP)).toEqual({ kind: 'not-found', suggestions: [] })
    })

    // A name of a note can be the name of a member of every object.
    test('does not find a path that is a name of the language', () => {
        expect(resolve('constructor', MAP)).toEqual({ kind: 'not-found', suggestions: [] })
        expect(resolve('__proto__', MAP)).toEqual({ kind: 'not-found', suggestions: [] })
    })
})

describe('resolver of attachments', () => {
    const KEY = 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'
    const WITH: ResolverMap = {
        pages: {},
        attachments: { [`/-/attachments/${KEY}/garden-plan.png`]: KEY }
    }

    test('gives the key of the file of an attachment', () => {
        expect(resolve(`/-/attachments/${KEY}/garden-plan.png`, WITH)).toEqual({
            kind: 'attachment',
            key: KEY,
            name: 'garden-plan.png'
        })
    })

    test('does not find the key with another name, or a name of the language', () => {
        expect(resolve(`/-/attachments/${KEY}/other.png`, WITH)).toEqual({
            kind: 'not-found',
            suggestions: []
        })
        expect(resolve(`/-/attachments/${KEY}`, WITH)).toEqual({
            kind: 'not-found',
            suggestions: []
        })
        expect(resolve('constructor', WITH)).toEqual({ kind: 'not-found', suggestions: [] })
    })
})

// The resolver folds a request as the publishing tool folds two paths to stop
// a plan: both read the shared cases of the root names.
const NAMES = fileURLToPath(new URL('../../../fixtures/canonical/names.json', import.meta.url))
const { folded } = (await Bun.file(NAMES).json()) as {
    folded: { name: string; one: string; two: string; equal: boolean }[]
}

describe('folded form of the resolver', () => {
    test.each(folded.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(foldedForm(entry.one) === foldedForm(entry.two)).toBe(entry.equal)
    })
})

// A name of a note can be the name of a member of every object. The map goes
// through JSON, as the build writes it and the server reads it.
describe('resolver of names of the language', () => {
    const notes = [
        { path: '__proto__/Inside.md', aliases: [] },
        { path: 'Other/__proto__.md', aliases: [] },
        { path: 'constructor/Inside.md', aliases: [] }
    ]
    const files: SiteFiles = {
        home: 'index.html',
        notFound: '404.html',
        gone: '410.html',
        robots: 'robots.txt',
        page: (path) => `page:${path}`,
        markdown: (path) => `markdown:${path}`,
        folder: (path) => `folder:${path}`,
        choice: (paths) => `choice:${paths.join('|')}`
    }
    const map = JSON.parse(JSON.stringify(resolverMapOf(notes, files))) as ResolverMap

    test('a folder named __proto__ is found in another letter case', () => {
        expect(resolve('/__Proto__', map)).toEqual({
            kind: 'redirect',
            status: 301,
            location: '/__proto__',
            cacheControl: 'public, max-age=3600'
        })
    })

    test('a folder named constructor is found in another letter case', () => {
        expect(resolve('/Constructor/', map)).toEqual({
            kind: 'redirect',
            status: 301,
            location: '/constructor',
            cacheControl: 'public, max-age=3600'
        })
    })

    // No folder of that name hides the file name or the alias (issue 80).
    const mapOf = (notes: { path: string; aliases: string[] }[]): ResolverMap =>
        JSON.parse(JSON.stringify(resolverMapOf(notes, files))) as ResolverMap

    test('a file name __proto__ leads to its note', () => {
        const names = mapOf([{ path: 'Other/__proto__.md', aliases: [] }])
        expect(resolve('/__proto__', names)).toEqual({
            kind: 'redirect',
            status: 301,
            location: '/Other/__proto__',
            cacheControl: 'public, max-age=3600'
        })
    })

    test('an alias __proto__ leads to its note', () => {
        const aliases = mapOf([{ path: 'Other/Inside.md', aliases: ['__proto__'] }])
        expect(resolve('/__Proto__', aliases)).toEqual({
            kind: 'redirect',
            status: 302,
            location: '/Other/Inside',
            cacheControl: 'no-store'
        })
    })
})

// A generated page of the build that is no note, no folder and no choice: the
// page with every backlink of a note (issue 48).
describe('resolver map with generated pages', () => {
    const files: SiteFiles = {
        home: 'index.html',
        notFound: '404.html',
        gone: '410.html',
        robots: 'robots.txt',
        page: (path) => `page:${path}`,
        markdown: (path) => `markdown:${path}`,
        folder: (path) => `folder:${path}`,
        choice: (paths) => `choice:${paths.join('|')}`
    }
    const notes = [{ path: 'Garden/Rain barrel.md', aliases: [] }]

    test('a generated page is found at its path, and has no variant', () => {
        const map = resolverMapOf(
            notes,
            files,
            {},
            {
                '/-/backlinks/203d446940c02032': '-/backlinks/203d446940c02032.html'
            }
        )

        expect(resolve('/-/backlinks/203d446940c02032', map)).toEqual({
            kind: 'page',
            file: '-/backlinks/203d446940c02032.html'
        })
        expect(resolve('/-/backlinks/203D446940C02032', map).kind).toBe('not-found')
        expect(resolve('/-/backlinks/203d446940c02032/', map).kind).toBe('not-found')
        expect(resolve('/Garden/Rain+barrel', map)).toEqual({
            kind: 'page',
            file: 'page:Garden/Rain barrel.md'
        })
    })

    test('a generated page outside the prefix of the generated pages is refused: it could take the path of a note', () => {
        expect(() => resolverMapOf(notes, files, {}, { '/Garden/Rain+barrel': 'x.html' })).toThrow(
            'generated page'
        )
        expect(() => resolverMapOf(notes, files, {}, { '/': 'x.html' })).toThrow('generated page')
    })
})

// The addresses of an unpublished note are gone (410), but a published note,
// folder or page always wins (URL-27, decision R64).
describe('resolver of unpublished notes', () => {
    const files: SiteFiles = {
        home: 'index.html',
        notFound: '404.html',
        gone: '410.html',
        robots: 'robots.txt',
        page: (path) => `page:${path}`,
        markdown: (path) => `markdown:${path}`,
        folder: (path) => `folder:${path}`,
        choice: (paths) => `choice:${paths.join('|')}`
    }
    const GONE: Resolution = { kind: 'gone', file: '410.html' }
    // Through JSON, as the build writes the map and the server reads it.
    const mapOf = (
        notes: { path: string; aliases: string[] }[],
        removed: { path: string; aliases: string[] }[]
    ): ResolverMap =>
        JSON.parse(JSON.stringify(resolverMapOf(notes, files, {}, {}, removed))) as ResolverMap

    test('a published note wins over the file name of an unpublished note', () => {
        const map = mapOf(
            [{ path: 'Garden/Shared.md', aliases: [] }],
            [{ path: 'Shed/Shared.md', aliases: [] }]
        )
        expect(resolve('/Shared', map)).toEqual({
            kind: 'redirect',
            status: 301,
            location: '/Garden/Shared',
            cacheControl: 'public, max-age=3600'
        })
        expect(resolve('/Shed/Shared', map)).toEqual(GONE)
    })

    test('an alias of a published note wins over the path of an unpublished note', () => {
        const map = mapOf(
            [{ path: 'Garden/Water butt.md', aliases: ['Rain barrel'] }],
            [{ path: 'Rain barrel.md', aliases: [] }]
        )
        expect(resolve('/Rain+barrel', map)).toEqual({
            kind: 'redirect',
            status: 302,
            location: '/Garden/Water+butt',
            cacheControl: 'no-store'
        })
        expect(resolve('/-/md/Rain+barrel.md', map)).toEqual(GONE)
    })

    test('another reading that finds a published note wins over the reading of an unpublished note', () => {
        const map = mapOf([{ path: 'A+B.md', aliases: [] }], [{ path: 'A B.md', aliases: [] }])
        expect(resolve('/A+B', map)).toEqual({
            kind: 'redirect',
            status: 301,
            location: '/A%2BB',
            cacheControl: 'public, max-age=3600'
        })
    })

    test('a folder of published notes wins over an unpublished note of the same text', () => {
        const map = mapOf(
            [{ path: 'Shed/Tools.md', aliases: [] }],
            [{ path: 'Shed.md', aliases: [] }]
        )
        expect(resolve('/Shed', map)).toEqual({ kind: 'page', file: 'folder:Shed' })
        expect(resolve('/-/md/Shed.md', map)).toEqual(GONE)
    })

    test('a name or an alias of two unpublished notes is gone', () => {
        const map = mapOf(
            [],
            [
                { path: 'Garden/Mint.md', aliases: ['Herb'] },
                { path: 'Kitchen/Mint.md', aliases: ['Herb'] }
            ]
        )
        expect(resolve('/Mint', map)).toEqual(GONE)
        expect(resolve('/herb', map)).toEqual(GONE)
    })

    test('a path under the prefix of the site is gone only as it is written', () => {
        const map = mapOf([], [{ path: 'Garden/Mint.md', aliases: [] }])
        expect(resolve('/-/md/Garden/Mint.md', map)).toEqual(GONE)
        expect(resolve('/-/md/garden/mint.md', map)).toEqual({
            kind: 'not-found',
            suggestions: [],
            file: '404.html'
        })
        expect(resolve('/-/Garden/Mint', map).kind).toBe('not-found')
    })

    test('a file name with a slash is no file name', () => {
        const map = mapOf([], [{ path: 'Garden/Mint.md', aliases: [] }])
        expect(resolve('/Other/Mint', map).kind).toBe('not-found')
    })

    test('a name of the language is no unpublished note', () => {
        const map = mapOf([], [{ path: 'constructor.md', aliases: ['toString'] }])
        expect(resolve('/constructor', map)).toEqual(GONE)
        expect(resolve('/toString', map)).toEqual(GONE)
        expect(resolve('/__proto__', map).kind).toBe('not-found')
        expect(resolve('/hasOwnProperty', map).kind).toBe('not-found')
    })

    // A release that leaks the map shows no title and no alias (R64).
    test('the map holds no text of an unpublished note', () => {
        const text = JSON.stringify(
            resolverMapOf([{ path: 'Garden/Mint.md', aliases: [] }], files, {}, {}, [
                { path: 'Shed/Secret plan.md', aliases: ['Hidden name'] }
            ])
        ).toLowerCase()
        for (const part of ['secret', 'plan', 'hidden', 'shed']) {
            expect(text).not.toContain(part)
        }
        expect(
            resolve(
                '/Shed/Secret+plan',
                mapOf([], [{ path: 'Shed/Secret plan.md', aliases: ['Hidden name'] }])
            )
        ).toEqual(GONE)
    })

    test('a map without unpublished notes has no gone page', () => {
        expect(resolve('/Anything', { pages: {} })).toEqual({ kind: 'not-found', suggestions: [] })
    })
})
