import { compareCodePoints } from '../../plugin/src/publishing/order.ts'
import { postOf } from '../../plugin/src/publishing/originals.ts'
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
// The noindex folders (R103): the optional list `noindexFolders` of
// `configuration.json` of the content store. A note under one of them has the
// signals of a note with the property. A folder covers the notes of its
// subfolders, by whole names: `A/B` covers `A/B/x.md`, not `A/Bc/x.md`. It is
// not a guard: it takes no note away from the site.
//
// The original of a note (issue 55, ADR 0010, IDX-11 to IDX-14): a note of a
// type that the main site also publishes, or a note that the Ghost Publish
// plugin posted (its property `public_ghost_blog_news_url`), names the post there in its
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

/** True when a note is under one of the noindex folders (R103). */
export function isInNoindexFolder(vaultPath: string, folders: readonly string[]): boolean {
    return folders.some((folder) => vaultPath.startsWith(`${folder}/`))
}

/** A noindex folder that covers no note, and the folder that it may mean. */
export interface UnusedNoindexFolder {
    readonly folder: string
    /** A folder of a note that is the same name in another letter case or Unicode form. */
    readonly near?: string
}

/** A name as the near match compares it: composed (NFC), in small letters. */
function looseForm(name: string): string {
    return name.normalize('NFC').toLowerCase().normalize('NFC')
}

/**
 * The noindex folders that cover none of these notes, in the order of the
 * list: the build warns about each, since a typo would else do nothing. Each
 * names the folder of a note that it may mean, by letter case and Unicode
 * form, the first in code point order.
 */
export function unusedNoindexFolders(
    folders: readonly string[],
    vaultPaths: readonly string[]
): UnusedNoindexFolder[] {
    return folders
        .filter((folder) => !vaultPaths.some((path) => path.startsWith(`${folder}/`)))
        .map((folder) => {
            const depth = folder.split('/').length
            const wanted = looseForm(folder)
            const near = vaultPaths
                .map((path) => path.split('/'))
                .filter((parts) => parts.length > depth)
                .map((parts) => parts.slice(0, depth).join('/'))
                .filter((candidate) => looseForm(candidate) === wanted)
                .sort(compareCodePoints)[0]
            return near === undefined ? { folder } : { folder, near }
        })
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

/**
 * True when a cleaned note also exists on the main site: the rule of the
 * publishing tool (`postOf()`, rule 1 of "The original of a note"), on the
 * text of the cleaned note and the note type of its entry.
 */
export function existsOnMainSite(cleaned: string, noteType: NoteType | undefined): boolean {
    return postOf(cleaned, noteType).inScope
}

/**
 * The signals of a note: its noindex, its original, and whether the sitemaps
 * list it. `onMainSite` is `existsOnMainSite()` of its cleaned note, and
 * `inNoindexFolder` is `isInNoindexFolder()` of its vault path: it counts as
 * the property.
 */
export function signalsOf(
    note: IndexedNote,
    properties: Readonly<Record<string, unknown>>,
    onMainSite: boolean,
    inNoindexFolder = false
): NoteSignals {
    const noindexProperty = inNoindexFolder || isNoindexNote(properties)
    if (!onMainSite) {
        return { noindex: noindexProperty, inSitemaps: !noindexProperty }
    }
    return note.original === undefined
        ? { noindex: true, inSitemaps: false }
        : { noindex: noindexProperty, original: note.original, inSitemaps: false }
}
