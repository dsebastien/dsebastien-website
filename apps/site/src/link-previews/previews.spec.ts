import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
    LINK_PREVIEW_RETRY_DAYS,
    previewKey,
    previewFileOf,
    readLinkPreviews,
    type FetchPort
} from './previews.ts'

const SITE = fileURLToPath(new URL('../..', import.meta.url))
const NOW = new Date('2031-05-01T08:00:00Z')

let cache = ''

beforeEach(async () => {
    const parent = join(SITE, '.cache')
    await mkdir(parent, { recursive: true })
    cache = await mkdtemp(join(parent, 'link-previews-spec-'))
})

afterEach(async () => {
    await rm(cache, { recursive: true, force: true })
})

/** An invented picture: a gradient of the given size, as a PNG. */
async function picture(width: number, height: number): Promise<Uint8Array> {
    const pixels = Buffer.alloc(width * height * 3)
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = index % 251
    return new Uint8Array(
        await sharp(pixels, { raw: { width, height, channels: 3 } })
            .png()
            .toBuffer()
    )
}

/** A fake web: each address answers from the table, and every request is recorded. */
function web(table: Record<string, () => Response | Promise<Response>>): {
    fetch: FetchPort
    asked: string[]
} {
    const asked: string[] = []
    return {
        asked,
        fetch: async (url) => {
            asked.push(url)
            const answer = table[url]
            if (answer === undefined) throw new Error(`no answer for ${url}`)
            return answer()
        }
    }
}

const html = (head: string): Response =>
    new Response(`<!doctype html><html><head>${head}</head><body>Text</body></html>`, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
    })

const image = (bytes: Uint8Array): Response =>
    new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } })

const SOIL = { url: 'https://garden.example/soil', video: false }
const TOUR = { url: 'https://www.youtube.com/watch?v=GardenTour1', video: true }

