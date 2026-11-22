import { describe, expect, test } from 'bun:test'
import type { ListedNote } from './generated-pages.ts'
import { statsLine, topicsOf } from './home.ts'

const MAP = {
    name: 'maps-of-content',
    one: 'Map of content',
    many: 'Maps of content',
    media: false
}
const NOTE = {
    name: 'permanent-notes',
    one: 'Permanent note',
    many: 'Permanent notes',
    media: false
}

function note(title: string, type: ListedNote['type'] = MAP): ListedNote {
    return { vaultPath: `${title}.md`, path: `/${title}`, title, type }
}

describe('the entry points by topic of the home page (NAV-02, R62)', () => {
    test('are the 12 maps of content that most notes link to, then A to Z', () => {
        const maps = Array.from({ length: 14 }, (_item, index) => ({
            note: note(`Map ${String(index).padStart(2, '0')}`),
            backlinks: index < 3 ? 50 : index
        }))
        const topics = topicsOf([
            ...maps,
            { note: note('Busy note', NOTE), backlinks: 999 },
            {
                note: { vaultPath: 'Untyped.md', path: '/Untyped', title: 'Untyped' },
                backlinks: 999
            }
        ])
        expect(topics.map((topic) => `${topic.note.title} ${String(topic.backlinks)}`)).toEqual([
            'Map 00 50',
            'Map 01 50',
            'Map 02 50',
            'Map 13 13',
            'Map 12 12',
            'Map 11 11',
            'Map 10 10',
            'Map 09 9',
            'Map 08 8',
            'Map 07 7',
            'Map 06 6',
            'Map 05 5'
        ])
    })

    test('are none without a map of content', () => {
        expect(topicsOf([{ note: note('Busy note', NOTE), backlinks: 3 }])).toEqual([])
    })
})

describe('the stats line of the home page (NAV-02, R62)', () => {
    test('counts the notes, the note types and the tags, with the last update', () => {
        expect(statsLine({ notes: 20734, types: 34, tags: 856, lastUpdate: '2031-05-02' })).toBe(
            '20,734 notes, 34 note types and 856 tags. Last update: 2031-05-02.'
        )
    })

    test('says one note, one type, one tag', () => {
        expect(statsLine({ notes: 1, types: 1, tags: 1, lastUpdate: '2031-05-02' })).toBe(
            '1 note, 1 note type and 1 tag. Last update: 2031-05-02.'
        )
    })
})
