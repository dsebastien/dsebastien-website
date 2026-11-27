import { describe, expect, test } from 'bun:test'
import { blocksSelector, MUSIC_LANGUAGES, musicOf } from './languages.ts'

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
})
