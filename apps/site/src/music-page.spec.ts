import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import {
    FIXTURE_NOTE_TYPES,
    copyFixtureVault,
    launchChrome,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'
import { brotliSize, MUSIC_BUDGET } from './budgets.ts'
import { MOBILE_RULES } from './mobile-rules.ts'
import { MUSIC_LANGUAGES } from './music/languages.ts'
import { SOUNDS_PATH } from './music/sounds.ts'

// The music notation of a note page (Story 11, REN-07, PERF-21, issue 53), on
// the built fixture site in the installed Chrome: the invented note with one
// block of each of the ten languages, and a note with no music block. Every
// request goes to the plain local server; a request to any other host is
// refused and recorded (the files are self-hosted, no CDN).
const SITE = fileURLToPath(new URL('..', import.meta.url))
const MUSIC_NOTE = '20 Library/20.03 Music/Campfire song.md'
const PLAIN_NOTE = '10 Garden/Drip irrigation.md'
const NOTES = [MUSIC_NOTE, PLAIN_NOTE]

let stores: TestStores | undefined
let outDir: string | undefined
let dist = ''
let server: Server | undefined
let browser: Browser | undefined
let exitCode = -1
/** The HTML of the page of each note, by its vault path. */
const pages = new Map<string, { path: string; html: string }>()

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const planned = await plan(device, { include: NOTES })
    await publish(device, planned.id, {
        time: '2031-04-01T08:00:00Z',
        device: 'garden-shed',
        face: 'plugin'
    })
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'music-page-spec-'))
    dist = join(outDir, 'dist')
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', dist], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    exitCode = await child.exited
    if (exitCode !== 0) return
    for (const file of await readdir(join(dist, '-', 'note'))) {
        const html = await Bun.file(join(dist, '-', 'note', file)).text()
        const note = NOTES.find((path) => html.includes(`>${titleOf(path)}<`))
        const canonical = /<link rel="canonical" href="https:\/\/[^/]+([^"]+)"/u.exec(html)?.[1]
        if (note !== undefined && canonical !== undefined)
            pages.set(note, { path: canonical, html })
    }
    server = await startServer({ dist, port: 0 })
    browser = await launchChrome()
}, 300_000)

afterAll(async () => {
    await browser?.close()
    await server?.stop()
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

function titleOf(note: string): string {
    return note.split('/').at(-1)?.replace(/\.md$/u, '') ?? note
}

function pageOf(note: string): { path: string; html: string } {
    const page = pages.get(note)
    if (page === undefined) throw new Error(`no page for ${note}`)
    return page
}

/** What a page asked for while a test ran. */
interface Traffic {
    /** The paths of the files of the site, in the order of the requests. */
    files: string[]
    /** Every request to another host, refused. */
    refused: string[]
    /** What the Content Security Policy blocked. */
    violations: string[]
    /** The errors of the scripts of the page. */
    errors: string[]
    /** The errors that the console of the page shows. */
    consoleErrors: string[]
}

/** A browser context whose requests go to the local server only. */
async function contextOf(
    traffic: Traffic,
    options: { mobile?: number; block?: RegExp } = {}
): Promise<BrowserContext> {
    if (browser === undefined || server === undefined) throw new Error('no browser')
    const origin = server.url
    const context = await browser.newContext(
        options.mobile === undefined
            ? { viewport: { width: 1280, height: 800 } }
            : {
                  viewport: { width: options.mobile, height: 740 },
                  isMobile: true,
                  hasTouch: true
              }
    )
    await context.exposeFunction('__blocked', (violation: string) => {
        traffic.violations.push(violation)
    })
    await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
            const report = (window as unknown as { __blocked: (text: string) => void }).__blocked
            report(`${event.effectiveDirective} ${event.blockedURI}`)
        })
    })
    await context.route('**/*', async (route) => {
        const url = route.request().url()
        if (!url.startsWith(`${origin}/`)) {
            traffic.refused.push(url)
            await route.abort()
            return
        }
        const path = new URL(url).pathname
        traffic.files.push(path)
        if (options.block?.test(path) === true) {
            await route.abort()
            return
        }
        await route.continue()
    })
    return context
}

function noTraffic(): Traffic {
    return { files: [], refused: [], violations: [], errors: [], consoleErrors: [] }
}

