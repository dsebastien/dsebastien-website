import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page, Route } from 'playwright-core'
import {
    BUDGET_SAMPLE,
    FIXTURE_NOTE_TYPES,
    FIXTURE_STORE_CATALOG,
    TEST_ANALYTICS,
    copyFixtureVault,
    launchChrome,
    makeContentStoreCopy,
    makeTestStores,
    writeBudgetSample,
    type TestStores
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'
import { NEWSLETTER_KEY } from './newsletter/bar.ts'
import { MESSAGES } from './newsletter/newsletter-bar.ts'

// The browser seam of the tests (issue 57): the built fixture site in the
// installed Chrome (`launchChrome()` of `packages/testing`). The site answers
// at an invented host through the plain local server: the analytics script
// ignores a local host. Every request is intercepted: the page views and the
// events never reach the network, the signup service is a stub, and any other
// host is refused and recorded. Only the script of the analytics is read from
// the proxy, as the page reads it.
const SITE = fileURLToPath(new URL('..', import.meta.url))
const ORIGIN = 'https://notes.example'
const MEMBERS = 'https://www.dsebastien.net/members/api/'

const NOTES = ['10 Garden/Drip irrigation.md', BUDGET_SAMPLE.long]

let stores: TestStores | undefined
let outDir: string | undefined
let server: Server | undefined
let browser: Browser | undefined
let exitCode = -1
/** The path of the page of each note, by its vault path. */
const paths = new Map<string, string>()

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
    const planned = await plan(device, { include: NOTES })
    await publish(device, planned.id, {
        time: '2031-04-01T08:00:00Z',
        device: 'garden-shed',
        face: 'plugin'
    })
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'browser-page-spec-'))
    const dist = join(outDir, 'dist')
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', dist], {
        cwd: SITE,
        env: {
            ...process.env,
            CONTENT_STORE: contentStore,
            STORE_CATALOG: FIXTURE_STORE_CATALOG,
            STORE_CATALOG_COPY: join(outDir, 'store-catalog.json'),
            SITE_ANALYTICS: JSON.stringify(TEST_ANALYTICS)
        },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    exitCode = await child.exited
    if (exitCode !== 0) return
    for (const file of await readdir(join(dist, '-', 'note'))) {
        const html = await Bun.file(join(dist, '-', 'note', file)).text()
        const canonical = /<link rel="canonical" href="https:\/\/[^/]+([^"]+)"/u.exec(html)?.[1]
        const vaultPath = /data-cta-page="([^"]+)"/u.exec(html)?.[1]
        if (canonical === undefined) continue
        paths.set(vaultPath ?? BUDGET_SAMPLE.long, canonical)
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

/** What a page sent while a test ran. */
interface Traffic {
    /** The bodies of the events sent to the proxy. */
    events: Record<string, unknown>[]
    /** The calls of the signup service, with their bodies. */
    members: { url: string; method: string; body: unknown }[]
    /** Every request to another host, refused. */
    refused: string[]
}

/** The answer of the stub of the signup service. */
type MembersStub = (url: string) => { status: number; body: string }

const SIGNUP_SENT: MembersStub = (url) =>
    url.endsWith('/integrity-token/')
        ? { status: 200, body: 'a-test-token' }
        : { status: 201, body: '{}' }

/** A browser context whose every request is intercepted. */
async function contextOf(
    traffic: Traffic,
    options: { mobile?: boolean; members?: MembersStub } = {}
): Promise<BrowserContext> {
    if (browser === undefined) throw new Error('no browser')
    const context = await browser.newContext(
        options.mobile === true
            ? { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true }
            : { viewport: { width: 1280, height: 800 } }
    )
    // The script of the analytics ignores a browser that a program drives,
    // unless the page says that it is a test of its own.
    await context.addInitScript('window.__plausible = true')
    await context.route('**/*', async (route: Route) => {
        const request = route.request()
        const url = request.url()
        if (url.startsWith(`${ORIGIN}/`)) {
            const local = new URL(url)
            const answer = await fetch(`${server?.url ?? ''}${local.pathname}${local.search}`, {
                method: request.method(),
                redirect: 'manual'
            })
            const headers = Object.fromEntries(answer.headers.entries())
            const location = headers['location']
            if (location !== undefined && server !== undefined) {
                headers['location'] = location.replace(server.url, ORIGIN)
            }
            await route.fulfill({
                status: answer.status,
                headers,
                body: Buffer.from(await answer.arrayBuffer())
            })
        } else if (url === TEST_ANALYTICS.script) {
            await route.fulfill({ response: await route.fetch() })
        } else if (url === TEST_ANALYTICS.event) {
            traffic.events.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>)
            await route.fulfill({ status: 202, body: 'ok' })
        } else if (url.startsWith(MEMBERS) && options.members !== undefined) {
            const body = request.postData()
            traffic.members.push({
                url,
                method: request.method(),
                body: body === null ? undefined : (JSON.parse(body) as unknown)
            })
            await route.fulfill({
                ...options.members(url),
                headers: { 'access-control-allow-origin': '*' }
            })
        } else {
            traffic.refused.push(url)
            await route.abort()
        }
    })
    return context
}

