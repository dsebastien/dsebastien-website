import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import {
    BUDGET_SAMPLE,
    FIXTURE_NOTE_TYPES,
    FIXTURE_STORE_CATALOG,
    copyFixtureVault,
    launchChrome,
    makeContentStoreCopy,
    makeTestStores,
    writeBudgetSample,
    type TestStores
} from '@dsebastien-website/testing'
import {
    LIBRARY_PATH,
    SEARCH_PATH,
    canonicalPath,
    folderPath,
    otherNotesPath,
    recentPath,
    tagPagePath
} from '@dsebastien-website/resolver'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'
import { MOBILE_RULES, type MobileFinding } from './mobile-rules.ts'

// The mobile rules of the site (issue 91, PAGE-07, DES-11, R95): every page
// type of the built fixture site, in the installed Chrome, as a phone with a
// touch screen at 320, 390 and 768 px wide, in both modes. The rules
// themselves run in the page (`mobile-rules.ts`): no sideways scroll, every
// control 44 px at least, no action that needs a hover, the viewport, the text
// fields. The fixture vault holds the wide content (`Wide content.md`: a long
// word, a wide table, a long line of code, a wide image) and the budget sample
// (a long outline, a hub with a page of backlinks). Set MOBILE_SCREENSHOTS to
// a folder outside the clone to keep a screenshot of each page.
const SITE = fileURLToPath(new URL('..', import.meta.url))
const WIDE = '50 Field guide/Text/Wide content.md'
const PROPERTIES = '50 Field guide/Text/Properties.md'
/** A folder with no folder note: the site shows a list (URL-16). */
const LIST_FOLDER = '50 Field guide/Text'
const WIDTHS = [320, 390, 768] as const
const MODES = ['dark', 'light'] as const
/** The height of a phone screen, and of what is left of it when its keyboard is open. */
const SCREEN_HEIGHT = 740
const KEYBOARD_HEIGHT = 420
const SCREENSHOTS = process.env['MOBILE_SCREENSHOTS']
/** The path of a page that the test answers with the gone page (410). */
const GONE = '/-/gone-in-this-test'

let stores: TestStores | undefined
let outDir: string | undefined
let server: Server | undefined
let browser: Browser | undefined
let exitCode = -1
let gonePage = ''
/** The canonical path of every note page of the build. */
const notePaths: string[] = []

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    await writeBudgetSample(vault)
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const queue = await status(device)
    const planned = await plan(device, { include: queue.new })
    await publish(device, planned.id, {
        time: '2031-05-01T00:00:00Z',
        device: 'phone-shed',
        face: 'command-line'
    })
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'mobile-page-spec-'))
    const dist = join(outDir, 'dist')
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', dist], {
        cwd: SITE,
        env: {
            ...process.env,
            CONTENT_STORE: contentStore,
            STORE_CATALOG: FIXTURE_STORE_CATALOG,
            STORE_CATALOG_COPY: join(outDir, 'store-catalog.json')
        },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    exitCode = await child.exited
    if (exitCode !== 0) return
    for (const file of await readdir(join(dist, '-', 'note'))) {
        const html = await Bun.file(join(dist, '-', 'note', file)).text()
        const canonical = /<link rel="canonical" href="https:\/\/[^/]+([^"]+)"/u.exec(html)?.[1]
        if (canonical !== undefined) notePaths.push(canonical)
    }
    notePaths.sort()
    gonePage = await Bun.file(join(dist, '410.html')).text()
    server = await startServer({ dist, port: 0, attachments: stores.attachmentStorage })
    browser = await launchChrome()
}, 600_000)

