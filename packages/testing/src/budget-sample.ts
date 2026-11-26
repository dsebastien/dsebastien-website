import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import sharp from 'sharp'

// The budget sample (issue 47, PERF-22): invented notes at the 99th percentile
// of the published notes of the author, to check the budgets of the note page
// on pages as large as his large pages (issue 25, R57, the shape is in
// `documentation/research/2026-11-20-note-page-budgets.md`):
//
// - a long note: about 23 KB of Markdown, 24 headings, 64 links, 4 images of
//   80 KB (90th percentile);
// - a media note: a cover of 142 KB (about the 95th percentile) first, then
//   notes, highlights and three images of 80 KB;
// - a hub note with 489 backlinks, the largest count of the published notes.
//
// Every word is invented, and the same seed gives the same bytes (with one
// version of sharp). The images are invented photos (issue 87): JPEG files
// of noise at several scales, with the detail of a photo, so that their
// variants in WebP are as large as the variants of a real photo; a comment
// gives each file its exact size. The sample goes into a folder of a copy of
// the fixture vault: it is data of full size, never committed (AGENTS.md,
// Testing).

/** The folder of the sample in the vault. */
export const BUDGET_SAMPLE_FOLDER = '95 Budget sample'

/** The vault paths of the three notes whose pages the budgets measure. */
export const BUDGET_SAMPLE = {
    long: `${BUDGET_SAMPLE_FOLDER}/Long note.md`,
    media: `${BUDGET_SAMPLE_FOLDER}/Media note.md`,
    hub: `${BUDGET_SAMPLE_FOLDER}/Hub note.md`
} as const

/** The number of notes that link to the hub note. */
export const BUDGET_SAMPLE_BACKLINKS = 489

const WORDS = (
    'garden note idea system habit reading writing review project task focus energy ' +
    'morning week month year friend family book chapter author quote insight question ' +
    'answer method practice skill learning memory attention time place light water soil ' +
    'seed tool path wall frost bee river stone paper pencil desk window door table chair ' +
    'small large quick slow simple clear deep long short early late open quiet bright ' +
    'build keep find make take give read write link connect grow plant collect sort ' +
    'share explain improve change start finish compare choose follow remember forget ' +
    'the a of and to in is that for it with as on was by this be are from at or an have ' +
    'not but what all were when we there can more if out so up one about into than them ' +
    'then some her would make like him time has two look more write go see number no way ' +
    'could people my than first water been call who oil its now find long down day did get'
).split(' ')

