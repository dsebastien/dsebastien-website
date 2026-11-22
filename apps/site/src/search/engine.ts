import { matchTitles, partOf, type TitleMatch, type TitleRow } from './titles.ts'

// The search of the site behind one interface (SRCH-04): the titles and the
// aliases answer first, from the parts of the title index (SRCH-02); the full
// text loads at the first full-text search only (R57). The page never sees
// the library of the full text or the files of the indexes, so the library
// can change without a change of the page.

/** A part of an excerpt: text, marked when it holds a word of the query. */
export interface ExcerptPart {
    readonly text: string
    readonly marked: boolean
}

/** A note that the full text finds. */
export interface FullTextHit {
    /** The canonical path of the note. */
    readonly path: string
    /** The display title of the note. */
    readonly title: string
    /** The singular label of its note type, when it has one. */
    readonly type?: string
    readonly excerpt: readonly ExcerptPart[]
}

/** The answer of the full text to one query. */
export interface FullTextResults {
    /** The number of notes found. */
    readonly total: number
    /** The notes from `from`, at most `count` of them, the best first. */
    hits(from: number, count: number): Promise<readonly FullTextHit[]>
}

/** A library of full-text search. */
export interface FullTextEngine {
    search(query: string): Promise<FullTextResults>
}

/** Where the search reads its data. */
export interface SearchSources {
    /** The keys of the parts of the title index: `true` for a complete part. */
    keys(): Promise<Readonly<Record<string, boolean>>>
    /** The rows of a part of the title index. */
    part(key: string): Promise<readonly TitleRow[]>
    /** The library of the full text, loaded. */
    fullText(): Promise<FullTextEngine>
}

/** The search of the site. */
export interface Search {
    /** The titles and aliases that answer a query, the best first. */
    titles(query: string): Promise<TitleMatch[]>
    /** The notes whose text answers a query. */
    fullText(query: string): Promise<FullTextResults>
}

const NOTHING: FullTextResults = { total: 0, hits: () => Promise.resolve([]) }

/** A value that loads at its first use, one time; a failed load is tried again at the next use. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
    let value: Promise<T> | undefined
    return () => {
        value ??= load().catch((error: unknown) => {
            value = undefined
            throw error
        })
        return value
    }
}

/** The search over these sources. */
export function createSearch(sources: SearchSources): Search {
    const keys = once(() => sources.keys())
    const parts = new Map<string, () => Promise<readonly TitleRow[]>>()
    const partOfKey = (key: string): Promise<readonly TitleRow[]> => {
        let load = parts.get(key)
        if (load === undefined) {
            load = once(() => sources.part(key))
            parts.set(key, load)
        }
        return load()
    }
    const engine = once(() => sources.fullText())
    return {
        async titles(query) {
            if (query.trim() === '') {
                return []
            }
            const part = partOf(query, await keys())
            return part === undefined ? [] : matchTitles(query, await partOfKey(part.key))
        },
        async fullText(query) {
            if (query.trim() === '') {
                return NOTHING
            }
            return (await engine()).search(query)
        }
    }
}

/** The characters that the full-text library writes as entities in an excerpt. */
const ENTITIES = new Map([
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&#39;', "'"],
    ['&#x27;', "'"]
])

function unescaped(text: string): string {
    return text.replace(
        /&(?:amp|lt|gt|quot|#39|#x27);/gu,
        (entity) => ENTITIES.get(entity) ?? entity
    )
}

/**
 * The parts of an excerpt of the full-text library: its text, with the words
 * of the query between `<mark>` and `</mark>`. Any other markup stays text,
 * so the page shows an excerpt with text nodes only, never as HTML.
 */
export function excerptParts(excerpt: string): ExcerptPart[] {
    const parts: ExcerptPart[] = []
    let marked = false
    for (const piece of excerpt.split(/(<mark>|<\/mark>)/u)) {
        if (piece === '<mark>' || piece === '</mark>') {
            marked = piece === '<mark>'
            continue
        }
        if (piece !== '') {
            parts.push({ text: unescaped(piece), marked })
        }
    }
    return parts
}
