import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LINK_PREVIEW_FOLDER } from '@dsebastien-website/resolver'
import type * as SharpTypes from 'sharp'
import { fromHtml } from 'hast-util-from-html'
import type { Element, Root, RootContent } from 'hast'
import { videoOf } from './video.ts'

// The previews of the link cards (CARD-06, CARD-07, CARD-09): the small image
// of the page that a card leads to (its `og:image`, else its `twitter:image`),
// and for a video card the still image of the video and its title. The build
// fetches each one time and keeps it in a cache folder that survives the
// builds: `previews.json` (what each address gave, and when) and the images,
// each a small WebP named by the SHA-256 of its bytes, as an attachment is.
// The pages load the images from the host of the notes
// (`/-/link-previews/<hash>.webp`, `LINK_PREVIEW_FOLDER`): a reader makes no
// request to the site of a card. A failed fetch leaves the card compact and
// never fails the build; it is tried again after `LINK_PREVIEW_RETRY_DAYS`.
// A build that only reads the cache (no `fetch`) makes no request at all.
//
// The rules of a fetch: `http` and `https` only, at most five redirects, a
// time limit, a size limit, a neutral user agent and no cookies.

/** A request to the web, as the build makes it: the `fetch` of the runtime, or a fake in a test. */
export type FetchPort = (url: string, init: RequestInit) => Promise<Response>

/** The image of a card, on the host of the notes. */
export interface PreviewImage {
    /** Its address: `/-/link-previews/<hash>.webp`. */
    readonly path: string
    readonly width: number
    readonly height: number
}

/** What a card shows of its target. A card with no image is the compact card. */
export interface LinkPreview {
    readonly image?: PreviewImage
    /** The title of a video. */
    readonly title?: string
}

/** The target of a card: its address, and whether it is a video card. */
export interface PreviewTarget {
    readonly url: string
    readonly video: boolean
}

/** What the build gives the reading of the previews. */
export interface PreviewOptions {
    /** The cache folder. */
    readonly cache: string
    /** The requests to the web; without it, the build reads the cache only. */
    readonly fetch?: FetchPort
    /** The time of the build. */
    readonly now: Date
    /** The most addresses that one build fetches: the others wait for the next build. */
    readonly maxFetches?: number
    readonly warn?: (line: string) => void
}

/** How many days a failed fetch waits before the next build tries again. */
export const LINK_PREVIEW_RETRY_DAYS = 7

/** The most addresses that one build fetches, by default. */
export const LINK_PREVIEW_FETCHES = 200

/** The size of the image of a card, in pixels: the shape of an `og:image`. */
const CARD_IMAGE = { width: 320, height: 168 } as const
/** The size of the still image of a video card: 16 by 9. */
const VIDEO_IMAGE = { width: 480, height: 270 } as const

const INDEX = 'previews.json'
const IMAGES = 'images'
const GENERATION = 1
const TIMEOUT = 10_000
const MAX_REDIRECTS = 5
const MAX_HTML = 1_000_000
const MAX_IMAGE = 5_000_000
const MAX_PIXELS = 50_000_000
const CONCURRENCY = 6
const USER_AGENT = 'Mozilla/5.0 (compatible; link-preview)'
const DAY = 86_400_000
const IMAGE_NAME = /^[0-9a-f]{64}\.webp$/u

/** What the cache knows of one address. */
interface Entry {
    readonly fetchedAt: string
    readonly failed?: true
    readonly image?: { readonly file: string; readonly width: number; readonly height: number }
    readonly title?: string
}

