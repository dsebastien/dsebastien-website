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

function list(
    sources: RecentSource[],
    key: string,
    options: { importRun?: string; labels?: ReadonlyMap<string, string> } = {}
) {
    const found = recentListsOf(sources, { importRun: IMPORT, ...options }).find(
        (item) => item.key === key
    )
    if (found === undefined) throw new Error(`no list ${key}`)
    return found
}

function shown(
    sources: RecentSource[],
    key: string,
    options: { importRun?: string } = {}
): string[] {
    return list(sources, key, options).pages.flatMap((page) =>
        page.notes.map((note) => `${note.title} ${note.date?.shown ?? ''}`)
    )
}

describe('the notes most recently added (PUB-70, R62)', () => {
    test('take the date of their first publication, newest first', () => {
        const sources = [
            source('Alder', { firstPublished: '2031-05-03T10:00:00Z' }),
            source('Birch', { firstPublished: '2031-06-01T08:00:00Z' }),
            // A note of the import keeps its created date.
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

    test('a note of the import with no valid created date has no date', () => {
        const [row] =
            list([source('Alder', { created: '2031-02-30' })], 'added').pages[0]?.notes ?? []
        expect(row?.title).toBe('Alder')
        expect(row?.date).toBeUndefined()
    })

    test('the import is the run that the content store names, not the earliest published note', () => {
        // The notes of the import were unpublished: no published note is of the import.
        const sources = [
            source('Alder', { firstPublished: '2031-06-01T00:00:00Z', created: '2020-01-01' })
        ]
        expect(shown(sources, 'added', { importRun: '2031-05-01T00:00:00Z' })).toEqual([
            'Alder 2031-06-01'
        ])
    })

    test('a property date is ordered by its time as the vault writes it, as the page shows it', () => {
        const sources = [
            source('Alder', { created: '2024-03-03T01:00+02:00' }),
            source('Birch', { created: '2024-03-02T23:30:00Z' }),
            source('Cedar', { created: '2024-03-02T23:00 (approx)' }),
            source('Dogwood', { created: '2024-03-02T10:00' })
        ]
        expect(shown(sources, 'added')).toEqual([
            'Alder 2024-03-03',
            'Birch 2024-03-02',
            'Cedar 2024-03-02',
            'Dogwood 2024-03-02'
        ])
    })

    test('a created date after the import is never newer than the import: the note has no date', () => {
        const sources = [
            source('Typo', { created: '2041-01-01' }),
            source('Later', { firstPublished: '2031-06-01T00:00:00Z' })
        ]
        expect(shown(sources, 'added')).toEqual(['Later 2031-06-01', 'Typo '])
    })

    test('a note of the import with no valid created date goes to the end, with no date', () => {
        const sources = [source('Undated'), source('Dated', { created: '2024-01-01' })]
        expect(shown(sources, 'added')).toEqual(['Dated 2024-01-01', 'Undated '])
    })

    test('the notes with no date are in the order of their titles, a typo date among them', () => {
        const sources = [
            source('Cedar'),
            source('alder', { created: '2041-01-01' }),
            source('Birch', { created: 'soon' }),
            source('Dated', { created: '2024-01-01' })
        ]
        expect(shown(sources, 'added')).toEqual(['Dated 2024-01-01', 'alder ', 'Birch ', 'Cedar '])
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
            // Published after the import, then changed.
            source('Cedar', {
                firstPublished: '2031-05-20T00:00:00Z',
                lastPublished: '2031-05-25T00:00:00Z',
                updated: '2020-01-01'
            })
        ]
        expect(shown(sources, 'updated')).toEqual([
            'Alder 2031-06-02',
            'Cedar 2031-05-25',
            'Birch 2026-10-12'
        ])
    })

    test('leave out a note that never changed after its first publication, but for the import', () => {
        const sources = [
            source('Alder', {
                firstPublished: '2031-05-20T00:00:00Z',
                lastPublished: '2031-05-20T00:00:00Z'
            }),
            source('Birch', { updated: '2026-10-12' })
        ]
        expect(shown(sources, 'updated')).toEqual(['Birch 2026-10-12'])
        expect(list(sources, 'updated').total).toBe(1)
        // No filter page for a type with no note in the list.
        const movies = [
            source(
                'Alien',
                { firstPublished: '2031-05-20T00:00:00Z', lastPublished: '2031-05-20T00:00:00Z' },
                MOVIE
            ),
            ...sources
        ]
        expect(list(movies, 'updated').filters.map((filter) => filter.label)).toEqual([
            'All',
            'Permanent notes'
        ])
        expect(
            recentListsOf(movies, { importRun: IMPORT }).some(
                (item) => item.key === 'updated/movies'
            )
        ).toBe(false)
    })

    test('a note of the import with no valid updated date takes its created date, or no date', () => {
        const sources = [
            source('Alder', { created: '2024-03-02T10:00' }),
            source('Birch', { updated: '2041-01-01', created: '2025-01-01' }),
            source('Cedar', { updated: 'later' }),
            source('Dogwood', { updated: '2024-05-01' })
        ]
        expect(shown(sources, 'updated')).toEqual([
            'Birch 2025-01-01',
            'Dogwood 2024-05-01',
            'Alder 2024-03-02',
            'Cedar '
        ])
    })

    test('an updated date on the day after the import stays: the import ran in UTC', () => {
        const run = {
            firstPublished: '2031-04-30T23:45:00Z',
            lastPublished: '2031-04-30T23:45:00Z'
        }
        const sources = [
            source('Alder', { ...run, updated: '2031-05-01T00:10' }),
            source('Birch', { ...run, updated: '2031-05-01T00:30' })
        ]
        expect(shown(sources, 'updated', { importRun: run.firstPublished })).toEqual([
            'Birch 2031-05-01',
            'Alder 2031-05-01'
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
        expect(added.total).toBe(1005)
        expect(added.pages[0]?.notes[0]?.title).toBe('Note 1004')
        expect(added.pages.at(-1)?.notes.at(-1)?.title).toBe('Note 0005')
        expect(added.pages.map((page) => page.notes.length)).toEqual(Array<number>(10).fill(100))
        expect(added.pages.map((page) => page.indexed)).toEqual([
            true,
            ...Array<boolean>(9).fill(false)
        ])
        expect(added.pages[1]?.path).toBe('/-/recent/added/page/2')
        // Note 101 is number 101 of its ordered list, not 1.
        expect(added.pages.map((page) => page.start)).toEqual(
            Array.from({ length: 10 }, (_item, index) => index * 100 + 1)
        )
        expect(added.label).toBe('Recently added notes')
    })

    test('drop the notes with no date first at the cut of 1,000', () => {
        const undated = Array.from({ length: 3 }, (_item, index) =>
            source(`Undated ${String(index)}`)
        )
        const added = list([...undated, ...many], 'added')
        expect([added.count, added.total]).toEqual([1000, 1008])
        const titles = added.pages.flatMap((page) => page.notes.map((note) => note.title))
        expect(titles.some((title) => title.startsWith('Undated'))).toBe(false)
        expect(titles.at(-1)).toBe('Note 0005')
        const all = list([...undated, ...many.slice(0, 10)], 'added')
        expect(all.pages[0]?.notes.slice(-3).map((note) => [note.title, note.date])).toEqual([
            ['Undated 0', undefined],
            ['Undated 1', undefined],
            ['Undated 2', undefined]
        ])
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
        expect(movies.pages[0]?.description).toBe(
            'Movies of Sébastien’s Notes most recently added, newest first.'
        )
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

    test('holds the 100 newest notes of the type, and says how many the type has', () => {
        const movies = Array.from({ length: 120 }, (_item, index) =>
            source(
                `Movie ${String(index).padStart(3, '0')}`,
                {
                    created: `2024-01-01T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`
                },
                MOVIE
            )
        )
        const filter = list(movies, 'added/movies')
        expect([filter.count, filter.total]).toEqual([100, 120])
        const titles = filter.pages[0]?.notes.map((note) => note.title)
        expect([titles?.[0], titles?.at(-1)]).toEqual(['Movie 119', 'Movie 020'])
        expect(filter.pages[0]?.description).toBe(
            'Movies of Sébastien’s Notes most recently added: the 100 newest of 120.'
        )
    })

    test('names a type with the label of its hub', () => {
        const sources = [
            source('Alien', {}, MOVIE),
            source('Brave', {}, { ...MOVIE, many: 'Films' })
        ]
        const labels = new Map([['movies', 'Movies']])
        expect(list(sources, 'added/movies', { labels }).label).toBe('Recently added: Movies')
        expect(list(sources, 'added', { labels }).filters.map((filter) => filter.label)).toEqual([
            'All',
            'Movies'
        ])
    })
})
