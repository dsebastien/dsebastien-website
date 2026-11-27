import {
    LANGUAGES,
    lightPlayer,
    renderBlock,
    sampledPlayer,
    type NotationLanguage,
    type NotePlayer,
    type PlayOptions,
    type RenderOptions
} from '@dsebastien/music-notation'
import { lookupGuitarVoicing } from '@dsebastien/music-notation/voicings'
import { sharedPlayers } from './players.ts'
import { SOUNDS_PATH } from './sounds.ts'

// The diagram part of the music of a page (REN-07): the chord, chords,
// keyboard, fretboard, strum, picking, progression and circle blocks, drawn
// by the pinned library as `music-notation.publish.min.js` draws them on the
// current site, with the same defaults: playback on, through the instrument
// files of the site (GeneralUser GS) with the sample player of the library,
// or through the soundfont players of the tab part once a page with tabs has
// it; the light synthesizer when a file cannot be read. The texts of the bars
// follow the language of the page. A block draws once its part is loaded,
// after the page shows (PERF-21). It uses the main entry of the library only
// (with the voicings): each entry of the package is a bundle of its own, so a
// second entry would load the same code twice.

/** The element of the page that holds the properties of the note, for its empty blocks. */
export const PROPERTIES_SELECTOR = 'script[type="application/json"][data-music-properties]'

/** The properties of the note of the page, from its data block; `null` without one. */
export function pageProperties(doc: Document): Record<string, unknown> | null {
    const text = doc.querySelector(PROPERTIES_SELECTOR)?.textContent
    if (text === undefined || text === '') return null
    try {
        const value: unknown = JSON.parse(text)
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null
    } catch {
        return null
    }
}

/** The players of the diagrams: the soundfont of the tab part first, when the page has it. */
function playOptions(win: Window): PlayOptions {
    const light = lightPlayer(win)
    let soundfont: NotePlayer | null | undefined
    let sonivox: NotePlayer | null | undefined
    let sampled: NotePlayer | undefined
    return {
        engines: {
            generaluser: () =>
                (soundfont ??= sharedPlayers.soundfont?.(light) ?? null) ??
                (sampled ??= sampledPlayer(win, SOUNDS_PATH, light)),
            sonivox: () => (sonivox ??= sharedPlayers.sonivox?.(light) ?? null)
        }
    }
}

/**
 * The drawer of the diagrams of a page: it draws one block after its source,
 * which hides once the block is drawn.
 */
export function diagramDrawer(doc: Document, win: Window): (code: Element) => void {
    const properties = pageProperties(doc)
    const options: RenderOptions = {
        voicings: lookupGuitarVoicing,
        language: doc.documentElement.lang,
        play: playOptions(win)
    }
    return (code) => {
        const pre = code.parentElement
        const language = LANGUAGES.find((name) => code.classList.contains(`language-${name}`))
        if (pre === null || pre.parentElement === null || language === undefined) return
        const source = code.textContent
        const holder = doc.createElement('div')
        const result = renderBlock(language satisfies NotationLanguage, source, holder, {
            ...options,
            // An empty block draws from the properties of the note; an embedded note is not
            // the note of the page, so its empty blocks draw nothing.
            properties:
                source.trim() === '' && code.closest('.note-embed') === null ? properties : null
        })
        pre.insertAdjacentElement('afterend', result.el)
        pre.dataset['mpRendered'] = result.ok ? 'done' : 'error'
        // A block with a mistake keeps its source, under the message that explains it.
        if (result.ok) pre.hidden = true
    }
}
