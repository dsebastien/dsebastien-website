import { describe, expect, test } from 'bun:test'
import {
    DESCRIPTION_LENGTH,
    noteDescription,
    plainTextOf,
    uniqueDescriptions
} from './descriptions.ts'

const MOVIE = {
    title: 'Inception',
    typeLabel: 'Movie',
    properties: {
        release_date: '2010-07-16',
        directors: ['[[Christopher Nolan]]'],
        rating: 8,
        status: 'Watched'
    },
    html: '<p>A thief who steals secrets through dreams.</p>'
}

describe('the description of a note', () => {
    test('is its description property', () => {
        expect(
            noteDescription({ ...MOVIE, properties: { description: '  A heist  in dreams. ' } })
        ).toBe('A heist in dreams.')
    })

    test('starts with the type and the data of the author, then the text', () => {
        expect(noteDescription(MOVIE)).toBe(
            'Movie, 2010, by Christopher Nolan, rated 8 by Sébastien, watched. A thief who steals secrets through dreams.'
        )
    })

    test('names two creators, or two and others', () => {
        expect(
            noteDescription({
                ...MOVIE,
                properties: { authors: ['[[Ada Quillfeather|Ada]]', 'Bo Lind'] },
                html: ''
            })
        ).toBe('Movie, by Ada and Bo Lind.')
        expect(
            noteDescription({
                ...MOVIE,
                properties: { authors: ['A', 'B', 'C'] },
                html: ''
            })
        ).toBe('Movie, by A, B and others.')
    })

    test('is the text alone for a note with no type and no such property', () => {
        expect(
            noteDescription({
                title: 'Compost',
                properties: { status: '' },
                html: '<h2>Notes</h2><p>Brown and green layers.</p><pre><code>x = 1</code></pre>'
            })
        ).toBe('Brown and green layers.')
    })

    test('is cut at a word end with an end mark', () => {
        const long = noteDescription({
            ...MOVIE,
            properties: {},
            html: `<p>${'grow '.repeat(60)}</p>`
        })
        expect(long.length).toBeLessThanOrEqual(DESCRIPTION_LENGTH)
        expect(long.endsWith('grow…')).toBe(true)
    })

    test.each([
        ['an emoji of one code point', '🌱'],
        ['a family of joined emoji', '👨‍👩‍👧'],
        ['a flag', '🇧🇪'],
        ['a letter with a combining accent', 'e\u0301']
    ])('is cut on whole characters, never inside %s', (_name, character) => {
        const cut = noteDescription({
            title: 'Seeds',
            properties: {},
            html: `<p>${character.repeat(200)}</p>`
        })
        expect(cut).toBe(`${character.repeat(DESCRIPTION_LENGTH - 1)}…`)
    })

    test('is never empty', () => {
        expect(noteDescription({ title: 'Mint', properties: {}, html: '' })).toBe(
            'Mint, a note of Sébastien’s Notes.'
        )
    })
})

describe('the text of a body', () => {
    test('is its paragraphs and list items, without code, diagrams and math', () => {
        expect(
            plainTextOf(
                '<p>One  <a href="/x">two</a>.</p><ul><li>three</li></ul><svg><text>no</text></svg><math><mi>y</mi></math>'
            )
        ).toBe('One two. three')
    })
})

describe('the descriptions of the notes', () => {
    test('get the title in front when two pages share one', () => {
        const descriptions = uniqueDescriptions([
            { key: '1.md', title: 'Letter 1', description: 'A garden letter.' },
            { key: '2.md', title: 'Letter 2', description: 'A garden letter.' },
            { key: '3.md', title: 'Mint', description: 'A herb.' }
        ])
        expect(descriptions.get('1.md')).toBe('Letter 1: A garden letter.')
        expect(descriptions.get('2.md')).toBe('Letter 2: A garden letter.')
        expect(descriptions.get('3.md')).toBe('A herb.')
    })

    test('stop the build when two pages still share one', () => {
        expect(() =>
            uniqueDescriptions([
                { key: 'a.md', title: 'Mint', description: 'A herb.' },
                { key: 'b.md', title: 'Mint', description: 'A herb.' }
            ])
        ).toThrow('two pages share the description')
    })
})
