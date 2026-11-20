import { describe, expect, test } from 'bun:test'
import { backlinkList, BACKLINKS_ON_PAGE } from './backlink-list.ts'
import type { Backlink } from './rendering/page.ts'

// The list of the backlinks of a note as a page shows it (issue 48, PAGE-03,
// R59): the newest update first, and a limited number on the note page.

function backlink(name: string): Backlink {
    return {
        vaultPath: `${name}.md`,
        path: `/${name}`,
        contexts: [{ before: 'See ', link: 'the note', after: '.' }]
    }
}

/** The title band of each note of a test: its title and the day of its last update. */
const NOTES: Record<string, { title: string; updated: string }> = {
    'Aster.md': { title: 'Aster', updated: '2031-03-02' },
    'Zinnia.md': { title: 'Zinnia', updated: '2031-03-09' },
    'Clover.md': { title: 'Clover', updated: '2031-03-09' },
    'Bean.md': { title: 'clover', updated: '2031-03-09' },
    'Other/Clover.md': { title: 'Clover', updated: '2031-03-09' }
}

function noteOf(vaultPath: string): { title: string; updated: string } {
    const note = NOTES[vaultPath]
    if (note === undefined) {
        throw new Error(`no such note: ${vaultPath}`)
    }
    return note
}

describe('list of the backlinks of a note', () => {
    test('shows each backlink with the title of its note, its address and its sentences', () => {
        expect(backlinkList([backlink('Aster')], noteOf)).toEqual([
            {
                title: 'Aster',
                href: '/Aster',
                contexts: [{ before: 'See ', link: 'the note', after: '.' }]
            }
        ])
    })

    test('puts the newest update first, then sorts by title with the letter case ignored, then by path', () => {
        const list = backlinkList(
            ['Aster', 'Other/Clover', 'Zinnia', 'Clover', 'Bean'].map(backlink),
            noteOf
        )

        expect(list.map((item) => item.href)).toEqual([
            // 2031-03-09: `Clover` two times (the paths decide), `clover`, then `Zinnia`.
            '/Clover',
            '/Other/Clover',
            '/Bean',
            '/Zinnia',
            // 2031-03-02
            '/Aster'
        ])
    })

    test('a note page holds the number of backlinks of its budget', () => {
        expect(BACKLINKS_ON_PAGE).toBe(50)
    })
})
