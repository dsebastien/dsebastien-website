import { describe, expect, test } from 'bun:test'
import { resolverMapFrom } from './map.ts'
import { applyRedirectList } from './redirects.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'

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

/** A map with every part, as a release holds it: JSON text. */
function written(): Record<string, unknown> {
    const base = resolverMapOf(
        [
            { path: 'Welcome.md', aliases: ['Hello'] },
            { path: '10 Garden/Mint.md', aliases: [], formerPaths: ['10 Garden/Herbs/Mint.md'] }
        ],
        FILES,
        { [`/-/attachments/${KEY}/photo.png`]: KEY },
        {},
        [{ path: '10 Garden/Rain barrel.md', aliases: [] }]
    )
    const { map } = applyRedirectList(base, {
        redirects: [{ from: 'Old/Mint', to: '/10+Garden/Mint' }],
        gone: ['Old/Stats'],
        prefixes: [{ from: 'Old docs/', to: '/Welcome' }]
    })
    // The cast is the boundary of the test: the text of a map is a record.
    return JSON.parse(JSON.stringify(map)) as Record<string, unknown>
}

describe('the reader of a resolver map', () => {
    test('takes a map that the build wrote, as it is', () => {
        const value = written()
        expect(resolverMapFrom(value)).toBe(value as never)
    })

    test('takes a map with its pages only', () => {
        expect(resolverMapFrom({ pages: {} })).toEqual({ pages: {} })
    })

    test.each([
        ['a text', 'pages'],
        ['a list', []],
        ['nothing', null],
        ['a map without pages', {}],
        ['a page that is not a file name', { pages: { '/Welcome': 1 } }]
    ])('refuses %s', (_name, value) => {
        expect(() => resolverMapFrom(value)).toThrow('-/resolver-map.json is not a resolver map')
    })

    test.each([
        ['files', { '/robots.txt': { file: 'robots.txt', type: 'html' } }],
        ['attachments', { '/-/attachments/x/photo.png': '../outside' }],
        ['folded', { welcome: ['/Welcome'] }],
        ['names', { welcome: '/Welcome' }],
        ['aliases', { hello: [1] }],
        ['choices', { '/Welcome': {} }],
        ['notFound', 404],
        ['gone', { longest: -1, paths: {}, folded: {}, names: {}, aliases: {} }],
        ['gone', { longest: 3, paths: { a: 'yes' }, folded: {}, names: {}, aliases: {} }],
        ['former', { folded: {}, names: {} }],
        ['former', { folded: { a: '/A' }, names: {}, markdown: {} }],
        ['redirects', { longest: 1, folded: {} }],
        [
            'redirects',
            {
                longest: 1,
                folded: {},
                prefixes: {},
                prefixLengths: [],
                temporary: { a: 1 },
                counts: {}
            }
        ],
        [
            'redirects',
            {
                longest: 1,
                folded: {},
                prefixes: {},
                prefixLengths: [],
                temporary: {},
                counts: { a: 'x' }
            }
        ],
        ['redirects', { longest: 1, folded: {}, prefixes: {}, prefixLengths: [] }],
        ['redirects', { longest: 1, folded: {}, prefixes: {}, prefixLengths: ['3'] }],
        ['redirects', { longest: 1, folded: {}, prefixes: {} }],
        ['redirects', { folded: {}, prefixes: {} }],
        ['redirects', { longest: -1, folded: {}, prefixes: {} }],
        ['redirects', { longest: 1, folded: { a: ['/A'] }, prefixes: {} }],
        ['redirects', { longest: 1, folded: {}, prefixes: [['a/', '/A']] }]
    ])('refuses a map with a wrong part "%s"', (part, value) => {
        expect(() => resolverMapFrom({ ...written(), [part]: value })).toThrow(
            'is not a resolver map'
        )
    })
})
