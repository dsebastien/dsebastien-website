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

// Issue 55, decision R90: a note that the Ghost Publish plugin posted also
// exists on the main site, whatever its type.
describe('the search signals of a note that the Ghost Publish plugin posted', () => {
    const TOOL = { name: 'tools', displayName: 'Tools' }
    const POST = 'https://www.dsebastien.net/a-tool/'
    const POSTED = { public_ghost_blog_news_url: POST, url: 'https://tool.example/' }

    test('names the verified post, and leaves the sitemaps', () => {
        expect(signalsOf({ noteType: TOOL, original: POST }, POSTED)).toEqual({
            noindex: false,
            original: POST,
            inSitemaps: false
        })
    })

    test('without a verified post is noindex', () => {
        expect(signalsOf({ noteType: TOOL }, POSTED)).toEqual({ noindex: true, inSitemaps: false })
        expect(signalsOf({}, POSTED)).toEqual({ noindex: true, inSitemaps: false })
    })

    test('an empty property is no post', () => {
        expect(signalsOf({ noteType: TOOL }, { public_ghost_blog_news_url: '' })).toEqual({
            noindex: false,
            inSitemaps: true
        })
    })
})
