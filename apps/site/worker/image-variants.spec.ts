import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import {
    EncoderUnavailableError,
    imageVariants,
    TooManyPixelsError,
    variantKey
} from '@dsebastien-website/resolver'
import { rejectionOf } from '@dsebastien-website/testing'
import sharp from 'sharp'
import { encodeVariants, writeVariants } from './image-variants.ts'

// The variants of an image (issue 87, PERF-25): WebP files of the widths
// that the pages name, made on the machine that publishes.

const CACHE = fileURLToPath(new URL('../../../.cache', import.meta.url))

/** A JPEG of this size, with a gradient, and the Exif turn when it is given. */
async function jpeg(width: number, height: number, orientation?: number): Promise<Uint8Array> {
    const pixels = new Uint8Array(width * height * 3)
    for (let index = 0; index < pixels.length; index += 1) {
        pixels[index] = (index * 7) % 251
    }
    const image = sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 80 })
    return new Uint8Array(
        await (orientation === undefined ? image : image.withMetadata({ orientation })).toBuffer()
    )
}

/** A PNG of this size, one color, with the Exif turn when it is given. */
async function png(width: number, height: number, orientation?: number): Promise<Uint8Array> {
    const image = sharp({
        create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } }
    }).png()
    return new Uint8Array(
        await (orientation === undefined ? image : image.withMetadata({ orientation })).toBuffer()
    )
}

/** An animated WebP of two frames of this size, with the Exif turn when it is given. */
async function animated(width: number, height: number, orientation?: number): Promise<Uint8Array> {
    const frame = (red: number): Promise<Buffer> =>
        sharp({ create: { width, height, channels: 3, background: { r: red, g: 0, b: 0 } } })
            .png()
            .toBuffer()
    const image = sharp([await frame(20), await frame(200)], { join: { animated: true } }).webp({
        delay: [100, 100]
    })
    return new Uint8Array(
        await (orientation === undefined ? image : image.withMetadata({ orientation })).toBuffer()
    )
}

/** A PNG whose header says this size, with one pixel of data: sharp reads its size only. */
async function pngHeader(width: number, height: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(await png(1, 1))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(16, width)
    view.setUint32(20, height)
    view.setUint32(29, Bun.hash.crc32(bytes.subarray(12, 29)))
    return bytes
}

/** A PNG chunk: its length, its type, its data and its checksum. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)))
    return out
}

/** An animated PNG made by hand: two frames of one color each, of this size. */
function apng(width: number, height: number): Uint8Array {
    const numbers = (...values: [number, number][]): Uint8Array => {
        const out = new Uint8Array(values.reduce((total, [, size]) => total + size, 0))
        const view = new DataView(out.buffer)
        let at = 0
        for (const [value, size] of values) {
            if (size === 4) view.setUint32(at, value)
            else if (size === 2) view.setUint16(at, value)
            else view.setUint8(at, value)
            at += size
        }
        return out
    }
    const pixels = (red: number): Uint8Array => {
        const row = new Uint8Array(1 + width * 3)
        for (let x = 0; x < width; x += 1) row[1 + x * 3] = red
        const raw = new Uint8Array(row.length * height)
        for (let y = 0; y < height; y += 1) raw.set(row, y * row.length)
        return deflateSync(raw)
    }
    const frame = (sequence: number): Uint8Array =>
        numbers(
            [sequence, 4],
            [width, 4],
            [height, 4],
            [0, 4],
            [0, 4],
            [1, 2],
            [10, 2],
            [0, 1],
            [0, 1]
        )
    const second = pixels(200)
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', numbers([width, 4], [height, 4], [8, 1], [2, 1], [0, 1], [0, 1], [0, 1])),
        pngChunk('acTL', numbers([2, 4], [0, 4])),
        pngChunk('fcTL', frame(0)),
        pngChunk('IDAT', pixels(20)),
        pngChunk('fcTL', frame(1)),
        pngChunk('fdAT', new Uint8Array([...numbers([2, 4]), ...second])),
        pngChunk('IEND', new Uint8Array(0))
    ]
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let at = 0
    for (const part of parts) {
        out.set(part, at)
        at += part.length
    }
    return out
}