describe('the preview of a link card (CARD-06, CARD-07)', () => {
    test('the build fetches the image of the other site once, small, and keeps it', async () => {
        const photo = await picture(1200, 630)
        const first = web({
            'https://garden.example/soil': () =>
                html('<meta property="og:image" content="/images/soil.png">'),
            'https://garden.example/images/soil.png': () => image(photo)
        })
        const previews = await readLinkPreviews([SOIL], { cache, fetch: first.fetch, now: NOW })
        const preview = previews.get(previewKey(SOIL) ?? '')
        expect(preview?.image?.path).toMatch(/^\/-\/link-previews\/[0-9a-f]{64}\.webp$/u)
        expect(preview?.image).toMatchObject({ width: 320, height: 168 })
        const file = previewFileOf(cache, preview?.image?.path ?? '')
        expect(file).toBeDefined()
        const stored = await sharp(await readFile(file ?? '')).metadata()
        expect(stored).toMatchObject({ format: 'webp', width: 320, height: 168 })
        expect(first.asked).toHaveLength(2)

        // The next build reads the cache: no request, the same image.
        const second = web({})
        const again = await readLinkPreviews([SOIL], { cache, fetch: second.fetch, now: NOW })
        expect(again.get(previewKey(SOIL) ?? '')).toEqual(preview)
        expect(second.asked).toEqual([])
        // A build that only reads the cache gives it too.
        const read = await readLinkPreviews([SOIL], { cache, now: NOW })
        expect(read.get(previewKey(SOIL) ?? '')).toEqual(preview)
    })

    test('a failed fetch leaves the card compact, never throws, and is tried again later', async () => {
        const broken = web({
            'https://garden.example/soil': () => new Response('down', { status: 503 })
        })
        const warnings: string[] = []
        const previews = await readLinkPreviews([SOIL], {
            cache,
            fetch: broken.fetch,
            now: NOW,
            warn: (line) => warnings.push(line)
        })
        expect(previews.get(previewKey(SOIL) ?? '')).toEqual({})
        expect(warnings.join('\n')).toContain('garden.example/soil')
        const soon = web({})
        await readLinkPreviews([SOIL], { cache, fetch: soon.fetch, now: NOW })
        expect(soon.asked).toEqual([])
        const later = new Date(NOW.getTime() + (LINK_PREVIEW_RETRY_DAYS + 1) * 86_400_000)
        const retry = web({ 'https://garden.example/soil': () => html('') })
        await readLinkPreviews([SOIL], { cache, fetch: retry.fetch, now: later })
        expect(retry.asked).toEqual(['https://garden.example/soil'])
    })

    test('a thrown error, an image that is no image and an image that is too large fail softly', async () => {
        const targets = [
            { url: 'https://a.example/', video: false },
            { url: 'https://b.example/', video: false },
            { url: 'https://c.example/', video: false }
        ]
        const fake = web({
            'https://a.example/': () => {
                throw new Error('no route')
            },
            'https://b.example/': () => html('<meta name="twitter:image" content="/x.png">'),
            'https://b.example/x.png': () =>
                new Response('<svg/>', { headers: { 'content-type': 'image/png' } }),
            'https://c.example/': () => html('<meta property="og:image" content="/big.png">'),
            'https://c.example/big.png': () =>
                new Response(new Uint8Array(6_000_000), {
                    headers: { 'content-type': 'image/png' }
                })
        })
        const previews = await readLinkPreviews(targets, {
            cache,
            fetch: fake.fetch,
            now: NOW,
            warn: () => undefined
        })
        for (const target of targets) {
            expect(previews.get(previewKey(target) ?? '')).toEqual({})
        }
    })

    test('an image that is not on the web, and a chain of more than five redirects, are not read', async () => {
        const hops: Record<string, () => Response> = {}
        for (let hop = 0; hop < 7; hop += 1) {
            hops[`https://d.example/${String(hop)}`] = () =>
                new Response(null, {
                    status: 301,
                    headers: { location: `/${String(hop + 1)}` }
                })
        }
        const fake = web({
            ...hops,
            'https://e.example/': () =>
                html('<meta property="og:image" content="javascript:alert(1)">')
        })
        const previews = await readLinkPreviews(
            [
                { url: 'https://d.example/0', video: false },
                { url: 'https://e.example/', video: false }
            ],
            { cache, fetch: fake.fetch, now: NOW, warn: () => undefined }
        )
        expect(previews.get('https://d.example/0')).toEqual({})
        expect(previews.get('https://e.example/')).toEqual({})
        expect(fake.asked).not.toContain('https://d.example/6')
        expect(fake.asked.some((url) => url.startsWith('javascript:'))).toBe(false)
    })

    test('a video card gets the still image of the video and its title', async () => {
        const still = await picture(480, 360)
        const fake = web({
            'https://i.ytimg.com/vi/GardenTour1/hqdefault.jpg': () => image(still),
            'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DGardenTour1&format=json':
                () => Response.json({ title: 'A tour of the garden' })
        })
        const previews = await readLinkPreviews([TOUR], { cache, fetch: fake.fetch, now: NOW })
        const preview = previews.get(previewKey(TOUR) ?? '')
        expect(preview?.title).toBe('A tour of the garden')
        expect(preview?.image).toMatchObject({ width: 480, height: 270 })
        expect(previewKey(TOUR)).toBe(
            previewKey({ url: 'https://youtu.be/GardenTour1?t=30', video: true })
        )
    })

    test('without a fetch the build reads the cache only, and a build fetches a limited number', async () => {
        const none = await readLinkPreviews([SOIL], { cache, now: NOW })
        expect(none.get(previewKey(SOIL) ?? '')).toBeUndefined()
        const fake = web({
            'https://garden.example/soil': () => html(''),
            'https://garden.example/tools': () => html('')
        })
        await readLinkPreviews([SOIL, { url: 'https://garden.example/tools', video: false }], {
            cache,
            fetch: fake.fetch,
            now: NOW,
            maxFetches: 1
        })
        expect(fake.asked).toHaveLength(1)
    })

    test('a cache that is not readable is read as empty, with a warning', async () => {
        await writeFile(join(cache, 'previews.json'), '{ not json')
        const warnings: string[] = []
        const previews = await readLinkPreviews([SOIL], {
            cache,
            now: NOW,
            warn: (line) => warnings.push(line)
        })
        expect(previews.size).toBe(0)
        expect(warnings).toHaveLength(1)
    })

    test('the key of a page has no fragment; a file of the cache is found only by its own name', () => {
        expect(previewKey({ url: 'https://Garden.example/soil#top', video: false })).toBe(
            'https://garden.example/soil'
        )
        expect(previewKey({ url: 'ftp://garden.example/', video: false })).toBeUndefined()
        expect(previewFileOf(cache, '/-/link-previews/../previews.json')).toBeUndefined()
    })
})
