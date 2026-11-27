// The music notation blocks of a page (Story 11, REN-07, issue 53). A block is
// a fenced code block whose language is one of the ten languages of the Music
// Notation library: the markup keeps it as `<pre><code class="language-…">`
// with its source as text, the form that the library reads in the browser.
// This module knows only the languages: it imports nothing of the library, so
// the build and the loader of the page can use it at no cost.

/** The languages that the main part of the library draws: diagrams, charts and patterns. */
export const DIAGRAM_LANGUAGES = [
    'chord',
    'chords',
    'keyboard',
    'fretboard',
    'strum',
    'picking',
    'progression',
    'circle'
] as const

/** The languages that alphaTab draws: tabs and scores. */
export const TAB_LANGUAGES = ['tab', 'score'] as const

/** The ten music languages, as the current site has them. */
export const MUSIC_LANGUAGES = [...DIAGRAM_LANGUAGES, ...TAB_LANGUAGES] as const

/** What the music of a page needs: the diagram part, the tab part, or both. */
export interface MusicOfPage {
    readonly diagrams: boolean
    readonly tabs: boolean
}

const CODE = /<code\b[^>]*\bclass="([^"]*)"[^>]*>([^<]*)/giu
const EXERCISE = /^[ \t]*exercise[ \t]*:/imu

/** A code element: its classes and its text. */
export interface CodeBlock {
    readonly classes: readonly string[]
    readonly text: string
}

/**
 * The music of some code elements. A fretboard with an `exercise:` line draws
 * its tab with the tab part, so it needs both.
 */
export function musicOfBlocks(blocks: Iterable<CodeBlock>): MusicOfPage {
    let diagrams = false
    let tabs = false
    for (const { classes, text } of blocks) {
        const names = new Set(classes)
        if (DIAGRAM_LANGUAGES.some((language) => names.has(`language-${language}`))) {
            diagrams = true
            if (names.has('language-fretboard') && EXERCISE.test(text)) tabs = true
        }
        if (TAB_LANGUAGES.some((language) => names.has(`language-${language}`))) tabs = true
    }
    return { diagrams, tabs }
}

/** The music of the HTML of a note body, its embeds included. */
export function musicOf(html: string): MusicOfPage {
    return musicOfBlocks(
        [...html.matchAll(CODE)].map(([, classes = '', text = '']) => ({
            classes: classes.split(/\s+/u),
            text
        }))
    )
}

/** The selector of the blocks of some languages, as the library finds them. */
export function blocksSelector(languages: readonly string[]): string {
    return languages.map((language) => `pre > code.language-${language}`).join(', ')
}
