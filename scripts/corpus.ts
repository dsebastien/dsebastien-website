// The generator of an invented corpus of full size (issue 18).
//
// It makes a vault of the size and the shape of the public notes of the
// author, from invented words only. Prototypes and budget tests run on it
// without any real note. The same seed gives the same corpus, byte for byte:
// nothing here reads the clock or a random source of the system.
//
// The numbers come from `documentation/research/2026-11-17-current-state.md`
// (sections 1.3, 1.4 and 1.4b). They are public counts, not content.

/** What the caller chooses. */
export interface CorpusOptions {
    /** The same seed gives the same corpus. */
    seed: number
    /** The number of notes. The default is the size of the public notes. */
    notes?: number
}

/** One file of the corpus. */
export interface CorpusFile {
    /** Relative to the root of the vault, with `/` as the separator. */
    path: string
    bytes: Uint8Array
}

/** The number of public notes that the research counted. */
export const DEFAULT_NOTES = 20_735

/** A note type: its tag, its folder and its share of the corpus. */
interface NoteType {
    tag: string
    folder: string
    weight: number
    media: boolean
}

// The shares follow the main type tags of the research. The folders are
// invented, and some hold a dot, as most folders of the public notes do.
const NOTE_TYPES: readonly NoteType[] = [
    { tag: 'movie', folder: '20 Library/20.01 Films', weight: 4890, media: true },
    { tag: 'note', folder: '10 Notes/10.01 Ideas', weight: 3839, media: false },
    { tag: 'quote', folder: '20 Library/20.05 Quotes', weight: 2475, media: false },
    { tag: 'board-game', folder: '20 Library/20.02 Board games', weight: 2375, media: true },
    { tag: 'video-game', folder: '20 Library/20.03 Video games', weight: 2029, media: true },
    { tag: 'person', folder: '30 People', weight: 1024, media: false },
    { tag: 'tv-show', folder: '20 Library/20.04 Shows', weight: 716, media: true },
    { tag: 'article', folder: '40 Writing/40.01 Articles', weight: 351, media: false },
    { tag: 'book', folder: '20 Library/20.06 Books', weight: 273, media: true },
    { tag: 'map', folder: '10 Notes/10.02 Maps', weight: 271, media: false },
    { tag: 'newsletter', folder: '40 Writing/40.02 Newsletters', weight: 231, media: false },
    { tag: 'song', folder: '20 Library/20.07 Songs', weight: 191, media: false }
]

/** The name patterns of research 1.4b, with the share of the notes that have each. */
const NAME_PATTERNS = [
    { name: 'dot', share: 1488 / 20735 },
    { name: 'extension', share: 13 / 20735 },
    { name: 'apostrophe', share: 1501 / 20735 },
    { name: 'non-ascii', share: 1221 / 20735 },
    { name: 'ampersand', share: 175 / 20735 },
    { name: 'plus', share: 14 / 20735 },
    { name: 'percent', share: 9 / 20735 }
] as const

type NamePattern = (typeof NAME_PATTERNS)[number]['name']

// No `z`: with it, the syllables spell a word that nobody wants in a title.
const CONSONANTS = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v']
const VOWELS = ['a', 'e', 'i', 'o', 'u']
const ACCENTS: Record<string, string> = { a: 'à', e: 'é', i: 'ï', o: 'ø', u: 'ü' }
const EXTENSIONS = ['js', 'ts', 'io', 'net', 'ai']
const TOPICS = [
    'soil',
    'water',
    'light',
    'seeds',
    'tools',
    'frost',
    'bees',
    'paths',
    'walls',
    'time'
]

/** A small random generator with a seed (mulberry32). The same seed gives the same numbers. */
class Random {
    private state: number

    constructor(seed: number) {
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
            throw new Error('the seed must be a whole number from 0 to 4294967295')
        }
        this.state = seed
    }

    /** A number from 0 (included) to 1 (excluded). */
    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0
        let value = this.state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }

    /** A whole number from `min` to `max`, both included. */
    between(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1))
    }

    chance(share: number): boolean {
        return this.next() < share
    }

    pick<T>(items: readonly T[]): T {
        const item = items[Math.floor(this.next() * items.length)]
        if (item === undefined) {
            throw new Error('cannot pick from an empty list')
        }
        return item
    }
}

