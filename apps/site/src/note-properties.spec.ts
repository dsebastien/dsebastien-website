import { describe, expect, test } from 'bun:test'
import { noteHeader } from './note-header.ts'
import { readProperties } from './note-properties.ts'
import { propertiesOf } from './properties.ts'

// The properties of a cleaned note, as the build reads them (issue 48, first
// review): a date stays the text that the vault writes. The reader of a
// content collection turns a date into a moment in UTC, which loses the form
// of the vault (its time zone, its seconds, a day that does not exist).

function note(properties: string, text = '# Note\n'): string {
    return `---\n${properties}\n---\n\n${text}`
}

describe('properties of a cleaned note', () => {
    test('reads the texts, the numbers, the truth values, the lists and the objects of the note', () => {
        expect(
            readProperties(
                note(
                    'status: To watch\nrating: 4\nai_generated: true\nempty:\ntags:\n  - type/movie\n  - topic/water\nplot: { beds: 2 }'
                )
            )
        ).toEqual({
            status: 'To watch',
            rating: 4,
            ai_generated: true,
            empty: null,
            tags: ['type/movie', 'topic/water'],
            plot: { beds: 2 }
        })
    })

    test('keeps every date as the text of the vault, also without quotes', () => {
        expect(
            readProperties(
                note(
                    'born: 1961-04-12\ncreated: 2031-03-07T07:00\nseen: 2031-03-09T08:00:00+02:00\nlate: 2031-03-09 23:30:15\nnever: 2031-02-30\nquoted: "2031-03-07T07:02"'
                )
            )
        ).toEqual({
            born: '1961-04-12',
            created: '2031-03-07T07:00',
            seen: '2031-03-09T08:00:00+02:00',
            late: '2031-03-09 23:30:15',
            never: '2031-02-30',
            quoted: '2031-03-07T07:02'
        })
    })

    test('keeps the order of the note, and the links as texts', () => {
        const properties = readProperties(
            note('zebra: 1\ndirectors:\n  - "[[Ada Quillfeather]]"\napple: 2')
        )

        expect(Object.keys(properties)).toEqual(['zebra', 'directors', 'apple'])
        expect(properties['directors']).toEqual(['[[Ada Quillfeather]]'])
    })

    test('a note without properties, or whose properties are no list of keys, has none', () => {
        expect(readProperties('# Note\n\nText.\n')).toEqual({})
        expect(readProperties(note(''))).toEqual({})
        expect(readProperties(note('- one\n- two'))).toEqual({})
        expect(readProperties(note('just a text'))).toEqual({})
    })

    test('reads a note with Windows line ends', () => {
        expect(readProperties('---\r\nstatus: Seen\r\n---\r\n\r\n# Note\r\n')).toEqual({
            status: 'Seen'
        })
    })
})

// The whole path of a date: from the text of the note to the page.
describe('dates of a note, from its text to its page', () => {
    const properties = readProperties(
        note(
            'seen: 2031-03-09T08:00:00+02:00\nlate: 2031-03-09 23:30:15\nnever: 2031-02-30\nborn: 1961-04-12\ncreated: 2031-03-09T01:00:00+02:00\nupdated: 2031-02-30'
        )
    )
    const panel = new Map(
        propertiesOf(properties, () => undefined).map((property) => [property.key, property.value])
    )

    test('the panel shows a time as the vault writes it, with no change of time zone', () => {
        expect(panel.get('seen')).toEqual({
            kind: 'date',
            datetime: '2031-03-09T08:00',
            text: '2031-03-09, 08:00'
        })
        expect(panel.get('late')).toEqual({
            kind: 'date',
            datetime: '2031-03-09T23:30',
            text: '2031-03-09, 23:30'
        })
        expect(panel.get('born')).toEqual({
            kind: 'date',
            datetime: '1961-04-12',
            text: '1961-04-12'
        })
    })

    test('the panel hides a day that the calendar does not have', () => {
        expect(panel.has('never')).toBe(false)
        expect(panel.has('updated')).toBe(false)
    })

    test('the title band shows the day of the vault, and the day of the publication for a day that does not exist', () => {
        const header = noteHeader({
            fileName: 'Note',
            properties,
            firstPublished: '2031-04-01T08:00:00Z',
            lastPublished: '2031-04-02T08:00:00Z'
        })

        // Early in the morning at +02:00 is the day before in UTC: the band keeps the day of the vault.
        expect(header.created.shown).toBe('2031-03-09')
        expect(header.updated.shown).toBe('2031-04-02')
    })
})
