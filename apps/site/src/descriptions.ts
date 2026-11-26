import { smallLetters } from '@dsebastien-website/resolver'
import remarkObsidian from '@quartz-community/remark-obsidian'
import type { Element, Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toText } from 'hast-util-to-text'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { SITE_NAME } from './site.ts'

// The description of a page (IDX-05, IDX-04, IDX-06, decision R61): the
// `description` property of a note, with the text of its links; else a
// sentence from its note type and its properties, with the data that only
// this site has first (the rating and the status of the author), then the
// first sentences of its text, cut at a word end. A note of a media type
// gets the sentence alone: its text often starts with a copied synopsis
// (IDX-06). It is never empty, and never the type alone: a note with nothing
// more gets its title, its type and the name of the site. No two indexable pages share one: when they
// would, each note of them gets its title in front, and is cut again.

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
    /** True for a note of a media type: its text stays out of its description (IDX-06). */
    readonly media?: boolean | undefined
    readonly properties: Readonly<Record<string, unknown>>
    /** The body of the note page, as HTML. */
    readonly html: string
}

/** The text of a link of the vault: `[[Ada Quillfeather|Ada]]` gives `Ada`. */
function shownText(value: string): string {
    const link = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/u.exec(value.trim())
    return (link?.[2] ?? link?.[1] ?? value).trim()
}

/** A node of the Markdown tree of a property, as loose as the parser makes it. */
interface TextNode {
    readonly type: string
    readonly value?: string
    readonly children?: readonly TextNode[]
    readonly embedded?: boolean
    readonly path?: string
    readonly heading?: string
    readonly alias?: string
}

/** The parser of the notes (`remark-obsidian`), for a property that holds Markdown. */
const PARSER = unified().use(remarkParse).use(remarkObsidian)

/** The text that a reader sees of a node of the tree of a property. */
function shownOf(node: TextNode): string {
    switch (node.type) {
        case 'text':
        case 'inlineCode':
            return node.value ?? ''
        case 'tag':
            return `#${node.value ?? ''}`
        case 'wikilink': {
            // An embed shows no text; a link shows its alias, else its note, else
            // the last heading of a link into the note (`[[#Layers]]`).
            if (node.embedded === true) return ''
            const heading = (node.heading ?? '').split('#').at(-1) ?? ''
            return (node.alias || node.path || heading.replace(/^\^/u, '')).trim()
        }
        case 'image':
        case 'imageReference':
        case 'html':
        case 'footnoteReference':
        case 'footnote':
            return ''
        case 'break':
            return ' '
        default:
            return (node.children ?? []).map(shownOf).join(node.type === 'root' ? ' ' : '')
    }
}

/**
 * A text as a reader sees it, read by the parser of the notes (issue 98):
 * `[[Compost basics|compost]]` gives `compost`, `[[Soil#Layers]]` gives
 * `Soil`, `[[#Layers]]` gives `Layers`, `[the guide](https://…)` gives `the
 * guide`, an embed and the tags of raw HTML give nothing, code its text.
 */
function linkTexts(text: string): string {
    const tree = PARSER.runSync(PARSER.parse(text)) as unknown as TextNode
    return shownOf(tree).replace(/\s+/gu, ' ').trim()
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

/** The characters of a text as a reader sees them: an emoji of several code points, a flag or a letter with its accent is one. */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

function graphemesOf(text: string): string[] {
    return Array.from(GRAPHEMES.segment(text), (part) => part.segment)
}

/** The text cut at a word end, with an end mark, when it has more characters than the limit. */
function cut(text: string): string {
    const characters = graphemesOf(text)
    if (characters.length <= DESCRIPTION_LENGTH) {
        return text
    }
    // Cut on whole characters, so that no emoji or accent loses a part.
    const room = characters.slice(0, DESCRIPTION_LENGTH - 1).join('')
    const end = room.lastIndexOf(' ')
    return `${(end > DESCRIPTION_LENGTH / 2 ? room.slice(0, end) : room).replace(/[\s,;:.]+$/u, '')}…`
}

/** The description of a note page (IDX-05). */
export function noteDescription(input: DescriptionInput): string {
    const property = input.properties['description']
    const written = typeof property === 'string' ? linkTexts(property) : ''
    if (written !== '') {
        return written
    }
    const text = [factsOf(input), input.media === true ? undefined : plainTextOf(input.html)]
        .filter((part) => part !== undefined && part !== '')
        .join(' ')
    if (text === '') {
        return `${input.title}, a note of ${SITE_NAME}.`
    }
    // The type alone (`Movie.`) says too little: the title and the site go with it (issue 98).
    if (input.typeLabel !== undefined && text === `${input.typeLabel}.`) {
        return cut(`${input.title}: ${input.typeLabel}, a note of ${SITE_NAME}.`)
    }
    return cut(text)
}

/**
 * The descriptions of the notes, so that no two indexable pages share one:
 * a description that more than one page has gets the title of each note in
 * front, and is cut to the limit, unless the cut would make it the same as
 * another one. `taken` holds the descriptions of the other indexable pages. It
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
    const prefixed = new Map<string, string>()
    for (const item of items) {
        const shared = (count.get(item.description) ?? 0) > 1 || taken.has(item.description)
        if (shared) {
            prefixed.set(item.key, `${item.title}: ${item.description}`)
        }
        result.set(item.key, item.description)
    }
    // A text with the title in front is cut, unless the cut makes it the same
    // as another text: two long titles that start alike keep it whole (issue 98).
    const others = new Map<string, number>()
    for (const [key, text] of result) {
        const shown = prefixed.has(key) ? cut(prefixed.get(key) ?? '') : text
        others.set(shown, (others.get(shown) ?? 0) + 1)
    }
    for (const [key, text] of prefixed) {
        const short = cut(text)
        result.set(key, (others.get(short) ?? 0) === 1 && !taken.has(short) ? short : text)
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
