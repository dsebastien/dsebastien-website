import { describe, expect, test } from 'bun:test'
import { languageOf } from './language.ts'
import { markdownProcessor } from './markup.ts'

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
        ).toBe('<input name="q" disabled type="checkbox">')
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
