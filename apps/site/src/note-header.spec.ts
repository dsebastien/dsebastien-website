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

describe('the type badge of a note', () => {
    test('names the note type of the first type tag', () => {
        expect(
            noteHeader({
                ...NOTE,
                properties: { tags: ['topic/soil', 'type/note', 'type/recipe'] }
            }).type
        ).toBe('Note')
    })

    test('writes the words of a type with spaces', () => {
        expect(noteHeader({ ...NOTE, properties: { tags: ['type/permanent_note'] } }).type).toBe(
            'Permanent note'
        )
        expect(noteHeader({ ...NOTE, properties: { tags: ['#type/board-game'] } }).type).toBe(
            'Board game'
        )
    })

    test('reads a tags property of one text', () => {
        expect(noteHeader({ ...NOTE, properties: { tags: 'type/movie' } }).type).toBe('Movie')
    })

    test('is absent when the note has no type tag', () => {
        expect(noteHeader({ ...NOTE, properties: { tags: ['topic/soil'] } }).type).toBeUndefined()
        expect(noteHeader({ ...NOTE, properties: { tags: 'type/' } }).type).toBeUndefined()
        expect(noteHeader(NOTE).type).toBeUndefined()
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
