import { describe, expect, test } from 'bun:test'
import type { ListedNote } from './generated-pages.ts'
import { recentListsOf, type RecentSource } from './recent.ts'

const MOVIE = { name: 'movies', one: 'Movie', many: 'Movies', media: true }
const NOTE = {
    name: 'permanent-notes',
    one: 'Permanent note',
    many: 'Permanent notes',
    media: false
}

/** The run of the first publication of the content store: the import. */
const IMPORT = '2031-05-01T00:00:00Z'

function source(
    title: string,
    dates: Partial<Omit<RecentSource, 'note'>> = {},
    type: ListedNote['type'] = NOTE
): RecentSource {
    return {
        note: { vaultPath: `${title}.md`, path: `/${title}`, title, type },
        firstPublished: IMPORT,
        lastPublished: IMPORT,
        created: undefined,
        updated: undefined,
        ...dates
    }
}

function list(sources: RecentSource[], key: string) {
    const found = recentListsOf(sources).find((item) => item.key === key)
    if (found === undefined) throw new Error(`no list ${key}`)
    return found
}

function shown(sources: RecentSource[], key: string): string[] {
    return list(sources, key).pages.flatMap((page) =>
        page.notes.map((note) => `${note.title} ${note.date?.shown ?? ''}`)
    )
}

describe('the notes most recently added (PUB-70, R62)', () => {
    test('take the date of their first publication, newest first', () => {
        const sources = [
            source('Alder', { firstPublished: '2031-05-03T10:00:00Z' }),
            source('Birch', { firstPublished: '2031-06-01T08:00:00Z' }),
            // The import is the earliest run: this note keeps its created date.
            source('Cedar', { created: '2024-03-02' })
        ]
        expect(shown(sources, 'added')).toEqual([
            'Birch 2031-06-01',
            'Alder 2031-05-03',
            'Cedar 2024-03-02'
        ])
    })

    test('a note of the import takes its created property, a later note its publication', () => {
        const sources = [
            source('Alder', { created: '2025-01-01T09:00' }),
            source('Birch', { created: '2024-03-02' }),
            source('Cedar', { firstPublished: '2031-07-01T00:00:00Z', created: '2020-01-01' })
        ]
        expect(shown(sources, 'added')).toEqual([
            'Cedar 2031-07-01',
            'Alder 2025-01-01',
            'Birch 2024-03-02'
        ])
    })

    test('a note of the import with no valid created date keeps the date of the import', () => {
        expect(shown([source('Alder', { created: '2031-02-30' })], 'added')).toEqual([
            'Alder 2031-05-01'
        ])
    })

    test('the same date gives the order of the titles from A to Z', () => {
        const sources = [
            source('Birch', { created: '2024-03-02' }),
            source('alder', { created: '2024-03-02' })
        ]
        expect(shown(sources, 'added')).toEqual(['alder 2024-03-02', 'Birch 2024-03-02'])
    })
})

describe('the notes most recently updated (PUB-71, R62)', () => {
    test('take the date of their last publication, or their updated property when unchanged since the import', () => {
        const sources = [
            // Changed after the import.
            source('Alder', { lastPublished: '2031-06-02T00:00:00Z', updated: '2030-01-01' }),
            // Not changed since the import.
            source('Birch', { updated: '2026-10-12T14:30' }),
            // Published after the import, never changed: its own publication.
            source('Cedar', {
                firstPublished: '2031-05-20T00:00:00Z',
                lastPublished: '2031-05-20T00:00:00Z',
                updated: '2020-01-01'
            })
        ]
        expect(shown(sources, 'updated')).toEqual([
            'Alder 2031-06-02',
            'Cedar 2031-05-20',
            'Birch 2026-10-12'
        ])
    })
})

describe('the pages of a recent list (NAV-05, IDX-22, IDX-23)', () => {
    const many = Array.from({ length: 1005 }, (_item, index) =>
        source(`Note ${String(index).padStart(4, '0')}`, {
            created: `2024-01-01T${String(Math.floor(index / 60) % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`
        })
    )

    test('hold the 1,000 newest notes, 100 per page; only page 1 is indexed', () => {
        const added = list(many, 'added')
        expect(added.count).toBe(1000)
        expect(added.pages.map((page) => page.notes.length)).toEqual(Array<number>(10).fill(100))
        expect(added.pages.map((page) => page.indexed)).toEqual([
            true,
            ...Array<boolean>(9).fill(false)
        ])
        expect(added.pages[1]?.path).toBe('/-/recent/added/page/2')
        expect(added.label).toBe('Recently added notes')
    })

    test('have their titles and descriptions', () => {
        const [first, second] = list(many, 'updated').pages
        expect(first?.title).toBe('Recently updated notes · Sébastien’s Notes')
        expect(first?.description).toBe(
            'The 1,000 notes of Sébastien’s Notes most recently updated, newest first, page 1 of 10.'
        )
        expect(second?.title).toBe('Recently updated notes, page 2 · Sébastien’s Notes')
        expect(second?.description).toBe(
            'The 1,000 notes of Sébastien’s Notes most recently updated, newest first, page 2 of 10.'
        )
    })
})

describe('the filter of a recent list by note type (NAV-05, R62)', () => {
    test('is one page with the newest notes of each type, not indexed, linked from every list', () => {
        const sources = [
            source('Alien', { created: '2024-01-02' }, MOVIE),
            source('Compost', { created: '2024-01-03' }),
            source('Welcome', { created: '2024-01-04' }, undefined)
        ]
        const movies = list(sources, 'added/movies')
        expect(movies.pages).toHaveLength(1)
        expect(movies.pages[0]?.path).toBe('/-/recent/added/movies')
        expect(movies.pages[0]?.title).toBe('Recently added: Movies · Sébastien’s Notes')
        expect(movies.pages[0]?.indexed).toBe(false)
        expect(shown(sources, 'added/movies')).toEqual(['Alien 2024-01-02'])
        const filters = [
            { label: 'All', path: '/-/recent/added' },
            { label: 'Movies', path: '/-/recent/added/movies' },
            { label: 'Permanent notes', path: '/-/recent/added/permanent-notes' }
        ]
        expect(list(sources, 'added').filters).toEqual(filters)
        expect(movies.filters).toEqual(filters)
        expect(list(sources, 'updated/movies').pages[0]?.path).toBe('/-/recent/updated/movies')
    })

    test('holds the 100 newest notes of the type', () => {
        const movies = Array.from({ length: 120 }, (_item, index) =>
            source(`Movie ${String(index).padStart(3, '0')}`, {}, MOVIE)
        )
        expect(list(movies, 'added/movies').count).toBe(100)
    })
})