/** A small random number generator (mulberry32): the same seed gives the same numbers. */
class Random {
    #state: number
    constructor(seed: number) {
        this.#state = seed >>> 0
    }
    next(): number {
        this.#state = (this.#state + 0x6d2b79f5) >>> 0
        let value = this.#state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
    int(max: number): number {
        return Math.floor(this.next() * max)
    }
    pick<T>(items: readonly T[]): T {
        const item = items[this.int(items.length)]
        if (item === undefined) {
            throw new Error('the list is empty')
        }
        return item
    }
}

function sentence(random: Random): string {
    const words = Array.from({ length: 8 + random.int(14) }, () => random.pick(WORDS))
    const text = words.join(' ')
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

function paragraph(random: Random, links: readonly string[] = []): string {
    const sentences = Array.from({ length: 3 + random.int(4) }, () => sentence(random))
    for (const link of links) {
        const at = random.int(sentences.length)
        sentences[at] = `${(sentences[at] ?? '').slice(0, -1)}, as in [[${link}]].`
    }
    return sentences.join(' ')
}

function title(random: Random): string {
    const text = `${random.pick(WORDS)} ${random.pick(WORDS)} ${random.pick(WORDS)}`
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function properties(type: string, created: string, updated: string): string {
    return `---\ntags:\n  - type/${type}\ncreated: ${created}\nupdated: ${updated}\n---\n`
}

/** The long note: about 23 KB of Markdown, 24 headings, 64 links, 4 images. */
function longNote(random: Random, targets: readonly string[]): string {
    const parts = [properties('note', '2024-03-02T09:00', '2026-11-18T10:00'), '# Long note']
    let next = 0
    const links = (count: number): string[] =>
        Array.from({ length: count }, () => targets[next++ % targets.length] ?? '')
    for (let section = 1; section <= 12; section += 1) {
        parts.push(`## ${title(random)} ${String(section)}`)
        parts.push(paragraph(random, links(2)), paragraph(random, links(2)))
        parts.push(`### ${title(random)}`)
        parts.push(paragraph(random), paragraph(random))
        if (section % 3 === 0) {
            parts.push(
                Array.from(
                    { length: 4 },
                    () => `- ${sentence(random)} [[${links(1)[0] ?? ''}]]`
                ).join('\n')
            )
        }
        if (section === 2) {
            parts.push(`> [!tip] ${title(random)}\n> ${paragraph(random)}`)
        }
        if (section === 4) {
            const lines = Array.from(
                { length: 12 },
                (_, index) => `const ${random.pick(WORDS)}${String(index)} = "${sentence(random)}"`
            )
            parts.push(`\`\`\`ts\n${lines.join('\n')}\n\`\`\``)
        }
        if (section === 6) {
            const rows = Array.from(
                { length: 8 },
                () => `| ${title(random)} | ${random.pick(WORDS)} | ${sentence(random)} |`
            )
            parts.push(`| Name | Kind | Note |\n| --- | --- | --- |\n${rows.join('\n')}`)
        }
        if (section % 3 === 1) {
            parts.push(`![[long-${String((section - 1) / 3 + 1)}.jpg]]`)
        }
        if (section === 9) {
            parts.push(`> ${paragraph(random)}`)
        }
    }
    return `${parts.join('\n\n')}\n`
}

/** The media note: a cover first, my notes, highlights and three images. */
function mediaNote(random: Random): string {
    const parts = [
        properties('book', '2025-05-10T20:00', '2026-10-02T21:00'),
        '# Media note',
        '![[cover.jpg]]',
        '## My notes',
        paragraph(random),
        paragraph(random),
        '## Highlights'
    ]
    for (let index = 0; index < 8; index += 1) {
        parts.push(`> ${paragraph(random)}`)
    }
    parts.push('## Pictures')
    for (let index = 1; index <= 3; index += 1) {
        parts.push(`![[media-${String(index)}.jpg]]`)
    }
    return `${parts.join('\n\n')}\n`
}

/** The hub note: a small map of content, linked from 489 notes. */
function hubNote(random: Random, targets: readonly string[]): string {
    const parts = [properties('map', '2023-01-15T08:00', '2026-11-01T08:00'), '# Hub note']
    for (let section = 1; section <= 4; section += 1) {
        parts.push(`## ${title(random)}`, paragraph(random))
        parts.push(
            targets
                .slice(section * 5, section * 5 + 5)
                .map((target) => `- [[${target}]]`)
                .join('\n')
        )
    }
    return `${parts.join('\n\n')}\n`
}

/**
 * A PNG image of this width and height, of about `bytes` bytes: a flat color,
 * and a private chunk of random bytes that a browser downloads and skips.
 */
export function samplePng(width: number, height: number, bytes: number, seed: number): Uint8Array {
    const random = new Random(seed)
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
        const out = new Uint8Array(12 + data.length)
        const view = new DataView(out.buffer)
        view.setUint32(0, data.length)
        out.set(new TextEncoder().encode(type), 4)
        out.set(data, 8)
        view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)))
        return out
    }
    const header = new Uint8Array(13)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, width)
    headerView.setUint32(4, height)
    header.set([8, 2, 0, 0, 0], 8)
    const shade = [random.int(256), random.int(256), random.int(256)]
    const row = new Uint8Array(1 + width * 3)
    for (let x = 0; x < width; x += 1) {
        row.set(shade, 1 + x * 3)
    }
    const raw = new Uint8Array(row.length * height)
    for (let y = 0; y < height; y += 1) {
        raw.set(row, y * row.length)
    }
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        new Uint8Array(0),
        chunk('IEND', new Uint8Array(0))
    ]
    const used = parts.reduce((total, part) => total + part.length, 0) + 12
    const padding = new Uint8Array(Math.max(0, bytes - used))
    for (let index = 0; index < padding.length; index += 1) {
        padding[index] = random.int(256)
    }
    parts[3] = chunk('prVt', padding)
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let at = 0
    for (const part of parts) {
        out.set(part, at)
        at += part.length
    }
    return out
}

/** The scales of the noise of a photo, in pixels, with their weights: large shapes, then finer detail. */
const PHOTO_SCALES = [
    [300, 1],
    [90, 0.5],
    [30, 0.28],
    [9, 0.16],
    [3, 0.1]
] as const

