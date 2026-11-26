import type { ResolverMap } from '@dsebastien-website/resolver'
import { getCollection } from 'astro:content'
import { storeCatalog } from './ads/build-catalog.ts'
import type { Product } from './ads/catalog.ts'
import { adProductsOf } from './ads/matching.ts'
import { backlinkList, BACKLINKS_ON_PAGE, type ShownBacklink } from './backlink-list.ts'
import {
    readCleanedNote,
    readPublication,
    type PublishedNote,
    type RemovedNote
} from './content-store.ts'
import { noteDescription, uniqueDescriptions } from './descriptions.ts'
import {
    generatedTexts,
    libraryOf,
    otherNotesOf,
    tagListsOf,
    typeHubsOf,
    type ListedNote,
    type NoteList
} from './generated-pages.ts'
import { newestDay, topicsOf, type Linked, type SiteStats } from './home.ts'
import { isSystemTag, refuseTagsThatTakePagePaths, tagsOfNote } from './lists.ts'
import { noteHeader, type NoteHeader } from './note-header.ts'
import { readProperties } from './note-properties.ts'
import { uniqueTitles } from './page-titles.ts'
import { propertyLinksOf } from './properties.ts'
import { compareCodePoints } from '../../plugin/src/publishing/order.ts'
import { isNoindexNote } from './noindex.ts'
import { lastUpdateOf, recentListsOf } from './recent.ts'
import { sitemapEntriesOf, type SitemapEntry } from './sitemaps.ts'
import { SitePages } from './rendering/page.ts'
import { hrefOfAddress } from './site-checks.ts'
import { resolverMapFor } from './site-files.ts'
import { titleIndexOf, type TitleIndex } from './search/titles.ts'

// The published notes of one build, read one time: the manifest, the cleaned
// notes with their properties and the markup that Astro keeps, the pages of the build with their
// link index (BUILD-05, MOD-06), and what several pages ask about a note (its
// title band, its backlinks), and the lists of the generated pages: the type
// hubs, the tag pages and the library (issue 49, R61). The titles and the
// descriptions of all pages are computed together, so that no two indexable
// pages share one (IDX-04). The note pages, the generated pages and the
// resolver map all read this one object.

/** The published notes of a build. */
export interface PublishedSite {
    /** The published notes, in the order of their paths. */
    readonly notes: readonly PublishedNote[]
    /**
     * The notes that the author unpublished, in the order of their paths: the
     * resolver map gives their addresses the gone page (410, R64). Nothing else
     * of the site reads them.
     */
    readonly removed: readonly RemovedNote[]
    /** The pages of the notes, and the link index of the build. */
    readonly pages: SitePages
    /** The properties of a published note. */
    propertiesOf(vaultPath: string): Readonly<Record<string, unknown>>
    /**
     * The title band of a published note: its display title, its type badge
     * and its dates. When two pages share a title, the fallback of the title
     * is its `title`, and its `heading` stays the display title (issue 94).
     */
    headerOf(vaultPath: string): NoteHeader
    /** The title of the page of a published note: the display title, the type word and the site name. */
    titleOf(vaultPath: string): string
    /** The description of the page of a published note (IDX-05). */
    descriptionOf(vaultPath: string): string
    /** The type hub of each note type, by the plural label of the type (NAV-03). */
    readonly typeHubs: readonly NoteList[]
    /** The page of each tag, in the order of the code points of the tags (NAV-04). */
    readonly tagLists: readonly NoteList[]
    /** The library: the type hubs of the media types. */
    readonly library: ReturnType<typeof libraryOf>
    /** The list of the notes with no note type, when the site has such notes: their crawl path. */
    readonly otherNotes: NoteList | undefined
    /** The recent lists: `added`, `updated`, then the filter of each note type of each (NAV-05, R62). */
    readonly recentLists: readonly NoteList[]
    /** The entry points by topic of the home page: the most linked maps of content (R62). */
    readonly topics: readonly Linked[]
    /** What the stats line of the home page counts (R62). */
    readonly stats: SiteStats
    /** The title index of the search: the display titles and the aliases of the notes (SRCH-02, R63). */
    readonly titleIndex: TitleIndex
    /** The canonical paths of the notes with `publish_noindex` (R85), in code point order: the random note leaves them out (issue 122). */
    readonly noindexPaths: readonly string[]
    /** The backlinks of a published note, in the order of a page (R59). */
    backlinksOf(vaultPath: string): readonly ShownBacklink[]
    /** The notes with more backlinks than a note page holds: each has a page with all of them. */
    notesWithBacklinksPage(): readonly PublishedNote[]
    /** The products of the ad at the end of a published note, from the store catalog: none for no ad (AD-01). */
    adOf(vaultPath: string): readonly Product[]
    /** The entries of each sitemap file, by group (IDX-30, issue 54). */
    readonly sitemaps: ReadonlyMap<string, readonly SitemapEntry[]>
}