function word(random: Random): string {
    let text = ''
    for (let syllable = random.between(2, 3); syllable > 0; syllable -= 1) {
        text += random.pick(CONSONANTS) + random.pick(VOWELS)
    }
    return text
}

function capital(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1)
}

function words(random: Random, count: number): string {
    return Array.from({ length: count }, () => word(random)).join(' ')
}

function sentence(random: Random): string {
    return `${capital(words(random, random.between(12, 30)))}.`
}

/** A date and a time without a time zone, from a number of minutes after the start of 2024. */
function dateTime(minutes: number): string {
    return new Date(Date.UTC(2024, 0, 1) + minutes * 60_000).toISOString().slice(0, 16)
}

/** A note before its text is written: what the other notes need to link to it. */
interface Outline {
    type: NoteType
    name: string
    path: string
    aliases: string[]
    heading: string
    /** A media note without a text of the author. It has no heading of its own. */
    stub: boolean
}

function pickType(random: Random): NoteType {
    const total = NOTE_TYPES.reduce((sum, type) => sum + type.weight, 0)
    let rest = random.next() * total
    for (const type of NOTE_TYPES) {
        rest -= type.weight
        if (rest < 0) {
            return type
        }
    }
    return random.pick(NOTE_TYPES)
}

/** Writes a name in one of the patterns that are hard in a URL or in a file system. */
function patterned(random: Random, pattern: NamePattern, base: string): string {
    switch (pattern) {
        case 'dot':
            return `${base} v${String(random.between(1, 9))}.${String(random.between(0, 9))}`
        case 'extension':
            return `${capital(word(random))}.${random.pick(EXTENSIONS)}`
        case 'apostrophe':
            return `${capital(word(random))}'s ${base.toLowerCase()}`
        case 'non-ascii':
            return base.replace(/[aeiou]/, (vowel) => ACCENTS[vowel] ?? vowel)
        case 'ampersand':
            return `${base} & ${word(random)}`
        case 'plus':
            return `${base} + ${word(random)}`
        case 'percent':
            return `${String(random.between(1, 100))}% ${base.toLowerCase()}`
    }
}

function makeOutlines(random: Random, count: number): Outline[] {
    const outlines: Outline[] = []
    // No two notes share a file name, also when letter case is ignored: the
    // public notes have none, and Windows cannot hold two such files.
    const taken = new Set<string>()
    const sharedAliases: string[] = []

    for (let index = 0; index < count; index += 1) {
        const type = pickType(random)
        // The first notes get one pattern each, so that a small corpus has
        // them all. The others get a pattern by its share.
        const forced = NAME_PATTERNS[index]?.name
        const pattern =
            forced ?? NAME_PATTERNS.find((candidate) => random.chance(candidate.share))?.name

        let name: string
        do {
            const base = capital(words(random, random.between(1, 4)))
            name = pattern === undefined ? base : patterned(random, pattern, base)
            if (type.tag === 'movie' && pattern !== 'extension') {
                name += ` (${String(random.between(1950, 2030))})`
            }
        } while (taken.has(name.toLowerCase()))
        taken.add(name.toLowerCase())

        // About one note in four has aliases (research 1.4).
        const aliases: string[] = []
        if (index === 7 || random.chance(0.26)) {
            aliases.push(capital(words(random, random.between(2, 3))))
        }
        // An alias that more than one note carries.
        if (index === 8 || index === 9) {
            aliases.push('Shared alias')
        } else if (sharedAliases.length > 0 && random.chance(0.007)) {
            aliases.push(random.pick(sharedAliases))
        } else if (aliases.length > 0 && random.chance(0.02)) {
            sharedAliases.push(aliases[0] ?? '')
        }
        // An alias that is the file name of another note.
        const earlier = outlines[random.between(0, Math.max(0, index - 1))]
        if (earlier !== undefined && (index === 10 || random.chance(0.001))) {
            aliases.push(earlier.name)
        }

        outlines.push({
            type,
            name,
            path: `${type.folder}/${name}.md`,
            aliases: aliases.filter((alias) => alias !== ''),
            heading: capital(word(random)),
            // Four media notes in ten are stubs.
            stub: type.media && random.chance(0.4)
        })
    }
    return outlines
}