function noTraffic(): Traffic {
    return { events: [], members: [], refused: [] }
}

function pathOf(note: string): string {
    const path = paths.get(note)
    if (path === undefined) throw new Error(`no page for ${note}`)
    return path
}

/** Waits until a page sent an event that the check accepts. */
async function eventWhere(
    traffic: Traffic,
    check: (event: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
    for (let wait = 0; wait < 100; wait += 1) {
        const found = traffic.events.find(check)
        if (found !== undefined) return found
        await Bun.sleep(100)
    }
    throw new Error(`no such event, the page sent ${JSON.stringify(traffic.events)}`)
}

/** Puts the bottom of the screen at a share of the text of the note. */
async function scrollToShare(page: Page, share: number): Promise<void> {
    await page.evaluate((part) => {
        const note = document.querySelector('[data-note-body]')
        if (note === null) throw new Error('no note body')
        const box = note.getBoundingClientRect()
        const top = box.top + window.scrollY + box.height * part - window.innerHeight
        window.scrollTo({ top, behavior: 'instant' })
    }, share)
}

async function scrollToEnd(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
    })
}

/** True when the bar shows. */
async function barShows(page: Page): Promise<boolean> {
    return await page.locator('[data-newsletter]').isVisible()
}

/** Waits for the bar to show or to hide; a few frames of the page. */
async function barBecomes(page: Page, shown: boolean): Promise<void> {
    await page
        .locator('[data-newsletter]')
        .waitFor({ state: shown ? 'visible' : 'hidden', timeout: 5_000 })
}

describe('the built site in a browser', () => {
    test('builds', () => {
        expect(exitCode).toBe(0)
        expect(paths.size).toBe(NOTES.length)
    })

    test('a note page sends its page view to the proxy with the site id of the target, and nothing else', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic)
        const page = await context.newPage()
        const path = pathOf(BUDGET_SAMPLE.long)
        await page.goto(`${ORIGIN}${path}`)

        const view = await eventWhere(traffic, (event) => event['n'] === 'pageview')
        expect(view).toMatchObject({ d: TEST_ANALYTICS.siteId, u: `${ORIGIN}${path}` })
        // No cookie, nothing in the storage, no other host, no call of the signup service.
        expect(await context.cookies()).toEqual([])
        expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
        expect(traffic.refused).toEqual([])
        expect(traffic.members).toEqual([])
        expect(await page.content()).not.toContain('/members/api')
        await context.close()
    })

    test('the "not found" page sends its view as /404, with the missing path', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic)
        const page = await context.newPage()
        const answer = await page.goto(`${ORIGIN}/No-such-note`)
        expect(answer?.status()).toBe(404)

        const view = await eventWhere(traffic, (event) => event['n'] === 'pageview')
        expect(view).toMatchObject({
            d: TEST_ANALYTICS.siteId,
            u: `${ORIGIN}/404`,
            p: { path: '/No-such-note' }
        })
        expect(traffic.refused).toEqual([])
        await context.close()
    })

    test('a click on an ad sends cta_clicked with its five properties', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic)
        const page = await context.newPage()
        await page.goto(`${ORIGIN}${pathOf('10 Garden/Drip irrigation.md')}`)
        const link = page.locator('a[data-cta-position]').first()
        const href = await link.getAttribute('href')
        const product = await link.getAttribute('data-cta-product')
        expect(product).not.toBeNull()
        await link.click()

        const click = await eventWhere(traffic, (event) => event['n'] === 'cta_clicked')
        expect(click).toMatchObject({
            d: TEST_ANALYTICS.siteId,
            p: {
                product,
                position: 'end',
                slot: '0',
                page: '10 Garden/Drip irrigation.md',
                href
            }
        })
        // The store opens in a new tab, which the test refuses.
        expect(traffic.refused.every((url) => url.startsWith('https://store.example/'))).toBe(true)
        await context.close()
    })
})

