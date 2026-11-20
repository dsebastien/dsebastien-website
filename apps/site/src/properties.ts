import { tagPath } from '@dsebastien-website/resolver'
import { wikilinksOf } from '../../plugin/src/publishing/links.ts'

// The properties panel of a note page (issue 48, PAGE-02): every property of
// the published note (business rule 14), with the display rules of the site
// of today (`documentation/research/2026-11-17-current-state.md`, section
// 1.7), which a script of that site applies in the browser. Here the build
// applies them, so the properties are in the HTML that the server sends.
//
// - The name of a key shows in title case.
// - An empty value is hidden: nothing, a blank text, an empty list or object,
//   a list with only empty items, a date that the calendar does not have. The
//   key `position` is hidden.
// - A truth value shows with a mark, a number as a number, an object as JSON.
// - A date stays as the vault writes it: `2024-03-02`, or `2024-03-02, 09:00`
//   with a time. The site of today shows a time in the zone of the reader; a
//   static page shows the time of the vault (R59).
// - A wikilink is a link when its target is published, with the heading that
//   it names, and plain text when it is not (business rule 5).
// - A web address is a link to another site. The items of a list are apart.
//   The tags are links to their tag pages.

/** A piece of the text of a value. */
export type Piece =
    | { kind: 'text'; text: string }
    /** A link to a published note or to an attachment. */
    | { kind: 'link'; text: string; href: string }
    /** A link whose target is not published: plain text, with no address. */
    | { kind: 'not-published'; text: string }
    /** A link to another site. */
    | { kind: 'external'; text: string; href: string }
    | { kind: 'tag'; text: string; href: string }

/** One value: a property that is no list, or an item of a list. */
export type Scalar =
    | { kind: 'text'; pieces: Piece[] }
    | { kind: 'number'; text: string }
    | { kind: 'boolean'; value: boolean; text: string }
    | { kind: 'date'; datetime: string; text: string }
    | { kind: 'json'; text: string }

/** The value of a property, as the panel shows it. */
export type PropertyValue = Scalar | { kind: 'list'; items: Scalar[] }

/** A property of a note, as the panel shows it. */
export interface Property {
    /** The key as the note writes it. */
    key: string
    /** The name that the panel shows. */
    name: string
    value: PropertyValue
}

/**
 * The address that a link path of the note leads to, with the heading or the
 * block after `#`: the page of a published note, or an attachment.
 * `undefined` when the target is not published or does not exist.
 */
export type LinkOf = (linkPath: string, fragment: string) => string | undefined

/** A link of a property to a note, for the backlinks of its target. */
export interface PropertyLink {
    /** The name of the property, as the panel shows it. */
    name: string
    linkPath: string
    /** What a reader sees. */
    text: string
}

/** The keys that the panel never shows. `position` is a key of the reader of Obsidian. */
const HIDDEN = new Set(['position'])

