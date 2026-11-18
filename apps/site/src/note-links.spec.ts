import { describe, expect, test } from 'bun:test'
import { withLinkState } from './note-links.ts'

// The second step of the links of a page: a mark becomes a link when its
// target is published, and plain text when it is not (business rule 5). The
// first step runs inside the build: `links-page.spec.ts` covers both.
const LINKS = new Map([
    ['Rain barrel', '10 Garden/Rain barrel.md'],
    ['Frost dates', '10 Garden/Frost dates explained.md']
])
const urlOf = (vaultPath: string): string | undefined =>
    vaultPath === '10 Garden/Rain barrel.md' ? '/10+Garden/Rain+barrel' : undefined

describe('markup of a note with the state of its links', () => {
    test('a mark whose target is published becomes a link to its canonical path', () => {
        expect(
            withLinkState(
                '<p>The <note-link data-link="Rain%20barrel">barrel</note-link>.</p>',
                LINKS,
                urlOf
            )
        ).toBe('<p>The <a href="/10+Garden/Rain+barrel">barrel</a>.</p>')
    })

    test('a mark whose target is not published becomes plain text in the style, with no address', () => {
        const html = withLinkState(
            '<note-link data-link="Frost%20dates">Frost dates</note-link>',
            LINKS,
            urlOf
        )
        expect(html).toBe('<span class="not-published">Frost dates</span>')
    })

    test('a mark whose link path has no target becomes plain text in the style', () => {
        expect(
            withLinkState('<note-link data-link="Nothing">Nothing</note-link>', LINKS, urlOf)
        ).toBe('<span class="not-published">Nothing</span>')
    })

    test('every mark of the markup gets its own state, and the other markup stays', () => {
        const html = withLinkState(
            '<p><note-link data-link="Rain%20barrel">one</note-link> <em>and</em> <note-link data-link="Nothing">two</note-link></p>\n<p><note-link data-link="Rain%20barrel">three</note-link></p>',
            LINKS,
            urlOf
        )
        expect(html).toBe(
            '<p><a href="/10+Garden/Rain+barrel">one</a> <em>and</em> <span class="not-published">two</span></p>\n<p><a href="/10+Garden/Rain+barrel">three</a></p>'
        )
    })

    test('the text of a mark can hold markup', () => {
        expect(
            withLinkState(
                '<note-link data-link="Rain%20barrel">the <em>big</em> barrel</note-link>',
                LINKS,
                urlOf
            )
        ).toBe('<a href="/10+Garden/Rain+barrel">the <em>big</em> barrel</a>')
    })
})