/** The key of a target in the cache: `youtube:<id>` for a video, else its address without its fragment. */
export function previewKey(target: PreviewTarget): string | undefined {
    if (target.video) {
        const video = videoOf(target.url)
        return video === undefined ? undefined : `youtube:${video.id}`
    }
    let url: URL
    try {
        url = new URL(target.url)
    } catch {
        return undefined
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    url.hash = ''
    return url.href
}

/** The file of the cache of an image address of a page, or `undefined` for any other address. */
export function previewFileOf(cache: string, path: string): string | undefined {
    const prefix = `/${LINK_PREVIEW_FOLDER}/`
    const name = path.startsWith(prefix) ? path.slice(prefix.length) : ''
    return IMAGE_NAME.test(name) ? join(cache, IMAGES, name) : undefined
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** One entry of the file, checked; `undefined` when it is not one. */
function entryFrom(value: unknown): Entry | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    const { fetchedAt, failed, image, title } = record
    if (typeof fetchedAt !== 'string' || Number.isNaN(Date.parse(fetchedAt))) return undefined
    let checked: Entry['image']
    if (image !== undefined) {
        if (typeof image !== 'object' || image === null) return undefined
        const { file, width, height } = image as Record<string, unknown>
        if (typeof file !== 'string' || !IMAGE_NAME.test(file)) return undefined
        if (!isNumber(width) || !isNumber(height)) return undefined
        checked = { file, width, height }
    }
    return {
        fetchedAt,
        ...(failed === true ? { failed } : {}),
        ...(checked === undefined ? {} : { image: checked }),
        ...(typeof title === 'string' && title !== '' ? { title } : {})
    }
}

/** The entries of the cache. A file that cannot be read is an empty cache. */
async function readIndex(cache: string, warn: (line: string) => void): Promise<Map<string, Entry>> {
    let text: string
    try {
        text = await readFile(join(cache, INDEX), 'utf8')
    } catch {
        return new Map()
    }
    try {
        const parsed: unknown = JSON.parse(text)
        const { generation, entries } = (parsed ?? {}) as Record<string, unknown>
        if (generation !== GENERATION || typeof entries !== 'object' || entries === null) {
            throw new Error('not a cache of this generation')
        }
        const read = new Map<string, Entry>()
        for (const [key, value] of Object.entries(entries)) {
            const entry = entryFrom(value)
            if (entry !== undefined) read.set(key, entry)
        }
        return read
    } catch (error) {
        warn(`the cache ${join(cache, INDEX)} is not readable, read as empty: ${String(error)}`)
        return new Map()
    }
}

async function writeIndex(cache: string, entries: ReadonlyMap<string, Entry>): Promise<void> {
    const sorted = [...entries].sort(([one], [two]) => (one < two ? -1 : one > two ? 1 : 0))
    const text = `${JSON.stringify({ generation: GENERATION, entries: Object.fromEntries(sorted) }, null, 4)}\n`
    const file = join(cache, INDEX)
    await writeFile(`${file}.tmp`, text)
    await rename(`${file}.tmp`, file)
}

/** The body of an answer, at most `limit` bytes: `undefined` past it, or the first bytes when `cut`. */
async function bodyOf(
    response: Response,
    limit: number,
    cut: boolean
): Promise<Uint8Array | undefined> {
    const reader = response.body?.getReader()
    if (reader === undefined) return new Uint8Array(0)
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        size += value.byteLength
        if (size > limit) {
            await reader.cancel()
            if (!cut) return undefined
            break
        }
    }
    const bytes = new Uint8Array(Math.min(size, limit))
    let at = 0
    for (const part of parts) {
        const room = bytes.length - at
        if (room <= 0) break
        bytes.set(part.subarray(0, room), at)
        at += Math.min(part.byteLength, room)
    }
    return bytes
}

/** True for an address of the web. */
function isWeb(url: URL): boolean {
    return url.protocol === 'https:' || url.protocol === 'http:'
}

/** An answer of the web after its redirects, with the address that gave it. */
async function get(
    fetch: FetchPort,
    address: string,
    accept: string
): Promise<{ url: URL; response: Response }> {
    let url = new URL(address)
    const signal = AbortSignal.timeout(TIMEOUT)
    for (let hop = 0; ; hop += 1) {
        if (!isWeb(url)) throw new Error(`${url.href} is not an address of the web`)
        const response = await fetch(url.href, {
            redirect: 'manual',
            credentials: 'omit',
            signal,
            headers: { 'accept': accept, 'user-agent': USER_AGENT }
        })
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location !== null) {
            await response.body?.cancel()
            if (hop >= MAX_REDIRECTS)
                throw new Error(`more than ${String(MAX_REDIRECTS)} redirects`)
            url = new URL(location, url)
            continue
        }
        if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`${url.href} answered ${String(response.status)}`)
        }
        return { url, response }
    }
}

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

/** The address of the image of a page: its `og:image`, else its `twitter:image`. */
function imageOfPage(html: string, base: URL): URL | undefined {
    const metas = elementsOf(fromHtml(html)).filter((element) => element.tagName === 'meta')
    const named = (name: string): string | undefined => {
        for (const meta of metas) {
            const key = meta.properties['property'] ?? meta.properties['name']
            const content = meta.properties['content']
            if (
                typeof key === 'string' &&
                key.toLowerCase() === name &&
                typeof content === 'string'
            ) {
                if (content.trim() !== '') return content.trim()
            }
        }
        return undefined
    }
    const found = named('og:image') ?? named('og:image:url') ?? named('twitter:image')
    if (found === undefined) return undefined
    try {
        const url = new URL(found, base)
        return isWeb(url) ? url : undefined
    } catch {
        return undefined
    }
}

let sharpModule: Promise<typeof SharpTypes> | undefined
const loadSharp = (): Promise<typeof SharpTypes> => (sharpModule ??= import('sharp'))

/** An image of the web, small, in WebP, stored in the cache by the hash of its bytes. */
async function storeImage(
    fetch: FetchPort,
    address: URL,
    size: { width: number; height: number },
    cache: string
): Promise<Entry['image']> {
    const { response } = await get(fetch, address.href, 'image/*')
    const type = response.headers.get('content-type') ?? ''
    if (!type.toLowerCase().startsWith('image/')) {
        await response.body?.cancel()
        throw new Error(`${address.href} is not an image`)
    }
    const bytes = await bodyOf(response, MAX_IMAGE, false)
    if (bytes === undefined)
        throw new Error(`${address.href} has more than ${String(MAX_IMAGE)} bytes`)
    const sharp = (await loadSharp()).default
    // The first frame, turned as its Exif says, without its metadata.
    const webp = await sharp(bytes, { failOn: 'truncated', limitInputPixels: MAX_PIXELS })
        .rotate()
        .resize(size.width, size.height, { fit: 'cover' })
        .webp({ quality: 75, effort: 4 })
        .toBuffer()
    const file = `${createHash('sha256').update(webp).digest('hex')}.webp`
    await mkdir(join(cache, IMAGES), { recursive: true })
    await writeFile(join(cache, IMAGES, file), webp)
    return { file, ...size }
}

