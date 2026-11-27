import * as alphaTab from '@coderline/alphatab'
import font from '@coderline/alphatab/font/Bravura.woff2?url'
import soundFont from '@coderline/alphatab/soundfont/sonivox.sf3?url'
import workerFile from '@coderline/alphatab/worker?worker&url'
import workletFile from '@coderline/alphatab/worklet?worker&url'
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
// The player starts at the first Play. Its worker and its audio worklet are
// files of the build, each a bundle with the core of alphaTab (`?worker&url`):
// the worklet plays the sound off the main thread, so a busy page does not
// crack it, as the script processor did (a buffer of 4096 frames that the main
// thread fills). The policy allows both as scripts of the site. Two fixes of
// the drawing: alphaTab's canvas forgets its color at each part that it draws
// (`keepCanvasColor`), and the colors of a drawing follow the mode of the
// page (`followMode`). It uses the tab entry of the library only: each entry
// of the package is a bundle of its own.

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
                settings.player = {
                    ...settings.player,
                    outputMode: module.PlayerOutputMode.WebAudioAudioWorklets
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

/**
 * Makes alphaTab start its worker and its audio worklet from the files of the
 * build: the worklet that alphaTab names itself imports the core of alphaTab
 * from a file that the build does not have.
 */
export function useBuiltFiles(module: AlphaTabModule): void {
    module.Environment.initializeMain(
        () => new Worker(workerFile, { type: 'module' }),
        (context) => context.audioWorklet.addModule(workletFile)
    )
}

/** The part of alphaTab's canvas that `keepCanvasColor` changes. */
interface CanvasState {
    _color?: { rgba: string }
    _context?: CanvasRenderingContext2D | null
}

/**
 * alphaTab's canvas starts each part that it draws on a new canvas, in black,
 * but keeps the color that it set last: a text in that color then stays black
 * (the tuning, the tempo and the names of the chords on a dark page). After
 * each start, the new canvas takes that color.
 */
export function keepCanvasColor(module: AlphaTabModule): void {
    const canvas = module.Environment.getRenderEngineFactory('html5').createCanvas()
    const prototype = Object.getPrototypeOf(canvas) as {
        beginRender: (this: CanvasState, width: number, height: number) => void
        __keepsColor?: true
    }
    if (prototype.__keepsColor === true) return
    const begin = prototype.beginRender
    prototype.beginRender = function (this: CanvasState, width, height) {
        begin.call(this, width, height)
        const color = this._color?.rgba
        if (this._context != null && color !== undefined) {
            this._context.fillStyle = color
            this._context.strokeStyle = color
        }
    }
    prototype.__keepsColor = true
}

/** A CSS color as `rgba()` numbers, read through a canvas (a theme can write `color()`). */
function rgbaOf(doc: Document, color: string, alpha: number): string | null {
    const context = doc.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    context.fillStyle = '#000'
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue, opacity] = context.getImageData(0, 0, 1, 1).data
    if (opacity === undefined) return null
    const channels = [red, green, blue].map(String).join(', ')
    return `rgba(${channels}, ${String((opacity / 255) * alpha)})`
}

/** The colors of a drawing: the text color of its block, as the library reads it. */
export function drawingColors(
    module: AlphaTabModule,
    block: Element
): Record<'main' | 'muted', InstanceType<typeof module.model.Color>> | null {
    const doc = block.ownerDocument
    const text = doc.defaultView?.getComputedStyle(block).color ?? ''
    const main = module.model.Color.fromJson(rgbaOf(doc, text, 1))
    const muted = module.model.Color.fromJson(rgbaOf(doc, text, 0.6))
    return main === null || muted === null ? null : { main, muted }
}

/**
 * Draws the tabs and the scores of a page again in the colors of its mode or
 * theme when the reader switches one: a canvas does not follow the variables
 * of the theme.
 */
export function followMode(
    module: AlphaTabModule,
    doc: Document
): (api: AlphaTabApiOf, block: Element) => void {
    const drawings: { api: AlphaTabApiOf; block: Element }[] = []
    new MutationObserver(() => {
        for (const { api, block } of drawings) {
            const colors = drawingColors(module, block)
            if (colors === null || !block.isConnected) continue
            const resources = api.settings.display.resources
            resources.mainGlyphColor = colors.main
            resources.scoreInfoColor = colors.main
            resources.barSeparatorColor = colors.main
            resources.secondaryGlyphColor = colors.muted
            resources.staffLineColor = colors.muted
            resources.barNumberColor = colors.muted
            api.updateSettings()
            api.render()
        }
    }).observe(doc.documentElement, { attributeFilter: ['data-theme', 'data-design'] })
    return (api, block) => {
        drawings.push({ api, block })
    }
}

/** The API of alphaTab. */
type AlphaTabApiOf = InstanceType<AlphaTabModule['AlphaTabApi']>

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
    useBuiltFiles(alphaTab)
    keepCanvasColor(alphaTab)
    const follow = followMode(alphaTab, doc)
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
            language: doc.documentElement.lang,
            onApi: (api) => {
                follow(api, holder.firstElementChild ?? holder)
            }
        })
        const { ok } = await result.ready
        pre.dataset['mpRendered'] = ok ? 'done' : 'error'
        if (ok && result.el.isConnected) pre.hidden = true
    }
}
