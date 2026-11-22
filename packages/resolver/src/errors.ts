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

/**
 * The weight of each media range of an `Accept` header, by the range in
 * small letters. A range with a weight in another form is left out.
 */
function weightsOf(accept: string): Map<string, number> {
    const weights = new Map<string, number>()
    for (const item of accept.split(',')) {
        const [range = '', ...parameters] = item.split(';').map((part) => part.trim().toLowerCase())
        let weight = 1
        for (const parameter of parameters) {
            const [name = '', value = ''] = parameter.split('=').map((part) => part.trim())
            if (name === 'q') {
                weight = WEIGHT.test(value) ? Number(value) : Number.NaN
            }
        }
        if (range !== '' && !Number.isNaN(weight) && !weights.has(range)) {
            weights.set(range, weight)
        }
    }
    return weights
}

/** The weight of a type: its own range, else the range of its group, else any type, else 0. */
function weightOf(weights: Map<string, number>, type: string): number {
    const group = `${type.slice(0, type.indexOf('/'))}/*`
    return weights.get(type) ?? weights.get(group) ?? weights.get('*/*') ?? 0
}

/**
 * The form of an error answer: `markdown` for a path of the Markdown of a
 * note, and for a request whose `Accept` header names `text/markdown` with a
 * weight above 0 and not below the weight of HTML; `html` in every other
 * case. The form follows the header or the path, never the user agent (URL-11).
 */
export function errorFormat(path: string, accept: string | null): 'html' | 'markdown' {
    if (path.startsWith(MARKDOWN_PREFIX)) {
        return 'markdown'
    }
    if (accept === null) {
        return 'html'
    }
    const weights = weightsOf(accept)
    const markdown = weights.get('text/markdown') ?? 0
    return markdown > 0 && markdown >= weightOf(weights, 'text/html') ? 'markdown' : 'html'
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
