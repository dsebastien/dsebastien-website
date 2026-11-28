import { markdownPath } from './url.ts'

// The download of the Markdown form of a note (issue 137): the Markdown path
// with `?download=<file name>`. The page names the file with the title of the
// note, and the answer says `Content-Disposition: attachment` with the same
// name, so a click saves the file without JavaScript. The plain Markdown path
// still opens in the browser.

/** The parameter of the query that asks for a download. */
export const DOWNLOAD_PARAMETER = 'download'

/** The name of a download when the title holds no text. */
const NO_TITLE = 'note'

/** The end of every name of a download. */
const EXTENSION = '.md'

/** The most bytes of a file name on Linux and macOS, in UTF-8. */
const MAX_BYTES = 255

/**
 * A character that Windows, macOS or Linux refuses in a file name (the
 * reserved marks and the control characters, `Cc`, also those of C1), or
 * that makes a name lie about its end: the marks that turn the direction of
 * the text (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), which can
 * show `gpj.md` as `md.jpg`. A joiner (U+200D) stays: emoji need it.
 */
const REFUSED = /[<>:"/\\|?*\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu

/** A dot or a space at the end of a name, which Windows removes or refuses. */
const LAST_DOTS = /[. ]+$/u

/**
 * A name that Windows reserves for a device, in any case, alone or before a
 * dot, also with spaces before that dot.
 */
const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/iu

/** The groups of characters that show as one (graphemes). */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The text of a name cut to a number of bytes of UTF-8, between two groups
 * of characters that show as one: never inside a character, an emoji with
 * its joiners, or a letter with its accents.
 */
function cut(text: string, bytes: number): string {
    const encoder = new TextEncoder()
    let kept = ''
    let used = 0
    for (const { segment } of GRAPHEMES.segment(text)) {
        used += encoder.encode(segment).length
        if (used > bytes) {
            break
        }
        kept += segment
    }
    // A first grapheme longer than a whole name (a letter with hundreds of
    // accents) leaves nothing: the name of a title with no text.
    return kept === '' ? NO_TITLE : kept
}

/**
 * The file name of the download of a note, from its title: `<title>.md`.
 * Each character that a file system refuses (`<>:"/\|?*` and the control
 * characters) and each mark that turns the direction of the text becomes a
 * hyphen, and so does each dot or space at the end of the title. A name that
 * Windows reserves (`CON`, `NUL`, `COM1`, `CONIN$`, alone or before a dot)
 * gets the suffix `-note`. The name keeps 255 bytes of UTF-8 at most, cut
 * between two graphemes. A name that it gave stays the same when it reads it
 * again.
 */
export function downloadName(title: string): string {
    if (title.trim() === '') {
        return NO_TITLE + EXTENSION
    }
    let stem = cut(title.replace(REFUSED, '-'), MAX_BYTES - EXTENSION.length)
    stem = stem.replace(LAST_DOTS, (dots) => '-'.repeat(dots.length))
    const dot = stem.indexOf('.')
    // Windows reads `CON .txt` as `CON`.
    const base = (dot === -1 ? stem : stem.slice(0, dot)).trimEnd()
    if (RESERVED.test(base)) {
        // The suffix makes the name longer: cut the rest again.
        stem = cut(`${base}-${NO_TITLE}${stem.slice(base.length)}`, MAX_BYTES - EXTENSION.length)
    }
    return stem + EXTENSION
}

/** The address of the download of the Markdown form of a note: its Markdown path and its file name. */
export function markdownDownloadPath(vaultPath: string, title: string): string {
    return `${markdownPath(vaultPath)}?${DOWNLOAD_PARAMETER}=${encodeURIComponent(downloadName(title))}`
}

/**
 * The file name that a request of a Markdown path asks for, made safe again:
 * the name of the query, or the file name of the path when the query names
 * none. `undefined` when the request asks for no download.
 *
 * @param path the Markdown path, as it is requested
 * @param query the query of the request, with its `?`, or nothing
 */
export function downloadNameOf(path: string, query: string): string | undefined {
    const parameters = new URLSearchParams(query)
    if (!parameters.has(DOWNLOAD_PARAMETER)) {
        return undefined
    }
    const asked = parameters.get(DOWNLOAD_PARAMETER) ?? ''
    if (asked !== '') {
        return downloadName(asked.endsWith(EXTENSION) ? asked.slice(0, -EXTENSION.length) : asked)
    }
    const segment = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, '')
    let name = segment.replaceAll('+', ' ')
    try {
        name = decodeURIComponent(name)
    } catch {
        // A path that does not decode keeps its text: the name is made safe anyway.
    }
    return downloadName(name)
}

/**
 * A character that the ASCII name of a header cannot hold: not printable
 * ASCII, a quote or a backslash, or a percent sign, which a client could read
 * as an encoding.
 */
const NOT_ASCII = /[^\u0020-\u007E]|["\\%]/gu

/**
 * The `Content-Disposition` header of a download: `attachment`, with an
 * ASCII name for a client that does not read the name in UTF-8 (each other
 * character, a quote, a backslash and a percent sign become a low line), then the name in
 * UTF-8, which a client that reads it takes (RFC 6266 section 4.3, RFC 8187).
 * In the name in UTF-8, each character that is not a plain letter, digit or
 * one of `!#$&+-.^_`|~` is percent-encoded.
 */
export function contentDisposition(name: string): string {
    const ascii = name.replace(NOT_ASCII, '_')
    const encoded = encodeURIComponent(name).replace(
        /['()*]/gu,
        (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`
    )
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
