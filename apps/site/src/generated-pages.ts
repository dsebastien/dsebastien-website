import {
    LIBRARY_PATH,
    otherNotesPath,
    tagPagePath,
    typeHubPath
} from '@dsebastien-website/resolver'
import { byTitle, childTagsOf, isIndexedTag, notesByTag, pagesOf } from './lists.ts'
import type { NoteTypeBadge } from './note-header.ts'
import { fullTitle } from './page-titles.ts'
import { SITE_NAME } from './site.ts'

// The generated pages of the lists (NAV-03, NAV-04, IDX-22, decision R61):
// the type hub of each note type, the page of each tag and the library of
// the media types, with their paths, their titles and their descriptions.
// Each page of a list links to every page of it.

/** A note in a list of a generated page. */
export interface ListedNote {
    readonly vaultPath: string
    /** The canonical path of the note. */
    readonly path: string
    /** The title of the note, as its title band shows it. */
    readonly title: string
    /** The note type of the note, when it has one. */
    readonly type?: NoteTypeBadge | undefined
}

/** One page of a list. */
export interface ListPage {
    /** The number of the page, from 1. */
    readonly number: number
    readonly path: string
    readonly title: string
    readonly description: string
    readonly notes: readonly ListedNote[]
}

/** The list of a type hub or of a tag, with its pages. */
export interface NoteList {
    /** A type hub, a tag page, or the list of the notes with no type. */
    readonly kind: 'type' | 'tag' | 'other'
    /** The canonical name of the note type, the tag in small letters, or `other`. */
    readonly key: string
    /** What the page names: the plural label of the type, or `#tag`. */
    readonly label: string
    /** The number of notes of the list. */
    readonly count: number
    /** False for a page that search engines must not index (IDX-22). */
    readonly indexed: boolean
    readonly pages: readonly ListPage[]
    /** For a tag, its direct child tags. */
    readonly children: readonly string[]
    /** For a type hub, true when the type is a media type: its hub is in the library. */
    readonly media: boolean
}

/** A number as a reader reads it: `4,890`. */
function count(value: number): string {
    return value.toLocaleString('en')
}

function pageText(number: number, pages: number): string {
    return pages > 1 ? `, page ${String(number)} of ${String(pages)}` : ''
}

/** The pages of a list, with the title and the description of each. */
function listPages(
    notes: readonly ListedNote[],
    pathOf: (page: number) => string,
    name: string,
    about: (page: number, pages: number) => string
): ListPage[] {
    const pages = pagesOf(byTitle(notes))
    return pages.map((page, index) => {
        const number = index + 1
        return {
            number,
            path: pathOf(number),
            title: fullTitle(number === 1 ? name : `${name}, page ${String(number)}`),
            description: about(number, pages.length),
            notes: page
        }
    })
}

/** The type hub of each note type of the published notes, by the plural label of the type. */
export function typeHubsOf(notes: readonly ListedNote[]): NoteList[] {
    const byType = new Map<string, { badge: NoteTypeBadge; notes: ListedNote[] }>()
    for (const note of notes) {
        if (note.type === undefined) continue
        const hub = byType.get(note.type.name) ?? { badge: note.type, notes: [] }
        hub.notes.push(note)
        byType.set(note.type.name, hub)
    }
    const hubs = [...byType.values()].map(({ badge, notes: listed }) => ({
        kind: 'type' as const,
        key: badge.name,
        label: badge.many,
        count: listed.length,
        indexed: true,
        children: [],
        media: badge.media,
        pages: listPages(
            listed,
            (page) => typeHubPath(badge.name, page),
            badge.many,
            (page, pages) =>
                `${badge.many} of ${SITE_NAME}: ${count(listed.length)} notes from A to Z${pageText(page, pages)}.`
        )
    }))
    return byTitle(hubs.map((hub) => ({ ...hub, title: hub.label, vaultPath: hub.key })))
}

/** The label of the list of the notes with no type. */
export const OTHER_NOTES = 'Other notes'

/**
 * The list of the notes with no note type (decision R61): their crawl path
 * from the home page, as a type hub is for the notes of a type. `undefined`
 * when every note has a type.
 */
export function otherNotesOf(notes: readonly ListedNote[]): NoteList | undefined {
    const other = notes.filter((note) => note.type === undefined)
    if (other.length === 0) {
        return undefined
    }
    return {
        kind: 'other',
        key: 'other',
        label: OTHER_NOTES,
        count: other.length,
        indexed: true,
        children: [],
        media: false,
        pages: listPages(
            other,
            otherNotesPath,
            OTHER_NOTES,
            (page, pages) =>
                `${OTHER_NOTES} of ${SITE_NAME}: ${count(other.length)} notes with no note type, from A to Z${pageText(page, pages)}.`
        )
    }
}

/** The page of each tag of the published notes, in the order of the code points of the tags. */
export function tagListsOf(
    notes: readonly { note: ListedNote; tags: ReadonlySet<string> }[]
): NoteList[] {
    const byTag = notesByTag(notes)
    const tags = [...byTag.keys()]
    return [...byTag].map(([tag, listed]) => ({
        kind: 'tag' as const,
        key: tag,
        label: `#${tag}`,
        count: listed.length,
        indexed: isIndexedTag(tag, listed.length),
        children: childTagsOf(tag, tags),
        media: false,
        pages: listPages(
            listed,
            (page) => tagPagePath(tag, page),
            `#${tag}`,
            (page, pages) =>
                `Notes tagged #${tag} on ${SITE_NAME}: ${count(listed.length)} notes from A to Z${pageText(page, pages)}.`
        )
    }))
}

/** The title and the description of the home page. */
export const HOME = {
    title: fullTitle(),
    description: `${SITE_NAME}: thousands of connected notes about knowledge management, personal productivity, software, and the books, movies and games of their author.`
} as const

/** The library: the type hubs of the media types (NAV-03). */
export function libraryOf(hubs: readonly NoteList[]): {
    readonly path: string
    readonly title: string
    readonly description: string
    readonly hubs: readonly NoteList[]
} {
    const media = hubs.filter((hub) => hub.media)
    return {
        path: LIBRARY_PATH,
        title: fullTitle('Library'),
        description: `The library of ${SITE_NAME}: ${media.length === 0 ? 'no media yet' : media.map((hub) => `${hub.label} (${count(hub.count)})`).join(', ')}.`,
        hubs: media
    }
}

/** The titles and the descriptions of the indexed generated pages: no note may take one (IDX-04). */
export function generatedTexts(lists: readonly NoteList[]): {
    titles: Set<string>
    descriptions: Set<string>
} {
    const library = libraryOf(lists.filter((list) => list.kind === 'type'))
    const titles = new Set<string>([HOME.title, library.title])
    const descriptions = new Set<string>([HOME.description, library.description])
    for (const list of lists) {
        if (!list.indexed) continue
        for (const page of list.pages) {
            titles.add(page.title)
            descriptions.add(page.description)
        }
    }
    return { titles, descriptions }
}