/** A link to another note, in one of the forms that the public notes use. */
function link(random: Random, target: Outline): string {
    const form = random.next()
    if (form < 0.85) {
        return `[[${target.name}]]`
    }
    if (form < 0.95) {
        return `[[${target.name}|${word(random)}]]`
    }
    // About one note in a hundred links to a heading (research 1.4). A stub
    // has no heading to link to.
    if (form < 0.9518 && !target.stub) {
        return `[[${target.name}#${target.heading}]]`
    }
    return `[[${target.path.replace(/\.md$/, '')}]]`
}

/** The Adler-32 checksum of the zlib format. */
function adler32(data: Uint8Array): number {
    let low = 1
    let high = 0
    for (const byte of data) {
        low = (low + byte) % 65_521
        high = (high + low) % 65_521
    }
    return ((high << 16) | low) >>> 0
}

/**
 * The bytes in the zlib format, stored and not compressed. The compressed
 * bytes of a library can change with its version. These cannot.
 */
function zlibStored(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(2 + 5 + data.length + 4)
    const view = new DataView(out.buffer)
    out.set([0x78, 0x01, 0x01])
    view.setUint16(3, data.length, true)
    view.setUint16(5, ~data.length & 0xffff, true)
    out.set(data, 7)
    view.setUint32(7 + data.length, adler32(data))
    return out
}

/** A valid PNG image of 8 by 8 pixels in one color. Each color gives other bytes. */
function png(red: number, green: number, blue: number): Uint8Array {
    const size = 8
    const row = [0, ...Array.from({ length: size }, () => [red, green, blue]).flat()]
    const pixels = Uint8Array.from(Array.from({ length: size }, () => row).flat())

    const chunk = (type: string, data: Uint8Array): Uint8Array => {
        const body = new Uint8Array(4 + data.length)
        body.set(new TextEncoder().encode(type))
        body.set(data, 4)
        const out = new Uint8Array(12 + data.length)
        const view = new DataView(out.buffer)
        view.setUint32(0, data.length)
        out.set(body, 4)
        view.setUint32(8 + data.length, Bun.hash.crc32(body))
        return out
    }

    const header = new Uint8Array(13)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, size)
    headerView.setUint32(4, size)
    header.set([8, 2, 0, 0, 0], 8)

    const parts = [
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlibStored(pixels)),
        chunk('IEND', new Uint8Array(0))
    ]
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) {
        out.set(part, offset)
        offset += part.length
    }
    return out
}

function properties(random: Random, outline: Outline, cover: string | undefined): string[] {
    const created = random.between(0, 900_000)
    const lines = ['---', 'tags:', `  - type/${outline.type.tag}`]
    if (random.chance(0.4)) {
        lines.push(`  - topic/${random.pick(TOPICS)}`)
    }
    if (outline.aliases.length > 0) {
        lines.push('aliases:', ...outline.aliases.map((alias) => `  - ${alias}`))
    }
    if (random.chance(0.13)) {
        lines.push(`description: ${sentence(random)}`)
    }
    if (outline.type.media) {
        const rated = random.chance(0.6)
        lines.push(`status: ${rated ? 'Done' : 'To do'}`)
        lines.push(rated ? `rating: ${String(random.between(1, 5))}` : 'rating:')
        lines.push(`release_date: ${dateTime(random.between(-30_000_000, 0)).slice(0, 10)}`)
        if (cover !== undefined) {
            lines.push(`cover: "[[${cover}]]"`)
        }
        // A media note of the public notes carries about 60 properties, most
        // of them empty (research 1.4).
        for (let field = 1; field <= 45; field += 1) {
            lines.push(`${word(random)}_${String(field).padStart(2, '0')}:`)
        }
    }
    if (outline.type.tag === 'person') {
        lines.push(
            `date_of_birth: ${dateTime(random.between(-50_000_000, -10_000_000)).slice(0, 10)}`
        )
        lines.push(`location: ${capital(word(random))}`)
    }
    lines.push(`created: ${dateTime(created)}`)
    lines.push(`updated: ${dateTime(created + random.between(0, 200_000))}`)
    lines.push('---')
    return lines
}

