import { describe, expect, test } from 'bun:test'
import { fullTitle, shareTitle, uniqueTitles } from './page-titles.ts'

describe('the title of a page', () => {
    test('is the display title, the type word and the site name', () => {
        expect(fullTitle('Inception', 'Movie')).toBe('Inception · Movie · Sébastien’s Notes')
    })

    test('has no type word for a note with no type', () => {
        expect(fullTitle('Welcome', undefined)).toBe('Welcome · Sébastien’s Notes')
    })

    test('is the site name alone for the home page', () => {
        expect(fullTitle()).toBe('Sébastien’s Notes')
    })
})

// Issue 133: a card shows the site name apart, so its title leaves it out.
describe('the title of a shared page', () => {
    test.each([
        ['a note', fullTitle('Inception', 'Movie'), 'Inception · Movie'],
        ['a page with one part', fullTitle('Library'), 'Library'],
        ['the home page', fullTitle(), 'Sébastien’s Notes'],
        [
            'a title that only holds the site name',
            'Notes of Sébastien’s Notes',
            'Notes of Sébastien’s Notes'
        ]
    ])('of %s', (_name, title, shared) => {
        expect(shareTitle(title)).toBe(shared)
    })
})

describe('the titles of the notes', () => {
    test('stay the display titles when no two pages share one', () => {
        const titles = uniqueTitles([
            { key: 'a.md', title: 'Dune', fallback: 'Dune (1965)', typeWord: 'Book' },
            { key: 'b.md', title: 'Dune', fallback: 'Dune (2021)', typeWord: 'Movie' }
        ])
        expect(titles.get('a.md')).toEqual({
            title: 'Dune',
            full: 'Dune · Book · Sébastien’s Notes'
        })
        expect(titles.get('b.md')?.full).toBe('Dune · Movie · Sébastien’s Notes')
    })

    test('take the file names of the notes when two pages share a title', () => {
        const titles = uniqueTitles([
            {
                key: '1.md',
                title: 'The garden letter',
                fallback: 'Letter 1',
                typeWord: 'Newsletter'
            },
            {
                key: '2.md',
                title: 'The garden letter',
                fallback: 'Letter 2',
                typeWord: 'Newsletter'
            },
            { key: '3.md', title: 'Compost', fallback: 'Compost basics', typeWord: 'Newsletter' }
        ])
        expect(titles.get('1.md')).toEqual({
            title: 'Letter 1',
            full: 'Letter 1 · Newsletter · Sébastien’s Notes'
        })
        expect(titles.get('2.md')?.title).toBe('Letter 2')
        expect(titles.get('3.md')?.title).toBe('Compost')
    })

    test('take the file name when a generated page has the title', () => {
        const titles = uniqueTitles(
            [{ key: 'Movies.md', title: 'Movies', fallback: 'Movies list' }],
            new Set(['Movies · Sébastien’s Notes'])
        )
        expect(titles.get('Movies.md')?.title).toBe('Movies list')
    })

    test('stop the build when two pages still share a title', () => {
        expect(() =>
            uniqueTitles([
                { key: 'A/Mint.md', title: 'Mint', fallback: 'Mint' },
                { key: 'B/Mint.md', title: 'Mint', fallback: 'Mint' }
            ])
        ).toThrow('two pages share the title "Mint · Sébastien’s Notes"')
    })
})
