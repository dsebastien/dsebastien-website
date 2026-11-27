import { smallLetters } from '@dsebastien-website/resolver'
import { sortByCodePoint } from './order.ts'

// The root names of the site (documentation/Canonical Form.md, section "The
// root names of the site"). The site answers some names at its root itself,
// and a note must never take one of them (URL-08, URL-09 of the spec). The
// Rust twin is `cli/src/names.rs`. Change both in the same commit.

/** The ends of the names of the files that the site answers at its root. */
const RESERVED_ENDS = ['.html', '.ico', '.json', '.txt', '.xml']

/** The text with its ASCII capital letters in small letters. No other character changes, as in Rust. */
function asciiLower(text: string): string {
    return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/**
 * True when a name at the root of the site is reserved: `-` (the prefix of the
 * generated pages), a name that starts with a dot, or the name of a file of
 * the site (`robots.txt`, a sitemap, `llms.txt`, a file of a search engine).
 */
export function isReservedRootName(name: string): boolean {
    const lower = asciiLower(name)
    return (
        lower === '-' || lower.startsWith('.') || RESERVED_ENDS.some((end) => lower.endsWith(end))
    )
}

/** The first part of a path: the text before its first slash, or the whole text when it has none. */
export function firstPart(text: string): string {
    const slash = text.indexOf('/')
    return slash < 0 ? text : text.slice(0, slash)
}

/**
 * The folded form of a text: the composed Unicode form, then small letters.
 * Two texts with one folded form are one URL for the resolver.
 */
export function foldedForm(text: string): string {
    // NFC again: a small letter can make a pair that NFC composes (J and U+030C).
    return smallLetters(text.normalize('NFC')).normalize('NFC')
}

/**
 * The path that Obsidian gives a vault path: what its `normalizePath` does
 * (Obsidian 1.15.1). Each run of slashes and backslashes becomes one slash,
 * the slashes at the two ends go (an empty path is `/`), each no-break space
 * (U+00A0, U+202F) becomes a space, then the composed Unicode form (NFC).
 * Obsidian lists the files of the disk with this path (section "Paths" of
 * the canonical form, issue 110).
 */
export function obsidianPath(path: string): string {
    const plain = path.replace(/[\\/]+/gu, '/').replace(/^\/+|\/+$/gu, '')
    return (plain === '' ? '/' : plain).replace(/[\u00a0\u202f]/gu, ' ').normalize('NFC')
}

/**
 * True when Obsidian gives this vault path another path: any change of the
 * Obsidian path (a no-break space, a backslash, a slash too many, a name that is
 * not in the composed Unicode form). Obsidian, its links and the APIs of its
 * plugins then name another file than the disk.
 */
export function isChangedByObsidian(path: string): boolean {
    return obsidianPath(path) !== path
}

/**
 * Names that Windows refuses for a file or a folder, whatever their end:
 * spaces after the name still name the device.
 */
const WINDOWS_NAMES =
    /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\.|$)/iu

/**
 * True when Windows cannot hold the path (decision of the author R82): a
 * part holds one of `<>:"|?*\` or a control character, ends with a dot or a
 * space, or is a reserved name of Windows (`CON`, `NUL`, `CONIN$`, `COM1`,
 * also with spaces after it, and any end). Git cannot write such a path into
 * a copy on Windows, so such a note is never published and no move takes a
 * note to it.
 */
export function isRefusedByWindows(path: string): boolean {
    return path
        .split('/')
        .some(
            (part) =>
                isChangedByWindows(part) ||
                /[<>:"|?*\\]/u.test(part) ||
                Array.from(part, (letter) => letter.codePointAt(0) ?? 0).some((code) => code < 0x20)
        )
}

/**
 * True when Windows opens another entry for this name of a file or a folder
 * (issue 79): the name ends with a dot or a space, which Windows drops, or it
 * is a reserved name of a device (`CON`, `NUL`, `CONIN$`, `COM1`, also with
 * spaces after it, and any end), which Windows opens as the device. A folder
 * `Private.` would else open the folder `Private`. The vault holds no entry
 * with such a name, on every system, so that both implementations agree.
 */
export function isChangedByWindows(name: string): boolean {
    return WINDOWS_NAMES.test(name) || /[. ]$/u.test(name)
}

/**
 * The twins among these paths: each path whose Obsidian path is the Obsidian
 * path of another one, with the first such other path in the order of the
 * code points. Obsidian lists one file for such an Obsidian path, so it can
 * take one twin for the other (decision R72).
 */
export function obsidianTwins(paths: Iterable<string>): Map<string, string> {
    const groups = new Map<string, string[]>()
    for (const path of sortByCodePoint([...paths])) {
        const key = obsidianPath(path)
        const group = groups.get(key)
        if (group === undefined) {
            groups.set(key, [path])
        } else {
            group.push(path)
        }
    }
    const twins = new Map<string, string>()
    for (const group of groups.values()) {
        for (const path of group.length > 1 ? group : []) {
            const other = group.find((one) => one !== path)
            if (other !== undefined) {
                twins.set(path, other)
            }
        }
    }
    return twins
}
