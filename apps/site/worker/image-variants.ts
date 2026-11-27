import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    isAttachmentKey,
    MAX_VARIANT_PIXELS,
    TooManyPixelsError,
    variantKey
} from '@dsebastien-website/resolver'
import sharp, { type Sharp } from 'sharp'
import { releaseImages, type ReleaseImage } from './deployment.ts'
import type { AttachmentFolder } from './release.ts'

// The making of the variants of an image (issue 87, PERF-25), on the machine
// that publishes: the deploy calls it for each variant that the attachment
// storage lacks (the port `encode` of `release.ts`, and `bun run variants`),
// and the local tools (`bun run budgets`, `bun run site:fixture`) write them
// into a folder that the plain server reads. Never in the Worker.
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

/** How sharp reads an image: every frame, a cut file fails, and at most `MAX_VARIANT_PIXELS`. */
const INPUT = {
    animated: true,
    failOn: 'truncated',
    limitInputPixels: MAX_VARIANT_PIXELS
} as const

/** The output of a variant. */
const webp = (image: Sharp): Sharp => image.webp({ quality: QUALITY, effort: EFFORT })

/**
 * The variants of an image from the bytes of its file, in the order of its
 * variants: each of its width and height, in WebP, without the metadata of
 * the file. A JPEG is turned as its Exif says, as the plugin reads its size
 * for the manifest; no other kind is (the plugin reads its size as stored),
 * and an image that moves (a WebP with frames) keeps its frames. The image is
 * read and resized one time, to the largest variant, and the others are made
 * from that one, so the pixels of the image are in memory one time. It throws
 * on a file that is not an image, a cut file, and an image of more than
 * `MAX_VARIANT_PIXELS`, all its frames together (`TooManyPixelsError`,
 * before its pixels are read).
 */
export async function encodeVariants(
    bytes: Uint8Array,
    image: Pick<ReleaseImage, 'variants'>
): Promise<Uint8Array[]> {
    const largest = image.variants.at(-1)
    if (largest === undefined) {
        return []
    }
    // The header only: the pixels of every frame count (review round 2).
    const facts = await sharp(bytes, { ...INPUT, limitInputPixels: false }).metadata()
    const frames = facts.pages ?? 1
    if (facts.width * (facts.pageHeight ?? facts.height) * frames > MAX_VARIANT_PIXELS) {
        throw new TooManyPixelsError()
    }
    const read = sharp(bytes, INPUT)
    const source = facts.format === 'jpeg' && frames === 1 ? read.rotate() : read
    const resized = source.resize(largest.width, largest.height, { fit: 'fill' })
    if (frames > 1) {
        // The frames of the largest variant make the smaller ones.
        const top = await webp(resized).toBuffer()
        return await Promise.all(
            image.variants.map(async (variant) =>
                variant === largest
                    ? new Uint8Array(top)
                    : new Uint8Array(
                          await webp(
                              sharp(top, { animated: true }).resize(variant.width, variant.height, {
                                  fit: 'fill'
                              })
                          ).toBuffer()
                      )
            )
        )
    }
    // The pixels of the largest variant, with no loss, make every variant.
    const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true })
    const raw = { width: info.width, height: info.height, channels: info.channels }
    return await Promise.all(
        image.variants.map(
            async (variant) =>
                new Uint8Array(
                    await webp(
                        variant === largest
                            ? sharp(data, { raw })
                            : sharp(data, { raw }).resize(variant.width, variant.height, {
                                  fit: 'fill'
                              })
                    ).toBuffer()
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

/**
 * The attachment folder of this machine (`<folder>/<key>`), as a deployment
 * reads it. Without a folder (a dry run), every read throws.
 */
export function attachmentFolder(folder: string | undefined): AttachmentFolder {
    const pathOf = (key: string): string => {
        if (folder === undefined || !isAttachmentKey(key)) {
            throw new Error(`"${key}" is not a key of the attachment storage`)
        }
        return join(folder, key)
    }
    return {
        exists: async (key) => (await stat(pathOf(key)).catch(() => undefined))?.isFile() === true,
        size: async (key) => (await stat(pathOf(key))).size,
        read: async (key) => new Uint8Array(await readFile(pathOf(key)))
    }
}

/**
 * Writes the variants of the images of the published notes of a content
 * store into a folder for the plain server, from an attachment folder
 * (`bun run budgets`, `bun run site:fixture`).
 */
export async function writeReleaseVariants(
    contentStore: string,
    attachments: string,
    folder: string
): Promise<void> {
    const files = attachmentFolder(attachments)
    await writeVariants(await releaseImages(contentStore), (key) => files.read(key), folder)
}
