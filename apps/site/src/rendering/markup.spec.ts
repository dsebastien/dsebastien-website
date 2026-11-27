import { describe, expect, test } from 'bun:test'
import { languageOf } from './language.ts'
import { MARKUP_VERSION, markdownProcessor } from './markup.ts'

// The Markdown processor of the site as one unit (issue 45): the cases that
// the corpus of the forms does not hold. The corpus runs on the built site in
// `rendering.spec.ts`; the page step has its own tests in `page.spec.ts`.
const renderer = await markdownProcessor().createRenderer({ syntaxHighlight: false })

async function html(markdown: string): Promise<string> {
    return (await renderer.render(markdown)).code
}

describe('allow list of the raw HTML of a note (REN-15)', () => {
    test('drops a script, a style, a frame and an object, with their content', async () => {
        const out = await html(
            '<script>steal()</script><style>p{}</style><iframe src="https://a.example"></iframe><object data="x.swf"></object><p>kept</p>'
        )
        expect(out).toBe('<p>kept</p>')
    })

    // Issue 79: the hooks of the scripts of a page (the properties panel, the
    // mode switch, the headings, the ads) come from the site only.
    test.each([
        '<a href="https://garden.example/" data-cta-position="sidebar" data-cta-product="osk">a</a>',
        '<div data-properties data-mode-switch data-heading="x" data-note-body>a</div>',
        '<span data-newsletter data-palette data-search-link data-pagefind-body>a</span>'
    ])('drops every data attribute of raw HTML that the site does not write: %s', async (raw) => {
        expect(await html(raw)).not.toContain('data-')
    })

    test('keeps the data attributes of the marks that a note may write', async () => {
        expect(
            await html('<note-link data-link="Rain barrel.md" data-cta-slot="x">b</note-link>')
        ).toBe('<p><note-link data-link="Rain barrel.md">b</note-link></p>')
    })

    test('drops a form; a field of it stays only as a checkbox that cannot change, as on GitHub', async () => {
        expect(
            await html('<form action="https://a.example/x"><input name="q" type="text"></form>')
        ).toBe('<input name="user-content-q" disabled type="checkbox">')
    })

    test('drops every event attribute and every javascript: address, and keeps the text', async () => {
        const out = await html(
            '<a href="javascript:alert(1)">a</a> <img src="x.png" onerror="alert(1)"> <span onclick="alert(1)" onmouseover="x()">b</span>'
        )
        expect(out).not.toMatch(/javascript:|onerror|onclick|onmouseover|alert/u)
        expect(out).toContain('<a>a</a>')
        expect(out).toContain('<span>b</span>')
    })

    test('keeps the elements that Obsidian allows: details, a table, a highlight, a keyboard key', async () => {
        expect(await html('<details><summary>More</summary>Text</details>')).toBe(
            '<details><summary>More</summary>Text</details>'
        )
        expect(await html('Press <kbd>g</kbd> and <mark>look</mark>.')).toBe(
            '<p>Press <kbd>g</kbd> and <mark>look</mark>.</p>'
        )
    })

    test('an unknown element of a note goes, its text stays', async () => {
        expect(await html('<groupId>org.example</groupId>')).toContain('org.example')
        expect(await html('<groupId>org.example</groupId>')).not.toContain('<groupid')
    })
})

describe('links that the tool does not read', () => {
    test('a reference link or image to a file of the vault is a mark with no target, never a link to the file', async () => {
        const out = await html(
            '[the barrel][b] and ![a plan][p] and [a site][s].\n\n[b]: Rain%20barrel.md\n[p]: plan.png\n[s]: https://garden.example/\n'
        )
        expect(out).toBe(
            '<p><note-link data-link="Rain%20barrel.md">the barrel</note-link> and <note-link data-link="plan.png" data-embed="">a plan</note-link> and <a href="https://garden.example/">a site</a>.</p>'
        )
    })

    test('a wikilink inside the text of a link stays as written: a link never holds a link', async () => {
        expect(await html('[**[[Rain barrel]]**](https://garden.example/)')).toBe(
            '<p><a href="https://garden.example/"><strong>[[Rain barrel]]</strong></a></p>'
        )
    })
})

