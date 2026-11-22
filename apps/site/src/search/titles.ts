import { compareCodePoints } from '../../../plugin/src/publishing/order.ts'

// The title index of the search (SRCH-02, decision R63): the display titles
// and the aliases of the published notes, which answer before the full text
// loads. The build writes it in parts, by the first letters of the words, so
// that the first letters of a query load one small part (R57). The build and
// the page both read this module: the build to write the parts, the page to
// find its part and to match the titles.

/**
 * A row of the title index: the text that matches (a display title or an
 * alias), the canonical path of the note, the singular label of its note
 * type (empty when it has none), and for an alias the display title of its
 * note.
 */
export type TitleRow =
    | readonly [text: string, path: string, type: string]
    | readonly [text: string, path: string, type: string, aliasOf: string]

/** A title that answers a query. */
export interface TitleMatch {
    readonly text: string
    readonly path: string
    /** The singular label of the note type of the note, when it has one. */
    readonly type?: string
    /** When the text is an alias: the display title of its note. */
    readonly aliasOf?: string
}

/** The most titles that a query shows. */
export const TITLES_SHOWN = 10

/**
 * The words of a text as the search compares them: without accents, in
 * small letters, cut at every character that is not a letter or a digit.
 */
export function foldedWords(text: string): string[] {
    return text
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word !== '')
}

/** How well a row answers the words of a query: 0 is best, `undefined` is no match. */
function rankOf(row: readonly string[], query: readonly string[]): number | undefined {
    if (!query.every((word) => row.some((part) => part.startsWith(word)))) {
        return undefined
    }
    if (row.join(' ') === query.join(' ')) return 0
    if (query.every((word, index) => (row[index] ?? '').startsWith(word))) return 1
    return 2
}

/** A published note as the title index needs it. */
export interface TitleEntry {
    /** The canonical path of the note. */
    readonly path: string
    /** The display title of the note (IDX-03). */
    readonly title: string
    /** The aliases of the note that get a URL. */
    readonly aliases: readonly string[]
    /** The singular label of the note type, empty when the note has none. */
    readonly type: string
}

/** The parts of the title index. */
export interface TitleIndex {
    /**
     * The key of each part: the first letters of a word, folded. `true` when
     * the part holds every row with a word that starts with its key, `false`
     * when it was split by one more letter and keeps its best rows only.
     */
    readonly keys: Readonly<Record<string, boolean>>
    /** The rows of each part, by key. */
    readonly parts: ReadonlyMap<string, readonly TitleRow[]>
}

/** The fewest letters of a key: a query of one letter loads no part. */
const SHORTEST_KEY = 2
/** The most letters of a key: a part with a longer word stays as it is, cut to its best rows. */
const LONGEST_KEY = 8

/**
 * The parts of the title index of these notes.
 *
 * @param options.partBytes the most characters of the JSON text of a part
 * @param options.rowsOfSplitPart the rows that a split part keeps: the best for a query of its key alone
 */