describe('the variants of an image', () => {
    test('are WebP files of the width and the height of each variant', async () => {
        const image = {
            key: 'k',
            name: 'cover.jpg',
            variants: imageVariants('cover.jpg', 1000, 1500)
        }
        const files = await encodeVariants(await jpeg(1000, 1500), image)

        expect(files).toHaveLength(3)
        const sizes = await Promise.all(
            files.map(async (bytes) => {
                const facts = await sharp(bytes).metadata()
                return [facts.format, facts.width, facts.height]
            })
        )
        expect(sizes).toEqual([
            ['webp', 480, 720],
            ['webp', 800, 1200],
            ['webp', 1000, 1500]
        ])
    })

    // The manifest gives the size of a turned photo as it shows (images.ts).
    test('turn a photo as its Exif says, as the size of the manifest does, and keep no Exif', async () => {
        const image = {
            key: 'k',
            name: 'photo.jpg',
            variants: imageVariants('photo.jpg', 600, 1000)
        }
        const files = await encodeVariants(await jpeg(1000, 600, 6), image)
        const facts = await Promise.all(files.map((bytes) => sharp(bytes).metadata()))

        expect(facts.map((fact) => [fact.width, fact.height])).toEqual([
            [480, 800],
            [600, 1000]
        ])
        expect(facts.map((fact) => fact.exif)).toEqual([undefined, undefined])
    })

    // Issue 87, R92: the plugin reads the turn of a JPEG only, so the size of
    // the manifest of any other kind is the size of its pixels as stored.
    // Review round 3: the plugin reads the turn of a JPEG only, so a PNG or a
    // WebP that has one would get variants of another shape than its page.
    test('refuse a PNG and a WebP with an Exif turn; keep one with no turn, and the frames of one that moves', async () => {
        const variants = imageVariants('plan.png', 1000, 600)
        expect(await rejectionOf(encodeVariants(await png(1000, 600, 6), { variants }))).toContain(
            'Exif turn'
        )
        expect(
            await rejectionOf(
                encodeVariants(await animated(1000, 600, 6), {
                    variants: imageVariants('moving.webp', 1000, 600)
                })
            )
        ).toContain('Exif turn')
        const fromPng = await encodeVariants(await png(1000, 600, 1), { variants })
        const facts = await Promise.all(fromPng.map((bytes) => sharp(bytes).metadata()))
        expect(facts.map((fact) => [fact.width, fact.height])).toEqual([
            [480, 288],
            [800, 480],
            [1000, 600]
        ])

        const moving = await encodeVariants(await animated(1000, 600), {
            variants: imageVariants('moving.webp', 1000, 600)
        })
        const frames = await Promise.all(
            moving.map((bytes) => sharp(bytes, { animated: true }).metadata())
        )
        expect(frames.map((fact) => [fact.width, fact.pageHeight, fact.pages])).toEqual([
            [480, 288, 2],
            [800, 480, 2],
            [1000, 600, 2]
        ])
    })

    // Review round 3: the kind comes from the bytes, not from the end of the name.
    test('refuse a file of another kind than JPEG, PNG and WebP, whatever its name says', async () => {
        const gif = new Uint8Array(
            await sharp({
                create: { width: 1000, height: 600, channels: 3, background: '#468' }
            })
                .gif()
                .toBuffer()
        )

        expect(
            await rejectionOf(
                encodeVariants(gif, { variants: imageVariants('photo.jpg', 1000, 600) })
            )
        ).toContain('gif')
    })

    // Review round 3: a sharp that cannot load is a failure of one image.
    test('fail, and throw nothing at their import, when sharp cannot load', async () => {
        const variants = imageVariants('cover.jpg', 1000, 600)
        const load = (): Promise<never> => Promise.reject(new Error('sharp has no binary here'))
        const error = await encodeVariants(await jpeg(1000, 600), { variants }, load).catch(
            (failure: unknown) => failure
        )

        expect(error).toBeInstanceOf(EncoderUnavailableError)
        expect(String(error)).toContain('sharp has no binary here')
    })

    // The last look: the plugin reads an animated PNG as a PNG, and sharp would
    // keep its first frame only; the page keeps the file that moves.
    test('refuse an animated PNG', async () => {
        const variants = imageVariants('moving.png', 600, 400)

        expect(await rejectionOf(encodeVariants(apng(600, 400), { variants }))).toContain('moves')
        expect(await encodeVariants(await png(600, 400), { variants })).toHaveLength(2)
    })

    test('fail on a cut JPEG and a cut PNG', async () => {
        const variants = imageVariants('cover.jpg', 1000, 600)
        const cut = (bytes: Uint8Array): Uint8Array => bytes.subarray(0, bytes.length >> 1)

        expect(
            await rejectionOf(encodeVariants(cut(await jpeg(1000, 600)), { variants }))
        ).toContain('JPEG')
        expect(
            await rejectionOf(encodeVariants(cut(await png(1000, 600)), { variants }))
        ).toContain('png')
    })

    test('fail on an image of more than 50 megapixels, before its pixels are read', async () => {
        const variants = imageVariants('huge.png', 1000, 600)
        const error = await encodeVariants(await pngHeader(8_000, 8_000), { variants }).catch(
            (failure: unknown) => failure
        )

        expect(error).toBeInstanceOf(TooManyPixelsError)
    })

    // Review round 2: an image that moves holds the pixels of all its frames.
    test('fail on an image that moves whose frames have more than 50 megapixels together', async () => {
        const frames = await Promise.all(
            Array.from({ length: 13 }, (_, index) =>
                sharp({
                    create: {
                        width: 2_000,
                        height: 2_000,
                        channels: 3,
                        background: { r: index * 15, g: 0, b: 0 }
                    }
                })
                    .png()
                    .toBuffer()
            )
        )
        const moving = new Uint8Array(
            await sharp(frames, { join: { animated: true } })
                .webp({ effort: 0 })
                .toBuffer()
        )
        const variants = imageVariants('moving.webp', 2_000, 2_000)
        const error = await encodeVariants(moving, { variants }).catch(
            (failure: unknown) => failure
        )

        expect(error).toBeInstanceOf(TooManyPixelsError)
    }, 30_000)

    test('fail on a file that is not an image', async () => {
        const image = {
            key: 'k',
            name: 'cover.jpg',
            variants: imageVariants('cover.jpg', 1000, 1500)
        }

        expect(await rejectionOf(encodeVariants(new Uint8Array([1, 2, 3]), image))).not.toBe('')
    })

    test('are written into a folder under their names, and an image whose variants are there is not read again', async () => {
        await mkdir(CACHE, { recursive: true })
        const folder = await mkdtemp(join(CACHE, 'image-variants-'))
        try {
            const bytes = await jpeg(900, 600)
            const image = {
                key: 'a'.repeat(64),
                name: 'plan.jpg',
                width: 900,
                height: 600,
                variants: imageVariants('plan.jpg', 900, 600)
            }
            const reads: string[] = []
            const read = (key: string): Promise<Uint8Array> => {
                reads.push(key)
                return Promise.resolve(bytes)
            }
            await writeVariants([image], read, folder)
            expect((await readdir(folder)).sort()).toEqual(
                [
                    variantKey(image.key, 480),
                    variantKey(image.key, 800),
                    variantKey(image.key, 1200)
                ].sort()
            )
            await writeFile(join(folder, variantKey(image.key, 480)), 'kept')
            await writeVariants([image], read, folder)
            expect(reads).toEqual([image.key])
        } finally {
            await rm(folder, { recursive: true, force: true })
        }
    })
})
