import { describe, expect, test } from 'bun:test'
import { fromHtml } from 'hast-util-from-html'
import { linkContextsOf, type NoteLinkContext } from './backlinks.ts'

// The context of a backlink (issue 48, PAGE-03): the sentence around each
// link of a note, read from the markup that the Markdown processor made, with
// its marks.

function contexts(markup: string): NoteLinkContext[] {
    return linkContextsOf(fromHtml(markup, { fragment: true }))
}

const link = (linkPath: string, shown = linkPath): string =>
    `<note-link data-link="${encodeURIComponent(linkPath)}">${shown}</note-link>`

describe('the sentence around a link', () => {
    test('is the sentence of its paragraph that holds the link, cut around the link', () => {
        expect(
            contexts(
                `<p>Water the beds at dawn. Fill the ${link('Rain barrel', 'barrel')} in spring, when it rains! Then rest.</p>`
            )
        ).toEqual([
            {
                linkPath: 'Rain barrel',
                before: 'Fill the ',
                link: 'barrel',
                after: ' in spring, when it rains!'
            }
        ])
    })

    test('ends with the sentence when the link is its last word, and starts with the paragraph when it is the first', () => {
        expect(
            contexts(`<p>${link('Wormery')} first. Then the bins, as in ${link('Compost')}.</p>`)
        ).toEqual([
            { linkPath: 'Wormery', before: '', link: 'Wormery', after: ' first.' },
            { linkPath: 'Compost', before: 'Then the bins, as in ', link: 'Compost', after: '.' }
        ])
    })

    test('keeps a full stop inside the link text, and a closing quote after the end of the sentence', () => {
        expect(
            contexts(
                `<p>He said "read ${link('Sprout.js', 'Sprout.js v2. Notes')} now." Then left.</p>`
            )
        ).toEqual([
            {
                linkPath: 'Sprout.js',
                before: 'He said "read ',
                link: 'Sprout.js v2. Notes',
                after: ' now."'
            }
        ])
    })

    test('reads the text through the markup of the sentence, with one space for a run of white space', () => {
        expect(
            contexts(
                `<p>The <em>big</em>\n   <strong>${link('Rain barrel', 'the <em>green</em> barrel')}</strong>\n\tholds <code>200</code> liters.</p>`
            )
        ).toEqual([
            {
                linkPath: 'Rain barrel',
                before: 'The big ',
                link: 'the green barrel',
                after: ' holds 200 liters.'
            }
        ])
    })

    test('is cut to some words on each side when the sentence is very long', () => {
        const words = (count: number, word: string): string =>
            Array.from({ length: count }, () => word).join(' ')
        const [context] = contexts(
            `<p>${words(60, 'soil')} ${link('Wormery')} ${words(60, 'leaf')}.</p>`
        )

        expect(context?.before).toStartWith('… soil soil')
        expect(context?.before).toEndWith('soil ')
        expect(context?.before.length).toBeLessThanOrEqual(162)
        expect(context?.after).toStartWith(' leaf leaf')
        expect(context?.after).toEndWith('leaf …')
        expect(context?.after.length).toBeLessThanOrEqual(162)
    })
})

