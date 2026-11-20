// The title band of a note page (issue 47, R58): the display title, the type
// badge and the created and updated dates.
//
// The display title follows IDX-03: the `title` property when it says
// something else than the file name, else the first heading of the note,
// else the file name. The prefix and the suffix of the note type are not
// taken off yet: the note types come with issue 49, which also replaces the
// type badge read here from the first `type/` tag.
//
// The dates are the `created` and `updated` properties of the published note,
// as the vault writes them, so they do not move at the switch (IDX-32). A note
// without a valid date property shows the date of its first or its last
// publication instead.

/** What the title band needs to know of a note. */
export interface NoteHeaderInput {
    /** The file name of the note, without `.md`. */
    fileName: string
    /** The properties of the published note. */
    properties: Readonly<Record<string, unknown>>
    /** The text of the H1 at the top of the note, when it starts with one. */
    firstHeading?: string
    /** The time of the first publication, in UTC. */
    firstPublished: string
    /** The time of the last publication that changed the note, in UTC. */
    lastPublished: string
}

/** A date of the title band. */
export interface NoteDate {
    /** The value of the `datetime` attribute: `2024-03-02`. */
    datetime: string
    /** The date as the page shows it. */
    shown: string
}

/** The title band of a note page. */
export interface NoteHeader {
    title: string
    /** The name of the note type, or `undefined` when the note has none. */
    type?: string
    created: NoteDate
    updated: NoteDate
}

/** The title band of a note page. */
export function noteHeader(input: NoteHeaderInput): NoteHeader {
    const type = typeOf(input.properties['tags'])
    return {
        title: titleOf(input),
        ...(type === undefined ? {} : { type }),
        created: dateOf(input.properties['created']) ?? dateOfTime(input.firstPublished),
        updated: dateOf(input.properties['updated']) ?? dateOfTime(input.lastPublished)
    }
}

function titleOf({ fileName, properties, firstHeading }: NoteHeaderInput): string {
    const property = properties['title']
    if (typeof property === 'string' && property.trim() !== '' && property.trim() !== fileName) {
        return property.trim()
    }
    if (firstHeading !== undefined && firstHeading.trim() !== '') {
        return firstHeading.trim()
    }
    return fileName
}

const TYPE_TAG = /^#?type\/(.+)$/u

function typeOf(tags: unknown): string | undefined {
    const list = typeof tags === 'string' ? [tags] : Array.isArray(tags) ? tags : []
    for (const tag of list) {
        const match = typeof tag === 'string' ? TYPE_TAG.exec(tag.trim()) : null
        const name = match?.[1]?.replace(/[_-]+/gu, ' ').trim()
        if (name !== undefined && name !== '') {
            return name.charAt(0).toUpperCase() + name.slice(1)
        }
    }
    return undefined
}

/** The date at the start of a property: `2024-03-02`, then nothing, a time after `T`, or a time after a space. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/u

function dateOf(value: unknown): NoteDate | undefined {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : day(value.toISOString().slice(0, 10))
    }
    if (typeof value !== 'string') {
        return undefined
    }
    const match = DATE.exec(value.trim())
    if (match === null) {
        return undefined
    }
    const [, year, month, date] = match.map(Number)
    if (year === undefined || month === undefined || date === undefined) {
        return undefined
    }
    // A day that the calendar does not have (`2031-02-30`) is not a date.
    const check = new Date(Date.UTC(year, month - 1, date))
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
        return undefined
    }
    return day(value.trim().slice(0, 10))
}

function dateOfTime(time: string): NoteDate {
    return day(time.slice(0, 10))
}

function day(iso: string): NoteDate {
    return { datetime: iso, shown: iso }
}
