import { sortByCodePoint } from './order.ts'

// The frozen lists of a note (documentation/Canonical Form.md, section "The
// frozen lists of a note"): which notes of a plan have a live query that the
// page drops (REN-14), and which have a list that the Dataview Serializer
// runs again after each edit (PUB-35, PUB-101). The Rust twin is
// `cli/src/frozen.rs`.

/** The info words of the fences that the page drops: live queries (REN-14). */
const LIVE_WORDS: ReadonlySet<string> = new Set([
    'dataview',
    'dataviewjs',
    'base',
    'bases',
    'query'
])

/**
 * The markers of the queries that the serializer runs again after each edit.
 * The markers of the queries that the author froze on purpose (manual, once,
 * once and eject) are not here (K14 of the study).
 */
const REFRESH_MARKERS: readonly string[] = [
    '<!-- QueryToSerialize:',
    '<!-- dataview-serializer-query:',
    '<!-- IQ: ',
    '<!-- dataview-serializer-iq: ',
    '<!-- DataviewJSToSerialize:',
    '<!-- dataview-serializer-js:'
]

/** What one line of a note is, for the rules of the frozen lists. */
interface Line {
    /** The info word of the fence that the line opens, or undefined when it opens none. */
    readonly opens: string | undefined
    /** True when the line is inside a fence, or opens or closes one. */
    readonly fenced: boolean
    readonly text: string
}

/** The body of a line: without the spaces, the tabs and the `>` characters at its start (rule 1). */
function bodyOf(line: string): string {
    let start = 0
    while (start < line.length && ' \t>'.includes(line.charAt(start))) {
        start += 1
    }
    return line.slice(start)
}

/** The length of the run of `mark` at the start of a text. */
function runOf(text: string, mark: string): number {
    let length = 0
    while (text.charAt(length) === mark) {
        length += 1
    }
    return length
}

/** The lines of a source, with the fences of rule 2. */
function linesOf(source: string): Line[] {
    const lines: Line[] = []
    let fence: { readonly mark: string; readonly length: number } | undefined
    for (const text of source.split('\n')) {
        const body = bodyOf(text)
        if (fence !== undefined) {
            const length = runOf(body, fence.mark)
            if (length >= fence.length && /^[ \t]*$/u.test(body.slice(length))) {
                fence = undefined
            }
            lines.push({ opens: undefined, fenced: true, text })
            continue
        }
        const mark = body.charAt(0)
        const length = mark === '`' || mark === '~' ? runOf(body, mark) : 0
        if (length >= 3) {
            fence = { mark, length }
            const rest = body.slice(length).replace(/^[ \t]+/u, '')
            const end = rest.search(/[ \t]/u)
            const word = (end === -1 ? rest : rest.slice(0, end)).replace(/[A-Z]/gu, (letter) =>
                letter.toLowerCase()
            )
            lines.push({ opens: word, fenced: true, text })
            continue
        }
        lines.push({ opens: undefined, fenced: false, text })
    }
    return lines
}

/** True when the source opens a fence of a live query (rule 3): the page drops it. */
export function hasLiveQuery(source: string): boolean {
    return linesOf(source).some((line) => line.opens !== undefined && LIVE_WORDS.has(line.opens))
}

/** True when a line outside the fences holds a marker of a query that the serializer runs again (rule 4). */
export function hasListToRefresh(source: string): boolean {
    return linesOf(source).some(
        (line) => !line.fenced && REFRESH_MARKERS.some((marker) => line.text.includes(marker))
    )
}

/** `liveQueries` (rule 5): the paths of the notes with a live query, sorted by path. */
export function liveQueries(
    paths: readonly string[],
    sources: ReadonlyMap<string, string>
): string[] {
    return sortByCodePoint(
        paths.filter((path) => {
            const source = sources.get(path)
            return source !== undefined && hasLiveQuery(source)
        })
    )
}

/**
 * `listsNotRefreshed` (rule 6): the paths of the notes with a list to refresh
 * that the refresh of this run did not refresh, sorted by path.
 */
export function listsNotRefreshed(
    paths: readonly string[],
    sources: ReadonlyMap<string, string>,
    refreshed: ReadonlySet<string>
): string[] {
    return sortByCodePoint(
        paths.filter((path) => {
            const source = sources.get(path)
            return source !== undefined && !refreshed.has(path) && hasListToRefresh(source)
        })
    )
}