export function titleIndexOf(
    entries: readonly TitleEntry[],
    options: { partBytes?: number; rowsOfSplitPart?: number } = {}
): TitleIndex {
    const partBytes = options.partBytes ?? 96_000
    const kept = options.rowsOfSplitPart ?? 200
    const rows: { row: TitleRow; words: string[] }[] = []
    for (const entry of entries) {
        const words = foldedWords(entry.title)
        rows.push({ row: [entry.title, entry.path, entry.type], words })
        const said = new Set([words.join(' ')])
        for (const alias of entry.aliases) {
            const aliasWords = foldedWords(alias)
            const key = aliasWords.join(' ')
            if (aliasWords.length === 0 || said.has(key)) continue
            said.add(key)
            rows.push({ row: [alias, entry.path, entry.type, entry.title], words: aliasWords })
        }
    }
    const keys: Record<string, boolean> = {}
    const parts = new Map<string, TitleRow[]>()
    const letters = (word: string): string[] => Array.from(word)
    const childrenOf = (key: string, members: typeof rows): Map<string, typeof rows> => {
        const size = letters(key).length
        const children = new Map<string, typeof rows>()
        for (const member of members) {
            const childKeys = new Set(
                member.words
                    .filter((word) => word.startsWith(key) && letters(word).length > size)
                    .map((word) =>
                        letters(word)
                            .slice(0, size + 1)
                            .join('')
                    )
            )
            for (const child of childKeys) {
                const list = children.get(child) ?? []
                list.push(member)
                children.set(child, list)
            }
        }
        return children
    }
    const place = (key: string, members: typeof rows): void => {
        const all = members.map((member) => member.row)
        if (JSON.stringify(all).length <= partBytes) {
            keys[key] = true
            parts.set(key, all)
            return
        }
        // The best rows for the key alone: a word that is the key, then the shortest text.
        const best = [...members]
            .sort(
                (one, two) =>
                    (one.words.includes(key) ? 0 : 1) - (two.words.includes(key) ? 0 : 1) ||
                    letters(one.row[0]).length - letters(two.row[0]).length ||
                    compareCodePoints(one.row[0], two.row[0]) ||
                    compareCodePoints(one.row[1], two.row[1])
            )
            .slice(0, kept)
            .map((member) => member.row)
        keys[key] = false
        parts.set(key, best)
        if (letters(key).length >= LONGEST_KEY) return
        for (const [child, list] of childrenOf(key, members)) {
            place(child, list)
        }
    }
    const top = new Map<string, typeof rows>()
    for (const member of rows) {
        const own = new Set(
            member.words
                .filter((word) => letters(word).length >= SHORTEST_KEY)
                .map((word) => letters(word).slice(0, SHORTEST_KEY).join(''))
        )
        for (const key of own) {
            const list = top.get(key) ?? []
            list.push(member)
            top.set(key, list)
        }
    }
    for (const key of [...top.keys()].sort(compareCodePoints)) {
        place(key, top.get(key) ?? [])
    }
    return { keys, parts }
}

/** The name of the file of a part, without its extension: the bytes of its key in UTF-8, in hexadecimal. */
export function partFile(key: string): string {
    return [...new TextEncoder().encode(key)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

/**
 * The part of the title index that answers a query: the deepest part of a
 * word of the query, a complete part first. `undefined` when no title can
 * answer: a word starts no word of any title, or every word has one letter.
 */
export function partOf(
    query: string,
    keys: Readonly<Record<string, boolean>>
): { key: string; complete: boolean } | undefined {
    const found: { key: string; complete: boolean }[] = []
    for (const word of foldedWords(query)) {
        const letters = Array.from(word)
        if (letters.length < SHORTEST_KEY) continue
        let size = SHORTEST_KEY
        let key = letters.slice(0, size).join('')
        if (!Object.hasOwn(keys, key)) return undefined
        // A split part has a child for each longer word that starts with its
        // key, but a part of the most letters has no child: it answers alone.
        while (keys[key] === false && letters.length > size && size < LONGEST_KEY) {
            size += 1
            key = letters.slice(0, size).join('')
            if (!Object.hasOwn(keys, key)) return undefined
        }
        found.push({ key, complete: keys[key] === true })
    }
    found.sort(
        (one, two) =>
            (one.complete ? 0 : 1) - (two.complete ? 0 : 1) ||
            Array.from(two.key).length - Array.from(one.key).length
    )
    return found[0]
}

/** The titles that answer a query, the best first, one per note, at most `limit`. */
export function matchTitles(
    query: string,
    rows: readonly TitleRow[],
    limit = TITLES_SHOWN
): TitleMatch[] {
    const words = foldedWords(query)
    if (words.length === 0) {
        return []
    }
    const found: { row: TitleRow; rank: number }[] = []
    for (const row of rows) {
        const rank = rankOf(foldedWords(row[0]), words)
        if (rank !== undefined) {
            found.push({ row, rank })
        }
    }
    found.sort(
        (one, two) =>
            one.rank - two.rank ||
            (one.row.length === 4 ? 1 : 0) - (two.row.length === 4 ? 1 : 0) ||
            Array.from(one.row[0]).length - Array.from(two.row[0]).length ||
            compareCodePoints(one.row[0], two.row[0]) ||
            compareCodePoints(one.row[1], two.row[1])
    )
    const seen = new Set<string>()
    const matches: TitleMatch[] = []
    for (const { row } of found) {
        if (seen.has(row[1])) continue
        seen.add(row[1])
        const [text, path, type] = row
        matches.push({
            text,
            path,
            ...(type === '' ? {} : { type }),
            ...(row.length === 4 ? { aliasOf: row[3] } : {})
        })
        if (matches.length === limit) break
    }
    return matches
}
