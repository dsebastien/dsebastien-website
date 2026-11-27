import { describe, expect, test } from 'bun:test'
import { noteHeader, type NoteHeaderInput } from './note-header.ts'

// The title band of a note page (issue 47): the display title, the type badge
// and the created and updated dates (PAGE-05, IDX-03, R58).
const NOTE: NoteHeaderInput = {
    fileName: 'Compost basics',
    properties: {},
    firstPublished: '2031-03-01T07:30:00Z',
    lastPublished: '2031-03-20T18:05:00Z'
}

describe('the display title of a note', () => {
    test('is the title property when it says something else than the file name', () => {
        const header = noteHeader({
            ...NOTE,
            properties: { title: 'How compost works' },
            firstHeading: 'Compost'
        })

        expect(header.title).toBe('How compost works')
    })

    test('is the first heading when the title property only repeats the file name', () => {
        const header = noteHeader({
            ...NOTE,
            properties: { title: 'Compost basics' },
            firstHeading: 'Compost, the basics'
        })

        expect(header.title).toBe('Compost, the basics')
    })

    test('is the first heading when the title property is empty or not a text', () => {
        expect(
            noteHeader({ ...NOTE, properties: { title: '  ' }, firstHeading: 'Compost' }).title
        ).toBe('Compost')
        expect(
            noteHeader({ ...NOTE, properties: { title: 42 }, firstHeading: 'Compost' }).title
        ).toBe('Compost')
    })

    test('is the file name when the note has no title property and no first heading', () => {
        expect(noteHeader(NOTE).title).toBe('Compost basics')
    })

    test('is the file name when the first heading is empty', () => {
        expect(noteHeader({ ...NOTE, firstHeading: ' ' }).title).toBe('Compost basics')
    })
})

describe('the display title of a note with a note type', () => {
    const book = { name: 'book-notes', displayName: 'Book Notes', suffix: ' (Book)' }
    const wiki = { name: 'ai-wiki-articles', displayName: 'AI Wiki Articles', prefix: 'AI Wiki - ' }

    test('is the file name without the suffix of its type', () => {
        expect(noteHeader({ ...NOTE, fileName: 'Dune (Book)', noteType: book }).title).toBe('Dune')
    })

    test('is the file name without the prefix of its type', () => {
        expect(noteHeader({ ...NOTE, fileName: 'AI Wiki - Mulch', noteType: wiki }).title).toBe(
            'Mulch'
        )
    })

    test('ignores a title property that repeats the file name with or without its suffix', () => {
        for (const title of ['Dune (Book)', 'Dune']) {
            const header = noteHeader({
                ...NOTE,
                fileName: 'Dune (Book)',
                noteType: book,
                properties: { title },
                firstHeading: 'Dune, the novel'
            })
            expect(header.title, title).toBe('Dune, the novel')
        }
    })

    test('keeps a file name that does not carry the affix, or that is only the affix', () => {
        expect(noteHeader({ ...NOTE, fileName: 'Dune', noteType: book }).title).toBe('Dune')
        expect(noteHeader({ ...NOTE, fileName: ' (Book)', noteType: book }).title).toBe(' (Book)')
    })

    test('keeps a prefix with a token of the Starter Kit: the site cannot tell the date', () => {
        const posts = { name: 'social-posts', displayName: 'Social Posts', prefix: '{{date}} - ' }
        expect(noteHeader({ ...NOTE, fileName: '2031-03-14 - Frost', noteType: posts }).title).toBe(
            '2031-03-14 - Frost'
        )
    })

    test('gives the file name without the affixes for a title that two pages share', () => {
        const header = noteHeader({
            ...NOTE,
            fileName: 'Garden letter 1 (Newsletter)',
            noteType: {
                name: 'own-newsletters',
                displayName: 'Own Newsletters',
                suffix: ' (Newsletter)'
            },
            firstHeading: 'The garden letter'
        })
        expect(header.title).toBe('The garden letter')
        expect(header.bareName).toBe('Garden letter 1')
    })
})

describe('the type badge of a note', () => {
    test('is the label of its note type', () => {
        const header = noteHeader({
            ...NOTE,
            noteType: { name: 'movies', displayName: 'Movies', suffix: ' (Movie)' }
        })
        expect(header.type).toEqual({ name: 'movies', one: 'Movie', many: 'Movies', media: true })
    })

    test('is the display name of a type that the table of the site does not know', () => {
        expect(
            noteHeader({ ...NOTE, noteType: { name: 'recipes', displayName: 'Recipes' } }).type?.one
        ).toBe('Recipes')
    })

    test('is absent for a note with no type, whatever its tags say', () => {
        expect(noteHeader({ ...NOTE, properties: { tags: ['type/movie'] } }).type).toBeUndefined()
    })
})

describe('the dates of a note', () => {
    test('are the created and updated properties, as the vault writes them', () => {
        const header = noteHeader({
            ...NOTE,
            properties: { created: '2024-03-02T09:15', updated: '2026-11-18T21:40' }
        })

        expect(header.created).toEqual({ datetime: '2024-03-02', shown: '2024-03-02' })
        expect(header.updated).toEqual({ datetime: '2026-11-18', shown: '2026-11-18' })
    })

    test('read a date with no time and a date with a space before the time', () => {
        const header = noteHeader({
            ...NOTE,
            properties: { created: '2024-03-02', updated: '2026-11-18 21:40' }
        })

        expect(header.created.datetime).toBe('2024-03-02')
        expect(header.updated.datetime).toBe('2026-11-18')
    })

    // A date with the tag `!!timestamp` stays the text of the note (issue 93),
    // in any form that YAML reads as a timestamp: a month or a day of one
    // digit, a small `t`, a tab before the time.
    test('read a date in the loose forms of a YAML timestamp', () => {
        const header = noteHeader({
            ...NOTE,
            properties: { created: '2031-3-9t08:00:00+02:00', updated: '2031-03-20\t10:00' }
        })

        expect(header.created).toEqual({ datetime: '2031-03-09', shown: '2031-03-09' })
        expect(header.updated).toEqual({ datetime: '2031-03-20', shown: '2031-03-20' })
        expect(
            noteHeader({ ...NOTE, properties: { created: '2031-2-30 10:00' } }).created.datetime
        ).toBe('2031-03-01')
    })

    // A YAML reader turns a timestamp with seconds into a date of UTC.
    test('read a date that the YAML reader made a date object', () => {
        const header = noteHeader({
            ...NOTE,
            properties: { created: new Date('2024-03-02T00:00:00Z') }
        })

        expect(header.created.datetime).toBe('2024-03-02')
    })

    test('are the dates of the first and last publication when the note has no date property', () => {
        const header = noteHeader(NOTE)

        expect(header.created).toEqual({ datetime: '2031-03-01', shown: '2031-03-01' })
        expect(header.updated).toEqual({ datetime: '2031-03-20', shown: '2031-03-20' })
    })

    test('are the dates of publication when a date property is not a date', () => {
        const header = noteHeader({
            ...NOTE,
            properties: {
                created: 'someday',
                updated: '2031-02-30T10:00'
            }
        })

        expect(header.created.datetime).toBe('2031-03-01')
        expect(header.updated.datetime).toBe('2031-03-20')
    })

    test('ignore a date object that is not a valid date', () => {
        expect(
            noteHeader({ ...NOTE, properties: { created: new Date('nothing') } }).created.datetime
        ).toBe('2031-03-01')
    })
})
