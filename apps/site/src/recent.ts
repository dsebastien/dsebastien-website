import { recentPath, recentTypePath, type RecentKind } from '@dsebastien-website/resolver'
import { compareCodePoints } from '../../plugin/src/publishing/order.ts'
import {
    count,
    listPages,
    pageText,
    type ListedNote,
    type ListLink,
    type NoteList
} from './generated-pages.ts'
import { byTitle } from './lists.ts'
import { propertyDate, type NoteDate } from './note-header.ts'
import { SITE_NAME } from './site.ts'

// The recent lists (NAV-05, PUB-70, PUB-71, decision R62): the notes most
// recently added and most recently updated, newest first.
//
// - Added: the date of the first publication of the note. A note of the
//   import (the first publication of the content store: the run of the
//   earliest `firstPublished`) takes its `created` property instead, so the
//   import keeps the dates of the vault.
// - Updated: the date of the last publication that changed the note (a
//   technical update does not move it). A note that has not changed since the
//   import takes its `updated` property instead.
//
// Each list holds the 1,000 newest notes, 100 per page; only page 1 is
// indexed. The filter of a note type is one page with its 100 newest notes,
// not indexed.

/** The most notes of a recent list. */
export const RECENT_NOTES = 1000

/** The most notes of the filter of a note type. */
export const RECENT_NOTES_OF_A_TYPE = 100

/** What a recent list knows of a published note. */
export interface RecentSource {
    readonly note: ListedNote
    /** The time of the run of the first publication, in UTC. */
    readonly firstPublished: string
    /** The time of the run of the last publication that changed the note, in UTC. */
    readonly lastPublished: string
    /** The `created` property of the published note. */
    readonly created: unknown
    /** The `updated` property of the published note. */
    readonly updated: unknown
}

/** A date of a recent list: what the page shows, and a key that orders it. */
interface Dated {
    readonly date: NoteDate
    /** `yyyy-mm-ddThh:mm:ss`: the time of a run in UTC, or the time of a property as the vault writes it. */
    readonly key: string
}

/** The date of a run of the tool. */
function runDate(time: string): Dated {
    return {
        date: { datetime: time.slice(0, 10), shown: time.slice(0, 10) },
        key: time.slice(0, 19)
    }
}

/** The date of a property, or `undefined` when it holds no valid date. */
function propertyDated(value: unknown): Dated | undefined {
    const date = propertyDate(value)
    if (date === undefined) {
        return undefined
    }
    const text = typeof value === 'string' ? value.trim() : ''
    const time = /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2}(?::\d{2})?)/u.exec(text)?.[1] ?? '00:00:00'
    return { date, key: `${date.datetime}T${time.padEnd(8, ':00')}` }
}

/** The labels of the two lists. */
const NAMES: Readonly<Record<RecentKind, string>> = {
    added: 'Recently added notes',
    updated: 'Recently updated notes'
}

function newestFirst<T extends { dated: Dated; note: ListedNote }>(items: readonly T[]): T[] {
    const titles = new Map(
        byTitle(items.map((item) => item.note)).map((note, index) => [note, index])
    )
    return [...items].sort(
        (one, two) =>
            compareCodePoints(two.dated.key, one.dated.key) ||
            (titles.get(one.note) ?? 0) - (titles.get(two.note) ?? 0)
    )
}

/**
 * The recent lists of the published notes: `added` and `updated`, then the
 * filter of each note type of each, by the plural label of the type.
 */
export function recentListsOf(sources: readonly RecentSource[]): NoteList[] {
    const firstRuns = sources.map((source) => source.firstPublished).sort(compareCodePoints)
    const importRun = firstRuns[0]
    const datesOf: Record<RecentKind, (source: RecentSource) => Dated> = {
        added: (source) =>
            (source.firstPublished === importRun ? propertyDated(source.created) : undefined) ??
            runDate(source.firstPublished),
        updated: (source) =>
            (source.lastPublished === importRun ? propertyDated(source.updated) : undefined) ??
            runDate(source.lastPublished)
    }
    const types = new Map<string, string>()
    for (const { note } of sources) {
        if (note.type !== undefined) {
            types.set(note.type.name, note.type.many)
        }
    }
    const byLabel = [...types].sort(
        ([oneName, one], [twoName, two]) =>
            compareCodePoints(one, two) || compareCodePoints(oneName, twoName)
    )
    const lists: NoteList[] = []
    const filters: NoteList[] = []
    for (const kind of ['added', 'updated'] as const) {
        const ordered = newestFirst(
            sources.map((source) => ({ note: source.note, dated: datesOf[kind](source) }))
        ).map(({ note, dated }) => ({ ...note, date: dated.date }))
        const links: ListLink[] = [
            { label: 'All', path: recentPath(kind, 1) },
            ...byLabel.map(([name, label]) => ({ label, path: recentTypePath(kind, name) }))
        ]
        const newest = ordered.slice(0, RECENT_NOTES)
        const verb = kind === 'added' ? 'added' : 'updated'
        lists.push({
            kind: 'recent',
            key: kind,
            label: NAMES[kind],
            count: newest.length,
            indexed: true,
            media: false,
            filters: links,
            pages: listPages(
                newest,
                (page) => recentPath(kind, page),
                NAMES[kind],
                (page, pages) =>
                    `The ${count(newest.length)} notes of ${SITE_NAME} most recently ${verb}, newest first${pageText(page, pages)}.`,
                { first: true, later: false },
                [],
                true
            )
        })
        for (const [name, label] of byLabel) {
            const ofType = ordered
                .filter((note) => note.type?.name === name)
                .slice(0, RECENT_NOTES_OF_A_TYPE)
            const title = `${kind === 'added' ? 'Recently added' : 'Recently updated'}: ${label}`
            filters.push({
                kind: 'recent',
                key: `${kind}/${name}`,
                label: title,
                count: ofType.length,
                indexed: false,
                media: false,
                filters: links,
                pages: listPages(
                    ofType,
                    () => recentTypePath(kind, name),
                    title,
                    () =>
                        `The ${count(ofType.length)} ${label} of ${SITE_NAME} most recently ${verb}, newest first.`,
                    { first: false, later: false },
                    [],
                    true
                )
            })
        }
    }
    return [...lists, ...filters]
}