function body(
    random: Random,
    outline: Outline,
    outlines: readonly Outline[],
    image: string | undefined
): string[] {
    const lines = ['', `# ${outline.name}`, '']
    // Half of the public notes hold a Meta Bind button (research 1.4).
    if (random.chance(0.5)) {
        lines.push('`BUTTON[edit-note]`', '')
    }
    if (image !== undefined) {
        lines.push(`![[${image}|300]]`, '')
    }
    // A stub has no text of the author.
    if (outline.stub) {
        lines.push('## Notes', '')
        return lines
    }

    // The length of the text and the number of links are tuned to the totals
    // of the research: about 71 MB of notes and about 155,000 links.
    const others = outlines.length > 1
    for (let paragraph = random.between(3, 9); paragraph > 0; paragraph -= 1) {
        const sentences = Array.from({ length: random.between(2, 6) }, () => sentence(random))
        if (others && random.chance(0.6)) {
            sentences.push(`${capital(word(random))} ${link(random, random.pick(outlines))}.`)
        }
        lines.push(sentences.join(' '), '')
    }

    lines.push(`## ${outline.heading}`, '', sentence(random), '')
    if (others) {
        for (let item = random.between(2, 8); item > 0; item -= 1) {
            lines.push(`- ${link(random, random.pick(outlines))}`)
        }
        lines.push('')
    }
    // The shares below are a little above the shares of the research,
    // because the stubs have none of these.
    if (random.chance(0.17)) {
        lines.push('| Name | Value |', '| ---- | ----- |')
        for (let row = random.between(2, 5); row > 0; row -= 1) {
            lines.push(`| ${word(random)} | ${String(random.between(1, 999))} |`)
        }
        lines.push('')
    }
    if (others && random.chance(0.17)) {
        const query = `LIST FROM #topic/${random.pick(TOPICS)} SORT file.name ASC`
        lines.push(`<!-- QueryToSerialize: ${query} -->`, `<!-- SerializedQuery: ${query} -->`)
        for (let row = random.between(2, 8); row > 0; row -= 1) {
            lines.push(`- [[${random.pick(outlines).name}]]`)
        }
        lines.push('<!-- SerializedQuery END -->', '')
    }
    if (random.chance(0.04)) {
        lines.push('```text', words(random, 6), '```', '')
    }
    if (random.chance(0.003)) {
        lines.push(`> [!note] ${capital(word(random))}`, `> ${sentence(random)}`, '')
    }
    if (random.chance(0.001)) {
        lines.push(`%% ${sentence(random)} %%`, '')
    }
    return lines
}

/**
 * Generates the files of an invented vault: the notes, and one small image for
 * each note that embeds a cover.
 *
 * The same options give the same files in the same order, byte for byte.
 */
export function* generateCorpus(options: CorpusOptions): Generator<CorpusFile> {
    const count = options.notes ?? DEFAULT_NOTES
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('the number of notes must be a whole number above zero')
    }
    const random = new Random(options.seed)
    const outlines = makeOutlines(random, count)
    const encoder = new TextEncoder()

    for (const [index, outline] of outlines.entries()) {
        // More than half of the public notes embed an image (research 1.4):
        // every media note has a cover, and a few other notes have a picture.
        const prefix = outline.type.media ? 'cover' : 'image'
        const image =
            outline.type.media || random.chance(0.04)
                ? `${prefix}-${String(index).padStart(6, '0')}.png`
                : undefined
        if (image !== undefined) {
            yield {
                path: `Attachments/${image}`,
                bytes: png(random.between(0, 255), random.between(0, 255), random.between(0, 255))
            }
        }
        const cover = outline.type.media ? image : undefined
        const lines = [
            ...properties(random, outline, cover),
            ...body(random, outline, outlines, image)
        ]
        yield { path: outline.path, bytes: encoder.encode(`${lines.join('\n').trimEnd()}\n`) }
    }
}
