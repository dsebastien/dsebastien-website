import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { hasListToRefresh, hasLiveQuery, listsNotRefreshed, liveQueries } from './frozen.ts'

// The frozen lists of a note (documentation/Canonical Form.md). The Rust
// implementation reads the same cases (`cli/src/frozen.rs`).
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/frozen.json', import.meta.url))

interface Cases {
    cases: { name: string; source: string; liveQuery: boolean; listToRefresh: boolean }[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const cases = (await Bun.file(CASES).json()) as Cases

describe('the frozen lists of a note', () => {
    test.each(cases.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect({
            liveQuery: hasLiveQuery(entry.source),
            listToRefresh: hasListToRefresh(entry.source)
        }).toEqual({ liveQuery: entry.liveQuery, listToRefresh: entry.listToRefresh })
    })

    test('the shared file has cases of each kind', () => {
        expect(cases.cases.filter((entry) => entry.liveQuery).length).toBeGreaterThan(5)
        expect(cases.cases.filter((entry) => entry.listToRefresh).length).toBeGreaterThan(5)
        expect(
            cases.cases.filter((entry) => !entry.liveQuery && !entry.listToRefresh).length
        ).toBeGreaterThan(5)
    })
})

describe('the lists of a plan', () => {
    const sources = new Map([
        ['B.md', '<!-- QueryToSerialize: LIST -->\n'],
        ['A.md', '```dataview\nLIST\n```\n<!-- IQ: =1 -->1<!-- /IQ -->\n'],
        ['C.md', 'Plain\n']
    ])

    test('liveQueries names the notes with a live query, sorted by path', () => {
        expect(liveQueries(['C.md', 'B.md', 'A.md'], sources)).toEqual(['A.md'])
    })

    test('listsNotRefreshed leaves out the notes that the refresh refreshed', () => {
        expect(listsNotRefreshed(['C.md', 'B.md', 'A.md'], sources, new Set())).toEqual([
            'A.md',
            'B.md'
        ])
        expect(listsNotRefreshed(['C.md', 'B.md', 'A.md'], sources, new Set(['A.md']))).toEqual([
            'B.md'
        ])
    })

    test('a path without a source is in no list', () => {
        expect(liveQueries(['Z.md'], sources)).toEqual([])
        expect(listsNotRefreshed(['Z.md'], sources, new Set())).toEqual([])
    })
})
