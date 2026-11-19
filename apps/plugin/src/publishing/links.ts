import { sortByCodePoint } from './order.ts'

// The links of a note: which note each link leads to (PUB-87, TOOL-07 of the
// spec). The rules are in `documentation/Canonical Form.md`, section "The
// links of a note". They follow what Obsidian does, because the Rust program
// cannot ask Obsidian. The Rust twin is `cli/src/links.rs`. Change both in
// the same commit.

/** One link of a note that leads to a note: the link path as the note writes it, and the vault path of its target. */
// A type alias, not an interface: the canonical form takes any object of data.
export type NoteLink = {
    readonly link: string
    readonly path: string
}

/** The start of a destination that is not a file of the vault: a scheme and a colon. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** The characters that the decoding of a destination leaves as they are written, as `decodeURI` does. */
const RESERVED = ';/?:@&=+$,#'

function isBlank(character: string | undefined): boolean {
    return character === ' ' || character === '\t'
}

/** The text without the spaces and the tabs around it. No other character is removed. */
function trim(text: string): string {
    let start = 0
    let end = text.length
    while (start < end && isBlank(text[start])) {
        start += 1
    }
    while (end > start && isBlank(text[end - 1])) {
        end -= 1
    }
    return text.slice(start, end)
}

/** The no-break space. Obsidian reads it as a space in a link. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0)

/**
 * The white space that Obsidian removes at the two ends of a link: what
 * `trim` of JavaScript removes. The list is written out, so that it is the
 * same in Rust and with every version of Unicode.
 */
function isWhiteSpace(character: string | undefined): boolean {
    const code = character?.charCodeAt(0)
    return (
        code !== undefined &&
        ((code >= 0x09 && code <= 0x0d) ||
            code === 0x20 ||
            code === 0xa0 ||
            code === 0x1680 ||
            (code >= 0x2000 && code <= 0x200a) ||
            code === 0x2028 ||
            code === 0x2029 ||
            code === 0x202f ||
            code === 0x205f ||
            code === 0x3000 ||
            code === 0xfeff)
    )
}

/** The text of a link as it is compared: each no-break space as a space, without the white space around it. */
function normal(text: string): string {
    const spaced = text.replaceAll(NO_BREAK_SPACE, ' ')
    let start = 0
    let end = spaced.length
    while (start < end && isWhiteSpace(spaced[start])) {
        start += 1
    }
    while (end > start && isWhiteSpace(spaced[end - 1])) {
        end -= 1
    }
    return spaced.slice(start, end)
}

/** The text up to its first `#`: a link to a heading or to a block has the path of its note. */
function beforeHash(text: string): string {
    const hash = text.indexOf('#')
    return hash === -1 ? text : text.slice(0, hash)
}