afterAll(async () => {
    await browser?.close()
    await server?.stop()
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

/** A phone of this width in this mode: a touch screen, a coarse pointer, no hover. */
async function phone(width: number, mode: (typeof MODES)[number]): Promise<BrowserContext> {
    if (browser === undefined || server === undefined) {
        throw new Error('the site was not built or Chrome did not start')
    }
    const context = await browser.newContext({
        viewport: { width, height: SCREEN_HEIGHT },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        colorScheme: mode,
        baseURL: server.url
    })
    // A listener of a hover event is an action that a finger cannot start.
    await context.addInitScript(() => {
        const hover = /^(mouse(over|out|enter|leave)|pointer(over|out|enter|leave))$/u
        const record = (type: string): void => {
            const page = window as unknown as { hoverListeners?: string[] }
            page.hoverListeners = [...(page.hoverListeners ?? []), type]
        }
        Reflect.set(window, 'hoverWatch', true)
        const add = Reflect.get(EventTarget.prototype, 'addEventListener') as (
            ...args: unknown[]
        ) => unknown
        Reflect.set(
            EventTarget.prototype,
            'addEventListener',
            function (this: EventTarget, ...args: unknown[]): unknown {
                if (typeof args[0] === 'string' && hover.test(args[0])) record(args[0])
                return Reflect.apply(add, this, args)
            }
        )
    })
    await context.route(`**${GONE}`, (route) =>
        route.fulfill({ status: 410, contentType: 'text/html', body: gonePage })
    )
    return context
}

/** The pages of every page type, found from the home page and from the notes. */
async function pagesToCheck(page: Page): Promise<{ name: string; path: string }[]> {
    const hrefOf = async (path: string, selector: string): Promise<string> => {
        await page.goto(path)
        const href = await page.locator(selector).first().getAttribute('href')
        if (href === null) throw new Error(`no ${selector} on ${path}`)
        return href
    }
    return [
        { name: 'home', path: '/' },
        { name: 'note with wide content', path: canonicalPath(WIDE) },
        { name: 'note with every kind of property', path: canonicalPath(PROPERTIES) },
        { name: 'long note with its outline', path: canonicalPath(BUDGET_SAMPLE.long) },
        { name: 'media note', path: canonicalPath(BUDGET_SAMPLE.media) },
        { name: 'hub note', path: canonicalPath(BUDGET_SAMPLE.hub) },
        {
            name: 'backlinks page',
            path: await hrefOf(canonicalPath(BUDGET_SAMPLE.hub), 'a[href^="/-/backlinks/"]')
        },
        { name: 'folder list', path: folderPath(LIST_FOLDER) },
        { name: 'type hub', path: await hrefOf(canonicalPath(WIDE), '[data-type-badge]') },
        {
            name: 'tag page',
            path: await hrefOf(canonicalPath(PROPERTIES), '[data-properties] a[href^="/-/tags/"]')
        },
        {
            name: 'tag page of a long tag',
            path: await hrefOf(
                canonicalPath(WIDE),
                '[data-properties] a[href^="/-/tags/"]:has-text("Rhododendron")'
            )
        },
        { name: 'tag page with a long nested tag', path: tagPagePath('garden', 1) },
        { name: 'notes with no type', path: otherNotesPath(1) },
        { name: 'library', path: LIBRARY_PATH },
        { name: 'recent list', path: recentPath('updated', 1) },
        { name: 'search', path: `${SEARCH_PATH}?q=garden` },
        { name: 'not found (404)', path: '/no/such/page' },
        { name: 'gone (410)', path: GONE }
    ]
}

function describeFindings(findings: readonly MobileFinding[]): string[] {
    return findings.map((finding) => `${finding.rule}: ${finding.detail}`)
}

/** Opens every folding block, so that what it holds is checked too. */
async function openFolds(page: Page): Promise<void> {
    await page.evaluate(() => {
        for (const fold of document.querySelectorAll('details')) fold.open = true
    })
}

async function check(page: Page): Promise<string[]> {
    const findings = await page.evaluate(MOBILE_RULES, page.viewportSize()?.width ?? 0)
    const listeners = await page.evaluate(() =>
        Reflect.get(window, 'hoverWatch') === true
            ? ((window as unknown as { hoverListeners?: string[] }).hoverListeners ?? [])
            : ['(the watch of the hover listeners is not installed)']
    )
    return [
        ...describeFindings(findings),
        ...listeners.map((type) => `hover: a listener of ${type}`)
    ]
}

async function screenshot(page: Page, name: string, fullPage = true): Promise<void> {
    if (SCREENSHOTS === undefined || SCREENSHOTS === '') return
    await mkdir(SCREENSHOTS, { recursive: true })
    await page.screenshot({
        path: join(SCREENSHOTS, `${name.replace(/[^a-z0-9-]+/giu, '-')}.png`),
        fullPage
    })
}

describe('the mobile rules (issue 91)', () => {
    test('the site builds and Chrome starts', () => {
        expect(exitCode).toBe(0)
        expect(browser).toBeDefined()
    })

    for (const mode of MODES) {
        for (const width of WIDTHS) {
            test(`every page type passes at ${String(width)} px in the ${mode} mode`, async () => {
                const context = await phone(width, mode)
                try {
                    const page = await context.newPage()
                    const failures: string[] = []
                    for (const { name, path } of await pagesToCheck(page)) {
                        await page.goto(path)
                        expect(
                            await page.evaluate(() => document.documentElement.dataset['theme'])
                        ).toBe(mode)
                        await openFolds(page)
                        for (const finding of await check(page)) {
                            failures.push(`${name} (${path}): ${finding}`)
                        }
                        await screenshot(page, `${String(width)}-${mode}-${name}`)
                    }
                    expect(failures).toEqual([])
                } finally {
                    await context.close()
                }
            }, 300_000)
        }
    }

    // Every note page of the fixture site, at the smallest width: a form of
    // Markdown that is wider than a phone shows here.
    test('no note page scrolls sideways at 320 px', async () => {
        const context = await phone(320, 'dark')
        try {
            const page = await context.newPage()
            const wide: string[] = []
            expect(notePaths.length).toBeGreaterThan(50)
            for (const path of notePaths) {
                await page.goto(path)
                await openFolds(page)
                const findings = (await page.evaluate(MOBILE_RULES, 320)).filter(
                    (finding) => finding.rule === 'width'
                )
                wide.push(...describeFindings(findings).map((text) => `${path}: ${text}`))
            }
            expect(wide).toEqual([])
        } finally {
            await context.close()
        }
    }, 600_000)

    test('the command palette passes, also with the keyboard open', async () => {
        for (const width of WIDTHS) {
            const context = await phone(width, 'dark')
            try {
                const page = await context.newPage()
                await page.goto(canonicalPath(WIDE))
                await page.locator('[data-palette]').first().tap()
                const field = page.getByRole('combobox')
                await field.waitFor()
                await field.fill('gar')
                await page.getByRole('option').first().waitFor()
                expect(await check(page)).toEqual([])
                await screenshot(page, `${String(width)}-palette`, false)
                // The keyboard of a phone takes the bottom of the screen; with
                // `interactive-widget=resizes-content`, the page gets the rest.
                await page.setViewportSize({ width, height: KEYBOARD_HEIGHT })
                const box = await field.boundingBox()
                expect(box).not.toBeNull()
                expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
                expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(KEYBOARD_HEIGHT)
                expect(await check(page)).toEqual([])
            } finally {
                await context.close()
            }
        }
    }, 300_000)

    // Story 8 (PAGE-04): on a screen without the left rail, a bar under the
    // header names the current section; a tap on it opens the outline.
    test('a long note shows the current section in a bar under the header', async () => {
        for (const width of WIDTHS) {
            const context = await phone(width, 'dark')
            try {
                const page = await context.newPage()
                await page.goto(canonicalPath(BUDGET_SAMPLE.long))
                const bar = page.locator('[data-section-bar]')
                expect(await bar.isVisible()).toBe(false)
                // The bar comes before the parts of the note in the order of the keyboard.
                expect(
                    await page.evaluate(() => {
                        const button = document.querySelector('[data-section-bar]')
                        const layout = document.querySelector('.note-layout')
                        return (
                            button !== null &&
                            layout !== null &&
                            (button.compareDocumentPosition(layout) &
                                Node.DOCUMENT_POSITION_FOLLOWING) !==
                                0
                        )
                    })
                ).toBe(true)
                // A link of the outline leads to a heading that neither the
                // header nor the bar hides.
                const fold = page.locator('[data-outline="fold"]')
                await fold.locator('summary').tap()
                const link = fold.locator('a[href^="#"]').nth(3)
                const text = (await link.textContent())?.trim() ?? ''
                const id = decodeURIComponent((await link.getAttribute('href'))?.slice(1) ?? '')
                await link.tap()
                await page.waitForFunction(
                    (wanted) =>
                        document.querySelector('[data-section-bar]')?.textContent.includes(wanted),
                    text
                )
                expect(await bar.isVisible()).toBe(true)
                const barBox = await bar.boundingBox()
                const heading = await page.locator(`[id="${id}"]`).boundingBox()
                expect(barBox?.height ?? 0).toBeGreaterThanOrEqual(44)
                expect(heading?.y ?? 0).toBeGreaterThanOrEqual(
                    (barBox?.y ?? 0) + (barBox?.height ?? 0)
                )
                expect(await check(page)).toEqual([])
                await screenshot(page, `${String(width)}-section-bar`, false)
                // A tap on the bar opens the outline and shows it.
                await page.evaluate(() => {
                    const outline = document.querySelector('[data-outline="fold"]')
                    if (outline instanceof HTMLDetailsElement) outline.open = false
                })
                await bar.tap()
                expect(await fold.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
                    true
                )
                await page.waitForFunction(() => {
                    const outline = document.querySelector('[data-outline="fold"]')
                    const top = outline?.getBoundingClientRect().top ?? -1
                    return top >= 0 && top < innerHeight
                })
                // Back at the top of the page, the bar goes away.
                await page.evaluate(() => {
                    scrollTo({ top: 0, behavior: 'instant' })
                })
                await page.waitForFunction(
                    () => document.querySelector<HTMLElement>('[data-section-bar]')?.hidden === true
                )
            } finally {
                await context.close()
            }
        }
    }, 300_000)

    // The newsletter bar (NEWS-01) is hidden when the page loads: the rules
    // run again once it shows, after 30 percent of the note.
    test('the newsletter bar passes once it shows', async () => {
        for (const width of WIDTHS) {
            for (const mode of MODES) {
                const context = await phone(width, mode)
                try {
                    const page = await context.newPage()
                    await page.goto(canonicalPath(BUDGET_SAMPLE.long))
                    await page.evaluate(() => {
                        const note = document.querySelector('[data-note-body]')
                        if (note === null) throw new Error('no note body')
                        const box = note.getBoundingClientRect()
                        const top = box.top + scrollY + box.height * 0.5 - innerHeight
                        scrollTo({ top, behavior: 'instant' })
                    })
                    await page.locator('[data-newsletter]').waitFor({ state: 'visible' })
                    expect(await check(page), `${String(width)} px, ${mode}`).toEqual([])
                } finally {
                    await context.close()
                }
            }
        }
    }, 60_000)

    test('the bar goes away when the screen becomes wide', async () => {
        const context = await phone(390, 'dark')
        try {
            const page = await context.newPage()
            await page.goto(canonicalPath(BUDGET_SAMPLE.long))
            const bar = page.locator('[data-section-bar]')
            await page.evaluate(() => {
                scrollTo({ top: 3000, behavior: 'instant' })
            })
            await bar.waitFor({ state: 'visible' })
            await page.setViewportSize({ width: 1280, height: 800 })
            await bar.waitFor({ state: 'hidden' })
            expect(await page.locator('[data-outline="rail"]').isVisible()).toBe(true)
        } finally {
            await context.close()
        }
    }, 120_000)
})
