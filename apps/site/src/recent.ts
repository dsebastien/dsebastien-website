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
//   import takes its `updated` property instead, or its `created` property
//   when `updated` holds no valid date.
// - A note of the import with no valid property has no date: it goes to the
//   end of the list, from A to Z, and its row shows no date.
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
    /** What the page shows: nothing for a note whose date is not known. */
    readonly date: NoteDate | undefined
    /**
     * `yyyy-mm-ddThh:mm:ss`: the time of a run in UTC, or the time of a
     * property as the vault writes it (an offset is not applied), so that the
     * order of a list is the order of the days that it shows. Empty for a
     * note whose date is not known: it goes to the end.
     */
    readonly key: string
}

/** A date that is known. */
type KnownDate = Dated & { readonly date: NoteDate }

/** The date of a note whose date is not known. */
const UNDATED: Dated = { date: undefined, key: '' }

/** The date of a run of the tool. */
function runDate(time: string): KnownDate {
    return {
        date: { datetime: time.slice(0, 10), shown: time.slice(0, 10) },
        key: time.slice(0, 19)
    }
}

/** The date of a property, or `undefined` when it holds no valid date. */
function propertyDated(value: unknown): KnownDate | undefined {
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

/** The day after a day: `2031-05-01` gives `2031-05-02`. */
function dayAfter(day: string): string {
    const next = new Date(`${day}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    return next.toISOString().slice(0, 10)
}

/**
 * The date of a note of the import: the first of its properties that holds
 * a valid date. A property more than one day after the import (a typo such
 * as `2041`) holds no valid date. One day of margin, because the import ran
 * in UTC and the vault writes local times. With no valid property, the note
 * has no date: its real date is not known.
 */
function importDate(properties: readonly unknown[], importRun: string): Dated {
    const latest = dayAfter(runDate(importRun).date.datetime)
    for (const property of properties) {
        const dated = propertyDated(property)
        if (dated !== undefined && compareCodePoints(dated.date.datetime, latest) <= 0) {
            return dated
        }
    }
    return UNDATED
}

/**
 * The date of the last update of a note, as the list `updated` dates it, for
 * the `lastmod` of the sitemaps (IDX-32): the time of the last publication
 * that changed it, in UTC, or for a note of the import the day of its
 * `updated` or `created` property. At the switch (decision R85, the one
 * deployment with `--switch`), a note that did not change since its first
 * publication takes its `updated` property too, else its `created`
 * property: its real last edit, not the day of its first publication. A
 * property more than one day after that publication holds no valid date.
 * `undefined` when the date is not known.
 */
export function lastUpdateOf(
    source: Pick<RecentSource, 'lastPublished' | 'created' | 'updated'> &
        Partial<Pick<RecentSource, 'firstPublished'>>,
    importRun: string | undefined,
    options: { readonly atSwitch?: boolean } = {}
): string | undefined {
    if (importRun !== undefined && source.lastPublished === importRun) {
        return importDate([source.updated, source.created], importRun).date?.datetime
    }
    if (source.lastPublished === '') {
        return undefined
    }
    if (options.atSwitch === true && source.firstPublished === source.lastPublished) {
        return (
            importDate([source.updated, source.created], source.lastPublished).date?.datetime ??
            source.lastPublished
        )
    }
    return source.lastPublished
}

/** What the recent lists need of the whole site. */
export interface RecentOptions {
    /** The run of the first publication of the content store, from every manifest entry (`readImportRun()`). */
    readonly importRun: string | undefined
    /** The plural label of each note type, as its hub names it, by canonical name. */
    readonly labels?: ReadonlyMap<string, string> | undefined
}

/**
 * The recent lists of the published notes: `added` and `updated`, then the
 * filter of each note type of each, by the plural label of the type.
 */
export function recentListsOf(
    sources: readonly RecentSource[],
    { importRun, labels }: RecentOptions
): NoteList[] {
    const datesOf: Record<RecentKind, (source: RecentSource) => Dated> = {
        added: (source) =>
            importRun !== undefined && source.firstPublished === importRun
                ? importDate([source.created], importRun)
                : runDate(source.firstPublished),
        updated: (source) =>
            importRun !== undefined && source.lastPublished === importRun
                ? importDate([source.updated, source.created], importRun)
                : runDate(source.lastPublished)
    }
    const types = new Map<string, string>()
    for (const { note } of sources) {
        if (note.type !== undefined && !types.has(note.type.name)) {
            types.set(note.type.name, labels?.get(note.type.name) ?? note.type.many)
        }
    }
    const byLabel = [...types].sort(
        ([oneName, one], [twoName, two]) =>
            compareCodePoints(one, two) || compareCodePoints(oneName, twoName)
    )
    const lists: NoteList[] = []
    const filters: NoteList[] = []
    for (const kind of ['added', 'updated'] as const) {
        // "Updated" holds the notes that changed after their first publication,
        // and the notes of the import (R62): a new note is in "added" only.
        const listed =
            kind === 'added'
                ? sources
                : sources.filter(
                      (source) =>
                          source.lastPublished !== source.firstPublished ||
                          source.firstPublished === importRun
                  )
        const ordered = newestFirst(
            listed.map((source) => ({ note: source.note, dated: datesOf[kind](source) }))
        ).map(({ note, dated }) => ({ ...note, date: dated.date }))
        // A filter for each type that this list holds.
        const present = new Set(ordered.map((note) => note.type?.name))
        const kindTypes = byLabel.filter(([name]) => present.has(name))
        const links: ListLink[] = [
            { label: 'All', path: recentPath(kind, 1) },
            ...kindTypes.map(([name, label]) => ({ label, path: recentTypePath(kind, name) }))
        ]
        const newest = ordered.slice(0, RECENT_NOTES)
        const verb = kind === 'added' ? 'added' : 'updated'
        lists.push({
            kind: 'recent',
            key: kind,
            label: NAMES[kind],
            count: newest.length,
            total: ordered.length,
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
        for (const [name, label] of kindTypes) {
            const all = ordered.filter((note) => note.type?.name === name)
            const ofType = all.slice(0, RECENT_NOTES_OF_A_TYPE)
            const title = `${kind === 'added' ? 'Recently added' : 'Recently updated'}: ${label}`
            filters.push({
                kind: 'recent',
                key: `${kind}/${name}`,
                label: title,
                count: ofType.length,
                total: all.length,
                indexed: false,
                media: false,
                filters: links,
                pages: listPages(
                    ofType,
                    () => recentTypePath(kind, name),
                    title,
                    () =>
                        `${label} of ${SITE_NAME} most recently ${verb}${all.length > ofType.length ? `: the ${count(ofType.length)} newest of ${count(all.length)}` : ', newest first'}.`,
                    { first: false, later: false },
                    [],
                    true
                )
            })
        }
    }
    return [...lists, ...filters]
}
