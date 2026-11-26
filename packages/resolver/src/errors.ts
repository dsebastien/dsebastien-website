// The error answers of the site for an agent (NAV-21 of the spec, decision
// R64): a request for the Markdown form of a path that answers 404, 410 or
// 500 gets a short Markdown text with the same status code. Plain
// TypeScript, so that the plain server and the edge give the same answer.

/** The status codes of the error answers that have a page. */
export type ErrorStatus = 404 | 410 | 500

/** The prefix of the Markdown of the notes (URL-10). */
const MARKDOWN_PREFIX = '/-/md/'

/** The names of the Markdown type: the name of RFC 7763 and the name before it. */
const MARKDOWN_TYPES = ['text/markdown', 'text/x-markdown'] as const

/** The form of a weight of the `Accept` header: 0 to 1, with three decimals at most (RFC 9110). */
const WEIGHT = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u

/**
 * A media range of an `Accept` header, in small letters, with its character
 * set when it names one and its weight. The other parameters of a type (the
 * `variant` of Markdown, RFC 7763) choose nothing here: the answer has one form.
 */
interface MediaRange {
    readonly type: string
    readonly charset: string | undefined
    readonly weight: number
}

/** The parts of a text between the separators that are outside of quotes. */
function splitOutsideQuotes(text: string, separator: string): string[] {
    const parts: string[] = []
    let part = ''
    let quoted = false
    let escaped = false
    for (const character of text) {
        if (escaped) {
            escaped = false
        } else if (quoted && character === '\\') {
            escaped = true
        } else if (character === '"') {
            quoted = !quoted
        } else if (!quoted && character === separator) {
            parts.push(part)
            part = ''
            continue
        }
        part += character
    }
    parts.push(part)
    return parts
}

/**
 * The media ranges of an `Accept` header. The weight ends a range: a
 * parameter after it is no parameter of the type (RFC 9110, section 12.4.2).
 * A range with a weight in another form is left out.
 */
function rangesOf(accept: string): MediaRange[] {
    const ranges: MediaRange[] = []
    for (const item of splitOutsideQuotes(accept, ',')) {
        const [type = '', ...rest] = splitOutsideQuotes(item, ';').map((part) => part.trim())
        let charset: string | undefined
        let weight = 1
        for (const parameter of rest) {
            const at = parameter.indexOf('=')
            const name = parameter
                .slice(0, at < 0 ? parameter.length : at)
                .trim()
                .toLowerCase()
            const value = (at < 0 ? '' : parameter.slice(at + 1).trim()).replace(/^"(.*)"$/su, '$1')
            if (name === 'q') {
                weight = WEIGHT.test(value) ? Number(value) : Number.NaN
                break
            }
            if (name === 'charset') {
                charset = value.toLowerCase() === 'utf8' ? 'utf-8' : value.toLowerCase()
            }
        }
        if (type.includes('/') && !Number.isNaN(weight)) {
            ranges.push({ type: type.toLowerCase(), charset, weight })
        }
    }
    return ranges
}

/**
 * The range that gives its weight to a type of the answers, which are always
 * UTF-8 (RFC 9110, section 12.5.1): the most specific range that matches it.
 * The type with the character set `utf-8` comes first, then the type, then
 * its group, then any type; the type with another character set does not
 * match. Among ranges of one rank, the first one wins.
 */
function rangeOf(
    ranges: readonly MediaRange[],
    type: string
): { weight: number; exact: boolean } | undefined {
    const group = `${type.slice(0, type.indexOf('/'))}/*`
    const rank = (range: MediaRange): number => {
        if (range.type === type) {
            return range.charset === undefined ? 3 : range.charset === 'utf-8' ? 4 : 0
        }
        return range.type === group ? 2 : range.type === '*/*' ? 1 : 0
    }
    let best: MediaRange | undefined
    for (const range of ranges) {
        if (rank(range) > 0 && (best === undefined || rank(range) > rank(best))) {
            best = range
        }
    }
    return best === undefined ? undefined : { weight: best.weight, exact: rank(best) >= 3 }
}

/**
 * The form of an error answer: `markdown` for a path of the Markdown of a
 * note, and for a request whose `Accept` header names `text/markdown` with a
 * weight above 0 and not below the weight of HTML (`text/html` or
 * `application/xhtml+xml`); `html` in every other case. The form follows the header or the path, never the user agent (URL-11).
 */
export function errorFormat(path: string, accept: string | null): 'html' | 'markdown' {
    if (path.startsWith(MARKDOWN_PREFIX)) {
        return 'markdown'
    }
    if (accept === null) {
        return 'html'
    }
    const ranges = rangesOf(accept)
    // Markdown only when a range of Markdown itself matches: a group or any
    // type is no wish for Markdown. `text/x-markdown` is the name of Markdown
    // before RFC 7763: the two names are one type, which takes the higher weight.
    const markdown = Math.max(
        ...MARKDOWN_TYPES.map((type) => rangeOf(ranges, type)).map((range) =>
            range?.exact === true ? range.weight : 0
        )
    )
    // HTML is `text/html` or XHTML, whichever the header weighs more.
    const html = Math.max(
        rangeOf(ranges, 'text/html')?.weight ?? 0,
        rangeOf(ranges, 'application/xhtml+xml')?.weight ?? 0
    )
    return markdown > 0 && markdown >= html ? 'markdown' : 'html'
}

/**
 * An absolute address of the site as a Markdown link: an agent that reads
 * the text has no base address. A canonical path keeps `(`, `)`, `*` and `_`
 * as they are (`canonicalPath()`), so the destination is written between
 * angle brackets, where a parenthesis does not end it, and each mark of the
 * text is escaped, so that it stays plain text (CommonMark, sections 2.4 and
 * 6.3).
 */
function link(origin: string, path: string): string {
    const address = `${origin}${path}`
    const text = address.replaceAll(/[\\`*_[\]()<>!~|]/gu, '\\$&')
    const destination = address.replaceAll(/[\\<>]/gu, '\\$&')
    return `[${text}](<${destination}>)`
}

/** The file of the server error page in the output of the build (NAV-20). */
export const SERVER_ERROR_FILE = '500.html'

/**
 * The short Markdown text of an error answer (NAV-21). It names no
 * unpublished note and no detail of a failure, and the 500 text says what
 * the server error page says.
 *
 * @param origin the origin of the site, such as `https://notes.dsebastien.net`:
 *   the configured origin, or the listening address of the plain server. It
 *   must never come from a header of the request (`Host`, `X-Forwarded-Host`),
 *   which a client chooses. At the edge, the origin of the URL of the request
 *   is allowed only because the host gives the Worker only the requests of
 *   its own names, so that origin is always one of them (issue 32)
 * @param suggestions the canonical paths of the published notes of a file
 * name or an alias of several notes (404 only, R47)
 */
export function errorText(
    status: ErrorStatus,
    origin: string,
    suggestions: readonly string[] = []
): string {
    const home = `Start at the home page: ${link(origin, '/')}\n`
    const search = `Search the notes in a browser: ${link(origin, '/-/search')}\n`
    if (status === 500) {
        return `# Server error\n\nThe site could not give this page. Try again in a moment.\n\n${home}`
    }
    const head =
        status === 410
            ? '# Removed\n\nThe note that had this address was removed. It is no longer published.\n\n'
            : '# Not found\n\nNo note has this address. It may have moved, or it was never published.\n\n'
    const list =
        status === 404 && suggestions.length > 0
            ? `These notes have this name:\n\n${suggestions.map((path) => `- ${link(origin, path)}`).join('\n')}\n\n`
            : ''
    return `${head}${list}${home}\n${search}`
}
