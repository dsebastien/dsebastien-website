import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { variantKey } from '@dsebastien-website/resolver'
import sharp from 'sharp'
import type { ReleaseImage } from './deployment.ts'

// The making of the variants of an image (issue 87, PERF-25), on the machine
// that publishes: the deploy calls it for each variant that the attachment
// storage lacks (the port `encode` of `release.ts`), and the local tools
// (`bun run budgets`, `bun run site:fixture`) write them into a folder that
// the plain server reads. Never in the Worker.
//
// WebP, lossy at quality 75 with the effort 4 of libwebp (sharp): the three
// variants of the cover of the budget sample take 130 ms, and AVIF saves 13
// to 20 % for two to four times the time
// (`documentation/research/2026-11-26-image-variants.md`). A change here
// gives other bytes at the same address: raise `VARIANT_GENERATION` of
// `packages/resolver/src/variants.ts` with it.

/** The quality of libwebp, 0 to 100. */
const QUALITY = 75

/** The effort of libwebp, 0 (fast) to 6 (small). */
const EFFORT = 4

/**
 * The variants of an image from the bytes of its file, in the order of its
 * variants: each turned as its Exif says (as the size of the manifest), of
 * its width and height, in WebP, without the metadata of the file. An image
 * that moves (a WebP with frames) keeps its frames. It throws on a file that
 * is not an image.
 */
export async function encodeVariants(
    bytes: Uint8Array,
    image: Pick<ReleaseImage, 'variants'>
): Promise<Uint8Array[]> {
    const source = sharp(bytes, { animated: true, failOn: 'error' }).rotate()
    return await Promise.all(
        image.variants.map(
            async (variant) =>
                new Uint8Array(
                    await source
                        .clone()
                        .resize(variant.width, variant.height, { fit: 'fill' })
                        .webp({ quality: QUALITY, effort: EFFORT })
                        .toBuffer()
                )
        )
    )
}

/**
 * Writes the variants of the images into a folder, under their names in the
 * attachment storage, for the plain server. An image whose variants are all
 * in the folder is not read again.
 *
 * @param read gives the bytes of the file of a key
 */
export async function writeVariants(
    images: readonly ReleaseImage[],
    read: (key: string) => Promise<Uint8Array>,
    folder: string
): Promise<void> {
    await mkdir(folder, { recursive: true })
    const exists = async (name: string): Promise<boolean> =>
        await stat(join(folder, name)).then(
            () => true,
            () => false
        )
    for (const image of images) {
        const names = image.variants.map((variant) => variantKey(image.key, variant.step))
        const present = await Promise.all(names.map(exists))
        if (present.every(Boolean)) continue
        const files = await encodeVariants(await read(image.key), image)
        for (const [index, name] of names.entries()) {
            const bytes = files[index]
            if (bytes === undefined || present[index] === true) continue
            // Complete or absent: written under another name first.
            const part = join(folder, `.${name}.part`)
            try {
                await writeFile(part, bytes)
                await rename(part, join(folder, name))
            } finally {
                await rm(part, { force: true })
            }
        }
    }
}
