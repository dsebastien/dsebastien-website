import { describe, expect, test } from 'bun:test'
import {
    generatedTexts,
    HOME,
    libraryOf,
    otherNotesOf,
    tagListsOf,
    typeHubsOf,
    type ListedNote
} from './generated-pages.ts'

const MOVIE = { name: 'movies', one: 'Movie', many: 'Movies', media: true }
const NOTE = {
    name: 'permanent-notes',
    one: 'Permanent note',
    many: 'Permanent notes',
    media: false
}

function note(title: string, type = MOVIE): ListedNote {
    return { vaultPath: `${title}.md`, path: `/${title}`, title, type }
}

describe('the type hubs', () => {
    test('list the notes of each type from A to Z, the hubs by their labels', () => {
        const hubs = typeHubsOf([
            note('Zorro'),
            note('Compost', NOTE),
            note('Alien'),
            { vaultPath: 'Welcome.md', path: '/Welcome', title: 'Welcome' }
        ])
        expect(hubs.map((hub) => hub.label)).toEqual(['Movies', 'Permanent notes'])
        const [movies] = hubs
        expect(movies?.count).toBe(2)
        expect(movies?.media).toBe(true)
        expect(movies?.pages).toEqual([
            {
                number: 1,
                path: '/-/types/movies',
                title: 'Movies · Sébastien’s Notes',
                description: 'Movies of Sébastien’s Notes: 2 notes from A to Z.',
                notes: [note('Alien'), note('Zorro')]
            }
        ])
    })

    test('have a page per 100 notes, with its number in its path, its title and its description', () => {
        const [hub] = typeHubsOf(
            Array.from({ length: 4890 }, (_item, index) => note(`Movie ${String(index)}`))
        )
        expect(hub?.pages).toHaveLength(49)
        const second = hub?.pages[1]
        expect(second?.path).toBe('/-/types/movies/page/2')
        expect(second?.title).toBe('Movies, page 2 · Sébastien’s Notes')
        expect(second?.description).toBe(
            'Movies of Sébastien’s Notes: 4,890 notes from A to Z, page 2 of 49.'
        )
        expect(hub?.pages.at(-1)?.notes).toHaveLength(90)
    })
})

describe('a type hub after a rename of its type', () => {
    test('takes the label that most of its notes have', () => {
        const films = { ...MOVIE, many: 'Films' }
        const [hub] = typeHubsOf([note('A'), note('B', films), note('C', films)])
        expect(hub?.label).toBe('Films')
        expect(hub?.count).toBe(3)
    })

    test('two hubs with one label stop the build, with the name of a type', () => {
        const other = { ...MOVIE, name: 'films' }
        expect(() => generatedTexts(typeHubsOf([note('A'), note('B', other)]))).toThrow(
            'two generated pages have the title "Movies · Sébastien’s Notes" (IDX-04): the type hub of the note type "films" and the type hub of the note type "movies"'
        )
    })

    test('a type whose label is the one of the library stops the build, with both pages', () => {
        const library = { ...MOVIE, name: 'shelves', many: 'Library' }
        expect(() => generatedTexts(typeHubsOf([note('A', library)]))).toThrow(
            'the library and the type hub of the note type "shelves"'
        )
    })
})

describe('the list of the notes with no type', () => {
    test('lists them from A to Z, with its pages', () => {
        const welcome = { vaultPath: 'Welcome.md', path: '/Welcome', title: 'Welcome' }
        const about = { vaultPath: 'About.md', path: '/About', title: 'About' }
        const list = otherNotesOf([note('Alien'), welcome, about])
        expect(list?.count).toBe(2)
        expect(list?.pages[0]?.notes).toEqual([about, welcome])
        expect(list?.pages[0]?.path).toBe('/-/other')
        expect(list?.pages[0]?.title).toBe('Other notes · Sébastien’s Notes')
        expect(list?.pages[0]?.description).toBe(
            'Other notes of Sébastien’s Notes: 2 notes with no note type, from A to Z.'
        )
    })

    test('does not exist when every note has a type', () => {
        expect(otherNotesOf([note('Alien')])).toBeUndefined()
    })
})

describe('the tag pages', () => {
    test('list the notes of a tag and of its nested tags, with its child tags', () => {
        const lists = tagListsOf([
            { note: note('Alien'), tags: new Set(['media', 'media/movie']) },
            { note: note('Atlas'), tags: new Set(['media']) }
        ])
        expect(lists.map((list) => [list.label, list.count, list.children])).toEqual([
            ['#media', 2, ['media/movie']],
            ['#media/movie', 1, []]
        ])
        expect(lists[0]?.pages[0]?.path).toBe('/-/tags/media')
        expect(lists[0]?.pages[0]?.title).toBe('#media · Sébastien’s Notes')
        expect(lists[0]?.pages[0]?.description).toBe(
            'Notes tagged #media on Sébastien’s Notes: 2 notes from A to Z.'
        )
    })

    test('are indexed with 5 notes or more, and never for a tag of the system', () => {
        const five = Array.from({ length: 5 }, (_item, index) => ({
            note: note(`N${String(index)}`),
            tags: new Set(['garden', 'type', 'type/note'])
        }))
        const lists = tagListsOf([...five, { note: note('Alone'), tags: new Set(['rare']) }])
        expect(Object.fromEntries(lists.map((list) => [list.key, list.indexed]))).toEqual({
            'garden': true,
            'rare': false,
            'type': false,
            'type/note': false
        })
    })
})

describe('the library and the texts of the generated pages', () => {
    test('the library holds the hubs of the media types', () => {
        const library = libraryOf(typeHubsOf([note('Alien'), note('Compost', NOTE)]))
        expect(library.path).toBe('/-/library')
        expect(library.hubs.map((hub) => hub.label)).toEqual(['Movies'])
        expect(library.description).toBe('The library of Sébastien’s Notes: Movies (1).')
    })

    test('the texts are the ones of the indexed pages only', () => {
        const lists = [
            ...typeHubsOf([note('Alien')]),
            ...tagListsOf([{ note: note('Alien'), tags: new Set(['rare']) }])
        ]
        const { titles, descriptions } = generatedTexts(lists)
        expect([...titles]).toEqual([
            HOME.title,
            'Library · Sébastien’s Notes',
            'Movies · Sébastien’s Notes'
        ])
        expect(descriptions.has(HOME.description)).toBe(true)
        expect(descriptions.size).toBe(3)
    })
})
