import { describe, expect, test } from 'bun:test'
import { rejectionOf } from '@dsebastien-website/testing'
import { createSearch, excerptParts, type FullTextEngine, type SearchSources } from './engine.ts'
import { titleIndexOf, type TitleEntry } from './titles.ts'

// The search behind its interface (SRCH-02, SRCH-04): the page asks it for
// titles and for the full text, and never sees the library or the files.

const ENTRIES: TitleEntry[] = [
    { path: '/Compost', title: 'Compost', aliases: ['Brown matter'], type: 'Concept' },
    { path: '/Compost+tea', title: 'Compost tea', aliases: [], type: '' },
    { path: '/Tomato', title: 'Tomato', aliases: [], type: 'Plant' }
]

/** Sources that answer from an index in memory and record what was loaded. */
function sources(engine: FullTextEngine = { search: () => Promise.resolve(empty) }): {
    sources: SearchSources
    loaded: string[]
} {
    const index = titleIndexOf(ENTRIES)
    const loaded: string[] = []
    return {
        loaded,
        sources: {
            keys: () => {
                loaded.push('keys')
                return Promise.resolve(index.keys)
            },
            part: (key) => {
                loaded.push(`part ${key}`)
                return Promise.resolve(index.parts.get(key) ?? [])
            },
            fullText: () => {
                loaded.push('full text')
                return Promise.resolve(engine)
            }
        }
    }
}

const empty = { total: 0, hits: () => Promise.resolve([]) }

describe('the titles of the search', () => {
    test('answer without the full text', async () => {
        const { sources: from, loaded } = sources()
        const search = createSearch(from)
        expect((await search.titles('comp')).map((match) => match.text)).toEqual([
            'Compost',
            'Compost tea'
        ])
        expect(loaded).toEqual(['keys', 'part co'])
    })

    test('load the keys and each part one time', async () => {
        const { sources: from, loaded } = sources()
        const search = createSearch(from)
        await Promise.all([search.titles('co'), search.titles('com')])
        await search.titles('compost')
        await search.titles('tomato')
        expect(loaded).toEqual(['keys', 'part co', 'part to'])
    })

    test('load no part when no title can answer', async () => {
        const { sources: from, loaded } = sources()
        const search = createSearch(from)
        expect(await search.titles('zebra')).toEqual([])
        expect(await search.titles('c')).toEqual([])
        expect(loaded).toEqual(['keys'])
    })

    test('give an alias with the title of its note', async () => {
        const search = createSearch(sources().sources)
        expect(await search.titles('brown')).toEqual([
            { text: 'Brown matter', path: '/Compost', type: 'Concept', aliasOf: 'Compost' }
        ])
    })

    test('can load again after a failed load', async () => {
        const { sources: from } = sources()
        let fail = true
        const search = createSearch({
            ...from,
            keys: () => {
                if (fail) {
                    fail = false
                    return Promise.reject(new Error('offline'))
                }
                return from.keys()
            }
        })
        expect(await rejectionOf(search.titles('comp'))).toContain('offline')
        expect(await search.titles('comp')).toHaveLength(2)
    })
})

describe('the full text of the search', () => {
    test('loads at the first full-text search, one time', async () => {
        const asked: string[] = []
        const { sources: from, loaded } = sources({
            search: (query) => {
                asked.push(query)
                return Promise.resolve({
                    total: 1,
                    hits: () =>
                        Promise.resolve([
                            { path: '/Tomato', title: 'Tomato', type: 'Plant', excerpt: [] }
                        ])
                })
            }
        })
        const search = createSearch(from)
        await search.titles('tom')
        expect(loaded).not.toContain('full text')
        const results = await search.fullText('tomato')
        expect(results.total).toBe(1)
        expect(await results.hits(0, 10)).toEqual([
            { path: '/Tomato', title: 'Tomato', type: 'Plant', excerpt: [] }
        ])
        await search.fullText('basil')
        expect(loaded.filter((item) => item === 'full text')).toHaveLength(1)
        expect(asked).toEqual(['tomato', 'basil'])
    })

    test('gives nothing for an empty query, and loads nothing for it', async () => {
        const { sources: from, loaded } = sources()
        const results = await createSearch(from).fullText('   ')
        expect(results.total).toBe(0)
        expect(await results.hits(0, 10)).toEqual([])
        expect(loaded).toEqual([])
    })
})

describe('the excerpt of a full-text result', () => {
    test('is text with the words of the query marked', () => {
        expect(excerptParts('Plant the <mark>tomato</mark> near basil.')).toEqual([
            { text: 'Plant the ', marked: false },
            { text: 'tomato', marked: true },
            { text: ' near basil.', marked: false }
        ])
    })

    test('reads the two characters that the engine escapes, and keeps any other markup as text', () => {
        // Pagefind writes `<` and `>` as entities and leaves `&` as it is.
        expect(excerptParts('A & B &amp; &lt;b&gt; <mark>&lt;i&gt;x</mark> & <b>c</b>')).toEqual([
            { text: 'A & B &amp; <b> ', marked: false },
            { text: '<i>x', marked: true },
            { text: ' & <b>c</b>', marked: false }
        ])
    })
})
