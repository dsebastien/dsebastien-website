import * as alphaTab from '@coderline/alphatab'
import font from '@coderline/alphatab/font/Bravura.woff2?url'
import soundFont from '@coderline/alphatab/soundfont/sonivox.sf3?url'
import {
    createSoundfontPlayer,
    renderTab,
    type AlphaTabModule,
    type TabAssets,
    type TabResult
} from '@dsebastien/music-notation/tab'
import { sharedPlayers } from './players.ts'
import { SOUNDS_PATH } from './sounds.ts'

// The tab part of the music of a page (REN-07): the tab and score blocks,
// drawn and played by alphaTab through the pinned library, as
// `music-notation.tab.min.js` does on the current site, with every file from
// the site itself: alphaTab (a module of the build), its music font, its
// soundfont and the instrument files (no other host, no CDN). Three changes
// for the Content Security Policy of the pages (SEC-01, issue 79), which
// allows no inline style:
// - alphaTab draws on a canvas, not in SVG: its SVG holds `style`
//   attributes that the policy refuses, and without them the text and the
//   numbers of a tab lose their font and their place;
// - alphaTab adds two `<style>` elements: the shared one, which a canvas
//   does not need, it skips when the page has an element with the id
//   `alphaTabStyle` (`SHARED_STYLE_ID`); the one of the music font is
//   allowed by its hash, which the build adds to the policy (`tab-style.ts`);
// - the sound goes out through a script processor, not an audio worklet.
// The player starts at the first Play; its worker is a file of the build. It
// uses the tab entry of the library only: each entry of the package is a
// bundle of its own.

/** The id of the element that makes alphaTab skip its shared `<style>` element. */
export const SHARED_STYLE_ID = 'alphaTabStyle'

/** alphaTab, drawing on a canvas: the module that the library gets. */
export function canvasAlphaTab(module: AlphaTabModule): AlphaTabModule {
    class CanvasApi extends module.AlphaTabApi {
        constructor(element: HTMLElement, options: unknown) {
            if (typeof options === 'object' && options !== null) {
                const settings = options as {
                    core?: Record<string, unknown>
                    player?: Record<string, unknown>
                }
                settings.core = { ...settings.core, engine: 'html5' }
                // No audio worklet: the build cannot give it as a file of its own (it
                // imports the core of alphaTab), and the policy refuses it as `data:`.
                settings.player = {
                    ...settings.player,
                    outputMode: module.PlayerOutputMode.WebAudioScriptProcessor
                }
            }
            super(element, options as ConstructorParameters<typeof module.AlphaTabApi>[1])
        }
    }
    return { ...module, AlphaTabApi: CanvasApi }
}

/** The files of the site that a tab draws and plays with. */
export const TAB_ASSETS: TabAssets = {
    scriptFile: null,
    font,
    soundFont,
    instruments: SOUNDS_PATH
}

/** Makes alphaTab skip its shared `<style>` element, one time: before alphaTab starts. */
function skipSharedStyle(doc: Document): void {
    if (doc.getElementById(SHARED_STYLE_ID) !== null) return
    const marker = doc.createElement('meta')
    marker.id = SHARED_STYLE_ID
    doc.head.append(marker)
}

/**
 * The drawer of the tabs and the scores of a page: it draws one block after
 * its source, which hides once the block is drawn.
 */
export function tabDrawer(doc: Document): (code: Element) => Promise<void> {
    const module = canvasAlphaTab(alphaTab)
    skipSharedStyle(doc)
    // The diagrams of the page play through alphaTab too, as on the current site.
    sharedPlayers.soundfont ??= (fallback) =>
        createSoundfontPlayer(module, TAB_ASSETS, doc, fallback)
    sharedPlayers.sonivox ??= (fallback) =>
        createSoundfontPlayer(module, { scriptFile: null, font, soundFont }, doc, fallback)
    return async (code) => {
        const pre = code.parentElement
        if (pre === null || pre.parentElement === null) return
        const language = code.classList.contains('language-score') ? 'score' : 'tab'
        const holder = doc.createElement('div')
        holder.className = 'mn-tab-holder'
        pre.insertAdjacentElement('afterend', holder)
        const result: TabResult = renderTab(language, code.textContent, holder, {
            alphaTab: module,
            assets: TAB_ASSETS,
            language: doc.documentElement.lang
        })
        const { ok } = await result.ready
        pre.dataset['mpRendered'] = ok ? 'done' : 'error'
        if (ok && result.el.isConnected) pre.hidden = true
    }
}
