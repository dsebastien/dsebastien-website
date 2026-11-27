import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath } from '@dsebastien-website/resolver'
import type { Element, Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import type { Browser, Route } from 'playwright-core'
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
import { SAMPLE_VIDEO_TITLE, writePreviewSample } from './link-previews/preview-sample.ts'
import { playerAddress } from './link-previews/video.ts'

// The link cards with their previews on the built site (issue 86, CARD-03,
// CARD-06, CARD-07, CARD-09): the cache of the preview sample, made with a fake web, a
// build that reads it (`LINK_PREVIEWS=cache`, no request to the web), and the
// pages of the notes with cards, read as HTML and opened in the installed
// Chrome, which answers every request of another host with a refusal.
const SITE = fileURLToPath(new URL('..', import.meta.url))
const ORIGIN = 'https://notes.example'

const READING = '40 Writing/Reading list.md'
const VIDEO = '50 Field guide/Queries/Video URL line.md'
const NOTES = [READING, VIDEO, '10 Garden/Compost basics.md', '10 Garden/Rain barrel.md']

let stores: TestStores | undefined
let outDir: string | undefined
let server: Server | undefined
let browser: Browser | undefined
let exitCode = -1
const pages = new Map<string, string>()
const paths = new Map<string, string>()

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
        time: '2031-05-01T00:00:00Z',
        device: 'garden-shed',
        face: 'command-line'
    })
    const parent = join(SITE, '.cache')
    await mkdir(parent, { recursive: true })
    outDir = await mkdtemp(join(parent, 'link-cards-spec-'))
    const cache = join(outDir, 'previews')
    await writePreviewSample(cache)
    const dist = join(outDir, 'dist')
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', dist], {
        cwd: SITE,
        env: {
            ...process.env,
            CONTENT_STORE: contentStore,
            LINK_PREVIEWS: 'cache',
            LINK_PREVIEWS_CACHE: cache
        },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    exitCode = await child.exited
    if (exitCode !== 0) return
    server = await startServer({ dist, port: 0 })
    for (const note of [READING, VIDEO]) {
        const path = canonicalPath(note)
        paths.set(note, path)
        pages.set(note, await (await fetch(`${server.url}${path}`)).text())
    }
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

function elementsOf(tree: Root): Element[] {
    const found: Element[] = []
    const visit = (nodes: readonly RootContent[]): void => {
        for (const node of nodes) {
            if (node.type !== 'element') continue
            found.push(node)
            visit(node.children)
        }
    }
    visit(tree.children)
    return found
}

function pageOf(note: string): Element[] {
    const html = pages.get(note)
    if (html === undefined) throw new Error(`no page for ${note}`)
    return elementsOf(fromHtml(html))
}

const classesOf = (element: Element): string[] => {
    const value = element.properties['className']
    return Array.isArray(value) ? value.map(String) : []
}

/** The kinds of a link element that load a file. */
const LOADING_RELS = new Set([
    'stylesheet',
    'preload',
    'modulepreload',
    'prefetch',
    'icon',
    'apple-touch-icon',
    'manifest'
])

/** The addresses that a page loads by itself: its files, images, frames, scripts and styles. */
function loadedAddresses(elements: readonly Element[]): string[] {
    const found: string[] = []
    for (const element of elements) {
        for (const key of ['src', 'poster', 'data']) {
            const value = element.properties[key]
            if (typeof value === 'string') found.push(value)
        }
        const set = element.properties['srcSet']
        const text = Array.isArray(set) ? set.join(',') : typeof set === 'string' ? set : ''
        for (const part of text.split(',')) {
            const address = part.trim().split(/\s+/u)[0]
            if (address !== undefined && address !== '') found.push(address)
        }
        // A link element that names another page (canonical, alternate) loads nothing.
        const rel = element.properties['rel']
        const rels = Array.isArray(rel) ? rel.map(String) : []
        const loads = rels.some((name) => LOADING_RELS.has(name))
        if (element.tagName === 'link' && loads && typeof element.properties['href'] === 'string') {
            found.push(element.properties['href'])
        }
    }
    return found
}

