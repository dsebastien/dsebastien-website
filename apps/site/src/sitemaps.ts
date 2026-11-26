import { compareCodePoints } from '../../plugin/src/publishing/order.ts'

// The sitemaps (IDX-30 to IDX-34, AGENT-01, issue 54): one sitemap index at
// `/sitemap.xml`, and one file per group of note types at the root of the
// host (a sitemap lists only URLs below its own folder), with the groups of
// the research (seo item 35). A note whose type no group names, or with no
// type, is in `sitemap-notes.xml`; the indexable generated pages are in
// `sitemap-generated.xml`. A group with no URL writes no file. Each entry is
// a canonical URL of a page that names itself and answers 200: the checks of
// the build (`site-checks.ts`) stop a build where it is not so. `lastmod` is
// the date of the last update of a note (IDX-32); a generated page has none.
// No `priority`, no `changefreq`, no image sitemap (seo items 38 and 40).

/**
 * The variable of the environment of a build that says that it is the build
 * of the switch (`--switch` of the deploy command, decision R85): `true`.
 */
export const SWITCH_VARIABLE = 'SITE_SWITCH'

/** The path of the sitemap index. */
export const SITEMAP_INDEX_PATH = '/sitemap.xml'

/** The note types of each group, by the name of the group (seo item 35). */
export const SITEMAP_GROUPS: Readonly<Record<string, readonly string[]>> = {
    'permanent': ['permanent-notes', 'expressions'],
    'maps': ['maps-of-content', 'folder-notes'],
    'books': ['book-notes', 'literature-notes'],
    'wiki': ['ai-wiki-articles'],
    'docs': ['own-products'],
    'music': [
        'music-albums',
        'music-artists',
        'music-recordings',
        'music-theory',
        'music-works',
        'guitar-arrangements',
        'guitar-chords',
        'guitar-strumming-patterns'
    ],
    'quotes': ['quotes', 'own-quotes'],
    'people': ['persons'],
    'movies': ['movies'],
    'tv': ['tv-shows', 'tv-seasons', 'anime'],
    'video-games': ['video-games'],
    'board-games': ['board-games', 'board-game-items']
}

/** The group of the notes that no group of `SITEMAP_GROUPS` names. */
export const OTHER_NOTES_GROUP = 'notes'

/** The group of the indexable generated pages. */
export const GENERATED_GROUP = 'generated'

const GROUP_OF_TYPE = new Map(
    Object.entries(SITEMAP_GROUPS).flatMap(([group, types]) =>
        types.map((type) => [type, group] as const)
    )
)

/** The group of a note, from the canonical name of its note type. */
export function sitemapGroupOf(noteType: string | undefined): string {
    return (noteType === undefined ? undefined : GROUP_OF_TYPE.get(noteType)) ?? OTHER_NOTES_GROUP
}

/** The path of the sitemap file of a group. */
export function sitemapPath(group: string): string {
    return `/sitemap-${group}.xml`
}

/** An entry of a sitemap: the path of a page, and the date of its last update. */
export interface SitemapEntry {
    readonly path: string
    readonly lastmod?: string | undefined
}

/** The groups that have a file: the groups of these notes, then the generated pages, in order. */
export function sitemapGroupsOf(noteTypes: readonly (string | undefined)[]): string[] {
    const groups = [...new Set(noteTypes.map(sitemapGroupOf))].sort(compareCodePoints)
    return [...groups, GENERATED_GROUP]
}

/** A text as XML writes it in an element (seo item 39). */
function escaped(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll("'", '&apos;')
        .replaceAll('"', '&quot;')
}

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'
const NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9'

function entryXml(element: string, origin: string, entry: SitemapEntry): string {
    const loc = `<loc>${escaped(new URL(entry.path, origin).href)}</loc>`
    const lastmod =
        entry.lastmod === undefined ? '' : `<lastmod>${escaped(entry.lastmod)}</lastmod>`
    return `  <${element}>${loc}${lastmod}</${element}>\n`
}

