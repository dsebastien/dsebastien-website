// The error answers of the site for an agent (NAV-21 of the spec, decision
// R64): a request for the Markdown form of a path that answers 404, 410 or
// 500 gets a short Markdown text with the same status code. Plain
// TypeScript, so that the plain server and the edge give the same answer.

/** The status codes of the error answers that have a page. */
export type ErrorStatus = 404 | 410 | 500

/** The prefix of the Markdown of the notes (URL-10). */
const MARKDOWN_PREFIX = '/-/md/'

/** The form of a weight of the `Accept` header: 0 to 1, with three decimals at most (RFC 9110). */
const WEIGHT = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u

/** A media range of an `Accept` header, in small letters, with its parameters and its weight. */
interface MediaRange {
    readonly type: string
    readonly parameters: ReadonlyMap<string, string>
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

/** The media ranges of an `Accept` header. A range with a weight in another form is left out. */
function rangesOf(accept: string): MediaRange[] {
    const ranges: MediaRange[] = []
    for (const item of splitOutsideQuotes(accept, ',')) {
        const [type = '', ...rest] = splitOutsideQuotes(item, ';').map((part) => part.trim())
        const parameters = new Map<string, string>()
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
            } else if (name !== '') {
                parameters.set(name, value.toLowerCase())
            }
        }
        if (type.includes('/') && !Number.isNaN(weight)) {
            ranges.push({ type: type.toLowerCase(), parameters, weight })
        }
    }
    return ranges
}

/**
 * The weight of a type of the answers, which are always UTF-8 (RFC 9110,
 * section 12.5.1): the most specific range that matches it wins. A range of
 * the type with parameters matches when each one is the character set
 * `utf-8`; then comes the range of the type, then its group, then any type.
 * Among ranges of one rank, the first one wins. No range: 0.
 */
function weightOf(ranges: readonly MediaRange[], type: string): number {
    const group = `${type.slice(0, type.indexOf('/'))}/*`
    const rank = (range: MediaRange): number => {
        if (range.type === type) {
            if (range.parameters.size === 0) {
                return 2
            }
            const matches = [...range.parameters].every(
                ([name, value]) => name === 'charset' && value === 'utf-8'
            )
            return matches ? 3 : 0
        }
        return range.type === group ? 1 : range.type === '*/*' ? 0.5 : 0
    }
    let best: MediaRange | undefined
    for (const range of ranges) {
        if (rank(range) > 0 && (best === undefined || rank(range) > rank(best))) {
            best = range
        }
    }
    return best?.weight ?? 0
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
    // Markdown only when the header names it: a group or any type is no wish for Markdown.
    const named = ranges.some((range) => range.type === 'text/markdown')
    const markdown = weightOf(ranges, 'text/markdown')
    // HTML is `text/html` or XHTML, whichever the header weighs more.
    const html = Math.max(weightOf(ranges, 'text/html'), weightOf(ranges, 'application/xhtml+xml'))
    return named && markdown > 0 && markdown >= html ? 'markdown' : 'html'
}

/** The ways on from an error answer: the search and the home page. */
const WAYS_ON = 'Search the notes at /-/search, or start at the home page: /\n'

const NOT_FOUND =
    '# Not found\n\nNo note has this address. It may have moved, or it was never published.\n\n'

const TEXTS: Record<ErrorStatus, string> = {
    404: `${NOT_FOUND}${WAYS_ON}`,
    410: `# Removed\n\nThe note that had this address was removed. It is no longer published.\n\n${WAYS_ON}`,
    500: '# Server error\n\nThe site could not give this answer. Try again later.\n\nThe home page: /\n'
}

/** The file of the server error page in the output of the build (NAV-20). */
export const SERVER_ERROR_FILE = '500.html'

/**
 * The short Markdown text of an error answer. It names no unpublished note
 * and no detail of a failure.
 *
 * @param suggestions the canonical paths of the published notes of a file
 * name or an alias of several notes (404 only, R47)
 */
export function errorText(status: ErrorStatus, suggestions: readonly string[] = []): string {
    if (status === 404 && suggestions.length > 0) {
        const list = suggestions.map((path) => `- ${path}`).join('\n')
        return `${NOT_FOUND}These notes have this name:\n\n${list}\n\n${WAYS_ON}`
    }
    return TEXTS[status]
}
