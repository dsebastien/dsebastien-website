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
 *   folded) holds that text are counted.
 * - `lacks`: a text that must not be anywhere in the HTML, markup and comments
 *   included, before and after the entities are read.
 * - `distinctIds`: every element that the selector matches has an id, and no
 *   two have the same one.
 */
export type FormCheck =
    { has: string; text?: string; count?: number } | { lacks: string } | { distinctIds: string }

/** One form of issue 12: the note that holds it, and what its HTML must show. */
export interface MarkdownForm {
    /** A short name, stable. */
    id: string
    /** The note of the fixture vault that holds the form, relative to the vault. */
    note: string
    /** The form and the rule of the spec, in one sentence. */
    covers: string
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
    const { has, text, count, lacks, distinctIds } = value
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
    if (keys === 'distinctIds' && typeof distinctIds === 'string') return { distinctIds }
    return fail()
}

function toForm(value: unknown): MarkdownForm {
    if (!isRecord(value)) {
        throw new Error('a form of the forms file is not an object')
    }
    const { id, note, covers, checks } = value
    if (
        typeof id !== 'string' ||
        typeof note !== 'string' ||
        typeof covers !== 'string' ||
        !Array.isArray(checks)
    ) {
        throw new Error(`a form of the forms file is not valid: ${JSON.stringify(value)}`)
    }
    return { id, note, covers, checks: checks.map((check) => toCheck(check, id)) }
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

function readEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
        if (name.startsWith('#x') || name.startsWith('#X')) {
            return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
        }
        if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
        return NAMED_ENTITIES[name.toLowerCase()] ?? entity
    })
}

function fold(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

interface Match {
    id: string | null
    text: string
}

/** Every element that the selector matches, with its id and its text. */
async function matches(html: string, selector: string): Promise<Match[]> {
    const found: Match[] = []
    const open: Match[] = []
    const rewriter = new HTMLRewriter().on(selector, {
        element(element) {
            const match: Match = { id: element.getAttribute('id'), text: '' }
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
    return found.map((match) => ({ id: match.id, text: fold(readEntities(match.text)) }))
}

async function failureOf(html: string, check: FormCheck): Promise<string | undefined> {
    if ('lacks' in check) {
        const present = html.includes(check.lacks) || readEntities(html).includes(check.lacks)
        return present ? `the HTML holds "${check.lacks}"` : undefined
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
    const counted = (await matches(html, check.has)).filter(
        (match) => wanted === undefined || match.text.includes(wanted)
    ).length
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