/** The pixels of an invented photo: smooth noise at several scales, in three channels. */
async function photoPixels(width: number, height: number, random: Random): Promise<Uint8Array> {
    const sum = new Float32Array(width * height * 3)
    let total = 0
    for (const [cell, weight] of PHOTO_SCALES) {
        total += weight
        const columns = Math.ceil(width / cell) + 1
        const rows = Math.ceil(height / cell) + 1
        const grid = Uint8Array.from({ length: columns * rows * 3 }, () => random.int(256))
        const layer = await sharp(grid, { raw: { width: columns, height: rows, channels: 3 } })
            .resize(columns * cell, rows * cell, { kernel: 'cubic' })
            .extract({ left: 0, top: 0, width, height })
            .raw()
            .toBuffer()
        for (let index = 0; index < sum.length; index += 1) {
            sum[index] = (sum[index] ?? 0) + weight * (layer[index] ?? 0)
        }
    }
    const pixels = new Uint8Array(sum.length)
    for (let index = 0; index < sum.length; index += 1) {
        const value = ((sum[index] ?? 0) / total - 128) * 2.2 + 128
        pixels[index] = Math.max(0, Math.min(255, Math.round(value)))
    }
    return pixels
}

/**
 * An invented photo: a JPEG of this width and height, of exactly `bytes`
 * bytes. Its image data is the JPEG of the highest quality that fits, and a
 * comment fills the rest, which a browser downloads and skips.
 */
export async function samplePhoto(
    width: number,
    height: number,
    bytes: number,
    seed: number
): Promise<Uint8Array> {
    const pixels = await photoPixels(width, height, new Random(seed))
    const encode = async (quality: number): Promise<Uint8Array> =>
        new Uint8Array(
            await sharp(pixels, { raw: { width, height, channels: 3 } })
                .jpeg({ quality })
                .toBuffer()
        )
    let low = 1
    let high = 100
    let best: Uint8Array | undefined
    while (low <= high) {
        const quality = Math.floor((low + high) / 2)
        const jpeg = await encode(quality)
        if (jpeg.length <= bytes) {
            best = jpeg
            low = quality + 1
        } else {
            high = quality - 1
        }
    }
    if (best === undefined) {
        throw new Error(
            `no JPEG of ${String(width)} by ${String(height)} pixels fits in ${String(bytes)} bytes`
        )
    }
    // Comment segments (0xFFFE) right after the start of the image.
    const segments: Uint8Array[] = []
    let missing = bytes - best.length
    while (missing > 0) {
        const length = Math.min(missing, 65_535 + 2)
        // A segment is at least its marker and its length: 4 bytes.
        const size = missing - length > 0 && missing - length < 4 ? length - 4 : length
        const segment = new Uint8Array(Math.max(size, 4))
        segment.set([0xff, 0xfe, ((segment.length - 2) >> 8) & 0xff, (segment.length - 2) & 0xff])
        segment.fill(0x20, 4)
        segments.push(segment)
        missing -= segment.length
    }
    if (missing < 0) {
        throw new Error('the comment of a photo of the sample cannot have this size')
    }
    const out = new Uint8Array(bytes)
    out.set(best.subarray(0, 2))
    let at = 2
    for (const segment of segments) {
        out.set(segment, at)
        at += segment.length
    }
    out.set(best.subarray(2), at)
    return out
}

/** Writes the budget sample into its folder of the vault (a copy of the fixture vault). */
export async function writeBudgetSample(vault: string, seed = 25): Promise<void> {
    const random = new Random(seed)
    const write = async (path: string, content: string | Uint8Array): Promise<void> => {
        const file = join(vault, BUDGET_SAMPLE_FOLDER, path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, content)
    }
    const targets: string[] = []
    for (let index = 0; index < 70; index += 1) {
        const name = `Sample target ${String(index)}`
        targets.push(name)
        await write(`Targets/${name}.md`, `${paragraph(random)}\n`)
    }
    const folder = BUDGET_SAMPLE_FOLDER.length + 1
    await write(BUDGET_SAMPLE.long.slice(folder), longNote(random, targets))
    await write(BUDGET_SAMPLE.media.slice(folder), mediaNote(random))
    await write(BUDGET_SAMPLE.hub.slice(folder), hubNote(random, targets))
    for (let index = 0; index < BUDGET_SAMPLE_BACKLINKS; index += 1) {
        await write(
            `Linking/Sample linking ${String(index)}.md`,
            `${paragraph(random)}\n\n${paragraph(random, ['Hub note'])}\n`
        )
    }
    await write('Files/cover.jpg', await samplePhoto(1000, 1500, 142_000, seed))
    for (let index = 1; index <= 3; index += 1) {
        await write(
            `Files/media-${String(index)}.jpg`,
            await samplePhoto(1200, 800, 80_000, seed + index)
        )
    }
    for (let index = 1; index <= 4; index += 1) {
        await write(
            `Files/long-${String(index)}.jpg`,
            await samplePhoto(1200, 700, 80_000, seed + 10 + index)
        )
    }
}
