import { describe, expect, test } from 'bun:test'
import type { NoteType } from '../../plugin/src/publishing/note-types.ts'
import {
    existsOnMainSite,
    isInNoindexFolder,
    isNoindexNote,
    NOINDEX_PROPERTY,
    signalsOf,
    unusedNoindexFolders,
    type NoteSignals
} from './noindex.ts'

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

// Issue 55 (ADR 0010, IDX-11 to IDX-14, R90): a note that also exists on the
// main site names the verified post as its original, is indexed there and
// not here, and leaves the sitemaps; without a verified post, it is noindex.
// The scope is the rule of the tool, on the text of the cleaned note.
describe('the search signals of a note', () => {
    const ARTICLE = { name: 'own-articles', displayName: 'Own Articles' }
    const TOOL = { name: 'tools', displayName: 'Tools' }
    const POST = 'https://www.dsebastien.net/a-post/'
    const PLAIN = 'Text\n'

    function signals(
        note: { noteType?: NoteType; original?: string },
        properties: Record<string, unknown>,
        cleaned: string
    ): NoteSignals {
        return signalsOf(note, properties, existsOnMainSite(cleaned, note.noteType))
    }

    test('a note of another type names itself, also with a recorded original', () => {
        expect(signals({ noteType: TOOL }, {}, PLAIN)).toEqual({ noindex: false, inSitemaps: true })
        expect(signals({ original: POST }, {}, PLAIN)).toEqual({ noindex: false, inSitemaps: true })
    })

    test('a note with a verified post names it, and leaves the sitemaps', () => {
        expect(signals({ noteType: ARTICLE, original: POST }, {}, PLAIN)).toEqual({
            noindex: false,
            original: POST,
            inSitemaps: false
        })
    })

    test('a note without a verified post is noindex, and leaves the sitemaps', () => {
        expect(signals({ noteType: ARTICLE }, {}, PLAIN)).toEqual({
            noindex: true,
            inSitemaps: false
        })
    })

    test('the noindex property still counts', () => {
        expect(
            signals({ noteType: ARTICLE, original: POST }, { publish_noindex: true }, PLAIN)
        ).toEqual({
            noindex: true,
            original: POST,
            inSitemaps: false
        })
        expect(signals({}, { publish_noindex: true }, PLAIN)).toEqual({
            noindex: true,
            inSitemaps: false
        })
    })

    // A note that the Ghost Publish plugin posted, whatever its type.
    test('a note with the property of the Ghost Publish plugin is in scope, whatever its value', () => {
        const posted = `---\nurl: https://tool.example/\npublic_ghost_blog_news_url: ${POST}\n---\nText\n`
        expect(signals({ noteType: TOOL, original: POST }, {}, posted)).toEqual({
            noindex: false,
            original: POST,
            inSitemaps: false
        })
        expect(signals({ noteType: TOOL }, {}, posted)).toEqual({
            noindex: true,
            inSitemaps: false
        })
        for (const value of ['', '~', 'null', '>-']) {
            const cleaned = `---\npublic_ghost_blog_news_url: ${value}\n---\nText\n`
            expect(signals({ noteType: TOOL }, {}, cleaned), value).toEqual({
                noindex: true,
                inSitemaps: false
            })
        }
        expect(
            signals(
                { noteType: TOOL },
                {},
                `---\n"public_ghost_blog_news_url": ${POST}\n---\nText\n`
            )
        ).toEqual({ noindex: true, inSitemaps: false })
    })
})

// Decision R103: the list `noindexFolders` of the configuration of the content
// store. A note under one of its folders is noindex as a note with
// `publish_noindex: true` is; it is not a guard.
describe('the noindex folders', () => {
    const FOLDERS = ['Seed Bank', 'Pond/Frogs']

    test('cover the notes under a folder, at any depth', () => {
        expect(isInNoindexFolder('Seed Bank/Bean.md', FOLDERS)).toBe(true)
        expect(isInNoindexFolder('Seed Bank/Old/Pea.md', FOLDERS)).toBe(true)
        expect(isInNoindexFolder('Pond/Frogs/Green frog.md', FOLDERS)).toBe(true)
    })

    test('match whole folder names only', () => {
        expect(isInNoindexFolder('Seed Banking/Bean.md', FOLDERS)).toBe(false)
        expect(isInNoindexFolder('Pond/Frogspawn/Eggs.md', FOLDERS)).toBe(false)
        expect(isInNoindexFolder('Pond/Lily.md', FOLDERS)).toBe(false)
        expect(isInNoindexFolder('Seed Bank.md', FOLDERS)).toBe(false)
        expect(isInNoindexFolder('Garden/Seed Bank/Bean.md', FOLDERS)).toBe(false)
        expect(isInNoindexFolder('seed bank/Bean.md', FOLDERS)).toBe(false)
    })

    test('cover nothing when the list is empty', () => {
        expect(isInNoindexFolder('Seed Bank/Bean.md', [])).toBe(false)
    })

    test('give a note the signals of the noindex property', () => {
        const note = {}
        expect(signalsOf(note, {}, false, true)).toEqual(
            signalsOf(note, { publish_noindex: true }, false)
        )
        expect(signalsOf(note, {}, false, true)).toEqual({ noindex: true, inSitemaps: false })
        expect(signalsOf(note, {}, false, false)).toEqual({ noindex: false, inSitemaps: true })
    })

    test('keep the original of a note of the main site, as the property does', () => {
        const ARTICLE = { name: 'own-articles', displayName: 'Own Articles' }
        const POST = 'https://www.dsebastien.net/a-post/'
        expect(signalsOf({ noteType: ARTICLE, original: POST }, {}, true, true)).toEqual({
            noindex: true,
            original: POST,
            inSitemaps: false
        })
    })

    test('name the folders that cover no published note, in the order of the list', () => {
        expect(
            unusedNoindexFolders(
                ['Seed Bank', 'Pond/Frogs', 'Seed', 'Shed'],
                ['Seed Bank/Bean.md', 'Pond/Frogspawn/Eggs.md', 'Shed.md']
            )
        ).toEqual(['Pond/Frogs', 'Seed', 'Shed'])
        expect(unusedNoindexFolders([], ['Seed Bank/Bean.md'])).toEqual([])
    })
})