/** Opens the page of a note and waits until its music blocks are drawn or failed. */
async function open(context: BrowserContext, note: string, traffic: Traffic): Promise<Page> {
    const page = await context.newPage()
    page.on('pageerror', (error) => traffic.errors.push(error.message))
    page.on('console', (message) => {
        if (message.type() === 'error') traffic.consoleErrors.push(message.text())
    })
    await page.goto(`${server?.url ?? ''}${pageOf(note).path}`, { waitUntil: 'load' })
    return page
}

/**
 * Scrolls through the page, as a reader does, until every music block is
 * drawn or failed: a block draws when it comes near the screen.
 */
async function waitForBlocks(page: Page): Promise<void> {
    const done = (): Promise<boolean> =>
        page.evaluate(() =>
            [...document.querySelectorAll('pre > code[class*="language-"]')].every((code) => {
                const state = (code.parentElement as HTMLElement).dataset['mpRendered']
                return state === 'done' || state === 'error'
            })
        )
    for (let step = 0; step < 300 && !(await done()); step += 1) {
        await page.evaluate(() => {
            window.scrollBy({ top: window.innerHeight / 2, behavior: 'instant' })
        })
        await page.waitForTimeout(100)
    }
    expect(await done()).toBe(true)
}

/** The size with Brotli of the files of the site that some paths name. */
async function brotliOf(paths: readonly string[]): Promise<number> {
    let total = 0
    for (const path of new Set(paths)) {
        total += brotliSize(await Bun.file(join(dist, ...path.split('/'))).bytes())
    }
    return total
}

/** The files of a page load that only music asks for: what a page without music never loads. */
function musicFiles(traffic: Traffic, plain: Traffic): string[] {
    const ofPlain = new Set(plain.files)
    return [...new Set(traffic.files)].filter(
        (path) => path.startsWith('/_astro/') && !ofPlain.has(path)
    )
}

