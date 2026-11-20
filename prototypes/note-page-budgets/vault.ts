import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// The invented vault of the prototype of issue 25 (PROTO-07). Three notes
// whose page is measured, with the shape of the published notes of the author
// at the 99th percentile (counted read only on his export, numbers only, in
// `documentation/research/2026-11-20-note-page-budgets.md`):
//
// - a long note: 23.5 kB of Markdown, 24 headings, 63 links, 4 images;
// - a media note: a cover of 150 kB (95th percentile of the images), three
//   more images of 80 kB (90th percentile) and a video;
// - a hub note with 489 backlinks, the largest count of the published notes.
//
// Every word is invented. The same seed gives the same vault. The images and
// the video are made by ImageMagick and ffmpeg, with noise, so that their
// size is near the size of a photo.

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

class Random {
    private state: number
    constructor(seed: number) {
        this.state = seed >>> 0
    }
    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0
        let t = this.state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    int(max: number): number {
        return Math.floor(this.next() * max)
    }
    pick<T>(items: readonly T[]): T {
        const item = items[this.int(items.length)]
        if (item === undefined) {
            throw new Error('empty list')
        }
        return item
    }
}

function sentence(random: Random, extra = ''): string {
    const count = 8 + random.int(14)
    const words = Array.from({ length: count }, () => random.pick(WORDS))
    const text = words.join(' ')
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}${extra}.`
}

function paragraph(random: Random, links: string[] = []): string {
    const count = 3 + random.int(4)
    const sentences = Array.from({ length: count }, () => sentence(random))
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

function properties(entries: Record<string, string>): string {
    const lines = Object.entries(entries).map(([key, value]) => `${key}: ${value}`)
    return `---\n${lines.join('\n')}\n---\n`
}

/** The long note: about 23.5 kB of Markdown, 24 headings, 63 links, 4 images. */
function longNote(random: Random, targets: string[]): string {
    const parts: string[] = [
        properties({ created: '2024-03-02T09:00', updated: '2026-11-18T10:00', tags: '[note]' })
    ]
    let linkIndex = 0
    const nextLinks = (count: number): string[] =>
        Array.from({ length: count }, () => targets[linkIndex++ % targets.length] ?? '')
    for (let section = 1; section <= 12; section += 1) {
        parts.push(`## ${title(random)} ${String(section)}`)
        parts.push(paragraph(random, nextLinks(2)))
        parts.push(paragraph(random, nextLinks(2)))
        parts.push(`### ${title(random)}`)
        parts.push(paragraph(random))
        parts.push(paragraph(random))
        if (section % 3 === 0) {
            parts.push(
                Array.from(
                    { length: 4 },
                    () => `- ${sentence(random)} [[${nextLinks(1)[0] ?? ''}]]`
                ).join('\n')
            )
        }
        if (section === 2) {
            parts.push(`> [!tip] ${title(random)}\n> ${paragraph(random)}`)
        }
        if (section === 4) {
            parts.push(
                '```ts\n' +
                    Array.from(
                        { length: 12 },
                        (_, index) =>
                            `const ${random.pick(WORDS)}${String(index)} = "${sentence(random)}"`
                    ).join('\n') +
                    '\n```'
            )
        }
        if (section === 6) {
            parts.push(
                '| Name | Kind | Note |\n| --- | --- | --- |\n' +
                    Array.from(
                        { length: 8 },
                        () => `| ${title(random)} | ${random.pick(WORDS)} | ${sentence(random)} |`
                    ).join('\n')
            )
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

/** The media note: a cover first, my notes, highlights, three images and a video. */
function mediaNote(random: Random): string {
    const parts: string[] = [
        properties({
            created: '2025-05-10T20:00',
            updated: '2026-10-02T21:00',
            tags: '[book]',
            cover: '"[[cover.jpg]]"'
        }),
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
    parts.push('## Video', '![[clip.mp4]]')
    return `${parts.join('\n\n')}\n`
}

/** The hub note: a map of content of about 4 kB, linked from 489 notes. */
function hubNote(random: Random, targets: string[]): string {
    const parts: string[] = [
        properties({ created: '2023-01-15T08:00', updated: '2026-11-01T08:00', tags: '[map]' })
    ]
    for (let section = 1; section <= 4; section += 1) {
        parts.push(`## ${title(random)}`)
        parts.push(paragraph(random))
        parts.push(
            targets
                .slice(section * 5, section * 5 + 5)
                .map((target) => `- [[${target}]]`)
                .join('\n')
        )
    }
    return `${parts.join('\n\n')}\n`
}

async function run(command: string[]): Promise<void> {
    const process = Bun.spawn(command, { stdout: 'ignore', stderr: 'inherit' })
    if ((await process.exited) !== 0) {
        throw new Error(`${command[0] ?? ''} failed`)
    }
}

/** A JPEG photo-like image: smooth noise with grain, near the size asked. */
async function photo(
    path: string,
    width: number,
    height: number,
    seed: number,
    extent: string
): Promise<void> {
    await run([
        'magick',
        '-seed',
        String(seed),
        '-size',
        `${String(width)}x${String(height)}`,
        'plasma:',
        '-attenuate',
        '0.35',
        '+noise',
        'Gaussian',
        '-define',
        `jpeg:extent=${extent}`,
        path
    ])
}

export const LONG_NOTE = '10 Notes/Long note.md'
export const MEDIA_NOTE = '20 Library/Media note.md'
export const HUB_NOTE = '10 Notes/Hub note.md'
export const BACKLINKS = 489

/** Writes the invented vault into the folder. */
export async function writeBudgetVault(vault: string, seed = 25): Promise<void> {
    const random = new Random(seed)
    const write = async (path: string, text: string): Promise<void> => {
        const file = join(vault, path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text)
    }
    const targets: string[] = []
    for (let index = 0; index < 70; index += 1) {
        const name = `Target ${String(index)}`
        targets.push(name)
        await write(`10 Notes/Targets/${name}.md`, `${paragraph(random)}\n`)
    }
    await write(LONG_NOTE, longNote(random, targets))
    await write(MEDIA_NOTE, mediaNote(random))
    await write(HUB_NOTE, hubNote(random, targets))
    for (let index = 0; index < BACKLINKS; index += 1) {
        await write(
            `10 Notes/Linking/Linking ${String(index)}.md`,
            `${paragraph(random)}\n\n${paragraph(random, ['Hub note'])}\n`
        )
    }
    // The folders of the deny list of the fixture configuration, which the tool requires.
    await write('80 Templates/Template.md', 'An invented template.\n')
    await write('90 Locked Shed/Locked.md', 'An invented locked note.\n')
    const files = join(vault, '90 Files')
    await mkdir(files, { recursive: true })
    await photo(join(files, 'cover.jpg'), 1000, 1500, seed, '150KB')
    for (let index = 1; index <= 3; index += 1) {
        await photo(join(files, `media-${String(index)}.jpg`), 1200, 800, seed + index, '80KB')
        await photo(join(files, `long-${String(index)}.jpg`), 1200, 700, seed + 10 + index, '80KB')
    }
    await photo(join(files, 'long-4.jpg'), 1200, 700, seed + 20, '80KB')
    await run([
        'ffmpeg',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30:duration=10',
        '-b:v',
        '1500k',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        join(files, 'clip.mp4')
    ])
}