describe('the block of a link', () => {
    test('is its own list item, not the list items around it or inside it', () => {
        expect(
            contexts(
                `<ul><li>Dig the bed</li><li>Then see ${link('Compost')}<ul><li>A deeper line</li></ul></li></ul>`
            )
        ).toEqual([{ linkPath: 'Compost', before: 'Then see ', link: 'Compost', after: '' }])
    })

    test('is its heading, its table cell or its quote', () => {
        expect(
            contexts(
                `<h2 id="x">About ${link('Wormery')}</h2><table><tr><td>Plot 1</td><td>${link('Compost')} bin</td></tr></table><blockquote><p>Read ${link('Mint')}.</p></blockquote>`
            )
        ).toEqual([
            { linkPath: 'Wormery', before: 'About ', link: 'Wormery', after: '' },
            { linkPath: 'Compost', before: '', link: 'Compost', after: ' bin' },
            { linkPath: 'Mint', before: 'Read ', link: 'Mint', after: '.' }
        ])
    })

    test('is the card of a link card', () => {
        expect(
            contexts(
                `<link-cards><link-card>${link('Mint')}</link-card><link-card>${link('Thyme')}</link-card></link-cards>`
            )
        ).toEqual([
            { linkPath: 'Mint', before: '', link: 'Mint', after: '' },
            { linkPath: 'Thyme', before: '', link: 'Thyme', after: '' }
        ])
    })

    test('holds no text of a diagram, of a style, of a script or of a footnote mark', () => {
        expect(
            contexts(
                `<p>See<sup><a href="#fn-1" data-footnote-ref="">1</a></sup> <svg><text>Graph</text></svg><style>p{}</style>${link('Mint')} <math><semantics><mi>x</mi><annotation>x^2</annotation></semantics></math>.</p>`
            )
        ).toEqual([{ linkPath: 'Mint', before: 'See ', link: 'Mint', after: ' x.' }])
    })
})

describe('the lines of a block', () => {
    // A line break of a note is a `br` element: a list of links on lines of
    // their own, with no list marks, is one paragraph.
    test('a line of a paragraph is a block of its own', () => {
        expect(
            contexts(
                `<p>Related notes<br>\n${link('Rain barrel')}<br>\n${link('Wormery')} for the worms</p>`
            )
        ).toEqual([
            { linkPath: 'Rain barrel', before: '', link: 'Rain barrel', after: '' },
            { linkPath: 'Wormery', before: '', link: 'Wormery', after: ' for the worms' }
        ])
    })

    test('a line break inside the markup of a line cuts the line there too', () => {
        expect(
            contexts(`<p><strong>First line<br>second ${link('Mint')}</strong> end<br>last</p>`)
        ).toEqual([{ linkPath: 'Mint', before: 'second ', link: 'Mint', after: ' end' }])
    })

    test('the mark of a footnote that leads back to the text is no word of the sentence', () => {
        expect(
            contexts(
                `<li id="fn-1"><p>From ${link('Hub')} <a href="#fnref-1" data-footnote-backref="" aria-label="Back to reference 1">↩</a></p></li>`
            )
        ).toEqual([{ linkPath: 'Hub', before: 'From ', link: 'Hub', after: '' }])
    })

    test('a block with very many links gives each link its own sentence', () => {
        const many = Array.from(
            { length: 4000 },
            (_, index) => `Word ${link(`Note ${String(index)}`)}.`
        )
        const found = contexts(`<p>${many.join(' ')}</p>`)

        expect(found).toHaveLength(4000)
        expect(found[3999]).toEqual({
            linkPath: 'Note 3999',
            before: 'Word ',
            link: 'Note 3999',
            after: '.'
        })
    })
})

describe('the links that are read', () => {
    test('an embed is read as a link, with the text that it shows when it cannot show', () => {
        expect(
            contexts(
                '<p><note-link data-link="Rain%20barrel" data-fragment="Cleaning" data-embed="">Rain barrel > Cleaning</note-link></p>'
            )
        ).toEqual([
            { linkPath: 'Rain barrel', before: '', link: 'Rain barrel > Cleaning', after: '' }
        ])
    })

    test('a link into the note itself and a mark that cannot be decoded are not read', () => {
        expect(
            contexts(
                '<p><note-link data-link="" data-fragment="Cleaning">Cleaning</note-link> <note-link data-link="%E0">raw</note-link> <note-link>bare</note-link></p>'
            )
        ).toEqual([])
    })

    test('every link of the note is read, in the order of the note', () => {
        expect(
            contexts(`<p>${link('B')} and ${link('A')}.</p><p>${link('B')} again.</p>`).map(
                (context) => context.linkPath
            )
        ).toEqual(['B', 'A', 'B'])
    })
})
