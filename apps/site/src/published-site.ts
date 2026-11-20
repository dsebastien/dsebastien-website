import { getCollection } from 'astro:content'
import { backlinkList, BACKLINKS_ON_PAGE, type ShownBacklink } from './backlink-list.ts'
import { readPublishedNotes, type PublishedNote } from './content-store.ts'
import { noteHeader, type NoteHeader } from './note-header.ts'
import { propertyLinksOf } from './properties.ts'
import { SitePages } from './rendering/page.ts'

// The published notes of one build, read one time: the manifest, the cleaned
// notes with the markup that Astro keeps, the pages of the build with their
// link index (BUILD-05, MOD-06), and what several pages ask about a note (its
// title band, its backlinks). The note pages, the pages with every backlink of
// a note and the resolver map all read this one object.

/** The published notes of a build. */
export interface PublishedSite {
    /** The published notes, in the order of their paths. */
    readonly notes: readonly PublishedNote[]
    /** The pages of the notes, and the link index of the build. */
    readonly pages: SitePages
    /** The properties of a published note. */
    propertiesOf(vaultPath: string): Readonly<Record<string, unknown>>
    /** The title band of a published note: its display title, its type badge and its dates. */
    headerOf(vaultPath: string): NoteHeader
    /** The backlinks of a published note, in the order of a page (R59). */
    backlinksOf(vaultPath: string): readonly ShownBacklink[]
    /** The notes with more backlinks than a note page holds: each has a page with all of them. */
    notesWithBacklinksPage(): readonly PublishedNote[]
}

/** The properties of a cleaned note, as the reader of the collection gives them: a record, or nothing. */
function propertiesOfEntry(data: unknown): Readonly<Record<string, unknown>> {
    return typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Readonly<Record<string, unknown>>)
        : {}
}

async function read(): Promise<PublishedSite> {
    const entries = new Map((await getCollection('notes')).map((entry) => [entry.id, entry]))
    const notes = await readPublishedNotes()
    const byPath = new Map(notes.map((note) => [note.vaultPath, note]))
    const properties = new Map<string, Readonly<Record<string, unknown>>>()
    const pages = new SitePages(
        notes.map((note) => {
            const entry = entries.get(note.vaultPath)
            if (entry === undefined) {
                throw new Error(`the content store has no cleaned note for "${note.vaultPath}"`)
            }
            if (entry.rendered === undefined) {
                throw new Error(`the note "${note.vaultPath}" has no markup`)
            }
            const data = propertiesOfEntry(entry.data)
            properties.set(note.vaultPath, data)
            // The pages of this build (BUILD-05): the markup of each note, which
            // Astro keeps between two builds, with its links and its embeds in
            // the state of this build.
            return {
                vaultPath: note.vaultPath,
                path: note.path,
                markup: entry.rendered.html,
                links: new Map(note.links.map((link) => [link.link, link.path])),
                files: new Map(note.attachments.map((file) => [file.link, file])),
                propertyLinks: propertyLinksOf(data)
            }
        })
    )
    const noteOf = (vaultPath: string): PublishedNote => {
        const note = byPath.get(vaultPath)
        if (note === undefined) {
            throw new Error(`the note "${vaultPath}" is not published`)
        }
        return note
    }
    const headers = new Map<string, NoteHeader>()
    const headerOf = (vaultPath: string): NoteHeader => {
        let header = headers.get(vaultPath)
        if (header === undefined) {
            const note = noteOf(vaultPath)
            const heading = pages.heading(vaultPath)
            header = noteHeader({
                fileName: note.title,
                properties: properties.get(vaultPath) ?? {},
                ...(heading === undefined ? {} : { firstHeading: heading.text }),
                firstPublished: note.firstPublished,
                lastPublished: note.lastPublished
            })
            headers.set(vaultPath, header)
        }
        return header
    }
    const backlinks = new Map<string, readonly ShownBacklink[]>()
    const backlinksOf = (vaultPath: string): readonly ShownBacklink[] => {
        let list = backlinks.get(vaultPath)
        if (list === undefined) {
            list = backlinkList(pages.backlinks(vaultPath), (path) => {
                const header = headerOf(path)
                return { title: header.title, updated: header.updated.datetime }
            })
            backlinks.set(vaultPath, list)
        }
        return list
    }
    return {
        notes,
        pages,
        propertiesOf: (vaultPath) => {
            noteOf(vaultPath)
            return properties.get(vaultPath) ?? {}
        },
        headerOf,
        backlinksOf,
        notesWithBacklinksPage: () =>
            notes.filter((note) => pages.backlinks(note.vaultPath).length > BACKLINKS_ON_PAGE)
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