/** The name of a key in title case: `date_of_birth`, `release-date` and `aiGenerated` are words. */
function nameOf(key: string): string {
    return key
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
        .split(/[\s_-]+/u)
        .filter((word) => word !== '')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u
const DATE_TIME =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/u

/** True when the calendar has this day. */
function isDay(year: number, month: number, day: number): boolean {
    const check = new Date(Date.UTC(year, month - 1, day))
    return (
        check.getUTCFullYear() === year &&
        check.getUTCMonth() === month - 1 &&
        check.getUTCDate() === day
    )
}

/**
 * A text in the form of a date: the date as the panel shows it, `null` for a
 * date that the calendar or the clock does not have, `undefined` for any
 * other text.
 */
function dateOfText(text: string): Scalar | null | undefined {
    const match = DATE.exec(text) ?? DATE_TIME.exec(text)
    if (match === null) {
        return undefined
    }
    const [, year = '', month = '', day = '', hour, minute] = match
    if (!isDay(Number(year), Number(month), Number(day))) {
        return null
    }
    const date = `${year}-${month}-${day}`
    if (hour === undefined || minute === undefined) {
        return { kind: 'date', datetime: date, text: date }
    }
    if (Number(hour) > 23 || Number(minute) > 59) {
        return null
    }
    return {
        kind: 'date',
        datetime: `${date}T${hour}:${minute}`,
        text: `${date}, ${hour}:${minute}`
    }
}

/** A date that the reader of the properties already read: its UTC fields are the text of the vault. */
function dateOfValue(value: Date): Scalar | undefined {
    if (Number.isNaN(value.getTime())) {
        return undefined
    }
    const iso = value.toISOString()
    const date = iso.slice(0, 10)
    const time = iso.slice(11, 16)
    // A date alone is read as midnight.
    return iso.slice(11) === '00:00:00.000Z'
        ? { kind: 'date', datetime: date, text: date }
        : { kind: 'date', datetime: `${date}T${time}`, text: `${date}, ${time}` }
}

/** True for the address of a page of the web. Only such an address becomes a link. */
function isWebAddress(text: string): boolean {
    if (!/^https?:\/\/\S+$/iu.test(text)) {
        return false
    }
    try {
        const { protocol } = new URL(text)
        return protocol === 'https:' || protocol === 'http:'
    } catch {
        return false
    }
}

/** The heading or the block that a wikilink names: the text after the first `#` of its target. */
function fragmentOf(written: string): string {
    const inner = written.slice(written.indexOf('[[') + 2, -2)
    const bar = inner.indexOf('|')
    const target = bar === -1 ? inner : inner.slice(0, bar)
    const hash = target.indexOf('#')
    return hash === -1 ? '' : target.slice(hash + 1).trim()
}

/** The pieces of a text: its wikilinks, and the text around them. */
function piecesOf(text: string, linkOf: LinkOf): Piece[] {
    if (isWebAddress(text)) {
        return [{ kind: 'external', text, href: text }]
    }
    const pieces: Piece[] = []
    let position = 0
    for (const link of wikilinksOf(text)) {
        if (link.start > position) {
            pieces.push({ kind: 'text', text: text.slice(position, link.start) })
        }
        position = link.end
        const shown = link.text.trim() === '' ? link.linkPath : link.text.trim()
        const href = linkOf(link.linkPath, fragmentOf(text.slice(link.start, link.end)))
        if (href !== undefined) {
            pieces.push({ kind: 'link', text: shown, href })
        } else if (link.linkPath === '') {
            // A link into the note itself whose heading the note does not have.
            pieces.push({ kind: 'text', text: shown })
        } else {
            pieces.push({ kind: 'not-published', text: shown })
        }
    }
    if (position < text.length) {
        pieces.push({ kind: 'text', text: text.slice(position) })
    }
    return pieces
}

/** One value as the panel shows it, or `undefined` for a value that it hides. */
function scalarOf(value: unknown, linkOf: LinkOf): Scalar | undefined {
    if (value === null || value === undefined) {
        return undefined
    }
    if (typeof value === 'string') {
        const text = value.trim()
        if (text === '') {
            return undefined
        }
        const date = dateOfText(text)
        if (date !== undefined) {
            return date ?? undefined
        }
        return { kind: 'text', pieces: piecesOf(text, linkOf) }
    }
    if (typeof value === 'boolean') {
        return { kind: 'boolean', value, text: value ? '✓ true' : '✗ false' }
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return { kind: 'number', text: String(value) }
    }
    if (value instanceof Date) {
        return dateOfValue(value)
    }
    if (typeof value !== 'object') {
        return undefined
    }
    if (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0) {
        return undefined
    }
    return { kind: 'json', text: JSON.stringify(value, null, 2) }
}

/** The tags of a note as links to their tag pages. */
function tagsOf(value: unknown): PropertyValue | undefined {
    const list = Array.isArray(value) ? value : [value]
    const items: Scalar[] = []
    for (const item of list) {
        const tag = typeof item === 'string' ? item.trim().replace(/^#/u, '') : ''
        if (tag !== '') {
            items.push({
                kind: 'text',
                pieces: [{ kind: 'tag', text: `#${tag}`, href: tagPath(tag) }]
            })
        }
    }
    return items.length === 0 ? undefined : { kind: 'list', items }
}

function valueOf(key: string, value: unknown, linkOf: LinkOf): PropertyValue | undefined {
    if (key === 'tags') {
        return tagsOf(value)
    }
    if (!Array.isArray(value)) {
        return scalarOf(value, linkOf)
    }
    const items = value.map((item) => scalarOf(item, linkOf)).filter((item) => item !== undefined)
    return items.length === 0 ? undefined : { kind: 'list', items }
}

/**
 * The properties of a note as the panel shows them, in the order of the note.
 *
 * @param properties the properties of the published note
 * @param linkOf where a link path of the note leads to
 */
export function propertiesOf(
    properties: Readonly<Record<string, unknown>>,
    linkOf: LinkOf
): Property[] {
    const shown: Property[] = []
    for (const [key, raw] of Object.entries(properties)) {
        if (HIDDEN.has(key)) {
            continue
        }
        const value = valueOf(key, raw, linkOf)
        if (value !== undefined) {
            shown.push({ key, name: nameOf(key), value })
        }
    }
    return shown
}

/**
 * The links of the properties of a note to other notes, in the order of the
 * note: the note is a backlink of each published target, with the name of the
 * property as the context of the link.
 */
export function propertyLinksOf(properties: Readonly<Record<string, unknown>>): PropertyLink[] {
    const links: PropertyLink[] = []
    for (const [key, raw] of Object.entries(properties)) {
        if (HIDDEN.has(key) || key === 'tags') {
            continue
        }
        for (const item of Array.isArray(raw) ? raw : [raw]) {
            if (typeof item !== 'string') {
                continue
            }
            for (const link of wikilinksOf(item)) {
                if (link.linkPath !== '') {
                    links.push({
                        name: nameOf(key),
                        linkPath: link.linkPath,
                        text: link.text.trim() === '' ? link.linkPath : link.text.trim()
                    })
                }
            }
        }
    }
    return links
}