describe('link cards with their previews (issue 86)', () => {
    test('the site builds', () => {
        expect(exitCode).toBe(0)
    })

    test('a card with an image shows the stored image; a card without one stays compact (CARD-06)', async () => {
        const cards = pageOf(READING).filter((element) => classesOf(element).includes('link-card'))
        const soil = cards.find((card) =>
            elementsOf({ type: 'root', children: [card] }).some(
                (element) => element.properties['href'] === 'https://garden.example/soil'
            )
        )
        const image =
            soil === undefined
                ? undefined
                : elementsOf({ type: 'root', children: [soil] }).find(
                      (element) => element.tagName === 'img'
                  )
        const src = image?.properties['src']
        expect(src).toMatch(/^\/-\/link-previews\/[0-9a-f]{64}\.webp$/u)
        expect(image?.properties).toMatchObject({ width: 320, height: 168, alt: '' })
        const answer = await fetch(`${server?.url ?? ''}${String(src)}`)
        expect(answer.status).toBe(200)
        expect(answer.headers.get('content-type')).toBe('image/webp')
        expect(answer.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        const compact = cards.filter((card) => !classesOf(card).includes('link-card-with-image'))
        expect(compact.length).toBeGreaterThan(5)
    })

    test('a note card shows the label of its link (CARD-03)', () => {
        const titles = pageOf(READING)
            .filter((element) => classesOf(element).includes('link-card-link'))
            .filter((link) => String(link.properties['href']).toLowerCase().includes('rain'))
            .map((link) => elementsOf({ type: 'root', children: [link] }))
            .map((inner) => inner.find((element) => classesOf(element).includes('link-card-title')))
            .map((title) => (title?.children[0]?.type === 'text' ? title.children[0].value : ''))
        expect(titles).toEqual(['The barrel'])
    })

    test('a page with cards loads nothing from another host (CARD-07)', () => {
        for (const note of [READING, VIDEO]) {
            const addresses = loadedAddresses(pageOf(note))
            expect(addresses.length).toBeGreaterThan(0)
            expect(
                addresses.filter((address) => !address.startsWith('/') || address.startsWith('//'))
            ).toEqual([])
        }
    })

    test('a video card is a link with a local image, and has no frame in its HTML (CARD-09)', () => {
        const elements = pageOf(VIDEO)
        const card = elements.find((element) => classesOf(element).includes('link-card-video'))
        expect(card?.properties['dataVideoId']).toBe('GardenTour1')
        const inner = card === undefined ? [] : elementsOf({ type: 'root', children: [card] })
        expect(inner.find((element) => element.tagName === 'a')?.properties['href']).toBe(
            'https://www.youtube.com/watch?v=GardenTour1'
        )
        expect(inner.find((element) => element.tagName === 'img')?.properties['src']).toMatch(
            /^\/-\/link-previews\//u
        )
        expect(
            inner.some((element) =>
                element.children.some(
                    (child) => child.type === 'text' && child.value === SAMPLE_VIDEO_TITLE
                )
            )
        ).toBe(true)
        expect(elements.filter((element) => element.tagName === 'iframe')).toEqual([])
        // The player script is only on a page with a video card.
        const scripts = (note: string): string =>
            pageOf(note)
                .filter((element) => element.tagName === 'script')
                .map((element) =>
                    element.children[0]?.type === 'text' ? element.children[0].value : ''
                )
                .join('\n')
        expect(scripts(VIDEO)).toContain('data-video-id')
        expect(scripts(READING)).not.toContain('data-video-id')
    })

    test('in a browser, the page asks no other host; a click loads the player of the host without cookies, which the policy allows', async () => {
        if (browser === undefined) throw new Error('no browser')
        const context = await browser.newContext({ viewport: { width: 390, height: 800 } })
        const asked: string[] = []
        const violations: string[] = []
        await context.exposeFunction('__blocked', (text: string) => {
            violations.push(text)
        })
        await context.addInitScript(() => {
            document.addEventListener('securitypolicyviolation', (event) => {
                const report = (window as unknown as { __blocked: (text: string) => void })
                    .__blocked
                report(`${event.effectiveDirective} ${event.blockedURI}`)
            })
        })
        await context.route('**/*', async (route: Route) => {
            const url = route.request().url()
            if (url.startsWith(`${ORIGIN}/`)) {
                const local = new URL(url)
                const answer = await fetch(`${server?.url ?? ''}${local.pathname}${local.search}`)
                await route.fulfill({
                    status: answer.status,
                    headers: Object.fromEntries(answer.headers.entries()),
                    body: Buffer.from(await answer.arrayBuffer())
                })
                return
            }
            asked.push(url)
            if (url.startsWith('https://www.youtube-nocookie.com/')) {
                await route.fulfill({ contentType: 'text/html', body: '<p>player</p>' })
            } else {
                await route.abort()
            }
        })
        const page = await context.newPage()
        for (const note of [READING, VIDEO]) {
            await page.goto(`${ORIGIN}${paths.get(note) ?? ''}`, { waitUntil: 'load' })
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight)
            })
            await page.waitForTimeout(300)
        }
        expect(asked).toEqual([])
        expect(await page.locator('iframe').count()).toBe(0)
        await page.locator('.link-card-video .link-card-link').click()
        const frame = page.locator('iframe.link-card-player')
        await frame.waitFor()
        expect(await frame.getAttribute('src')).toBe(playerAddress({ id: 'GardenTour1' }))
        await page.waitForTimeout(500)
        expect(asked).toEqual([playerAddress({ id: 'GardenTour1' })])
        expect(violations).toEqual([])
        await context.close()
    })
})
