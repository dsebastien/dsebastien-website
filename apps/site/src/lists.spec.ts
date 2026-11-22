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
    test('are the tags of its property and of its text, with their parent levels, in small letters', () => {
        const markup = `<p>See <a class="tag" href="${tagPath('Garden/Herbs')}">#Garden/Herbs</a> and <a class="tag" href="${tagPath('été')}">#été</a></p>`
        expect([...tagsOfNote(['type/media/movie', '#Topic', 'not a tag!', 42], markup)]).toEqual([
            'type',
            'type/media',
            'type/media/movie',
            'topic',
            'garden',
            'garden/herbs',
            'été'
        ])
    })

    test('read a tags property of one text', () => {
        expect([...tagsOfNote('compost', '')]).toEqual(['compost'])
    })
})

describe('the notes of each tag', () => {
    test('list each note under each of its tags, the tags in the order of their code points', () => {
        const byTag = notesByTag([
            { note: 'a', tags: new Set(['media', 'media/movie']) },
            { note: 'b', tags: new Set(['media']) }
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