/** The byte that a `%` at this place of the text writes, or `undefined` when two hexadecimal digits do not follow it. */
function byteAt(text: string, index: number): number | undefined {
    const digits = text.slice(index + 1, index + 3)
    return text[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(digits)
        ? Number.parseInt(digits, 16)
        : undefined
}

/** The number of bytes of the UTF-8 sequence that this byte starts, or 0 when it starts none. */
function sequenceLength(first: number): number {
    if (first >= 0xc2 && first <= 0xdf) {
        return 2
    }
    if (first >= 0xe0 && first <= 0xef) {
        return 3
    }
    return first >= 0xf0 && first <= 0xf4 ? 4 : 0
}

/**
 * The destination of a Markdown link, decoded as a whole. A destination that
 * cannot be decoded is given back as it is written.
 */
function decode(destination: string): string {
    if (!destination.includes('%')) {
        return destination
    }
    // The decoder refuses bytes that are not UTF-8, and keeps a byte order mark as a character.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let decoded = ''
    let index = 0
    while (index < destination.length) {
        if (destination[index] !== '%') {
            decoded += destination[index] ?? ''
            index += 1
            continue
        }
        const first = byteAt(destination, index)
        if (first === undefined) {
            return destination
        }
        if (first < 0x80) {
            const character = String.fromCharCode(first)
            decoded += RESERVED.includes(character)
                ? destination.slice(index, index + 3)
                : character
            index += 3
            continue
        }
        const length = sequenceLength(first)
        if (length === 0) {
            return destination
        }
        const bytes = [first]
        for (let more = 1; more < length; more += 1) {
            const next = byteAt(destination, index + 3 * more)
            if (next === undefined) {
                return destination
            }
            bytes.push(next)
        }
        try {
            decoded += decoder.decode(new Uint8Array(bytes))
        } catch {
            return destination
        }
        index += 3 * length
    }
    return decoded
}

/**
 * One wikilink or one embed of a line. The build reads the same links as the
 * tool through this. When the result of `wikilinksOf` or of
 * `linkPathOfDestination` changes, raise `MARKUP_VERSION` in
 * `apps/site/src/note-links.ts`: the site keeps the markup of a note.
 */
export interface Wikilink {
    /** Where the link starts in the line: at its `[[`, or at the `!` of an embed. */
    readonly start: number
    /** Where the text after the link starts: after its `]]`. */
    readonly end: number
    /** The link path. It is empty for a link into the note itself. */
    readonly linkPath: string
    /** What a reader sees: the link text after the bar, or the target as it is written. */
    readonly text: string
    /** True when a `!` stands before the link. */
    readonly embed: boolean
}

/** The wikilinks and the embeds of one line, in their order. */
export function wikilinksOf(line: string): Wikilink[] {
    const links: Wikilink[] = []
    let position = 0
    for (;;) {
        const close = line.indexOf(']]', position)
        if (close === -1) {
            return links
        }
        // The last opening before the first closing.
        const open = line.slice(position, close).lastIndexOf('[[')
        if (open !== -1) {
            const start = position + open
            const inner = line.slice(start + 2, close)
            const bar = inner.indexOf('|')
            // In a table, a backslash stands before the bar. It is not part of the target.
            const end = bar > 0 && inner[bar - 1] === '\\' ? bar - 1 : bar
            const target = normal(bar === -1 ? inner : inner.slice(0, end))
            const embed = start > position && line[start - 1] === '!'
            links.push({
                start: embed ? start - 1 : start,
                end: close + 2,
                linkPath: beforeHash(target),
                text: bar === -1 ? target : inner.slice(bar + 1),
                embed
            })
        }
        position = close + 2
    }
}

/**
 * The link path of the destination of a Markdown link. `undefined` when the
 * destination is not a file of the vault: it is empty, it leads into the note
 * itself, or it has a scheme.
 */
export function linkPathOfDestination(destination: string): string | undefined {
    if (destination === '' || destination.startsWith('#') || SCHEME.test(destination)) {
        return undefined
    }
    return beforeHash(normal(decode(destination)))
}

/** Adds the link paths of the Markdown links of one line. */
function readMarkdownLinks(line: string, found: Set<string>): void {
    let position = 0
    for (;;) {
        const start = line.indexOf('](', position)
        if (start === -1) {
            return
        }
        position = start + 2
        let index = position
        while (isBlank(line[index])) {
            index += 1
        }
        let destination: string
        if (line[index] === '<') {
            const end = line.indexOf('>', index + 1)
            if (end === -1) {
                continue
            }
            destination = trim(line.slice(index + 1, end))
        } else {
            let depth = 0
            let end = index
            for (; end < line.length; end += 1) {
                const character = line[end]
                if (isBlank(character)) {
                    break
                }
                if (character === '(') {
                    depth += 1
                } else if (character === ')') {
                    if (depth === 0) {
                        break
                    }
                    depth -= 1
                }
            }
            destination = line.slice(index, end)
        }
        const linkPath = linkPathOfDestination(destination)
        if (linkPath !== undefined) {
            found.add(linkPath)
        }
    }
}

/**
 * The link paths of a note, from its source: each one time, in the order of
 * the code points. The properties are read like the text. A link path that
 * is empty names the note itself and is left out.
 */
export function linkPathsOf(source: string): string[] {
    const found = new Set<string>()
    for (const line of source.split('\n')) {
        for (const link of wikilinksOf(line)) {
            found.add(link.linkPath)
        }
        readMarkdownLinks(line, found)
    }
    found.delete('')
    return sortByCodePoint([...found])
}

/** The part of a path after its last slash. */
function nameOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1)
}

/** The part of a path before its last slash. The empty text for a path without a slash. */
function folderOf(path: string): string {
    const slash = path.lastIndexOf('/')
    return slash === -1 ? '' : path.slice(0, slash)
}

/** A file of the scan, with its path in small letters. */
interface Candidate {
    readonly path: string
    readonly lower: string
}

/** The files of a scan, notes and other files, by their names: what a link path is resolved against. */
export class LinkIndex {
    /** The files by their name in small letters. The files of one name are in the order of the code points of their paths. */
    readonly #byName = new Map<string, Candidate[]>()

