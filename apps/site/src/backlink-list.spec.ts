import { describe, expect, test } from 'bun:test'
import { backlinkList } from './backlink-list.ts'
import { noteHeader } from './note-header.ts'
import { SitePages, type Backlink } from './rendering/page.ts'

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
})

// A note whose H1 holds an embed (issue 93): its backlink entry gives the
// text that its own page gives in the title band and in `data-heading`.
describe('backlink of a note whose H1 holds an embed', () => {
    test('has the title of the page of that note', () => {
        const pages = new SitePages([
            {
                vaultPath: 'Icon.md',
                path: '/Icon',
                markup: '<h1 id="iconpng-title"><note-link data-link="icon.png" data-embed="">icon.png</note-link> Title</h1><p>See <note-link data-link="Target">Target</note-link>.</p>',
                links: new Map([['Target', 'Target.md']]),
                files: new Map([
                    ['icon.png', { url: '/-/attachments/k/icon.png', name: 'icon.png' }]
                ])
            },
            {
                vaultPath: 'Target.md',
                path: '/Target',
                markup: '<p>Text.</p>',
                links: new Map(),
                files: new Map()
            }
        ])
        const titleOf = (vaultPath: string): string => {
            const heading = pages.heading(vaultPath)
            return noteHeader({
                fileName: vaultPath.replace(/\.md$/u, ''),
                properties: {},
                ...(heading === undefined ? {} : { firstHeading: heading.text }),
                firstPublished: '2031-03-01T07:30:00Z',
                lastPublished: '2031-03-20T18:05:00Z'
            }).title
        }

        const [entry] = backlinkList(pages.backlinks('Target.md'), (vaultPath) => ({
            title: titleOf(vaultPath),
            updated: '2031-03-20'
        }))
        const page = pages.page('Icon.md')

        expect(page.heading?.text).toBe('icon.png Title')
        expect(entry?.title).toBe('icon.png Title')
        expect(titleOf('Icon.md')).toBe('icon.png Title')
    })
})
