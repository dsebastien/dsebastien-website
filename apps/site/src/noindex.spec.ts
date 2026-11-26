import { describe, expect, test } from 'bun:test'
import { isNoindexNote, NOINDEX_PROPERTY } from './noindex.ts'

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