async function read(): Promise<PublishedSite> {
    const entries = new Map((await getCollection('notes')).map((entry) => [entry.id, entry]))
    const { notes, removed, importRun } = await readPublication()
    // The store catalog, read one time per build (BUILD-06, CAT-01).
    const catalog = await storeCatalog()
    const byPath = new Map(notes.map((note) => [note.vaultPath, note]))
    // The properties of each note, read from its cleaned note with every date
    // as the text of the vault (`note-properties.ts`), not from the collection.
    const properties = new Map<string, Readonly<Record<string, unknown>>>()
    for (const note of notes) {
        const source = await readCleanedNote(note.vaultPath)
        try {
            properties.set(note.vaultPath, readProperties(source))
        } catch (error) {
            // The build stops, and says which note the author must correct.
            throw new Error(
                `the properties of "${note.vaultPath}" cannot be read: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
            )
        }
    }
    // The resolver map of this build, for the raw links of the notes to an
    // address of the site (issue 98). It is made from the first lists, before
    // the page step runs: the titles of the notes do not change its paths.
    const made: { map?: ResolverMap } = {}
    const addressOf = (address: string): string | undefined => {
        if (made.map === undefined) {
            throw new Error('a raw link of a note was resolved before the resolver map was made')
        }
        return hrefOfAddress(address, made.map)
    }
    const pages = new SitePages(
        notes.map((note) => {
            const entry = entries.get(note.vaultPath)
            if (entry === undefined) {
                throw new Error(`the content store has no cleaned note for "${note.vaultPath}"`)
            }
            if (entry.rendered === undefined) {
                throw new Error(`the note "${note.vaultPath}" has no markup`)
            }
            // The pages of this build (BUILD-05): the markup of each note, which
            // Astro keeps between two builds, with its links and its embeds in
            // the state of this build.
            return {
                vaultPath: note.vaultPath,
                path: note.path,
                markup: entry.rendered.html,
                links: new Map(note.links.map((link) => [link.link, link.path])),
                files: new Map(note.attachments.map((file) => [file.link, file])),
                propertyLinks: propertyLinksOf(properties.get(note.vaultPath) ?? {})
            }
        }),
        { addressOf }
    )
    const noteOf = (vaultPath: string): PublishedNote => {
        const note = byPath.get(vaultPath)
        if (note === undefined) {
            throw new Error(`the note "${vaultPath}" is not published`)
        }
        return note
    }
    // The title band of each note, then the titles of all pages together.
    const raw = new Map<string, NoteHeader>()
    for (const note of notes) {
        const heading = pages.heading(note.vaultPath)
        raw.set(
            note.vaultPath,
            noteHeader({
                fileName: note.title,
                ...(note.noteType === undefined ? {} : { noteType: note.noteType }),
                properties: properties.get(note.vaultPath) ?? {},
                ...(heading === undefined ? {} : { firstHeading: heading.text }),
                firstPublished: note.firstPublished,
                lastPublished: note.lastPublished
            })
        )
    }
    const listed = (note: PublishedNote, title: string): ListedNote => {
        const header = raw.get(note.vaultPath)
        return { vaultPath: note.vaultPath, path: note.path, title, type: header?.type }
    }
    // The lists hold the titles of the notes, which do not change the titles of the lists.
    const listsOf = (titleOf: (note: PublishedNote) => string) => {
        const tagged = notes.map((note) => {
            const markup = entries.get(note.vaultPath)?.rendered?.html ?? ''
            const tags = tagsOfNote(properties.get(note.vaultPath)?.['tags'], markup)
            return { note: listed(note, titleOf(note)), tags }
        })
        const typeHubs = typeHubsOf(tagged.map((item) => item.note))
        return {
            typeHubs,
            otherNotes: otherNotesOf(tagged.map((item) => item.note)),
            tagLists: tagListsOf(tagged),
            recentLists: recentListsOf(
                tagged.map(({ note }, index) => {
                    const published = notes[index]
                    const noteProperties = properties.get(note.vaultPath) ?? {}
                    return {
                        note,
                        firstPublished: published?.firstPublished ?? '',
                        lastPublished: published?.lastPublished ?? '',
                        created: noteProperties['created'],
                        updated: noteProperties['updated']
                    }
                }),
                { importRun, labels: new Map(typeHubs.map((hub) => [hub.key, hub.label])) }
            )
        }
    }
    const draft = listsOf((note) => raw.get(note.vaultPath)?.title ?? note.title)
    refuseTagsThatTakePagePaths(draft.tagLists.map((list) => list.key))
    const draftLists = [
        ...draft.typeHubs,
        ...(draft.otherNotes === undefined ? [] : [draft.otherNotes]),
        ...draft.tagLists,
        ...draft.recentLists
    ]
    const taken = generatedTexts(draftLists)
    made.map = resolverMapFor(
        notes,
        notes.filter((note) => pages.backlinks(note.vaultPath).length > BACKLINKS_ON_PAGE),
        draftLists,
        removed
    )
    const titles = uniqueTitles(
        notes.map((note) => {
            const header = raw.get(note.vaultPath)
            return {
                key: note.vaultPath,
                title: header?.title ?? note.title,
                fallback: header?.bareName ?? note.title,
                typeWord: header?.type?.one
            }
        }),
        taken.titles
    )
    const headers = new Map<string, NoteHeader>()
    for (const [vaultPath, header] of raw) {
        headers.set(vaultPath, { ...header, title: titles.get(vaultPath)?.title ?? header.title })
    }
    const descriptions = uniqueDescriptions(
        notes.map((note) => {
            const header = headers.get(note.vaultPath)
            const title = header?.title ?? note.title
            return {
                key: note.vaultPath,
                title,
                description: noteDescription({
                    title,
                    typeLabel: header?.type?.one,
                    media: header?.type?.media,
                    properties: properties.get(note.vaultPath) ?? {},
                    html: pages.page(note.vaultPath).html
                })
            }
        }),
        taken.descriptions
    )
    const lists = listsOf((note) => headers.get(note.vaultPath)?.title ?? note.title)
    const headerOf = (vaultPath: string): NoteHeader => {
        noteOf(vaultPath)
        const header = headers.get(vaultPath)
        if (header === undefined) {
            throw new Error(`the note "${vaultPath}" has no title band`)
        }
        return header
    }
    // Not kept: almost every list is read one time, by the page of its note.
    const backlinksOf = (vaultPath: string): readonly ShownBacklink[] =>
        backlinkList(pages.backlinks(vaultPath), (path) => {
            const header = headerOf(path)
            return { title: header.title, updated: header.updated.datetime }
        })
    return {
        notes,
        removed,
        pages,
        propertiesOf: (vaultPath) => {
            noteOf(vaultPath)
            return properties.get(vaultPath) ?? {}
        },
        headerOf,
        titleOf: (vaultPath) => {
            noteOf(vaultPath)
            return titles.get(vaultPath)?.full ?? vaultPath
        },
        descriptionOf: (vaultPath) => {
            noteOf(vaultPath)
            return descriptions.get(vaultPath) ?? ''
        },
        typeHubs: lists.typeHubs,
        tagLists: lists.tagLists,
        library: libraryOf(lists.typeHubs),
        otherNotes: lists.otherNotes,
        recentLists: lists.recentLists,
        topics: topicsOf(
            notes.map((note) => ({
                note: listed(note, headers.get(note.vaultPath)?.title ?? note.title),
                backlinks: pages.backlinks(note.vaultPath).length
            }))
        ),
        stats: {
            notes: notes.length,
            types: lists.typeHubs.length,
            tags: lists.tagLists.filter((list) => !isSystemTag(list.key)).length,
            // The newest day of "added" and "updated": a run that only adds notes is an update too.
            lastUpdate: newestDay(
                lists.recentLists
                    .filter((list) => list.key === 'added' || list.key === 'updated')
                    .map((list) => list.pages[0]?.notes[0]?.date?.datetime)
            )
        },
        titleIndex: titleIndexOf(
            notes.map((note) => {
                const header = headers.get(note.vaultPath)
                return {
                    path: note.path,
                    title: header?.title ?? note.title,
                    aliases: note.aliases,
                    type: header?.type?.one ?? ''
                }
            })
        ),
        noindexPaths: notes
            .filter((note) => isNoindexNote(properties.get(note.vaultPath) ?? {}))
            .map((note) => note.path)
            .sort(compareCodePoints),
        backlinksOf,
        notesWithBacklinksPage: () =>
            notes.filter((note) => pages.backlinks(note.vaultPath).length > BACKLINKS_ON_PAGE),
        adOf: (vaultPath) => {
            const note = noteOf(vaultPath)
            const noteProperties = properties.get(vaultPath) ?? {}
            return adProductsOf(
                {
                    vaultPath,
                    fileName: (vaultPath.split('/').pop() ?? '').replace(/\.md$/iu, ''),
                    ...(note.noteType === undefined ? {} : { noteType: note.noteType.name }),
                    tags: noteProperties['tags'],
                    topics: noteProperties['topics']
                },
                catalog
            )
        },
        sitemaps: sitemapEntriesOf({
            notes: notes.map((note) => {
                const noteProperties = properties.get(note.vaultPath) ?? {}
                return {
                    path: note.path,
                    noteType: note.noteType?.name,
                    indexable: !isNoindexNote(noteProperties),
                    lastmod: lastUpdateOf({
                        lastPublished: note.lastPublished,
                        updated: noteProperties['updated']
                    })
                }
            }),
            lists: [
                ...lists.typeHubs,
                ...(lists.otherNotes === undefined ? [] : [lists.otherNotes]),
                ...lists.tagLists,
                ...lists.recentLists
            ],
            library: libraryOf(lists.typeHubs)
        })
    }
}

let site: Promise<PublishedSite> | undefined

/**
 * The published notes of this build. A build reads them one time; the dev
 * server reads them at each question, because a note can change under it.
 */
export function publishedSite(): Promise<PublishedSite> {
    if (import.meta.env.DEV) {
        return read()
    }
    site ??= read()
    return site
}
