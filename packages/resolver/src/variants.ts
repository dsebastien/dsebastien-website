import { isAttachmentKey } from './url.ts'

// The variants of an image (issue 87, PERF-25, R92): smaller copies of an
// image of a note in WebP, which a page offers with `srcset` so that a phone
// loads the size that its screen needs. The deploy on the machine that
// publishes makes them from the file of the image and puts them into the
// attachment storage beside it (`apps/site/worker/release.ts`); the build
// writes their addresses from the width and the height of the manifest, so it
// reads no image; the resolver gives a variant only of an image that the
// release uses, and a host gives the file of the image when the storage
// lacks the variant.
//
// A variant is a file derived from its image: it follows every rule of its
// image (the guards, a takedown, the withdrawn files, the cleanup, a revert).
// The deploy reaches that by the key of the image, which each name of a
// variant holds (`imageKeyOf()`).

/** The kinds of the images that get variants, by the end of their names. An SVG, a GIF (it can move) and any other kind keep only their file. */
const SOURCES = new Set(['jpeg', 'jpg', 'png', 'webp'])

/**
 * The widths of the variants, in pixels, the smallest first. An image gets
 * each width below its own, and the first width at or above its own is its
 * whole size in WebP. An image that is not wider than the first width gets
 * no variant: it is small already.
 */
export const VARIANT_WIDTHS = [480, 800, 1200, 1600] as const

/**
 * The most pixels of an image that gets variants: 50 million. A larger image
 * keeps only its file, so the machine that publishes never holds its pixels.
 */
export const MAX_VARIANT_PIXELS = 50_000_000

/**
 * The generation of the variants: it is in every name and every address of a
 * variant, so a change of the way they are made (format, quality) gives new
 * addresses. An address of an attachment is kept for a year (URL-15). Raise
 * it with every change of `encodeVariants()` of `apps/site/worker/image-variants.ts`.
 * The deployment record of a release names its generation, so the cleanup
 * keeps the variants that the release before uses.
 */
export const VARIANT_GENERATION = 1

/** The width that a variant is made for, one of `VARIANT_WIDTHS`. */
export type VariantStep = (typeof VARIANT_WIDTHS)[number]

/** A variant of an image. */
export interface ImageVariant {
    /** The width of `VARIANT_WIDTHS` that it is made for: it names the variant. */
    readonly step: VariantStep
    /** Its width in pixels: the step, or the width of the image when the image is narrower. */
    readonly width: number
    /** Its height in pixels, in the shape of the image. */
    readonly height: number
}