describe('raw links with an address of the site (issue 98)', () => {
    test('a raw link to a root-relative address is a mark that the page step resolves', async () => {
        expect(
            await html('See <a href="/wiki/Compost#Layers" title="x">the <em>heap</em></a>.')
        ).toBe(
            '<p>See <note-link data-address="%2Fwiki%2FCompost%23Layers">the <em>heap</em></note-link>.</p>'
        )
    })

    test('a raw link with the class of a tag is no tag link: it is a mark too', async () => {
        expect(await html('<div><a class="tag" href="/-/tags/foo">#bar</a></div>')).toBe(
            '<div><note-link data-address="%2F-%2Ftags%2Ffoo">#bar</note-link></div>'
        )
    })

    test('a raw link to another site, to a place of the note or with no address stays a link', async () => {
        expect(
            await html(
                '<a href="https://garden.example/">a</a> <a href="//garden.example/">b</a> <a href="#top">c</a> <a>d</a> <a href="/\\garden.example/">e</a>'
            )
        ).toBe(
            '<p><a href="https://garden.example/">a</a> <a href="//garden.example/">b</a> <a href="#top">c</a> <a>d</a> <a href="/\\garden.example/">e</a></p>'
        )
    })

    test('a tag link of the text stays a tag link', async () => {
        expect(await html('#Topic/Water and <a href="/x">x</a>')).toBe(
            '<p><a class="tag" href="/-/tags/topic/water">#Topic/Water</a> and <note-link data-address="%2Fx">x</note-link></p>'
        )
    })
})

describe('tags of the text (NAV-04)', () => {
    test('a tag that has a tag page is a link to it', async () => {
        expect(await html('#Topic/Water x')).toBe(
            '<p><a class="tag" href="/-/tags/topic/water">#Topic/Water</a> x</p>'
        )
    })

    test('a tag that the parser reads but that has no tag page stays plain text', async () => {
        for (const tag of ['#tag/', '#a//b', '#a·b']) {
            expect(await html(`${tag} x`)).toBe(`<p>${tag} x</p>`)
        }
    })
})

describe('language of a note (REN-09)', () => {
    test('is the property language when it is a language tag, else English', () => {
        expect(languageOf({ language: 'fr' })).toBe('fr')
        expect(languageOf({ language: ' pt-BR ' })).toBe('pt-BR')
        expect(languageOf({ languages: ['fr'] })).toBe('en')
        expect(languageOf({ language: 'French!' })).toBe('en')
        expect(languageOf({ language: '"><script>' })).toBe('en')
        expect(languageOf({})).toBe('en')
    })
})

