import { describe, expect, test } from 'bun:test'
import { markdownProcessor } from '../rendering/markup.ts'
import { SitePages, type SiteNote } from '../rendering/page.ts'
import { blocksSelector, MUSIC_LANGUAGES, musicOf } from './languages.ts'

// The blocks of a note as the site renders them: the Markdown processor, then
// the page step, which puts the embedded notes in the body.
const renderer = await markdownProcessor().createRenderer({ syntaxHighlight: false })

async function markupOf(markdown: string): Promise<string> {
    return (await renderer.render(markdown)).code
}

function note(vaultPath: string, markup: string, links: Record<string, string> = {}): SiteNote {
    return {
        vaultPath,
        path: `/${vaultPath.replace(/\.md$/u, '')}`,
        markup,
        links: new Map(Object.entries(links)),
        files: new Map()
    }
}

describe('musicOf', () => {
    test('a body with no music block needs no music', () => {
        expect(musicOf('<p>Beans</p><pre><code class="language-js">x</code></pre>')).toEqual({
            diagrams: false,
            tabs: false
        })
    })

    test('a diagram block needs the diagram part only', () => {
        const html =
            '<pre class="language-chord"><code class="language-chord">A x02220</code></pre>'
        expect(musicOf(html)).toEqual({ diagrams: true, tabs: false })
    })

    test('a tab or a score block needs the tab part', () => {
        expect(musicOf('<pre><code class="language-score">:4 C4</code></pre>')).toEqual({
            diagrams: false,
            tabs: true
        })
        expect(musicOf('<pre><code class="x language-tab">:8 2.5</code></pre>').tabs).toBe(true)
    })

    test('a fretboard exercise draws a tab, so it needs both parts', () => {
        const html =
            '<pre><code class="language-fretboard">scale: A minor\nexercise: up</code></pre>'
        expect(musicOf(html)).toEqual({ diagrams: true, tabs: true })
    })

    test('a language that only starts like a music language is no music', () => {
        expect(musicOf('<pre><code class="language-chordpro">x</code></pre>')).toEqual({
            diagrams: false,
            tabs: false
        })
    })

    test('the ten languages of the current site', () => {
        expect(MUSIC_LANGUAGES).toHaveLength(10)
        expect(blocksSelector(['tab'])).toBe('pre > code.language-tab')
    })

    test('a block in an embedded note counts for the page', async () => {
        const song = note('Song.md', await markupOf(['```tab', ':8 2.5', '```'].join('\n')))
        const self = note('Self.md', await markupOf('Play it: ![[Song]]'), { Song: 'Song.md' })
        const html = new SitePages([self, song]).render('Self.md')
        expect(html).toContain('note-embed')
        expect(musicOf(html)).toEqual({ diagrams: false, tabs: true })
    })

    test('a block in a callout counts', async () => {
        const html = await markupOf(
            ['> [!tip] Chord', '> ```chord', '> A x02220', '> ```'].join('\n')
        )
        expect(html).toContain('callout')
        expect(musicOf(html)).toEqual({ diagrams: true, tabs: false })
    })

    test('a block inside an outer fence is only text: no music', async () => {
        const html = await markupOf(
            ['````markdown', '```chord', 'A x02220', '```', '````'].join('\n')
        )
        expect(html).toContain('language-markdown')
        expect(musicOf(html)).toEqual({ diagrams: false, tabs: false })
    })
})
