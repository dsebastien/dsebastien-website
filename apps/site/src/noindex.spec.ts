import { describe, expect, test } from 'bun:test'
import { isNoindexNote, NOINDEX_PROPERTY, signalsOf } from './noindex.ts'

// Decision R85 (IDX-20, story 100): a note with `publish_noindex: true`
// stays on the site, says noindex, and leaves the sitemaps.
describe('the noindex property of a note', () => {
    test('is publish_noindex', () => {
        expect(NOINDEX_PROPERTY).toBe('publish_noindex')
    })

    test('takes a note out of the index only with the value true', () => {
        expect(isNoindexNote({ publish_noindex: true })).toBe(true)
        for (const value of [false, 'true', 'yes', 1, null, undefined]) {
            expect(isNoindexNote({ publish_noindex: value })).toBe(false)
        }
        expect(isNoindexNote({})).toBe(false)
        expect(isNoindexNote({ noindex: true })).toBe(false)
    })
})

// Issue 55 (ADR 0010, IDX-11 to IDX-14): a note of a type that the main site
// also publishes names the verified post as its original, is indexed there
// and not here, and leaves the sitemaps; without a verified post, it is
// noindex.
describe('the search signals of a note', () => {
    const ARTICLE = { name: 'own-articles', displayName: 'Own Articles' }
    const POST = 'https://www.dsebastien.net/a-post/'

    test('a note of another type names itself, also with a recorded original', () => {
        expect(signalsOf({ noteType: { name: 'book-notes', displayName: 'Books' } }, {})).toEqual({
            noindex: false,
            inSitemaps: true
        })
        expect(signalsOf({ original: POST }, {})).toEqual({ noindex: false, inSitemaps: true })
    })

    test('a note with a verified post names it, and leaves the sitemaps', () => {
        expect(signalsOf({ noteType: ARTICLE, original: POST }, {})).toEqual({
            noindex: false,
            original: POST,
            inSitemaps: false
        })
    })

    test('a note without a verified post is noindex, and leaves the sitemaps', () => {
        expect(signalsOf({ noteType: ARTICLE }, {})).toEqual({ noindex: true, inSitemaps: false })
    })

    test('the noindex property still counts', () => {
        expect(signalsOf({ noteType: ARTICLE, original: POST }, { publish_noindex: true })).toEqual(
            { noindex: true, original: POST, inSitemaps: false }
        )
        expect(signalsOf({}, { publish_noindex: true })).toEqual({
            noindex: true,
            inSitemaps: false
        })
    })
})
