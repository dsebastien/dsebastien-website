import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import sharp from 'sharp'
import { imageSize } from '../../../apps/plugin/src/publishing/images.ts'
import {
    BUDGET_SAMPLE,
    BUDGET_SAMPLE_BACKLINKS,
    BUDGET_SAMPLE_FOLDER,
    samplePhoto,
    samplePng,
    writeBudgetSample
} from './budget-sample.ts'
import { makeTestStores, type TestStores } from './test-stores.ts'

// The budget sample of issue 47: invented notes with the shape of the large
// published notes, written the same way at each run.

const made: TestStores[] = []

async function sample(seed?: number): Promise<string> {
    const stores = await makeTestStores()
    made.push(stores)
    const vault = join(stores.root, 'vault')
    await writeBudgetSample(vault, seed)
    return vault
}

/** The SHA-256 of every file of a folder, by its path. */
async function hashes(folder: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const path = join(entry.parentPath, entry.name)
        result[path.slice(folder.length)] = createHash('sha256')
            .update(await readFile(path))
            .digest('hex')
    }
    return result
}

afterAll(async () => {
    for (const stores of made) {
        await stores.remove()
    }
})

describe('the budget sample', () => {
    test('is the same at each run for one seed, and another for another seed', async () => {
        const one = await hashes(await sample())
        const two = await hashes(await sample())
        const other = await hashes(await sample(26))

        expect(two).toEqual(one)
        expect(other).not.toEqual(one)
    }, 60_000)

    test('has the shape of the large published notes', async () => {
        const vault = await sample()
        const long = await readFile(join(vault, BUDGET_SAMPLE.long), 'utf8')
        const media = await readFile(join(vault, BUDGET_SAMPLE.media), 'utf8')

        expect(long.length).toBeGreaterThan(20_000)
        expect(long.match(/^#{2,3} /gmu)).toHaveLength(24)
        expect(long.match(/\[\[[^\]]+\]\]/gu)?.length).toBeGreaterThanOrEqual(60)
        expect(media.indexOf('![[cover.jpg]]')).toBeLessThan(media.indexOf('## My notes'))
        const linking = await readdir(join(vault, BUDGET_SAMPLE_FOLDER, 'Linking'))
        expect(linking).toHaveLength(BUDGET_SAMPLE_BACKLINKS)
    }, 30_000)

    test('has images of the size of a photo, that the tool reads with their width and height', async () => {
        const vault = await sample()
        const cover = new Uint8Array(
            await readFile(join(vault, BUDGET_SAMPLE_FOLDER, 'Files/cover.jpg'))
        )

        expect(cover.length).toBe(142_000)
        expect(imageSize(cover)).toEqual({ width: 1000, height: 1500 })
    }, 30_000)
})

// Issue 87: the variants of an image are only as small as its pixels let
// them be, so the images of the sample have the detail of a photo.
describe('a photo of the sample', () => {
    test('is a JPEG of its size and bytes, almost all of them image data', async () => {
        const photo = await samplePhoto(600, 400, 40_000, 1)
        const facts = await sharp(photo).metadata()

        expect([facts.format, facts.width, facts.height]).toEqual(['jpeg', 600, 400])
        expect(photo.length).toBe(40_000)
        // Without its comment, the image data alone is near the size.
        const data = await sharp(photo).jpeg({ quality: 100 }).toBuffer()
        expect(data.length).toBeGreaterThan(30_000)
    })

    test('keeps much of its size in WebP, as a photo does', async () => {
        const photo = await samplePhoto(1000, 1500, 142_000, 25)
        const webp = await sharp(photo).resize(800).webp({ quality: 75 }).toBuffer()

        expect(webp.length).toBeGreaterThan(20_000)
    })

    test('is the same at each run for one seed', async () => {
        expect(await samplePhoto(300, 200, 10_000, 3)).toEqual(
            await samplePhoto(300, 200, 10_000, 3)
        )
    })
})

describe('a PNG of the sample', () => {
    test('is a valid PNG: its image data inflates to one filtered row per line', () => {
        const png = samplePng(3, 2, 500, 1)
        const view = new DataView(png.buffer)
        // The signature, then IHDR (13 bytes), then IDAT.
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const idatLength = view.getUint32(33)
        expect(new TextDecoder().decode(png.subarray(37, 41))).toBe('IDAT')
        const raw = inflateSync(png.subarray(41, 41 + idatLength))
        expect(raw.length).toBe(2 * (1 + 3 * 3))
        expect(png.length).toBe(500)
        expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe('IEND')
    })

    test('has a valid checksum on each chunk, as a browser checks it', () => {
        const png = samplePng(3, 2, 500, 1)
        const view = new DataView(png.buffer)
        let at = 8
        while (at < png.length) {
            const length = view.getUint32(at)
            const crc = view.getUint32(at + 8 + length)
            expect(crc).toBe(Bun.hash.crc32(png.subarray(at + 4, at + 8 + length)))
            at += 12 + length
        }
        expect(at).toBe(png.length)
    })
})