/** The end of a name in small letters, without its dot. */
function endOf(name: string): string {
    const dot = name.lastIndexOf('.')
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** True when an image of this name gets variants (by its kind). */
export function hasVariants(name: string): boolean {
    return SOURCES.has(endOf(name))
}

/**
 * The variants of an image of this name and size, the smallest first: none
 * for a kind that gets none, none for an image of `VARIANT_WIDTHS[0]` pixels
 * or less, and none for an image of more than `MAX_VARIANT_PIXELS`.
 */
export function imageVariants(name: string, width: number, height: number): ImageVariant[] {
    const smallest = VARIANT_WIDTHS[0]
    if (
        !hasVariants(name) ||
        !(width > smallest) ||
        !(height > 0) ||
        width * height > MAX_VARIANT_PIXELS
    ) {
        return []
    }
    const variants: ImageVariant[] = []
    for (const step of VARIANT_WIDTHS) {
        if (step < width) {
            variants.push({
                step,
                width: step,
                height: Math.max(1, Math.round((step * height) / width))
            })
        } else {
            variants.push({ step, width, height })
            break
        }
    }
    return variants
}

/** The part of a name or an address that says which variant it is: `w800-1`. */
function nameTag(step: number, generation = VARIANT_GENERATION): string {
    return `w${String(step)}-${String(generation)}`
}

/** The name in the attachment storage of a variant of the image of this key. */
export function variantKey(key: string, step: VariantStep): string {
    if (!isAttachmentKey(key)) {
        throw new Error(`"${key}" is not the key of an attachment`)
    }
    return `${key}-${nameTag(step)}.webp`
}

/**
 * The names in the attachment storage of the variants that the image of this
 * key can have: each width of each generation up to this one. A deletion
 * that does not list the storage deletes them all with the image; a list of
 * the storage finds any other (`imageKeyOf()`).
 */
export function variantKeysOf(key: string): string[] {
    if (!isAttachmentKey(key)) {
        throw new Error(`"${key}" is not the key of an attachment`)
    }
    const names: string[] = []
    for (let generation = 1; generation <= VARIANT_GENERATION; generation += 1) {
        for (const step of VARIANT_WIDTHS) {
            names.push(`${key}-${nameTag(step, generation)}.webp`)
        }
    }
    return names
}

const VARIANT_NAME = /^([0-9a-f]{64})-w([1-9]\d*)-([1-9]\d*)\.webp$/u

/**
 * The generation of a name of the attachment storage that is a variant (of
 * any generation and any width); `undefined` for any other name.
 */
export function variantGenerationOf(name: string): number | undefined {
    const generation = VARIANT_NAME.exec(name)?.[3]
    return generation === undefined ? undefined : Number(generation)
}

/**
 * The key of the image that a name of the attachment storage belongs to:
 * the name itself for the file of an image (any attachment), the key of its
 * image for a variant of any generation (an older one, and a newer one of
 * another clone), `undefined` for any other name. A variant always leaves
 * the storage with its image.
 */
export function imageKeyOf(name: string): string | undefined {
    return isAttachmentKey(name) ? name : VARIANT_NAME.exec(name)?.[1]
}

const ATTACHMENT_ADDRESS = /^\/-\/attachments\/([0-9a-f]{64})\/([^/]+)$/u

/**
 * The address of a variant of an image, from the hashed address of the image
 * (`attachmentPath()`): `/-/attachments/<key>/w800-1/<name of the image>.webp`.
 * It holds the address of its image, so the resolver finds the image with
 * one lookup of the map.
 */
export function variantPath(imagePath: string, step: VariantStep): string {
    const match = ATTACHMENT_ADDRESS.exec(imagePath)
    const key = match?.[1]
    const name = match?.[2]
    if (key === undefined || name === undefined) {
        throw new Error(`"${imagePath}" is not the address of an attachment`)
    }
    return `/-/attachments/${key}/${nameTag(step)}/${name}.webp`
}

const VARIANT_ADDRESS = /^\/-\/attachments\/([0-9a-f]{64})\/w([1-9]\d*)-([1-9]\d*)\/([^/]+)\.webp$/u

/** A variant of an image of a release, as the resolver gives it. */
export interface VariantFile {
    /** The name of the variant in the attachment storage. */
    readonly key: string
    /** Its file name, which gives its kind (`.webp`). */
    readonly name: string
    /** The file of its image, which a host gives when the storage lacks the variant. */
    readonly image: { readonly key: string; readonly name: string }
}

/**
 * The variant of an image of the release at this address. `undefined` when
 * the address is no variant of this generation, of a width of
 * `VARIANT_WIDTHS`, of an image with variants of `attachments` (the hashed
 * addresses of the release and their keys).
 */
export function variantAt(
    path: string,
    attachments: Readonly<Record<string, string>>
): VariantFile | undefined {
    const match = VARIANT_ADDRESS.exec(path)
    if (match === null) {
        return undefined
    }
    const [, key = '', step = '', generation = '', encoded = ''] = match
    const image = `/-/attachments/${key}/${encoded}`
    if (
        Number(generation) !== VARIANT_GENERATION ||
        !(VARIANT_WIDTHS as readonly number[]).includes(Number(step)) ||
        !Object.hasOwn(attachments, image) ||
        attachments[image] !== key
    ) {
        return undefined
    }
    // The map holds only addresses that the build wrote, so the name decodes.
    const name = decodeURIComponent(encoded)
    if (!hasVariants(name)) {
        return undefined
    }
    return {
        key: `${key}-${nameTag(Number(step))}.webp`,
        name: `${name}.webp`,
        image: { key, name }
    }
}
