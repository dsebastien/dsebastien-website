import { join } from 'node:path'
import { FIXTURES } from './fixture-vault.ts'

// The corpus of the Markdown forms (issue 26). Each form of issue 12 has an
// invented note of the fixture vault and checks on the HTML that a conversion
// gives for that note alone. The checks follow spec v2 (REN, CARD, URL-14) and
// the reading view of Obsidian where the spec names no markup, never one
// candidate converter. The rendering slice (issue 45) adds its own snapshots.

/** The file that lists the forms and their checks. */
export const MARKDOWN_FORMS = join(FIXTURES, 'markdown-forms.json')

/**
 * One check on the HTML of a note.
 *
 * - `has`: a CSS selector (a list with commas is a list of alternatives). At
 *   least one element matches, or exactly `count`. With `text`, only the
 *   elements whose text (descendants included, entities read, white space
 *   folded) holds that text are counted, and of nested ones only the deepest:
 *   a list item that holds the text through an inner item does not count.
 *   The rewriter of Bun closes no element by itself, so an end tag that the
 *   HTML leaves out (`<p>One<p>Two`) nests the next element.
 * - `lacks`: a text that must not be anywhere in the HTML, markup and comments
 *   included, before and after the entities are read.
 * - `lacksText`: a text that must not be in the text of the page: the text
 *   nodes only (no markup, no attribute, no comment), entities read, white
 *   space folded. A text split by an element (`LINK: <a>url</a>`) is found.
 * - `distinctIds`: every element that the selector matches has an id, and no
 *   two have the same one.
 * - `anchorsResolve`: at least one element that the selector matches links to
 *   a fragment (`href` that starts with `#`), and each such fragment, read as
 *   a URL, is the id of an element of the page.
 */
export type FormCheck =
    | { has: string; text?: string; count?: number }
    | { lacks: string }
    | { lacksText: string }
    | { distinctIds: string }
    | { anchorsResolve: string }

/** One form of issue 12: the note that holds it, and what its HTML must show. */
export interface MarkdownForm {
    /** A short name, stable. */
    id: string
    /** The note of the fixture vault that holds the form, relative to the vault. */
    note: string
    /** The form and the rule of the spec, in one sentence. */
    covers: string
    /**
     * A regular expression (flags `m` and `u`) that the text of the note
     * matches: a test checks that the note still holds its form.
     */
    source: string
    checks: FormCheck[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toCheck(value: unknown, form: string): FormCheck {
    const fail = (): never => {
        throw new Error(`a check of the form ${form} is not valid: ${JSON.stringify(value)}`)
    }
    if (!isRecord(value)) return fail()
    const keys = Object.keys(value).sort().join(',')
    const { has, text, count, lacks, lacksText, distinctIds, anchorsResolve } = value
    if (typeof has === 'string') {
        const allowed = ['count', 'has', 'text']
        if (!Object.keys(value).every((key) => allowed.includes(key))) return fail()
        if (text !== undefined && typeof text !== 'string') return fail()
        if (
            count !== undefined &&
            !(Number.isInteger(count) && typeof count === 'number' && count >= 0)
        ) {
            return fail()
        }
        return {
            has,
            ...(typeof text === 'string' ? { text } : {}),
            ...(typeof count === 'number' ? { count } : {})
        }
    }
    if (keys === 'lacks' && typeof lacks === 'string' && lacks !== '') return { lacks }
    if (keys === 'lacksText' && typeof lacksText === 'string' && lacksText !== '') {
        return { lacksText }
    }
    if (keys === 'distinctIds' && typeof distinctIds === 'string') return { distinctIds }
    if (keys === 'anchorsResolve' && typeof anchorsResolve === 'string') return { anchorsResolve }
    return fail()
}

function toForm(value: unknown): MarkdownForm {
    if (!isRecord(value)) {
        throw new Error('a form of the forms file is not an object')
    }
    const { id, note, covers, source, checks } = value
    if (
        typeof id !== 'string' ||
        typeof note !== 'string' ||
        typeof covers !== 'string' ||
        typeof source !== 'string' ||
        source === '' ||
        !Array.isArray(checks)
    ) {
        throw new Error(`a form of the forms file is not valid: ${JSON.stringify(value)}`)
    }
    try {
        new RegExp(source, 'mu')
    } catch (error) {
        throw new Error(`the source pattern of the form ${id} does not compile`, { cause: error })
    }
    return { id, note, covers, source, checks: checks.map((check) => toCheck(check, id)) }
}

/** Reads the forms file. Throws when its shape is wrong. */
export async function readMarkdownForms(): Promise<MarkdownForm[]> {
    const file: unknown = await Bun.file(MARKDOWN_FORMS).json()
    const forms = isRecord(file) ? file['forms'] : undefined
    if (!Array.isArray(forms)) {
        throw new Error('the forms file has no list of forms')
    }
    return forms.map(toForm)
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
}

/**
 * Reads the numeric entities and a few named ones. A converter writes other
 * characters as themselves; an entity that names no character stays as written.
 */
function readEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
        if (!name.startsWith('#')) return NAMED_ENTITIES[name.toLowerCase()] ?? entity
        const hex = name.startsWith('#x') || name.startsWith('#X')
        const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
        return point <= 0x10ffff ? String.fromCodePoint(point) : entity
    })
}

