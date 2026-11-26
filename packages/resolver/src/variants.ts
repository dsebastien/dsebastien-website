// The variants of an image (issue 87, PERF-25): smaller copies of an image of
// a note in WebP, which a page offers with `srcset` so that a phone loads the
// size that its screen needs. The deploy on the machine that publishes makes
// them from the file of the image and puts them into the attachment storage
// beside it (`apps/site/worker/release.ts`); the build writes their addresses
// from the width and the height of the manifest, so it reads no image; the
// resolver gives a variant only of an image that the release uses.
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
 * The generation of the variants: it is in every name and every address of a
 * variant, so a change of the way they are made (format, quality) gives new
 * addresses. An address of an attachment is kept for a year (URL-15). Raise
 * it with every change of `encodeVariants()` of `apps/site/worker/image-variants.ts`.
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

const KEY = /^[0-9a-f]{64}$/u

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
 * for a kind that gets none, and none for an image of `VARIANT_WIDTHS[0]`
 * pixels or less.
 */
export function imageVariants(name: string, width: number, height: number): ImageVariant[] {
    const smallest = VARIANT_WIDTHS[0]
    if (!hasVariants(name) || !(width > smallest) || !(height > 0)) {
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
function tagOf(step: number): string {
    return nameTag(step, VARIANT_GENERATION)
}

/** The name in the attachment storage of a variant of the image of this key. */
export function variantKey(key: string, step: VariantStep): string {
    if (!KEY.test(key)) {
        throw new Error(`"${key}" is not the key of an attachment`)
    }
    return `${key}-${tagOf(step)}.webp`
}

/**
 * The names in the attachment storage of the variants that the image of this
 * key can have: each width of each generation up to this one. A deletion
 * that does not list the storage deletes them all with the image.
 */
export function variantKeysOf(key: string): string[] {
    if (!KEY.test(key)) {
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

function nameTag(step: number, generation: number): string {
    return `w${String(step)}-${String(generation)}`
}

const VARIANT_NAME = /^([0-9a-f]{64})-w([1-9]\d*)-([1-9]\d*)\.webp$/u

/**
 * The key of the image that a name of the attachment storage belongs to:
 * the name itself for the file of an image (any attachment), the key of its
 * image for a variant of this generation or of an older one, `undefined`
 * for any other name. A variant always follows its image: it leaves the
 * storage with it, and stays while a release keeps it.
 */
export function imageKeyOf(name: string): string | undefined {
    if (KEY.test(name)) {
        return name
    }
    const match = VARIANT_NAME.exec(name)
    return match !== null && Number(match[3]) <= VARIANT_GENERATION ? match[1] : undefined
}

/** The name of a variant file: the name of the image without its end, then `.webp`. */
function variantName(name: string): string {
    const dot = name.lastIndexOf('.')
    return `${dot > 0 ? name.slice(0, dot) : name}.webp`
}

const ATTACHMENT_ADDRESS = /^\/-\/attachments\/([0-9a-f]{64})\/([^/]+)$/u

/**
 * The address of a variant of an image, from the hashed address of the image
 * (`attachmentPath()`): `/-/attachments/<key>/w800-1/<name>.webp`.
 */
export function variantPath(imagePath: string, step: VariantStep): string {
    const match = ATTACHMENT_ADDRESS.exec(imagePath)
    const key = match?.[1]
    const name = match?.[2]
    if (key === undefined || name === undefined) {
        throw new Error(`"${imagePath}" is not the address of an attachment`)
    }
    return `/-/attachments/${key}/${tagOf(step)}/${encodeURIComponent(variantName(decodeURIComponent(name)))}`
}

/** The addresses of the variants of each image of an attachment map, by the address of the variant. */
const variantMaps = new WeakMap<object, Map<string, { key: string; name: string }>>()

/**
 * The variant of an image of the release at this address: its name in the
 * attachment storage and its file name. `undefined` when the address is no
 * variant of an image of `attachments` (the hashed addresses of the release
 * and their keys).
 */
export function variantAt(
    path: string,
    attachments: Readonly<Record<string, string>>
): { key: string; name: string } | undefined {
    let variants = variantMaps.get(attachments)
    if (variants === undefined) {
        variants = new Map()
        for (const [address, key] of Object.entries(attachments)) {
            const match = ATTACHMENT_ADDRESS.exec(address)
            const encoded = match?.[2]
            if (match?.[1] !== key || encoded === undefined) continue
            const name = decodeURIComponent(encoded)
            if (!hasVariants(name)) continue
            for (const step of VARIANT_WIDTHS) {
                variants.set(variantPath(address, step), {
                    key: variantKey(key, step),
                    name: variantName(name)
                })
            }
        }
        variantMaps.set(attachments, variants)
    }
    return variants.get(path)
}
