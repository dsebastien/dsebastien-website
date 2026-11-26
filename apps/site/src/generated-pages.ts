import {
    LIBRARY_PATH,
    otherNotesPath,
    tagPagePath,
    typeHubPath
} from '@dsebastien-website/resolver'
import { compareCodePoints } from '../../plugin/src/publishing/order.ts'
import {
    byTitle,
    childTagsOf,
    INDEXED_LIST_NOTES,
    isIndexedTag,
    notesByTag,
    pagesOf,
    type Listed
} from './lists.ts'
import type { NoteDate, NoteTypeBadge } from './note-header.ts'
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
    /** In a recent list, the date that orders the note (R62). */
    readonly date?: NoteDate | undefined
}

/** A link of a list page to another list: a nested tag, or a filter of a recent list. */
export interface ListLink {
    readonly label: string
    readonly path: string
}

/** One page of a list. */
export interface ListPage {
    /** The number of the page, from 1. */
    readonly number: number
    readonly path: string
    readonly title: string
    readonly description: string
    readonly notes: readonly ListedNote[]
    /** For page 1 of a tag, its direct child tags, as most of their notes write them; nothing on a later page. */
    readonly children: readonly ListLink[]
    /** False for a page that search engines must not index (IDX-22, IDX-23). */
    readonly indexed: boolean
}

/** The list of a type hub or of a tag, with its pages. */
export interface NoteList {
    /** A type hub, a tag page, the list of the notes with no type, or a recent list. */
    readonly kind: 'type' | 'tag' | 'other' | 'recent'
    /**
     * The canonical name of the note type, the folded form of the tag,
     * `other`, or the recent list: `added`, `updated`, `added/<type>`.
     */
    readonly key: string
    /** What the page names: the plural label of the type, or `#tag` as most of its notes write it. */
    readonly label: string
    /** The number of notes of the list. */
    readonly count: number
    /** For a recent list, the number of notes that it is cut from: its newest notes are listed. */
    readonly total?: number
    /** False for a list whose pages search engines must not index (IDX-22). */
    readonly indexed: boolean
    readonly pages: readonly ListPage[]
    /** For a recent list, the links of its filter by note type, with `All` first. */
    readonly filters: readonly ListLink[]
    /** For a type hub, true when the type is a media type: its hub is in the library. */
    readonly media: boolean
}

/** A number as a reader reads it: `4,890`. */
export function count(value: number): string {
    return value.toLocaleString('en')
}

export function pageText(number: number, pages: number): string {
    return pages > 1 ? `, page ${String(number)} of ${String(pages)}` : ''
}

/**
 * The pages of a list, with the title and the description of each.
 *
 * @param indexed whether page 1 and the later pages are indexed
 * @param ordered true when the notes are already in the order of the list
 */
export function listPages(
    notes: readonly ListedNote[],
    pathOf: (page: number) => string,
    name: string,
    about: (page: number, pages: number) => string,
    indexed: { first: boolean; later: boolean },
    children: readonly ListLink[] = [],
    ordered = false
): ListPage[] {
    const pages = pagesOf(ordered ? notes : byTitle(notes))
    return pages.map((page, index) => {
        const number = index + 1
        return {
            number,
            path: pathOf(number),
            title: fullTitle(number === 1 ? name : `${name}, page ${String(number)}`),
            description: about(number, pages.length),
            notes: page,
            children: number === 1 ? children : [],
            indexed: number === 1 ? indexed.first : indexed.later
        }
    })
}

/** The type hub of each note type of the published notes, by the plural label of the type. */
export function typeHubsOf(notes: readonly ListedNote[]): NoteList[] {
    const byType = new Map<string, { badges: Map<string, number>; notes: ListedNote[] }>()
    for (const note of notes) {
        if (note.type === undefined) continue
        const hub = byType.get(note.type.name) ?? {
            badges: new Map<string, number>(),
            notes: [] as ListedNote[]
        }
        // The entries of one type can hold two labels for a time: after a
        // rename in the Starter Kit, until every technical update is published.
        const key = JSON.stringify(note.type)
        hub.badges.set(key, (hub.badges.get(key) ?? 0) + 1)
        hub.notes.push(note)
        byType.set(note.type.name, hub)
    }
    const hubs = [...byType.values()].map(({ badges, notes: listed }) => ({
        badge: [...badges].sort(
            ([one, many], [two, more]) => more - many || compareCodePoints(one, two)
        )[0]?.[0],
        listed
    }))
    return byTitle(
        hubs.map(({ badge, listed }) => {
            const type = JSON.parse(badge ?? '{}') as NoteTypeBadge
            return hubOf(type, listed)
        })
    )
}

/** The type hub of one note type: the label that most of its notes have. */
function hubOf(badge: NoteTypeBadge, listed: readonly ListedNote[]): NoteList & Listed {
    const indexed = listed.length >= INDEXED_LIST_NOTES
    return {
        title: badge.many,
        vaultPath: badge.name,
        kind: 'type' as const,
        key: badge.name,
        label: badge.many,
        count: listed.length,
        indexed,
        media: badge.media,
        filters: [],
        pages: listPages(
            listed,
            (page) => typeHubPath(badge.name, page),
            badge.many,
            (page, pages) =>
                `${badge.many} of ${SITE_NAME}: ${count(listed.length)} notes from A to Z${pageText(page, pages)}.`,
            { first: indexed, later: indexed }
        )
    }
}

