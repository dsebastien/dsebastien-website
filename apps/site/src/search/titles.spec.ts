import { describe, expect, test } from 'bun:test'
import {
    foldedWords,
    matchTitles,
    partFile,
    partOf,
    titleIndexOf,
    type TitleEntry,
    type TitleRow
} from './titles.ts'
import { isShownProperty } from '../property-filter.ts'

// Invented rows: [text, path, type label, title of the note when the row is an alias].
const ROWS: TitleRow[] = [
    ['Compost basics', '/10-Garden/Compost-basics', 'Map of content'],
    ['Hot composting', '/10-Garden/Hot-composting', 'Concept'],
    ['Compost', '/10-Garden/Compost', 'Concept'],
    ['Cold compost tea', '/10-Garden/Cold-compost-tea', ''],
    ['Brown matter', '/10-Garden/Compost', 'Concept', 'Compost'],
    ['Compost heap', '/10-Garden/Compost', 'Concept', 'Compost']
]

describe('the titles that answer a query (SRCH-02)', () => {
    test('match when each word of the query starts a word of the title', () => {
        expect(matchTitles('comp', ROWS).map((match) => match.text)).toEqual([
            'Compost',
            'Compost basics',
            'Hot composting',
            'Cold compost tea'
        ])
        expect(matchTitles('tea cold', ROWS).map((match) => match.text)).toEqual([
            'Cold compost tea'
        ])
    })

    test('do not match inside a word', () => {
        expect(matchTitles('post', ROWS)).toEqual([])
    })

    test('ignore the letter case and the accents', () => {
        const rows: TitleRow[] = [['Évier à compost', '/Evier', '']]
        expect(matchTitles('EVIER a', rows).map((match) => match.text)).toEqual(['Évier à compost'])
    })

    test('give an alias with the title of its note, once per note', () => {
        expect(matchTitles('brown', ROWS)).toEqual([
            {
                text: 'Brown matter',
                path: '/10-Garden/Compost',
                type: 'Concept',
                aliasOf: 'Compost'
            }
        ])
        // The note "Compost" matches by its title and by its alias "Compost heap": one row.
        expect(
            matchTitles('compost', ROWS).filter((match) => match.path === '/10-Garden/Compost')
        ).toEqual([{ text: 'Compost', path: '/10-Garden/Compost', type: 'Concept' }])
    })

    test('rank the exact title, then a title that starts with the query, then the rest', () => {
        const rows: TitleRow[] = [
            ['Tea for plants', '/a', ''],
            ['Compost tea', '/b', ''],
            ['Tea', '/c', ''],
            ['Tea', '/d', '', 'Tea for plants']
        ]
        expect(matchTitles('tea', rows).map((match) => match.path)).toEqual([
            '/c',
            '/d',
            '/a',
            '/b'
        ])
    })

    test('give 10 titles at most', () => {
        const rows: TitleRow[] = Array.from({ length: 30 }, (_, index) => [
            `Seed ${String(index)}`,
            `/seed-${String(index)}`,
            ''
        ])
        expect(matchTitles('seed', rows)).toHaveLength(10)
    })

    test('give nothing for an empty query', () => {
        expect(matchTitles('  ', ROWS)).toEqual([])
        expect(matchTitles('·', ROWS)).toEqual([])
    })
})

/** A note with a title of the words, at a path of its own. */
function entry(title: string, aliases: string[] = [], type = ''): TitleEntry {
    return { path: `/${title.replaceAll(' ', '-')}`, title, aliases, type }
}

