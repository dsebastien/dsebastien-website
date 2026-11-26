import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { foldedForm, resolve, type Resolution, type ResolverMap } from './resolver.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'
import { variantKey, variantPath } from './variants.ts'

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

    // Issue 87, PERF-25: a variant follows its image.
    test('gives the variants of an image that a page uses, in WebP', () => {
        expect(resolve(variantPath(`/-/attachments/${KEY}/garden-plan.png`, 800), WITH)).toEqual({
            kind: 'attachment',
            key: variantKey(KEY, 800),
            name: 'garden-plan.png.webp',
            image: { key: KEY, name: 'garden-plan.png' }
        })
        expect(resolve(variantPath(`/-/attachments/${KEY}/other.png`, 800), WITH)).toMatchObject({
            kind: 'not-found'
        })
        expect(
            resolve(variantPath(`/-/attachments/${KEY}/garden-plan.png`, 800), { pages: {} })
        ).toMatchObject({ kind: 'not-found' })
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
        icon: 'favicon.ico',
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
        icon: 'favicon.ico',
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

    // Issue 54: the sitemaps and the IndexNow key file live at the root.
    test('a file at the root of the site is found at its path only', () => {
        const map = resolverMapOf(notes, {
            ...files,
            root: {
                '/sitemap.xml': { file: 'sitemap.xml', type: 'xml' },
                '/0123abcd.txt': { file: '0123abcd.txt', type: 'text' }
            }
        })
        expect(resolve('/sitemap.xml', map)).toEqual({
            kind: 'file',
            file: 'sitemap.xml',
            type: 'xml'
        })
        expect(resolve('/0123abcd.txt', map)).toEqual({
            kind: 'file',
            file: '0123abcd.txt',
            type: 'text'
        })
    })

    test('a file at the root outside the root, or over robots.txt, is refused', () => {
        for (const path of ['/a/sitemap.xml', 'sitemap.xml', '/robots.txt']) {
            expect(() =>
                resolverMapOf(notes, { ...files, root: { [path]: { file: 'x', type: 'xml' } } })
            ).toThrow('another file at the root')
        }
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
        icon: 'favicon.ico',
        page: (path) => `page:${path}`,
        markdown: (path) => `markdown:${path}`,
        folder: (path) => `folder:${path}`,
        choice: (paths) => `choice:${paths.join('|')}`
    }
    const GONE: Resolution = { kind: 'gone', file: '410.html' }
    const GONE_PART = { longest: 0, paths: {}, folded: {}, names: {}, aliases: {} }
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

    // A path longer than every text of the gone part is never hashed: a long
    // request costs no hash (R64).
    test('looks for no text longer than the longest text of the gone part', () => {
        const map = mapOf([], [{ path: 'Mint.md', aliases: ['Garden mint'] }])
        expect(map.gone?.longest).toBe('/-/md/Mint.md'.length)
        const shorter: ResolverMap = { ...map, gone: { ...(map.gone ?? GONE_PART), longest: 3 } }
        expect(resolve('/Mint', map)).toEqual(GONE)
        expect(resolve('/Mint', shorter).kind).toBe('not-found')
        expect(resolve('/-/md/Mint.md', shorter).kind).toBe('not-found')
        expect(resolve(`/${'a'.repeat(10_000)}`, map).kind).toBe('not-found')
    })

    test('a map without unpublished notes has no gone page', () => {
        expect(resolve('/Anything', { pages: {} })).toEqual({ kind: 'not-found', suggestions: [] })
    })
})

// The former paths of a note that moved answer 301 to the note (URL-06,
// URL-21, decision R66): the old path and its variants, its Markdown path and
// its file name. A current path or folder of a published note wins over a
// former path, and a former path wins over a file name and an alias. The
// former paths of an unpublished note are gone (R64).
describe('resolver of former paths', () => {
    const files: SiteFiles = {
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
    type Note = { path: string; aliases: string[]; formerPaths?: string[] }
    // Through JSON, as the build writes the map and the server reads it.
    const mapOf = (notes: Note[], removed: Note[] = []): ResolverMap =>
        JSON.parse(JSON.stringify(resolverMapOf(notes, files, {}, {}, removed))) as ResolverMap
    const moved = (location: string): Resolution => ({
        kind: 'redirect',
        status: 301,
        location,
        cacheControl: 'public, max-age=3600'
    })
    const NOTE = { path: 'Garden/Wormery.md', aliases: [], formerPaths: ['Shed/Worm bin.md'] }

    test('the old path and its variants lead to the note in one redirect', () => {
        const map = mapOf([NOTE])
        expect(resolve('/Shed/Worm+bin', map)).toEqual(moved('/Garden/Wormery'))
        expect(resolve('/Shed/Worm%20bin', map)).toEqual(moved('/Garden/Wormery'))
        expect(resolve('/shed/WORM+BIN.md/', map)).toEqual(moved('/Garden/Wormery'))
        expect(resolve('/Shed/Worm+bin', map, '?ref=x')).toEqual(moved('/Garden/Wormery?ref=x'))
    })

    test('the old Markdown path leads to the Markdown of the note, as it is written only', () => {
        const map = mapOf([NOTE])
        expect(resolve('/-/md/Shed/Worm+bin.md', map)).toEqual(moved('/-/md/Garden/Wormery.md'))
        expect(resolve('/-/md/shed/worm+bin.md', map)).toEqual({
            kind: 'not-found',
            suggestions: [],
            file: '404.html'
        })
    })

    test('the old file name leads to the note', () => {
        expect(resolve('/Worm+bin', mapOf([NOTE]))).toEqual(moved('/Garden/Wormery'))
    })

    // Decision R82: a former folder whose notes all moved to one folder.
    test('the old folder leads to the folder that all its notes moved to', () => {
        const map = mapOf([
            NOTE,
            { path: 'Garden/Compost.md', aliases: [], formerPaths: ['Shed/Compost.md'] }
        ])
        expect(resolve('/Shed', map)).toEqual(moved('/Garden'))
        expect(resolve('/shed/', map, '?ref=x')).toEqual(moved('/Garden?ref=x'))
    })

    test('the old folder leads to the folder note of that folder when it is published', () => {
        const map = mapOf([NOTE, { path: 'Garden/Garden.md', aliases: [] }])
        expect(resolve('/Shed', map)).toEqual(moved('/Garden/Garden'))
    })

    test('an old folder whose notes moved to two folders is no address', () => {
        const map = mapOf([
            NOTE,
            { path: 'Kitchen/Compost.md', aliases: [], formerPaths: ['Shed/Compost.md'] }
        ])
        expect(resolve('/Shed', map)).toEqual({
            kind: 'not-found',
            suggestions: [],
            file: '404.html'
        })
    })

    test('a folder that holds notes again wins over its old target', () => {
        const map = mapOf([NOTE, { path: 'Shed/Rake.md', aliases: [] }])
        expect(resolve('/Shed', map)).toEqual({ kind: 'page', file: 'folder:Shed' })
    })

    test('a current path wins over a former path, and a former path over a name and an alias', () => {
        const map = mapOf([
            NOTE,
            { path: 'Shed/Worm bin.md', aliases: [] },
            { path: 'Kitchen/Wormery.md', aliases: ['Old Wormery'], formerPaths: ['Hut.md'] },
            { path: 'Barn/Hut.md', aliases: [] },
            { path: 'Garden/Old Wormery.md', aliases: [] }
        ])
        // A new note took the old path: it wins.
        expect(resolve('/Shed/Worm+bin', map)).toEqual({
            kind: 'page',
            file: 'page:Shed/Worm bin.md'
        })
        // The old path of a note wins over the file name of another note.
        expect(resolve('/Hut', map)).toEqual(moved('/Kitchen/Wormery'))
        // The file name of a note wins over an old file name.
        expect(resolve('/Worm+bin', map)).toEqual(moved('/Shed/Worm+bin'))
    })

    test('a former path of two notes gives the "not found" page with both', () => {
        const map = mapOf([
            { path: 'Garden/One.md', aliases: [], formerPaths: ['Old.md'] },
            { path: 'Kitchen/Two.md', aliases: [], formerPaths: ['Old.md'] }
        ])
        expect(resolve('/Old', map)).toEqual({
            kind: 'not-found',
            suggestions: ['/Garden/One', '/Kitchen/Two'],
            file: 'choice:Garden/One.md|Kitchen/Two.md'
        })
        expect(resolve('/-/md/Old.md', map)).toEqual({
            kind: 'not-found',
            suggestions: [],
            file: '404.html'
        })
    })

    test('the former paths of an unpublished note are gone, unless a published note has them', () => {
        const map = mapOf(
            [{ path: 'Garden/Mint.md', aliases: [], formerPaths: ['Herbs/Basil.md'] }],
            [
                {
                    path: 'Garden/Rain barrel.md',
                    aliases: [],
                    formerPaths: ['Shed/Rain butt.md', 'Herbs/Basil.md']
                }
            ]
        )
        const GONE: Resolution = { kind: 'gone', file: '410.html' }
        expect(resolve('/Shed/Rain+butt', map)).toEqual(GONE)
        expect(resolve('/shed/rain+butt', map)).toEqual(GONE)
        expect(resolve('/Rain+butt', map)).toEqual(GONE)
        expect(resolve('/-/md/Shed/Rain+butt.md', map)).toEqual(GONE)
        expect(resolve('/Herbs/Basil', map)).toEqual(moved('/Garden/Mint'))
        expect(JSON.stringify(map)).not.toContain('Rain butt')
    })

    // Decision R82: a published note had the name, so it is a reading of it.
    test('a former file name of a published note wins over the file name of an unpublished note', () => {
        const map = mapOf(
            [{ path: 'Garden/Mint.md', aliases: [], formerPaths: ['Herbs/Basil.md'] }],
            [{ path: 'Kitchen/Basil.md', aliases: [] }]
        )
        expect(resolve('/Basil', map)).toEqual(moved('/Garden/Mint'))
        expect(resolve('/Kitchen/Basil', map)).toEqual({ kind: 'gone', file: '410.html' })
    })

    // The last owner of an address wins (business rule 1): a note took the
    // old path of another note, then the author unpublished it.
    test('the path and the Markdown path of an unpublished note win over a former path of another note, and a former path still wins over a file name', () => {
        const map = mapOf(
            [{ path: 'Garden/Moved.md', aliases: [], formerPaths: ['Shed/Tools.md', 'Tools.md'] }],
            [{ path: 'Shed/Tools.md', aliases: [] }]
        )
        const GONE: Resolution = { kind: 'gone', file: '410.html' }
        expect(resolve('/Shed/Tools', map)).toEqual(GONE)
        expect(resolve('/shed/tools', map)).toEqual(GONE)
        expect(resolve('/-/md/Shed/Tools.md', map)).toEqual(GONE)
        expect(resolve('/Tools', map)).toEqual(moved('/Garden/Moved'))
    })
})