/** The label of the list of the notes with no type. */
export const OTHER_NOTES = 'Other notes'

/**
 * The list of the notes with no note type (decision R61): their crawl path
 * from the home page, as a type hub is for the notes of a type. Search
 * engines follow its links but do not index it (IDX-22). `undefined` when
 * every note has a type.
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
        indexed: false,
        media: false,
        filters: [],
        pages: listPages(
            other,
            otherNotesPath,
            OTHER_NOTES,
            (page, pages) =>
                `${OTHER_NOTES} of ${SITE_NAME}: ${count(other.length)} notes with no note type, from A to Z${pageText(page, pages)}.`,
            { first: false, later: false }
        )
    }
}

/** The form of a tag that most of its notes write, then the first in the order of the code points. */
function writtenForm(forms: ReadonlyMap<string, number>): string | undefined {
    return [...forms].sort(
        ([one, many], [two, more]) => more - many || compareCodePoints(one, two)
    )[0]?.[0]
}

/**
 * The page of each tag of the published notes, in the order of the code
 * points of the tags. Its path is the folded form of the tag; it names the
 * tag as most of its notes write it.
 */
export function tagListsOf(
    notes: readonly { note: ListedNote; tags: ReadonlyMap<string, string> }[]
): NoteList[] {
    const byTag = notesByTag(notes)
    const forms = new Map<string, Map<string, number>>()
    for (const { tags } of notes) {
        for (const [tag, written] of tags) {
            const counts = forms.get(tag) ?? new Map<string, number>()
            counts.set(written, (counts.get(written) ?? 0) + 1)
            forms.set(tag, counts)
        }
    }
    const labels = new Map(
        [...byTag.keys()].map((tag) => [
            tag,
            `#${writtenForm(forms.get(tag) ?? new Map<string, number>()) ?? tag}`
        ])
    )
    const tags = [...byTag.keys()]
    return [...byTag].map(([tag, listed]) => {
        const label = labels.get(tag) ?? `#${tag}`
        const children = childTagsOf(tag, tags).map((child) => ({
            label: labels.get(child) ?? `#${child}`,
            path: tagPagePath(child, 1)
        }))
        const indexed = isIndexedTag(tag, listed.length)
        return {
            kind: 'tag' as const,
            key: tag,
            label,
            count: listed.length,
            indexed,
            media: false,
            filters: [],
            pages: listPages(
                listed,
                (page) => tagPagePath(tag, page),
                label,
                (page, pages) =>
                    `Notes tagged ${label} on ${SITE_NAME}: ${count(listed.length)} notes from A to Z${pageText(page, pages)}.`,
                { first: indexed, later: indexed },
                children
            )
        }
    })
}

/** The title and the description of the home page. */
export const HOME = {
    title: fullTitle(),
    description: `${SITE_NAME}: thousands of connected notes about knowledge management, personal productivity, software, and the books, movies and games of their author.`
} as const

/**
 * The library: the type hubs of the media types (NAV-03). It is indexed as a
 * curated list (IDX-22, R61) when one of its hubs is indexed: with no hub, or
 * only hubs under the floor of 5 notes, it is a thin page (issue 98).
 */
export function libraryOf(hubs: readonly NoteList[]): {
    readonly path: string
    readonly title: string
    readonly description: string
    readonly hubs: readonly NoteList[]
    readonly indexed: boolean
} {
    const media = hubs.filter((hub) => hub.media)
    return {
        path: LIBRARY_PATH,
        title: fullTitle('Library'),
        description: `The library of ${SITE_NAME}: ${media.length === 0 ? 'no media yet' : media.map((hub) => `${hub.label} (${count(hub.count)})`).join(', ')}.`,
        hubs: media,
        indexed: media.some((hub) => hub.indexed)
    }
}

/** A list as a message names it. */
function listName(list: NoteList): string {
    return {
        type: `the type hub of the note type "${list.key}"`,
        tag: `the page of the tag "${list.key}"`,
        other: 'the list of the notes with no type',
        recent: `the recent list "${list.key}"`
    }[list.kind]
}

/**
 * The titles and the descriptions of the indexed generated pages: no note
 * may take one (IDX-04). It throws when two generated pages share a title,
 * indexed or not: a reader could not tell them apart.
 */
export function generatedTexts(lists: readonly NoteList[]): {
    titles: Set<string>
    descriptions: Set<string>
} {
    const library = libraryOf(lists.filter((list) => list.kind === 'type'))
    // The page that has each title, to name both pages of a shared one.
    const owners = new Map<string, string>([
        [HOME.title, 'the home page'],
        [library.title, 'the library']
    ])
    const descriptions = new Set<string>([HOME.description])
    const titles = new Set<string>([HOME.title])
    if (library.indexed) {
        titles.add(library.title)
        descriptions.add(library.description)
    }
    for (const list of lists) {
        for (const page of list.pages) {
            const owner = owners.get(page.title)
            if (owner !== undefined) {
                throw new Error(
                    `two generated pages have the title "${page.title}" (IDX-04): ${owner} and ${listName(list)}. Give a note type another label in the table of the site`
                )
            }
            owners.set(page.title, listName(list))
            if (page.indexed) {
                titles.add(page.title)
                descriptions.add(page.description)
            }
        }
    }
    return { titles, descriptions }
}