function fold(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

interface Match {
    id: string | null
    href: string | null
    text: string
    /** The nearest open match around this one. */
    parent: Match | undefined
}

/** Every element that the selector matches, with its id and its text. */
async function matches(html: string, selector: string): Promise<Match[]> {
    const found: Match[] = []
    const open: Match[] = []
    const rewriter = new HTMLRewriter().on(selector, {
        element(element) {
            const match: Match = {
                id: element.getAttribute('id'),
                href: element.getAttribute('href'),
                text: '',
                parent: open.at(-1)
            }
            found.push(match)
            if (!element.canHaveContent) return
            open.push(match)
            element.onEndTag(() => {
                open.splice(open.lastIndexOf(match), 1)
            })
        },
        text(chunk) {
            for (const match of open) match.text += chunk.text
        }
    })
    await rewriter.transform(new Response(html)).text()
    for (const match of found) match.text = fold(readEntities(match.text))
    return found
}

/** The text nodes of the whole HTML, entities read and white space folded. */
async function textOf(html: string): Promise<string> {
    let text = ''
    const rewriter = new HTMLRewriter().onDocument({
        text(chunk) {
            text += chunk.text
        }
    })
    await rewriter.transform(new Response(html)).text()
    return fold(readEntities(text))
}

async function failureOf(html: string, check: FormCheck): Promise<string | undefined> {
    if ('lacks' in check) {
        const present = html.includes(check.lacks) || readEntities(html).includes(check.lacks)
        return present ? `the HTML holds "${check.lacks}"` : undefined
    }
    if ('lacksText' in check) {
        const present = (await textOf(html)).includes(fold(check.lacksText))
        return present ? `the text holds "${check.lacksText}"` : undefined
    }
    if ('anchorsResolve' in check) {
        const ids = new Set((await matches(html, '[id]')).map((match) => match.id))
        const fragments = (await matches(html, check.anchorsResolve))
            .map((match) => match.href)
            .filter((href): href is string => href?.startsWith('#') === true)
        if (fragments.length === 0) {
            return `no element matches "${check.anchorsResolve}" with a link to a fragment`
        }
        for (const href of fragments) {
            let id = href.slice(1)
            try {
                id = decodeURIComponent(id)
            } catch {
                // kept as written
            }
            if (!ids.has(id)) {
                return `"${check.anchorsResolve}" links to "${href}", which is no id of the page`
            }
        }
        return undefined
    }
    if ('distinctIds' in check) {
        const seen = new Set<string>()
        for (const { id } of await matches(html, check.distinctIds)) {
            if (id === null || id === '') return `an element of "${check.distinctIds}" has no id`
            if (seen.has(id)) return `two elements of "${check.distinctIds}" have the id "${id}"`
            seen.add(id)
        }
        return undefined
    }
    const wanted = check.text === undefined ? undefined : fold(check.text)
    const holding = (await matches(html, check.has)).filter(
        (match) => wanted === undefined || match.text.includes(wanted)
    )
    // Of nested matches that hold the text, only the deepest counts.
    const outer = new Set<Match>()
    for (const match of holding) {
        for (let parent = match.parent; parent !== undefined; parent = parent.parent) {
            outer.add(parent)
        }
    }
    const counted =
        wanted === undefined ? holding.length : holding.filter((match) => !outer.has(match)).length
    const withText = wanted === undefined ? '' : ` with the text "${wanted}"`
    if (check.count === undefined) {
        return counted > 0 ? undefined : `no element matches "${check.has}"${withText}`
    }
    return counted === check.count
        ? undefined
        : `"${check.has}"${withText} matches ${String(counted)} elements, not ${String(check.count)}`
}

/**
 * Runs the checks on the HTML of one note. Gives one message per failing
 * check, in the order of the checks: an empty list is a pass. Throws when a
 * selector does not parse.
 */
export async function checkHtml(html: string, checks: readonly FormCheck[]): Promise<string[]> {
    const failures: string[] = []
    for (const check of checks) {
        const failure = await failureOf(html, check)
        if (failure !== undefined) failures.push(failure)
    }
    return failures
}