    constructor(files: Iterable<string>) {
        for (const path of sortByCodePoint([...files])) {
            const lower = path.toLowerCase()
            const name = nameOf(lower)
            const candidates = this.#byName.get(name)
            if (candidates === undefined) {
                this.#byName.set(name, [{ path, lower }])
            } else {
                candidates.push({ path, lower })
            }
        }
    }

    /**
     * The vault path of the file that a link path leads to, from the note that
     * holds the link: a note or another file. `undefined` when the link path
     * has no target.
     */
    targetOf(linkPath: string, from: string): string | undefined {
        // Step 1: the candidates have the name of the link path. A file that
        // is not a note comes first, as in Obsidian.
        let wanted = linkPath.toLowerCase()
        let candidates = this.#byName.get(nameOf(wanted))
        if (candidates === undefined) {
            // The end is added before the small letters are made.
            wanted = `${linkPath}.md`.toLowerCase()
            candidates = this.#byName.get(nameOf(wanted))
        }
        if (candidates === undefined) {
            return undefined
        }
        // Step 2: a name alone that one file has.
        if (!wanted.includes('/') && candidates.length === 1) {
            return candidates[0]?.path
        }
        // Step 3: a path from the folder of the note.
        let folder = folderOf(from).toLowerCase()
        if (wanted.startsWith('./') || wanted.startsWith('../')) {
            if (wanted.startsWith('./../')) {
                wanted = wanted.slice(2)
            }
            if (wanted.startsWith('./')) {
                wanted = wanted.slice(2)
            } else {
                while (wanted.startsWith('../')) {
                    wanted = wanted.slice(3)
                    folder = folderOf(folder)
                }
            }
            if (folder !== '') {
                folder += '/'
            }
            wanted = folder + wanted
            const exact = candidates.find((candidate) => candidate.lower === wanted)
            if (exact !== undefined) {
                return exact.path
            }
        }
        // Step 4: a path from the root.
        if (wanted.startsWith('/')) {
            wanted = wanted.slice(1)
        }
        const exact = candidates.find((candidate) => candidate.lower === wanted)
        if (exact !== undefined) {
            return exact.path
        }
        // Step 5.
        if (linkPath.startsWith('/')) {
            return undefined
        }
        // Step 6: the end of a path. The notes below the folder come first, then the shorter path.
        const fitting = candidates.filter((candidate) => candidate.lower.endsWith(wanted))
        const near = fitting.filter((candidate) => candidate.lower.startsWith(folder))
        const far = fitting.filter((candidate) => !candidate.lower.startsWith(folder))
        // The sort is stable, and the candidates are in the order of the code
        // points. The length is counted in UTF-16 units, as Obsidian counts.
        const byLength = (one: Candidate, two: Candidate): number =>
            one.path.length - two.path.length
        return [...near.sort(byLength), ...far.sort(byLength)][0]?.path
    }
}

/** The targets of the links of a note, each list sorted by the link path. */
export interface Targets {
    /** The list `links` of the manifest entry: the links that lead to a note. */
    readonly links: NoteLink[]
    /** The links that lead to a file that is not a note: the attachments of the note, without their bytes. */
    readonly files: NoteLink[]
}

/**
 * The targets of the links of a note: one item per link path that has a
 * target, sorted by the link path. A target that a guard excludes gives no
 * item, and a file whose name ends in `.md` in another letter case gives
 * none: it is not a note, and as an attachment it would pass the guard of
 * the ignore property.
 */
export function linksOf(
    source: string,
    from: string,
    index: LinkIndex,
    guarded: ReadonlySet<string>
): Targets {
    return linksOfPaths(linkPathsOf(source), from, index, guarded)
}

/** The targets of the links of a note whose link paths are known. */
export function linksOfPaths(
    linkPaths: readonly string[],
    from: string,
    index: LinkIndex,
    guarded: ReadonlySet<string>
): Targets {
    const links: NoteLink[] = []
    const files: NoteLink[] = []
    for (const link of linkPaths) {
        const path = index.targetOf(link, from)
        if (path === undefined || guarded.has(path)) {
            continue
        }
        if (path.endsWith('.md')) {
            links.push({ link, path })
        } else if (!path.toLowerCase().endsWith('.md')) {
            files.push({ link, path })
        }
    }
    return { links, files }
}

/** True when two lists of links say the same. */
export function sameLinks(one: readonly NoteLink[], two: readonly NoteLink[]): boolean {
    return (
        one.length === two.length &&
        one.every((link, index) => link.link === two[index]?.link && link.path === two[index].path)
    )
}
