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

    test('a mark of raw HTML with a link path that cannot be decoded has no target, and the build goes on', () => {
        expect(withLinkState('<note-link data-link="%E0">raw</note-link>', LINKS, urlOf)).toBe(
            '<span class="not-published">raw</span>'
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

// The attachments of a note (issue 35): the manifest entry says to which file
// each link leads, with its hashed URL and the size of an image.
describe('markup of a note with its attachments', () => {
    const KEY = 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'
    const FILES = new Map([
        [
            'garden-plan.png',
            {
                url: `/-/attachments/${KEY}/garden-plan.png`,
                name: 'garden-plan.png',
                width: 16,
                height: 12
            }
        ],
        ['plan.svg', { url: `/-/attachments/${KEY}/plan.svg`, name: 'plan.svg' }],
        ['pond.mp4', { url: `/-/attachments/${KEY}/pond.mp4`, name: 'pond.mp4' }],
        ['frogs.MP3', { url: `/-/attachments/${KEY}/frogs.MP3`, name: 'frogs.MP3' }],
        ['map.pdf', { url: `/-/attachments/${KEY}/map.pdf`, name: 'map.pdf' }]
    ])
    const render = (html: string): string => withLinkState(html, LINKS, urlOf, FILES)

    test('an embed of an image becomes an image with its width and its height', () => {
        expect(
            render(
                '<p><note-link data-link="garden-plan.png" data-embed="">garden-plan.png</note-link></p>'
            )
        ).toBe(
            `<p><img src="/-/attachments/${KEY}/garden-plan.png" alt="garden-plan.png" width="16" height="12" loading="lazy" decoding="async"></p>`
        )
    })

    test('an embed with a width keeps the shape of the image', () => {
        expect(render('<note-link data-link="garden-plan.png" data-embed="">300</note-link>')).toBe(
            `<img src="/-/attachments/${KEY}/garden-plan.png" alt="garden-plan.png" width="300" height="225" loading="lazy" decoding="async">`
        )
        expect(
            render('<note-link data-link="garden-plan.png" data-embed="">40x10</note-link>')
        ).toContain('width="40" height="10"')
    })

    test('an image whose size is not known has no width and no height', () => {
        expect(render('<note-link data-link="plan.svg" data-embed="">A plan</note-link>')).toBe(
            `<img src="/-/attachments/${KEY}/plan.svg" alt="A plan" loading="lazy" decoding="async">`
        )
    })

    test('the text of an image is its alternative text, without markup and with its quotes escaped', () => {
        expect(
            render(
                '<note-link data-link="garden-plan.png" data-embed="">the &quot;<em>new</em>&quot; plan</note-link>'
            )
        ).toContain('alt="the &quot;new&quot; plan"')
    })

    test('an embed of a video and of a sound gets the player of the browser', () => {
        expect(render('<note-link data-link="pond.mp4" data-embed="">pond.mp4</note-link>')).toBe(
            `<video src="/-/attachments/${KEY}/pond.mp4" controls preload="metadata"></video>`
        )
        expect(render('<note-link data-link="frogs.MP3" data-embed="">frogs.MP3</note-link>')).toBe(
            `<audio src="/-/attachments/${KEY}/frogs.MP3" controls preload="metadata"></audio>`
        )
    })

    test('an embed of another file, and a link to a file, become a link to the file', () => {
        expect(render('<note-link data-link="map.pdf" data-embed="">map.pdf</note-link>')).toBe(
            `<a href="/-/attachments/${KEY}/map.pdf">map.pdf</a>`
        )
        expect(render('<note-link data-link="garden-plan.png">the plan</note-link>')).toBe(
            `<a href="/-/attachments/${KEY}/garden-plan.png">the plan</a>`
        )
    })

    test('an embed of a file that is not an attachment is plain text in the style', () => {
        expect(
            render('<note-link data-link="shed-key.png" data-embed="">shed-key.png</note-link>')
        ).toBe('<span class="not-published">shed-key.png</span>')
    })
})
