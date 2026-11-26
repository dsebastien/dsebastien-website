import { describe, expect, test } from 'bun:test'
import { tagPath } from '@dsebastien-website/resolver'
import {
    byTitle,
    childTagsOf,
    isIndexedTag,
    LIST_PAGE_SIZE,
    notesByTag,
    pagesOf,
    refuseTagsThatTakePagePaths,
    tagsOfNote
} from './lists.ts'

describe('the order of a list', () => {
    test('is by title from A to Z as a reader sorts, numbers by their value', () => {
        const titles = byTitle(
            [
                { title: 'zucchini', vaultPath: 'z.md' },
                { title: 'Écume', vaultPath: 'e.md' },
                { title: 'Apple', vaultPath: 'a.md' },
                { title: 'Week 10', vaultPath: 'w10.md' },
                { title: 'Week 9', vaultPath: 'w9.md' }
            ].reverse()
        ).map((note) => note.title)
        expect(titles).toEqual(['Apple', 'Écume', 'Week 9', 'Week 10', 'zucchini'])
    })

    test('breaks a tie by the vault path, so each build gives the same pages', () => {
        const paths = byTitle([
            { title: 'Mint', vaultPath: 'B/Mint.md' },
            { title: 'Mint', vaultPath: 'A/Mint.md' }
        ]).map((note) => note.vaultPath)
        expect(paths).toEqual(['A/Mint.md', 'B/Mint.md'])
    })

    // The order comes from the ICU data of the runtime (Intl.Collator), which
    // an upgrade of Bun can change (issue 97). This test pins it on hard
    // titles. When it fails, the runtime sorts in a new way: review the new
    // order, and if a reader still finds it right, take it as the expected
    // order here. Know that the pages of the lists can then move: a URL such
    // as /-/types/movies/page/3 can hold other notes after the next build.
    test('is pinned on hard titles: on a failure, review the new order, as pages of lists can move', () => {
        const expected = [
            '_under',
            '-5 degrees',
            '¡Hola!',
            '...Ellipsis',
            '"Quoted"',
            '(Aside)',
            '[Bracket]',
            '#hashtag',
            '+1 idea',
            '😀 Smile',
            '🚀 Launch',
            '2 tips',
            '10 tips',
            '42',
            '2001',
            '½ cup',
            'a b',
            'a-b',
            'A.B',
            'ab',
            'Æther',
            'Alpha',
            'Ångström',
            'Äpfel',
            'Apple',
            'apple',
            'Çà va',
            'emile',
            'Émile',
            'Łódź',
            'naïve',
            'Ñandú',
            'Œuvre',
            'Ørsted',
            'Resume',
            'resume',
            'résumé',
            'Strasse',
            'straße',
            'Week 1.5',
            'Week 02',
            'Week 2',
            'Week 10',
            'Ⅻ',
            'Zebra',
            'zebra',
            'άλφα',
            'Ελλάδα',
            'Ёлка',
            'Елка',
            'Москва',
            'とうきょう',
            'トウキョウ',
            '東京'
        ]
        // A fixed shuffle of the expected order, the same at each run.
        const shuffled = expected.map(
            (_title, index) => expected[(index * 7) % expected.length] ?? ''
        )
        expect(new Set(shuffled).size).toBe(expected.length)
        const titles = byTitle(shuffled.map((title) => ({ title, vaultPath: `${title}.md` }))).map(
            (note) => note.title
        )
        expect(titles).toEqual(expected)
    })
})

describe('the pages of a list', () => {
    test('hold 100 notes each', () => {
        const pages = pagesOf(Array.from({ length: 250 }, (_item, index) => index))
        expect(pages.map((page) => page.length)).toEqual([LIST_PAGE_SIZE, LIST_PAGE_SIZE, 50])
    })

    test('are one empty page for an empty list', () => {
        expect(pagesOf([])).toEqual([[]])
    })
})

describe('the tags of a note', () => {
    test('are the tags of its property and of its text, with their parent levels, by their folded forms', () => {
        const markup = `<p>See <a class="tag" href="${tagPath('Garden/Herbs')}">#Garden/Herbs</a> and <a class="tag" href="${tagPath('été')}">#été</a></p>`
        expect([...tagsOfNote(['type/media/movie', '#Topic', 'not a tag!', 42], markup)]).toEqual([
            ['type', 'type'],
            ['type/media', 'type/media'],
            ['type/media/movie', 'type/media/movie'],
            ['topic', 'Topic'],
            ['garden', 'Garden'],
            ['garden/herbs', 'Garden/Herbs'],
            ['été', 'été']
        ])
    })

    // A raw link of a note with the class of a tag is not a tag of the note
    // (issue 98): only a link that the markup writes for a tag leads to its page.
    test('are never read from a link whose address is not the page of its tag', () => {
        expect([
            ...tagsOfNote([], '<div><a class="tag" href="/-/tags/foo">#bar</a></div>')
        ]).toEqual([])
    })

    test('read a tags property of one text', () => {
        expect([...tagsOfNote('compost', '')]).toEqual([['compost', 'compost']])
    })

    test('are one tag in two Unicode forms', () => {
        const decomposed = 'Cafe\u0301/The\u0301'
        expect([...tagsOfNote([decomposed, 'café/thé'], '')]).toEqual([
            ['café', 'Café'],
            ['café/thé', 'Café/Thé']
        ])
    })
})

describe('the notes of each tag', () => {
    test('list each note under each of its tags, the tags in the order of their code points', () => {
        const byTag = notesByTag([
            {
                note: 'a',
                tags: new Map([
                    ['media', 'media'],
                    ['media/movie', 'media/movie']
                ])
            },
            { note: 'b', tags: new Map([['media', 'media']]) }
        ])
        expect([...byTag]).toEqual([
            ['media', ['a', 'b']],
            ['media/movie', ['a']]
        ])
    })

    test('give the direct child tags of a tag', () => {
        expect(
            childTagsOf('media', ['media', 'media/movie', 'media/movie/old', 'mediation'])
        ).toEqual(['media/movie'])
    })
})

describe('the indexed tag pages', () => {
    test('have 5 notes or more and are no tags of the system', () => {
        expect(isIndexedTag('garden', 5)).toBe(true)
        expect(isIndexedTag('garden', 4)).toBe(false)
        expect(isIndexedTag('type/media/movie', 4890)).toBe(false)
        expect(isIndexedTag('zone/areas', 20247)).toBe(false)
        expect(isIndexedTag('typewriter', 9)).toBe(true)
    })
})

describe('a tag that takes the path of a page', () => {
    test('stops the build', () => {
        expect(() => {
            refuseTagsThatTakePagePaths(['books', 'books/page/2'])
        }).toThrow('the tag "books/page/2" has the path of a page of the tag "books"')
        expect(() => {
            refuseTagsThatTakePagePaths(['page/3'])
        }).toThrow('has the path of a page')
    })

    test('is only a level `page` followed by a page number', () => {
        expect(() => {
            refuseTagsThatTakePagePaths(['page', 'books/page', 'books/page/two', 'books/page/0'])
        }).not.toThrow()
    })
})
