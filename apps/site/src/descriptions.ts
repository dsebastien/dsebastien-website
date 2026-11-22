import { smallLetters } from '@dsebastien-website/resolver'
import type { Element, Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toText } from 'hast-util-to-text'
import { SITE_NAME } from './site.ts'

// The description of a page (IDX-05, IDX-04, decision R61): the `description`
// property of a note; else a sentence from its note type and its properties,
// with the data that only this site has first (the rating and the status of
// the author), then the first sentences of its text, cut at a word end. It
// is never empty. No two indexable pages share one: when they would, each
// note of them gets its title in front.

/** The longest description that the build writes, in characters, the end mark included. */
export const DESCRIPTION_LENGTH = 155

/** The properties of a year, in the order in which they are read. */
const YEAR_KEYS = ['release_date', 'first_aired', 'published_on'] as const

/** The properties of the people who made the work, in the order in which they are read. */
const CREATOR_KEYS = ['authors', 'directors', 'developers', 'author', 'creators'] as const

/** What the description of a note is made from. */
export interface DescriptionInput {
    /** The display title of the note. */
    readonly title: string
    /** The label of its note type, when it has one. */
    readonly typeLabel?: string | undefined
    readonly properties: Readonly<Record<string, unknown>>
    /** The body of the note page, as HTML. */
    readonly html: string
}

/** The text of a link of the vault: `[[Ada Quillfeather|Ada]]` gives `Ada`. */
function shownText(value: string): string {
    const link = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/u.exec(value.trim())
    return (link?.[2] ?? link?.[1] ?? value).trim()
}

function textsOf(value: unknown): string[] {
    const list = Array.isArray(value) ? value : [value]
    return list
        .filter(
            (item): item is string | number => typeof item === 'string' || typeof item === 'number'
        )
        .map((item) => shownText(String(item)))
        .filter((item) => item !== '')
}

/** The year of a property that holds a date, a year or a text that starts with one. */
function yearOf(properties: DescriptionInput['properties']): string | undefined {
    for (const key of YEAR_KEYS) {
        const year = /^(\d{4})(?:$|[-T ])/u.exec(textsOf(properties[key])[0] ?? '')?.[1]
        if (year !== undefined) {
            return year
        }
    }
    return undefined
}

function creatorsOf(properties: DescriptionInput['properties']): string | undefined {
    for (const key of CREATOR_KEYS) {
        const names = textsOf(properties[key])
        if (names.length === 1) return `by ${names[0] ?? ''}`
        if (names.length === 2) return `by ${names[0] ?? ''} and ${names[1] ?? ''}`
        if (names.length > 2) return `by ${names[0] ?? ''}, ${names[1] ?? ''} and others`
    }
    return undefined
}

/** The sentence from the note type and the properties: `Movie, 2010, by Ada Quillfeather, rated 8 by Sébastien, watched.` */
function factsOf(input: DescriptionInput): string | undefined {
    const rating = textsOf(input.properties['rating'])[0]
    const status = textsOf(input.properties['status'])[0]
    const parts = [
        input.typeLabel,
        yearOf(input.properties),
        creatorsOf(input.properties),
        rating === undefined ? undefined : `rated ${rating} by Sébastien`,
        status === undefined ? undefined : smallLetters(status)
    ].filter((part): part is string => part !== undefined && part !== '')
    return parts.length === 0 ? undefined : `${parts.join(', ')}.`
}

/** The text of the paragraphs and the list items of a body, in their order. */
export function plainTextOf(html: string): string {
    const texts: string[] = []
    const walk = (nodes: readonly (Root | RootContent)[]): void => {
        for (const node of nodes) {
            if (node.type !== 'element' && node.type !== 'root') continue
            if (node.type === 'element' && isSkipped(node)) continue
            if (node.type === 'element' && (node.tagName === 'p' || node.tagName === 'li')) {
                texts.push(toText(node, { whitespace: 'normal' }))
                continue
            }
            walk(node.children)
        }
    }
    walk([fromHtml(html, { fragment: true })])
    return texts
        .map((text) => text.replace(/\s+/gu, ' ').trim())
        .filter((text) => text !== '')
        .join(' ')
}

/** Parts of a body that are no running text: code, diagrams, math, scripts. */
function isSkipped(element: Element): boolean {
    return ['pre', 'svg', 'math', 'script', 'style', 'template', 'nav'].includes(element.tagName)
}

/** The text cut at a word end, with an end mark, when it is longer than the limit. */
function cut(text: string): string {
    if (text.length <= DESCRIPTION_LENGTH) {
        return text
    }
    const room = text.slice(0, DESCRIPTION_LENGTH - 1)
    const end = room.lastIndexOf(' ')
    return `${(end > DESCRIPTION_LENGTH / 2 ? room.slice(0, end) : room).replace(/[\s,;:.]+$/u, '')}…`
}

/** The description of a note page (IDX-05). */
export function noteDescription(input: DescriptionInput): string {
    const property = input.properties['description']
    if (typeof property === 'string' && property.trim() !== '') {
        return property.trim().replace(/\s+/gu, ' ')
    }
    const text = [factsOf(input), plainTextOf(input.html)]
        .filter((part) => part !== undefined && part !== '')
        .join(' ')
    return text === '' ? `${input.title}, a note of ${SITE_NAME}.` : cut(text)
}

/**
 * The descriptions of the notes, so that no two indexable pages share one:
 * a description that more than one page has gets the title of each note in
 * front. `taken` holds the descriptions of the other indexable pages. It
 * throws when two pages still share one: the build stops and names them.
 */
export function uniqueDescriptions(
    items: readonly { key: string; title: string; description: string }[],
    taken: ReadonlySet<string> = new Set()
): Map<string, string> {
    const count = new Map<string, number>()
    for (const item of items) {
        count.set(item.description, (count.get(item.description) ?? 0) + 1)
    }
    const result = new Map<string, string>()
    for (const item of items) {
        const shared = (count.get(item.description) ?? 0) > 1 || taken.has(item.description)
        result.set(item.key, shared ? `${item.title}: ${item.description}` : item.description)
    }
    const seen = new Map<string, string>()
    for (const [key, description] of result) {
        const other = seen.get(description)
        if (other !== undefined || taken.has(description)) {
            throw new Error(
                `two pages share the description "${description}" (IDX-04): "${other ?? 'a generated page'}" and "${key}". Give one of them a description property`
            )
        }
        seen.set(description, key)
    }
    return result
}