describe('the parts of the title index (SRCH-02, R57)', () => {
    test('put a note in the part of the first two letters of each of its words', () => {
        const index = titleIndexOf([entry('Compost tea', ['Brew'], 'Concept')])
        expect(Object.keys(index.keys).sort()).toEqual(['br', 'co', 'te'])
        expect(index.keys['co']).toBe(true)
        expect(index.parts.get('co')).toEqual([['Compost tea', '/Compost-tea', 'Concept']])
        expect(index.parts.get('br')).toEqual([['Brew', '/Compost-tea', 'Concept', 'Compost tea']])
    })

    test('take the aliases through the filter of the properties panel (business rule 14, issue 100)', () => {
        // Today the filter shows the key `aliases`: the aliases are in the index.
        expect(isShownProperty('aliases')).toBe(true)
        // A filter that hides the key (a later allow list) leaves every alias out, and keeps the title.
        const index = titleIndexOf([entry('Compost tea', ['Brew'], 'Concept')], {
            isShown: (key) => key !== 'aliases'
        })
        expect(Object.keys(index.keys).sort()).toEqual(['co', 'te'])
        expect(index.parts.get('co')).toEqual([['Compost tea', '/Compost-tea', 'Concept']])
    })

    test('leave out an alias that says the title again', () => {
        const index = titleIndexOf([entry('Compost tea', ['compost  Tea', 'Compost-tea'])])
        expect(index.parts.get('co')).toEqual([['Compost tea', '/Compost-tea', '']])
    })

    test('split a part that is too large by one more letter, and keep its best rows', () => {
        const entries = [
            ...Array.from({ length: 30 }, (_, index) => entry(`Seed ${String(index)}`)),
            ...Array.from({ length: 30 }, (_, index) => entry(`Seaweed ${String(index)}`)),
            entry('Se')
        ]
        const index = titleIndexOf(entries, { partBytes: 1_000, rowsOfSplitPart: 5 })
        // The part "se" is split: it keeps 5 rows, the words that are "se" first, then the shortest.
        expect(index.keys['se']).toBe(false)
        expect(index.parts.get('se')?.map((row) => row[0])).toEqual([
            'Se',
            'Seed 0',
            'Seed 1',
            'Seed 2',
            'Seed 3'
        ])
        for (const key of Object.keys(index.keys)) {
            expect(JSON.stringify(index.parts.get(key)).length, key).toBeLessThanOrEqual(1_000)
        }
        // Each row is in a complete part of each of its words.
        const complete = Object.entries(index.keys).filter(([, whole]) => whole)
        for (const one of entries.slice(0, -1)) {
            const word = foldedWords(one.title)[0] ?? ''
            expect(
                complete.some(
                    ([key]) =>
                        word.startsWith(key) &&
                        (index.parts.get(key) ?? []).some((row) => row[1] === one.path)
                ),
                one.title
            ).toBe(true)
        }
    })

    test('have file names of plain ASCII', () => {
        expect(partFile('co')).toBe('636f')
        expect(partFile('év')).toBe('c3a976')
    })
})

describe('a part at the most letters of a key (round 1, finding 1)', () => {
    test('answers a longer word of the query with its best rows', () => {
        const entries = Array.from({ length: 60 }, (_, index) =>
            entry(`Knowledge ${String(index)}`)
        )
        const index = titleIndexOf(entries, { partBytes: 500, rowsOfSplitPart: 5 })
        expect(index.keys['knowledg']).toBe(false)
        expect(partOf('knowledge', index.keys)).toEqual({ key: 'knowledg', complete: false })
        expect(partOf('knowledge 12', index.keys)).toEqual({ key: '12', complete: true })
        expect(partOf('knowledgeable', index.keys)).toEqual({ key: 'knowledg', complete: false })
    })
})

describe('the part that answers a query', () => {
    const keys = { co: false, com: true, cop: true, te: true, se: false }

    test('is the deepest part of a word of the query', () => {
        expect(partOf('compost', keys)).toEqual({ key: 'com', complete: true })
        expect(partOf('co', keys)).toEqual({ key: 'co', complete: false })
    })

    test('is a complete part when a word of the query has one', () => {
        expect(partOf('co te', keys)).toEqual({ key: 'te', complete: true })
    })

    test('is none when a word of the query starts no word of any title', () => {
        expect(partOf('cox', keys)).toBeUndefined()
        expect(partOf('compost zebra', keys)).toBeUndefined()
        expect(partOf('sex', keys)).toBeUndefined()
    })

    test('is none while each word of the query has one letter', () => {
        expect(partOf('c t', keys)).toBeUndefined()
        expect(partOf('', keys)).toBeUndefined()
    })

    test('takes the part of the two letters of a longer word whose part is not split', () => {
        expect(partOf('tea', keys)).toEqual({ key: 'te', complete: true })
    })
})
