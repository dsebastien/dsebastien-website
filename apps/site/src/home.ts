import type { ListedNote } from './generated-pages.ts'
import { byTitle } from './lists.ts'

// The parts of the home page that the build computes (NAV-02, decision R62):
// the entry points by topic and the stats line.

/** The most maps of content on the home page. */
export const TOPICS_ON_HOME = 12

/** The most notes of each recent list on the home page. */
export const RECENT_ON_HOME = 10

/** The note type of a map of content. */
const MAPS_OF_CONTENT = 'maps-of-content'

/** A note with the number of published notes that link to it. */
export interface Linked {
    readonly note: ListedNote
    readonly backlinks: number
}

/** The entry points by topic: the maps of content that most published notes link to, then A to Z. */
export function topicsOf(notes: readonly Linked[]): Linked[] {
    const maps = notes.filter((item) => item.note.type?.name === MAPS_OF_CONTENT)
    const order = new Map(
        byTitle(maps.map((item) => item.note)).map((note, index) => [note, index])
    )
    return [...maps]
        .sort(
            (one, two) =>
                two.backlinks - one.backlinks ||
                (order.get(one.note) ?? 0) - (order.get(two.note) ?? 0)
        )
        .slice(0, TOPICS_ON_HOME)
}

/** What the stats line counts. */
export interface SiteStats {
    readonly notes: number
    readonly types: number
    readonly tags: number
    /** The date of the newest update, as the recent list shows it. */
    readonly lastUpdate: string
}

function counted(value: number, one: string, many: string): string {
    return `${value.toLocaleString('en')} ${value === 1 ? one : many}`
}

/** The stats line of the home page: `20,734 notes, 34 note types and 856 tags. Last update: 2031-05-02.` */
export function statsLine(stats: SiteStats): string {
    return `${counted(stats.notes, 'note', 'notes')}, ${counted(stats.types, 'note type', 'note types')} and ${counted(stats.tags, 'tag', 'tags')}. Last update: ${stats.lastUpdate}.`
}
