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
    return text.normalize('NFC').toLowerCase()
}