describe('cards, names and diagrams', () => {
    test('a LINK line with a Markdown link to a note is a card of that note', async () => {
        expect(await html('LINK: [the barrel](Rain%20barrel.md#Cleaning)')).toBe(
            '<link-cards><link-card data-label=""><note-link data-link="Rain%20barrel.md" data-fragment="Cleaning">the barrel</note-link></link-card></link-cards>'
        )
    })

    test('a card of a wikilink says whether the link has a label (CARD-03)', async () => {
        expect(await html('LINK: [[Rain barrel|The barrel]]')).toBe(
            '<link-cards><link-card data-label=""><note-link data-link="Rain%20barrel">The barrel</note-link></link-card></link-cards>'
        )
        expect(await html('LINK: [[Rain barrel]]')).toBe(
            '<link-cards><link-card><note-link data-link="Rain%20barrel">Rain barrel</note-link></link-card></link-cards>'
        )
    })

    test('a name of raw HTML gets a prefix: it cannot hide a property of the document', async () => {
        const out = await html('<img name="querySelectorAll" src="a.png">')
        expect(out).not.toContain('name="querySelectorAll"')
        expect(out).toContain('name="user-content-querySelectorAll"')
    })

    test('two diagrams and a heading never share an id, and each diagram names its own title', async () => {
        const diagram = '```mermaid\ngraph TD\n  accTitle: Garden\n  A --> B\n```'
        const out = await html(`# A\n\n${diagram}\n\n${diagram}\n\n## Diagram 1 title`)
        const ids = [...out.matchAll(/ id="([^"]+)"/gu)].map(([, id]) => id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(out).toContain('aria-labelledby="diagram-1-title"')
        expect(out).toContain('aria-labelledby="diagram-2-title"')
    })

    test('a heading "Content" never takes the id of the main element of the page (issue 88)', async () => {
        expect(await html('# Content')).toBe('<h1 id="content-2">Content</h1>')
        expect(await html('# Guide\n\n## Content')).toBe(
            '<h1 id="guide">Guide</h1>\n<h2 id="guide-content">Content</h2>'
        )
    })

    test('a block id never is an id of the frame of the page (it keeps its ^) (issue 124)', async () => {
        expect(await html('A block. ^content')).toBe('<p id="^content">A block.</p>')
    })

    test('a repeated block id names its first block only; the next one takes a number (issue 124)', async () => {
        expect(await html('A ^twice\n\nB ^twice')).toBe(
            '<p id="^twice">A</p>\n<p id="^twice-2">B</p>'
        )
    })

    test('raw HTML never gives an element an id of the frame of the page (issue 124)', async () => {
        expect(await html('<div id="content">x</div>')).toBe('<div id="content-2">x</div>')
    })

    test('a repeated id of raw HTML, of a block or of a heading names its first element only (issue 124)', async () => {
        expect(await html('<p id="a">1</p>\n\n<p id="a">2</p>')).toBe(
            '<p id="a">1</p>\n<p id="a-2">2</p>'
        )
        expect(await html('A ^b\n\n<p id="^b">x</p>')).toBe('<p id="^b">A</p>\n<p id="^b-2">x</p>')
        expect(await html('<p id="notes">x</p>\n\n# Notes')).toBe(
            '<p id="notes">x</p>\n<h1 id="notes-2">Notes</h1>'
        )
    })

    test('a heading takes its slug before an id of raw HTML after it (issue 124)', async () => {
        expect(await html('# Notes\n\n<p id="notes">x</p>')).toBe(
            '<h1 id="notes">Notes</h1>\n<p id="notes-2">x</p>'
        )
    })

    test('a number never takes an id that the note writes later (issue 124)', async () => {
        expect(await html('A ^x\n\nB ^x\n\nC ^x-2')).toBe(
            '<p id="^x">A</p>\n<p id="^x-3">B</p>\n<p id="^x-2">C</p>'
        )
        expect(await html('## Notes\n\n## Notes\n\n<p id="notes-2">x</p>')).toBe(
            '<h2 id="notes">Notes</h2>\n<h2 id="notes-3">Notes</h2>\n<p id="notes-2">x</p>'
        )
    })

    test('the ids of the footnotes win over an id of raw HTML before them (issue 124)', async () => {
        const out = await html(
            '<p id="user-content-fn-1">a</p>\n\n<p id="user-content-fnref-1">b</p>\n\n<p id="footnote-label">c</p>\n\nText[^1]\n\n[^1]: A note.'
        )
        expect(out).toContain('<p id="user-content-fn-1-2">a</p>')
        expect(out).toContain('<p id="user-content-fnref-1-2">b</p>')
        expect(out).toContain('<p id="footnote-label-2">c</p>')
        expect(out).toContain('<li id="user-content-fn-1">')
        expect(out).toContain('id="user-content-fnref-1" data-footnote-ref')
        expect(out).toContain('<h2 class="sr-only" id="footnote-label">')
    })

    test('raw HTML that looks like the footnotes never passes as the footnotes of the build (issue 124)', async () => {
        expect(await html('<section data-footnotes><p id="content">x</p></section>')).toBe(
            '<section data-footnotes=""><p id="content-2">x</p></section>'
        )
        const out = await html(
            '<section data-footnotes><p id="user-content-fn-1">x</p></section>\n\n<a data-footnote-ref id="user-content-fnref-1" href="#user-content-fn-1">y</a>\n\nText[^1]\n\n[^1]: A note.'
        )
        expect(out).toContain('<p id="user-content-fn-1-2">x</p>')
        expect(out).toContain('id="user-content-fnref-1-2"')
        expect(out).toContain('<li id="user-content-fn-1">')
        expect(out).toContain('id="user-content-fnref-1" data-footnote-ref')
    })

    test('the ids of a diagram win over an id of raw HTML before it (issue 124)', async () => {
        const diagram = '```mermaid\ngraph TD\n  accTitle: Garden\n  A --> B\n```'
        const out = await html(`<p id="diagram-1-title">x</p>\n\n${diagram}`)
        expect(out).toContain('<p id="diagram-1-title-2">x</p>')
        expect(out).toContain('aria-labelledby="diagram-1-title"')
        expect(out).toMatch(/<figure class="diagram">[\s\S]* id="diagram-1-title"/u)
    })
})

describe('cache of the markup (BUILD-04)', () => {
    // Astro keeps the markup of a note while the options of the steps stay the
    // same: the options name the version of the markup and of each package
    // that writes it, so an upgrade renders every note again.
    test('the options of the step hold the version of the markup and of the packages that write it', async () => {
        const site = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
            dependencies: Record<string, string>
        }
        const [, step] = markdownProcessor().options.remarkPlugins
        const options = (
            step as [unknown, { version: number; packages: Record<string, string> }]
        )[1]
        expect(options.version).toBe(MARKUP_VERSION)
        for (const name of [
            'pele',
            'rehype-sanitize',
            'temml',
            '@quartz-community/remark-obsidian'
        ]) {
            expect(options.packages[name]).toBe(site.dependencies[name])
        }
        expect(Object.values(options.packages)).not.toContain('undefined')
    })
})
