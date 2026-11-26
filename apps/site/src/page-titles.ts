import { SITE_NAME } from './site.ts'

// The title of a page (IDX-01, IDX-04, decision R61): the display title, the
// label of the note type, then the site name, with a middle dot between them:
// `Inception · Movie · Sébastien’s Notes`. A note with no type has no type
// word. No two indexable pages share a title: when they would, each note of
// them takes its file name without the prefix and the suffix of its type. The
// H1 of the title band keeps the display title (IDX-07, issue 94).

/** The text between the parts of a title. */
export const TITLE_SEPARATOR = ' · '

/** The title of a page: its parts, then the site name. */
export function fullTitle(...parts: readonly (string | undefined)[]): string {
    return [...parts.filter((part) => part !== undefined && part !== ''), SITE_NAME].join(
        TITLE_SEPARATOR
    )
}

/**
 * The title of a shared page (`og:title`, issue 133): the title without the
 * site name at its end, which the card shows apart (`og:site_name`). A title
 * that is only the site name stays whole.
 */
export function shareTitle(title: string): string {
    const end = `${TITLE_SEPARATOR}${SITE_NAME}`
    return title.endsWith(end) && title.length > end.length ? title.slice(0, -end.length) : title
}

/** What the title of a note can be. */
export interface TitleCandidate {
    /** The vault path of the note. */
    readonly key: string
    /** The display title of the note (IDX-03). */
    readonly title: string
    /** The title when another page has the same one: the file name without the prefix and the suffix of its type. */
    readonly fallback: string
    /** The label of the note type, the word of the title (IDX-01). */
    readonly typeWord?: string | undefined
}

/** The title of a note: its text in the lists and the backlinks, and the title of its page. */
export interface NoteTitle {
    readonly title: string
    readonly full: string
}

/** The notes of each title that more than one page has. */
function shared(
    titles: ReadonlyMap<string, string>,
    taken: ReadonlySet<string>
): Map<string, string[]> {
    const byTitle = new Map<string, string[]>()
    for (const [key, title] of titles) {
        byTitle.set(title, [...(byTitle.get(title) ?? []), key])
    }
    return new Map([...byTitle].filter(([title, keys]) => keys.length > 1 || taken.has(title)))
}

/**
 * The title of each note, so that no two indexable pages share one. `taken`
 * holds the titles of the other indexable pages of the site (the home page,
 * the type hubs, the tag pages). It throws when two pages still share a
 * title after the fallback: the build stops and names them.
 */
export function uniqueTitles(
    candidates: readonly TitleCandidate[],
    taken: ReadonlySet<string> = new Set()
): Map<string, NoteTitle> {
    const chosen = new Map(candidates.map((candidate) => [candidate.key, candidate.title]))
    const full = (candidate: TitleCandidate): string =>
        fullTitle(chosen.get(candidate.key), candidate.typeWord)
    const fulls = (): Map<string, string> =>
        new Map(candidates.map((candidate) => [candidate.key, full(candidate)]))
    const first = shared(fulls(), taken)
    for (const candidate of candidates) {
        if (first.has(full(candidate))) {
            chosen.set(candidate.key, candidate.fallback)
        }
    }
    const left = shared(fulls(), taken)
    if (left.size > 0) {
        const [title, keys] = [...left][0] ?? ['', []]
        throw new Error(
            `two pages share the title "${title}", also with the file names of their notes (IDX-04): ${keys.map((key) => `"${key}"`).join(', ') || 'a note and a generated page'}. Give one of them a title property`
        )
    }
    return new Map(
        candidates.map((candidate) => [
            candidate.key,
            { title: chosen.get(candidate.key) ?? candidate.title, full: full(candidate) }
        ])
    )
}