describe('the newsletter bar in a browser', () => {
    test('shows after 30 percent of the note, leaves before the footer and stays closed after a dismissal', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic, { mobile: true })
        const page = await context.newPage()
        const address = `${ORIGIN}${pathOf(BUDGET_SAMPLE.long)}`
        await page.goto(address)

        expect(await barShows(page)).toBe(false)
        await scrollToShare(page, 0.2)
        await Bun.sleep(200)
        expect(await barShows(page)).toBe(false)
        await scrollToShare(page, 0.35)
        await barBecomes(page, true)

        // On a phone of 360 px, a small part of the screen and no side scroll.
        const box = await page.locator('[data-newsletter]').boundingBox()
        expect(box?.height ?? 640).toBeLessThanOrEqual(640 * 0.2)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360)

        await scrollToEnd(page)
        await barBecomes(page, false)
        await scrollToShare(page, 0.5)
        await barBecomes(page, true)

        await page.getByRole('button', { name: "Don't show this again" }).click()
        await barBecomes(page, false)
        expect(await page.evaluate((key) => localStorage.getItem(key), NEWSLETTER_KEY)).toBe(
            'dismissed'
        )
        await page.reload()
        await scrollToShare(page, 0.5)
        await Bun.sleep(300)
        expect(await barShows(page)).toBe(false)
        expect(traffic.members).toEqual([])
        await context.close()
    })

    test('works with the keyboard, with a visible focus', async () => {
        const context = await contextOf(noTraffic())
        const page = await context.newPage()
        await page.goto(`${ORIGIN}${pathOf(BUDGET_SAMPLE.long)}`)
        await scrollToShare(page, 0.5)
        await barBecomes(page, true)

        await page.getByRole('textbox', { name: 'Your email address' }).focus()
        await page.keyboard.press('Tab')
        const submit = await page.evaluate(() => {
            const active = document.activeElement
            return {
                text: active?.textContent.trim(),
                visible: active?.matches(':focus-visible'),
                outline: active === null ? 'none' : getComputedStyle(active).outlineStyle
            }
        })
        expect(submit).toEqual({ text: 'Subscribe', visible: true, outline: 'solid' })
        await page.keyboard.press('Tab')
        expect(await page.evaluate(() => document.activeElement?.textContent.trim())).toBe(
            "Don't show this again"
        )
        await context.close()
    })

    test('signs up through the stub of the service, then stays closed', async () => {
        const traffic = noTraffic()
        const context = await contextOf(traffic, { members: SIGNUP_SENT })
        const page = await context.newPage()
        await page.goto(`${ORIGIN}${pathOf(BUDGET_SAMPLE.long)}`)
        await scrollToShare(page, 0.5)
        await barBecomes(page, true)

        await page.getByRole('textbox', { name: 'Your email address' }).fill('reader@example.com')
        await page.getByRole('button', { name: 'Subscribe' }).click()
        await page.getByRole('status').getByText(MESSAGES.sent).waitFor({ timeout: 5_000 })
        expect(traffic.members).toEqual([
            { url: `${MEMBERS}integrity-token/`, method: 'GET', body: undefined },
            {
                url: `${MEMBERS}send-magic-link`,
                method: 'POST',
                body: {
                    email: 'reader@example.com',
                    emailType: 'subscribe',
                    integrityToken: 'a-test-token'
                }
            }
        ])
        expect(await page.evaluate((key) => localStorage.getItem(key), NEWSLETTER_KEY)).toBe(
            'signed-up'
        )
        // The message stays a moment, then the bar closes.
        await page.locator('[data-newsletter]').waitFor({ state: 'hidden', timeout: 8_000 })

        await page.reload()
        await scrollToShare(page, 0.5)
        await Bun.sleep(300)
        expect(await barShows(page)).toBe(false)
        await context.close()
    }, 20_000)
})