/** The newest date of these entries, or `undefined` when none has one. */
function newestOf(entries: readonly SitemapEntry[]): string | undefined {
    const dates = entries.flatMap((entry) => (entry.lastmod === undefined ? [] : [entry.lastmod]))
    return dates.sort(compareCodePoints).at(-1)
}

/** A sitemap file: its entries in the order of their paths. */
export function sitemapXml(entries: readonly SitemapEntry[], origin: string): string {
    const ordered = [...entries].sort((one, two) => compareCodePoints(one.path, two.path))
    return `${HEAD}<urlset xmlns="${NAMESPACE}">\n${ordered.map((entry) => entryXml('url', origin, entry)).join('')}</urlset>\n`
}

/** The sitemap index: one entry per group, with the newest date of the group. */
export function sitemapIndexXml(
    groups: ReadonlyMap<string, readonly SitemapEntry[]>,
    origin: string
): string {
    const entries = [...groups].map(([group, items]) => ({
        path: sitemapPath(group),
        lastmod: newestOf(items)
    }))
    return `${HEAD}<sitemapindex xmlns="${NAMESPACE}">\n${entries.map((entry) => entryXml('sitemap', origin, entry)).join('')}</sitemapindex>\n`
}

/** The `<loc>` values of a sitemap file or of a sitemap index, as URLs. */
export function locsOf(xml: string): string[] {
    return [...xml.matchAll(/<loc>([^<]*)<\/loc>/gu)].map((match) =>
        (match[1] ?? '')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&apos;', "'")
            .replaceAll('&quot;', '"')
            .replaceAll('&amp;', '&')
    )
}

/** The entries of a sitemap file: each `<loc>` with its `<lastmod>`. */
export function entriesOf(xml: string): { loc: string; lastmod?: string }[] {
    return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gu)].map((match) => {
        const body = match[1] ?? ''
        const [loc = ''] = locsOf(body)
        const lastmod = /<lastmod>([^<]*)<\/lastmod>/u.exec(body)?.[1]
        return lastmod === undefined ? { loc } : { loc, lastmod }
    })
}

/** What the sitemaps read of a build. */
export interface SitemapSource {
    /** The published notes: the canonical path, the note type and the date of the last update of each. */
    readonly notes: readonly {
        readonly path: string
        readonly noteType?: string | undefined
        readonly lastmod?: string | undefined
        /** False when the page of the note says noindex (R85): it is in no sitemap. */
        readonly indexable?: boolean
    }[]
    /** The generated lists, with the pages that are indexed (IDX-22). */
    readonly lists: readonly { readonly pages: readonly { path: string; indexed: boolean }[] }[]
    /** The library, with whether it is indexed. */
    readonly library: { readonly path: string; readonly indexed: boolean }
}

/**
 * The entries of each group, in the order of `sitemapGroupsOf()`: every
 * note that is indexed (IDX-20: no note type is out of the index; a note
 * with `publish_noindex` is, R85; its group keeps its file, which the
 * resolver map names from the note types alone), and the home page, the
 * library and the pages of the lists that are indexed.
 */
export function sitemapEntriesOf(source: SitemapSource): Map<string, SitemapEntry[]> {
    const groups = new Map<string, SitemapEntry[]>(
        sitemapGroupsOf(source.notes.map((note) => note.noteType)).map((group) => [group, []])
    )
    const notes = source.notes.filter((note) => note.indexable !== false)
    for (const note of notes) {
        groups.get(sitemapGroupOf(note.noteType))?.push({ path: note.path, lastmod: note.lastmod })
    }
    const generated = groups.get(GENERATED_GROUP) ?? []
    generated.push({ path: '/' })
    if (source.library.indexed) {
        generated.push({ path: source.library.path })
    }
    for (const list of source.lists) {
        for (const page of list.pages) {
            if (page.indexed) {
                generated.push({ path: page.path })
            }
        }
    }
    return groups
}