/** The title of a video, from the oEmbed answer of YouTube, or `undefined`. */
async function videoTitle(fetch: FetchPort, id: string): Promise<string | undefined> {
    const watch = `https://www.youtube.com/watch?v=${id}`
    try {
        const { response } = await get(
            fetch,
            `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
            'application/json'
        )
        const bytes = await bodyOf(response, MAX_HTML, false)
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
        const title = (parsed as Record<string, unknown> | null)?.['title']
        return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
    } catch {
        return undefined
    }
}

/** What the web gives for one target. */
async function fetchEntry(fetch: FetchPort, key: string, cache: string, now: Date): Promise<Entry> {
    const fetchedAt = now.toISOString()
    if (key.startsWith('youtube:')) {
        const id = key.slice('youtube:'.length)
        const title = await videoTitle(fetch, id)
        const image = await storeImage(
            fetch,
            new URL(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
            VIDEO_IMAGE,
            cache
        )
        return {
            fetchedAt,
            ...(image === undefined ? {} : { image }),
            ...(title === undefined ? {} : { title })
        }
    }
    const { url, response } = await get(fetch, key, 'text/html')
    const type = response.headers.get('content-type') ?? ''
    if (!type.toLowerCase().includes('html')) {
        await response.body?.cancel()
        return { fetchedAt }
    }
    const bytes = await bodyOf(response, MAX_HTML, true)
    const address = imageOfPage(new TextDecoder().decode(bytes), url)
    if (address === undefined) return { fetchedAt }
    const image = await storeImage(fetch, address, CARD_IMAGE, cache)
    return { fetchedAt, ...(image === undefined ? {} : { image }) }
}

/** True when the cache must ask the web again: never read, or failed long enough ago. */
function isDue(entry: Entry | undefined, now: Date): boolean {
    if (entry === undefined) return true
    return (
        entry.failed === true &&
        now.getTime() - Date.parse(entry.fetchedAt) > LINK_PREVIEW_RETRY_DAYS * DAY
    )
}

function previewOf(entry: Entry): LinkPreview {
    return {
        ...(entry.image === undefined
            ? {}
            : {
                  image: {
                      path: `/${LINK_PREVIEW_FOLDER}/${entry.image.file}`,
                      width: entry.image.width,
                      height: entry.image.height
                  }
              }),
        ...(entry.title === undefined ? {} : { title: entry.title })
    }
}

/**
 * The previews of the targets of the cards of a build, by `previewKey()`:
 * the cache, with each target that it lacks fetched when the build has a
 * `fetch`. A target that the cache does not know and that is not fetched has
 * no preview. Never throws for a target: a failure is a warning.
 */
export async function readLinkPreviews(
    targets: Iterable<PreviewTarget>,
    options: PreviewOptions
): Promise<ReadonlyMap<string, LinkPreview>> {
    const warn =
        options.warn ??
        ((line: string) => {
            console.warn(`[link-previews] ${line}`)
        })
    const entries = await readIndex(options.cache, warn)
    // An entry whose image left the cache folder is read again.
    for (const [key, entry] of entries) {
        if (entry.image === undefined) continue
        const found = await access(join(options.cache, IMAGES, entry.image.file)).then(
            () => true,
            () => false
        )
        if (!found) entries.delete(key)
    }
    const keys = new Set<string>()
    for (const target of targets) {
        const key = previewKey(target)
        if (key !== undefined) keys.add(key)
    }
    const { fetch } = options
    if (fetch !== undefined) {
        const due = [...keys].filter((key) => isDue(entries.get(key), options.now))
        const chosen = due.slice(0, options.maxFetches ?? LINK_PREVIEW_FETCHES)
        let next = 0
        const work = async (): Promise<void> => {
            while (next < chosen.length) {
                const key = chosen[next] as string
                next += 1
                try {
                    entries.set(key, await fetchEntry(fetch, key, options.cache, options.now))
                } catch (error) {
                    warn(
                        `no preview for ${key}: ${error instanceof Error ? error.message : String(error)}`
                    )
                    entries.set(key, { fetchedAt: options.now.toISOString(), failed: true })
                }
            }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, work))
        if (chosen.length > 0) {
            await mkdir(options.cache, { recursive: true })
            await writeIndex(options.cache, entries)
        }
        if (due.length > chosen.length) {
            warn(`${String(due.length - chosen.length)} previews wait for the next build`)
        }
    }
    const previews = new Map<string, LinkPreview>()
    for (const key of keys) {
        const entry = entries.get(key)
        if (entry !== undefined) previews.set(key, previewOf(entry))
    }
    return previews
}
