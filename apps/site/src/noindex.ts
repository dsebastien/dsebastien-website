import { hasOriginal } from '../../plugin/src/publishing/originals.ts'
import type { NoteType } from '../../plugin/src/publishing/note-types.ts'

// The noindex property of a note (IDX-20, story 100, decision R85). A note
// with `publish_noindex: true` stays on the site: its page says
// `noindex, follow`, and it leaves the sitemaps (and so the batches of
// IndexNow, which follow the sitemaps). The site reads it from the cleaned
// note, as the other properties that only the site uses (`description`,
// `language`): the publishing tool keeps every property but `public_note`
// in the cleaned note, so the manifest entry, the canonical form and the
// parity do not change. Only the value `true` counts.
//
// The original of a note (issue 55, ADR 0010, IDX-11 to IDX-14): a note of a
// type that the main site also publishes names the post there in its
// canonical link, when its manifest entry holds the post that the tool
// verified at publication. The build reads only that, and opens no
// connection (IDX-12). Without a verified post, the note is noindex
// (IDX-13). Either way it leaves the sitemaps, and so IndexNow, which hold
// only URLs that name themselves; it stays in the feeds and in `llms.txt`
// (IDX-14). The note is still served under its own path.

/** The key of the property. */
export const NOINDEX_PROPERTY = 'publish_noindex'

/** True when the properties of a note take it out of the index. */
export function isNoindexNote(properties: Readonly<Record<string, unknown>>): boolean {
    return properties[NOINDEX_PROPERTY] === true
}

/** What the signals of a note read of its manifest entry. */
export interface IndexedNote {
    readonly noteType?: NoteType | undefined
    /** The post URL that the tool verified, from the manifest entry. */
    readonly original?: string | undefined
}

/** The signals of a note for search engines. */
export interface NoteSignals {
    /** True when the page says `noindex, follow`. */
    readonly noindex: boolean
    /** The URL that the canonical link names when it is not the page: the post on the main site. */
    readonly original?: string
    /** True when the page is in the sitemaps, and so in the batches of IndexNow. */
    readonly inSitemaps: boolean
}

/** The signals of a note: its noindex, its original, and whether the sitemaps list it. */
export function signalsOf(
    note: IndexedNote,
    properties: Readonly<Record<string, unknown>>
): NoteSignals {
    const noindexProperty = isNoindexNote(properties)
    if (!hasOriginal(note.noteType)) {
        return { noindex: noindexProperty, inSitemaps: !noindexProperty }
    }
    return note.original === undefined
        ? { noindex: true, inSitemaps: false }
        : { noindex: noindexProperty, original: note.original, inSitemaps: false }
}
