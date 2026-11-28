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
 * A character that Windows, macOS or Linux refuses in a file name: the
 * reserved marks and the control characters (`Cc`, also those of C1).
 */
const REFUSED = /[<>:"/\\|?*\p{Cc}]/gu

/** A dot or a space at the end of a name, which Windows removes or refuses. */
const LAST_DOTS = /[. ]+$/u

/** A name that Windows reserves for a device, in any case, alone or before a dot. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu

/** The text of a name cut to a number of bytes of UTF-8, never inside a character. */
function cut(text: string, bytes: number): string {
    const encoder = new TextEncoder()
    let kept = ''
    let used = 0
    for (const character of text) {
        used += encoder.encode(character).length
        if (used > bytes) {
            break
        }
        kept += character
    }
    return kept
}

/**
 * The file name of the download of a note, from its title: `<title>.md`.
 * Each character that a file system refuses (`<>:"/\|?*` and the control
 * characters) becomes a hyphen, and so does each dot or space at the end of
 * the title. A name that Windows reserves (`CON`, `NUL`, `COM1`, alone or
 * before a dot) gets the suffix `-note`. The name keeps 255 bytes of UTF-8 at
 * most. A name that it gave stays the same when it reads it again.
 */
export function downloadName(title: string): string {
    if (title.trim() === '') {
        return NO_TITLE + EXTENSION
    }
    let stem = cut(title.replace(REFUSED, '-'), MAX_BYTES - EXTENSION.length)
    stem = stem.replace(LAST_DOTS, (dots) => '-'.repeat(dots.length))
    const dot = stem.indexOf('.')
    const base = dot === -1 ? stem : stem.slice(0, dot)
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
 * The `Content-Disposition` header of a download: `attachment`, with the
 * name in UTF-8 (RFC 6266, RFC 8187). Each character that is not a plain
 * letter, digit or one of `!#$&+-.^_`|~` is percent-encoded.
 */
export function contentDisposition(name: string): string {
    const encoded = encodeURIComponent(name).replace(
        /['()*]/gu,
        (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`
    )
    return `attachment; filename*=UTF-8''${encoded}`
}
