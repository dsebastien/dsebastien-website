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
            '<link-cards><link-card><note-link data-link="Rain%20barrel.md" data-fragment="Cleaning">the barrel</note-link></link-card></link-cards>'
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
