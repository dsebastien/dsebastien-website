// The size of an image, from the first bytes of its file (documentation/
// Canonical Form.md, section "The attachments of a note", rule 5). The page
// sets the width and the height of an image from the manifest, so the build
// reads no image (PERF-25). The Rust twin is `cli/src/images.rs`. Change both
// in the same commit.

/** The width and the height of an image, in pixels. */
export interface ImageSize {
    readonly width: number
    readonly height: number
}

/** The bytes of a file, read with bounds: a read outside the file gives `undefined`. */
class Bytes {
    readonly #bytes: Uint8Array

    constructor(bytes: Uint8Array) {
        this.#bytes = bytes
    }

    get length(): number {
        return this.#bytes.length
    }

    byte(at: number): number | undefined {
        return at >= 0 && at < this.#bytes.length ? this.#bytes[at] : undefined
    }

    /** A number of `count` bytes, the high byte first (BE) or the low byte first (LE). */
    number(at: number, count: number, littleEndian: boolean): number | undefined {
        let value = 0
        for (let index = 0; index < count; index += 1) {
            const byte = this.byte(littleEndian ? at + count - 1 - index : at + index)
            if (byte === undefined) {
                return undefined
            }
            value = value * 256 + byte
        }
        return value
    }

    /** True when the bytes at this place are the ASCII codes of the text. */
    is(at: number, text: string): boolean {
        for (let index = 0; index < text.length; index += 1) {
            if (this.byte(at + index) !== text.charCodeAt(index)) {
                return false
            }
        }
        return true
    }
}

/** A size whose two numbers are whole numbers above 0, else no size. */
function sized(width: number | undefined, height: number | undefined): ImageSize | undefined {
    return width !== undefined && height !== undefined && width > 0 && height > 0
        ? { width, height }
        : undefined
}

const PNG = '\x89PNG\r\n\x1a\n'

function webpSize(bytes: Bytes): ImageSize | undefined {
    if (bytes.is(12, 'VP8 ')) {
        if (!bytes.is(23, '\x9d\x01\x2a')) {
            return undefined
        }
        const width = bytes.number(26, 2, true)
        const height = bytes.number(28, 2, true)
        return width === undefined || height === undefined
            ? undefined
            : sized(width & 0x3fff, height & 0x3fff)
    }
    if (bytes.is(12, 'VP8L')) {
        const bits = bytes.byte(20) === 0x2f ? bytes.number(21, 4, true) : undefined
        return bits === undefined
            ? undefined
            : sized((bits % 0x4000) + 1, (Math.floor(bits / 0x4000) % 0x4000) + 1)
    }
    if (bytes.is(12, 'VP8X')) {
        const width = bytes.number(24, 3, true)
        const height = bytes.number(27, 3, true)
        return width === undefined || height === undefined
            ? undefined
            : sized(width + 1, height + 1)
    }
    return undefined
}

/**
 * True when the Exif segment of a JPEG says that the image is turned by a
 * quarter: a TIFF block with the tag of the rotation, of type 3 and count 1,
 * with a value from 5 to 8. A block that is cut, or that has another form,
 * says nothing. The data of the segment starts at `start` and ends before
 * `end`, after the 6 bytes `Exif`, 0, 0.
 */
function quarterTurn(bytes: Bytes, start: number, end: number): boolean {
    const tiff = start + 6
    const little = bytes.is(tiff, 'II') ? true : bytes.is(tiff, 'MM') ? false : undefined
    if (little === undefined) {
        return false
    }
    // Every read stays inside the segment: a block that is cut says nothing.
    const read = (at: number, count: number): number | undefined =>
        at + count <= end ? bytes.number(at, count, little) : undefined
    if (read(tiff + 2, 2) !== 42) {
        return false
    }
    const offset = read(tiff + 4, 4)
    const list = offset === undefined ? undefined : tiff + offset
    const count = list === undefined ? undefined : read(list, 2)
    if (list === undefined || count === undefined) {
        return false
    }
    for (let index = 0; index < count; index += 1) {
        const tag = list + 2 + index * 12
        if (read(tag, 2) === 0x0112) {
            const value =
                read(tag + 2, 2) === 3 && read(tag + 4, 4) === 1 ? read(tag + 8, 2) : undefined
            return value !== undefined && value >= 5 && value <= 8
        }
    }
    return false
}

function jpegSize(bytes: Bytes): ImageSize | undefined {
    let at = 2
    let turned: boolean | undefined
    for (;;) {
        if (bytes.byte(at) !== 0xff) {
            return undefined
        }
        while (bytes.byte(at) === 0xff) {
            at += 1
        }
        const marker = bytes.byte(at)
        if (marker === undefined || marker === 0xd9 || marker === 0xda) {
            return undefined
        }
        at += 1
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue
        }
        const length = bytes.number(at, 2, false)
        if (length === undefined || length < 2) {
            return undefined
        }
        if (
            marker >= 0xc0 &&
            marker <= 0xcf &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc
        ) {
            const height = bytes.number(at + 3, 2, false)
            const width = bytes.number(at + 5, 2, false)
            return turned === true ? sized(height, width) : sized(width, height)
        }
        // Only the first Exif segment counts.
        if (marker === 0xe1 && turned === undefined && bytes.is(at + 2, 'Exif\0\0')) {
            turned = quarterTurn(bytes, at + 2, at + length)
        }
        at += length
    }
}

/**
 * The width and the height of an image, from the first bytes of its file,
 * whatever its name says: PNG, GIF, WebP and JPEG (with the rotation flag of
 * a photo). `undefined` for every other file, and for a file that is cut.
 */
export function imageSize(file: Uint8Array): ImageSize | undefined {
    const bytes = new Bytes(file)
    if (bytes.is(0, PNG)) {
        return bytes.is(12, 'IHDR')
            ? sized(bytes.number(16, 4, false), bytes.number(20, 4, false))
            : undefined
    }
    if (bytes.is(0, 'GIF87a') || bytes.is(0, 'GIF89a')) {
        return sized(bytes.number(6, 2, true), bytes.number(8, 2, true))
    }
    if (bytes.is(0, 'RIFF') && bytes.is(8, 'WEBP')) {
        return webpSize(bytes)
    }
    if (bytes.byte(0) === 0xff && bytes.byte(1) === 0xd8) {
        return jpegSize(bytes)
    }
    return undefined
}
