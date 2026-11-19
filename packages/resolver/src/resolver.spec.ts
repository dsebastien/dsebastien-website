import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { foldedForm, resolve, type ResolverMap } from './resolver.ts'
import { resolverMapOf, type SiteFiles } from './site.ts'

// The resolver (MOD-05 of the spec): a pure function that turns a requested
// path into the page to serve, or "not found". The first slice knows the
// canonical path of a published note. The variants and the redirects are in
// the URL table (`table.spec.ts`), and "gone" comes with issue 38.
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