describe('the music notation of a note page', () => {
    test('the site builds', () => {
        expect(exitCode).toBe(0)
        expect(pages.size).toBe(NOTES.length)
    })

    test('a page with no music block names no music code', () => {
        const { html } = pageOf(PLAIN_NOTE)
        expect(html).not.toMatch(/music|Music\.astro/u)
        expect(pageOf(MUSIC_NOTE).html).toMatch(/Music\.astro_astro_type_script[^"]*\.js/u)
    })

    test('a page with no music block loads no music code', async () => {
        const plain = noTraffic()
        const music = noTraffic()
        const plainContext = await contextOf(plain)
        await (await open(plainContext, PLAIN_NOTE, plain)).waitForLoadState('networkidle')
        const musicContext = await contextOf(music)
        await waitForBlocks(await open(musicContext, MUSIC_NOTE, music))
        await Promise.all([plainContext.close(), musicContext.close()])
        // The files that only the music page loads are none of the files of the plain page.
        expect(musicFiles(music, plain).length).toBeGreaterThan(0)
        expect(plain.files.filter((path) => /music|alphaTab|tabs|diagrams/iu.test(path))).toEqual(
            []
        )
        expect(plain.refused).toEqual([])
    }, 60_000)

    test('a block draws when it comes near the screen', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic)
        const page = await open(context, MUSIC_NOTE, traffic)
        await page.waitForLoadState('networkidle')
        // The first block is on the screen; the tabs, at the end of the note, are far below.
        const states = await page.evaluate(() =>
            [...document.querySelectorAll('pre > code[class*="language-"]')].map(
                (code) => (code.parentElement as HTMLElement).dataset['mpRendered'] ?? 'waiting'
            )
        )
        const tabFiles = traffic.files.filter((path) => /\/tabs\.|Bravura/u.test(path))
        await waitForBlocks(page)
        await context.close()
        expect(states[0]).toBe('done')
        expect(states.at(-1)).toBe('waiting')
        expect(tabFiles).toEqual([])
        expect(traffic.files.some((path) => /\/tabs\./u.test(path))).toBe(true)
    }, 60_000)

    test('each of the ten languages renders, from the files of the site only', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic)
        const page = await open(context, MUSIC_NOTE, traffic)
        await waitForBlocks(page)
        const blocks = await page.evaluate(() =>
            [...document.querySelectorAll('pre > code[class*="language-"]')].map((code) => {
                const pre = code.parentElement as HTMLElement
                const drawing = pre.nextElementSibling
                return {
                    language: code.className.replace(/.*language-(\w+).*/u, '$1'),
                    state: pre.dataset['mpRendered'],
                    sourceShown: getComputedStyle(pre).display !== 'none',
                    drawn:
                        drawing !== null &&
                        drawing.getBoundingClientRect().height > 40 &&
                        drawing.querySelector('svg, canvas') !== null,
                    // Tabs and scores draw on a canvas: alphaTab's SVG needs inline styles.
                    canvas: drawing?.querySelector('canvas') !== null
                }
            })
        )
        await context.close()
        expect(blocks.map((block) => block.language).sort()).toEqual([...MUSIC_LANGUAGES].sort())
        for (const block of blocks) {
            expect(block).toMatchObject({ state: 'done', sourceShown: false, drawn: true })
        }
        expect(blocks.filter((block) => block.canvas).map((block) => block.language)).toEqual([
            'tab',
            'score'
        ])
        expect(traffic.refused).toEqual([])
        expect(traffic.errors).toEqual([])
        // alphaTab skips its shared `<style>` element, and the policy allows the
        // one of its music font by its hash: no violation, no console error.
        expect(traffic.violations).toEqual([])
        expect(traffic.consoleErrors).toEqual([])
        // No sound before the first Play (PERF-21).
        expect(traffic.files.filter((path) => /\.sf[23]$|worker|index\.json/u.test(path))).toEqual(
            []
        )
    }, 60_000)

    test('the music of the page passes its budget', async () => {
        const plain = noTraffic()
        const diagrams = noTraffic()
        const both = noTraffic()
        const plainContext = await contextOf(plain)
        await (await open(plainContext, PLAIN_NOTE, plain)).waitForLoadState('networkidle')
        // The same page without its tab part: what a page with diagrams only loads.
        const diagramsContext = await contextOf(diagrams, { block: /\/tabs\.[^/]*\.js$/u })
        const withoutTabs = await open(diagramsContext, MUSIC_NOTE, diagrams)
        await waitForBlocks(withoutTabs)
        await withoutTabs.waitForLoadState('networkidle')
        const bothContext = await contextOf(both)
        await waitForBlocks(await open(bothContext, MUSIC_NOTE, both))
        await Promise.all([plainContext.close(), diagramsContext.close(), bothContext.close()])
        const diagramFiles = musicFiles(diagrams, plain).filter(
            (path) => !/\/tabs\.[^/]*\.js$/u.test(path)
        )
        const tabFiles = musicFiles(both, plain).filter((path) => !diagramFiles.includes(path))
        const fonts = tabFiles.filter((path) => path.endsWith('.woff2'))
        const diagramBytes = await brotliOf(diagramFiles)
        const tabBytes = await brotliOf(tabFiles.filter((path) => !fonts.includes(path)))
        let fontBytes = 0
        for (const font of fonts) fontBytes += Bun.file(join(dist, font)).size
        console.error(
            `music: diagrams ${String(diagramBytes)} B (${diagramFiles.join(', ')}), ` +
                `tabs ${String(tabBytes)} B, music font ${String(fontBytes)} B`
        )
        expect(diagramBytes).toBeLessThanOrEqual(MUSIC_BUDGET.diagramsBrotli)
        expect(tabBytes).toBeLessThanOrEqual(MUSIC_BUDGET.tabsBrotli)
        expect(fonts).toHaveLength(1)
        expect(fontBytes).toBeLessThanOrEqual(MUSIC_BUDGET.musicFontBytes)
    }, 90_000)

    test('a diagram and a tab play, with the instrument files of the site', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic)
        await context.addInitScript(() => {
            const loaded: string[] = []
            ;(window as unknown as { __worklets: string[] }).__worklets = loaded
            // The method of `Worklet`, which holds it, called with its worklet below.
            const descriptor = Object.getOwnPropertyDescriptor(Worklet.prototype, 'addModule')
            const add = descriptor?.value as AudioWorklet['addModule']
            AudioWorklet.prototype.addModule = async function (url, options) {
                await add.call(this, url, options)
                loaded.push(String(url))
            }
        })
        const page = await open(context, MUSIC_NOTE, traffic)
        await waitForBlocks(page)
        // The first Play of the chord diagram reads the instruments that it plays.
        await page.locator('.mn-block-chord .mn-play button').first().click()
        await page.waitForFunction(
            (folder) =>
                performance
                    .getEntriesByType('resource')
                    .some((entry) => entry.name.includes(folder) && entry.name.endsWith('.sf3')),
            SOUNDS_PATH,
            { timeout: 20_000 }
        )
        // The first Play of the tab starts the synthesizer of alphaTab in its worker, and
        // the sound goes out through its audio worklet, a file of the site: off the main thread.
        await page.locator('.mn-tab-holder .mn-play button').first().click()
        await page.waitForFunction(
            () =>
                performance
                    .getEntriesByType('resource')
                    .some((entry) => entry.name.includes('alphaTab.worker')),
            undefined,
            { timeout: 20_000 }
        )
        // A worklet is no resource of the timeline: the page records what it loads.
        await page.waitForFunction(
            () => (window as unknown as { __worklets: string[] }).__worklets.length > 0,
            undefined,
            { timeout: 20_000 }
        )
        const worklets = await page.evaluate(
            () => (window as unknown as { __worklets: string[] }).__worklets
        )
        await page.waitForTimeout(2_000)
        await context.close()
        expect(traffic.files).toContain(`${SOUNDS_PATH}/index.json`)
        // One worklet for each player: the diagrams' and the tab's.
        expect(worklets.length).toBeGreaterThan(0)
        for (const url of worklets) expect(url).toMatch(/^\/_astro\/alphaTab\.worklet[^/]*\.js$/u)
        expect(traffic.refused).toEqual([])
        expect(traffic.errors).toEqual([])
        expect(traffic.violations).toEqual([])
        expect(traffic.consoleErrors).toEqual([])
    }, 90_000)

    test('the bars have the style of the site, and the music follows the mode', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic)
        const page = await open(context, MUSIC_NOTE, traffic)
        await waitForBlocks(page)
        const look = await page.evaluate(() => {
            const bar = document.querySelector('.mn-block-chord .mn-play') as HTMLElement
            const button = bar.querySelector('button') as HTMLElement
            const radius = getComputedStyle(document.documentElement).getPropertyValue(
                '--theme-radius-pill'
            )
            const line = document.querySelector('.mn-block pre.mn-pre')
            return {
                barFont: getComputedStyle(bar).fontFamily,
                buttonRadius: getComputedStyle(button).borderTopLeftRadius,
                buttonHeight: button.getBoundingClientRect().height,
                radius: Number.parseFloat(radius) * 16,
                // A line of a chart is not a block of code of the note: no border.
                lineBorder: line === null ? 'none' : getComputedStyle(line).borderTopStyle
            }
        })
        expect(look.barFont).toContain('Noto Sans')
        expect(look.buttonRadius).toBe(`${String(look.radius)}px`)
        expect(look.buttonHeight).toBeGreaterThan(0)
        expect(look.lineBorder).toBe('none')
        /** The mean brightness of the opaque pixels of the tab: its ink. */
        const ink = (): Promise<number> =>
            page.evaluate(() => {
                let sum = 0
                let count = 0
                for (const canvas of document.querySelectorAll('.mn-tab-holder canvas')) {
                    const context = (canvas as HTMLCanvasElement).getContext('2d')
                    if (context === null) continue
                    const { width, height } = canvas as HTMLCanvasElement
                    const { data } = context.getImageData(0, 0, width, height)
                    for (let at = 0; at < data.length; at += 4) {
                        if ((data[at + 3] ?? 0) < 250) continue
                        sum += ((data[at] ?? 0) + (data[at + 1] ?? 0) + (data[at + 2] ?? 0)) / 3
                        count += 1
                    }
                }
                return count === 0 ? -1 : sum / count
            })
        const mode = (): Promise<string | undefined> =>
            page.evaluate(() => document.documentElement.dataset['theme'])
        const before = await ink()
        const first = await mode()
        await page.locator('[data-mode-switch]').first().click()
        await page.waitForFunction(
            (was) => document.documentElement.dataset['theme'] !== was,
            first
        )
        await page.waitForTimeout(1_000)
        const after = await ink()
        await context.close()
        expect(before).toBeGreaterThan(-1)
        // Dark ink on a light page, light ink on a dark page: every text of the drawing too.
        if (first === 'light') {
            expect(before).toBeLessThan(80)
            expect(after).toBeGreaterThan(170)
        } else {
            expect(before).toBeGreaterThan(170)
            expect(after).toBeLessThan(80)
        }
        expect(traffic.errors).toEqual([])
        expect(traffic.consoleErrors).toEqual([])
    }, 90_000)

    for (const width of [320, 390]) {
        test(`the music page keeps the mobile rules at ${String(width)} px`, async () => {
            const traffic = noTraffic()
            const context = await contextOf(traffic, { mobile: width })
            const page = await open(context, MUSIC_NOTE, traffic)
            await waitForBlocks(page)
            const findings = await page.evaluate(MOBILE_RULES, width)
            await context.close()
            expect(findings).toEqual([])
        }, 60_000)
    }
})
