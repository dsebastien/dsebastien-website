import { describe, expect, test } from 'bun:test'
import type { TitleRow } from '../search/titles.ts'
import { randomNote } from './random.ts'

// The random note of the palette (SRCH-05, item 134, issue 122): a note of
// the title index, picked by chance, never an alias.

const PARTS: Record<string, readonly TitleRow[]> = {
    co: [
        ['Compost basics', '/10+Garden/Compost+basics', 'Permanent note'],
        ['Compost tea', '/10+Garden/Compost+basics', 'Permanent note', 'Compost basics']
    ],
    ra: [['Rain barrel', '/10+Garden/Rain+barrel', '']],
    // A split part keeps its best rows only: it is never picked.
    se: [['Seed catalogue', '/20+Library/Seed+catalogue', '']],
    al: [['Alias only', '/x', '', 'X']]
}
const KEYS = { co: true, ra: true, se: false, al: true }

function sources(
    keys: Record<string, boolean> = KEYS,
    noindex: readonly string[] = []
): {
    keys: () => Promise<Record<string, boolean>>
    part: (key: string) => Promise<readonly TitleRow[]>
    noindex: () => Promise<readonly string[]>
} {
    return {
        keys: () => Promise.resolve(keys),
        part: (key) => Promise.resolve(PARTS[key] ?? []),
        noindex: () => Promise.resolve(noindex)
    }
}

/** A chance that gives these numbers in turn. */
function chances(...values: number[]): () => number {
    let index = 0
    return () => values[index++ % values.length] ?? 0
}

describe('a random note', () => {
    test('is a title of a complete part', async () => {
        expect(await randomNote(sources(), chances(0, 0))).toBe('/10+Garden/Compost+basics')
        expect(await randomNote(sources(), chances(0.4, 0.9))).toBe('/10+Garden/Rain+barrel')
    })

    test('is never an alias: a part of aliases alone gives another try', async () => {
        expect(await randomNote(sources(), chances(0.9, 0, 0.4, 0))).toBe('/10+Garden/Rain+barrel')
    })

    test('is never a note that search engines must not index (publish_noindex)', async () => {
        const hidden = sources(KEYS, ['/10+Garden/Compost+basics'])
        expect(await randomNote(hidden, chances(0, 0, 0.4, 0))).toBe('/10+Garden/Rain+barrel')
        expect(
            await randomNote(sources({ co: true }, ['/10+Garden/Compost+basics']), chances(0))
        ).toBeUndefined()
    })

    test('is none when the index has no complete part', async () => {
        expect(await randomNote(sources({ se: false }), chances(0))).toBeUndefined()
        expect(await randomNote(sources({ al: true }), chances(0))).toBeUndefined()
    })
})
