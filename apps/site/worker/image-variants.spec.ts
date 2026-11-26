import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageVariants, variantKey } from '@dsebastien-website/resolver'
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
