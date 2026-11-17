import { describe, expect, test } from 'bun:test'
import { resolve, type ResolverMap } from './resolver.ts'

// The resolver (MOD-05 of the spec): a pure function that turns a requested
// path into the page to serve, or "not found". The first slice knows the
// canonical path of a published note. The variants, the redirects and "gone"
// come with the slice of the URL contract.
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
        expect(resolve('/10+Garden/No+such+note', MAP)).toEqual({ kind: 'not-found' })
        expect(resolve('/', MAP)).toEqual({ kind: 'not-found' })
    })

    // A name of a note can be the name of a member of every object.
    test('does not find a path that is a name of the language', () => {
        expect(resolve('constructor', MAP)).toEqual({ kind: 'not-found' })
        expect(resolve('__proto__', MAP)).toEqual({ kind: 'not-found' })
    })
})
