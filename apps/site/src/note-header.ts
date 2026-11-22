// The title band of a note page (issue 47, R58): the display title, the type
// badge and the created and updated dates.
//
// The display title follows IDX-03 and R23: the `title` property when it says
// something else than the file name (with or without the prefix and the
// suffix of the note type), else the first heading of the note, else the
// file name without the prefix and the suffix of its note type. The type
// badge is the label of the note type that the Starter Kit gives the note
// (decision R61, issue 49).
//
// The dates are the `created` and `updated` properties of the published note,
// as the vault writes them, so they do not move at the switch (IDX-32). A note
// without a valid date property shows the date of its first or its last
// publication instead.

import { typeLabelOf, type TypeLabel } from './type-labels.ts'

/** The note type of a published note, as its manifest entry holds it. */
export interface HeaderNoteType {
    readonly name: string
    readonly displayName: string
    readonly prefix?: string
    readonly suffix?: string
}

/** What the title band needs to know of a note. */
export interface NoteHeaderInput {
    /** The file name of the note, without `.md`. */
    fileName: string
    /** The note type of the note, when it has one. */
    noteType?: HeaderNoteType
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

/** The type badge of a note: the canonical name and the labels of its note type. */
export type NoteTypeBadge = TypeLabel & { readonly name: string }

/** The title band of a note page. */
export interface NoteHeader {
    title: string
    /** The file name of the note without the prefix and the suffix of its note type. */
    bareName: string
    /** The note type of the note, or `undefined` when the note has none. */
    type?: NoteTypeBadge
    created: NoteDate
    updated: NoteDate
}

/** The title band of a note page. */
export function noteHeader(input: NoteHeaderInput): NoteHeader {
    const type =
        input.noteType === undefined
            ? undefined
            : { name: input.noteType.name, ...typeLabelOf(input.noteType) }
    const bareName = bareNameOf(input.fileName, input.noteType)
    return {
        title: titleOf(input, bareName),
        bareName,
        ...(type === undefined ? {} : { type }),
        created: dateOf(input.properties['created']) ?? dateOfTime(input.firstPublished),
        updated: dateOf(input.properties['updated']) ?? dateOfTime(input.lastPublished)
    }
}

/** A prefix or a suffix with a token of the Starter Kit (`{{date}}`): the site cannot tell its text. */
const TOKEN = /\{\{[^}]*\}\}/u

/**
 * The file name without the prefix and the suffix of its note type, when it
 * carries them as the Starter Kit gives them. An affix with a token, or one
 * that would leave no name, stays.
 */
function bareNameOf(fileName: string, noteType: HeaderNoteType | undefined): string {
    let name = fileName
    const prefix = noteType?.prefix
    if (prefix !== undefined && !TOKEN.test(prefix) && name.startsWith(prefix)) {
        name = name.slice(prefix.length)
    }
    const suffix = noteType?.suffix
    if (suffix !== undefined && !TOKEN.test(suffix) && name.endsWith(suffix)) {
        name = name.slice(0, name.length - suffix.length)
    }
    return name.trim() === '' ? fileName : name
}

function titleOf(
    { fileName, properties, firstHeading }: NoteHeaderInput,
    bareName: string
): string {
    const property = properties['title']
    if (typeof property === 'string') {
        const title = property.trim()
        // A tool of the vault can fill the property with the file name: it says nothing (R23).
        if (title !== '' && title !== fileName && title !== bareName) {
            return title
        }
    }
    if (firstHeading !== undefined && firstHeading.trim() !== '') {
        return firstHeading.trim()
    }
    return bareName
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
