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
 * A text is read as a reader sees it: the text nodes only (no markup, no
 * attribute, no comment, no script, no style), a space at each edge of a block
 * element (`p`, `li`, `br`, a heading, a cell and the like), entities read,
 * white space folded. A text split by an inline element (`LINK: <a>url</a>`)
 * or by two blocks (`<p>LINK:</p><ul><li>url`) is found.
 *
 * - `has`: a CSS selector (a list with commas is a list of alternatives). At
 *   least one element matches, or exactly `count`. With `text`, only the
 *   elements whose text (descendants included) holds that text count. Of
 *   nested matches only the deepest counts, with or without a text: a list
 *   item that holds the text through an inner item does not count, and two
 *   alternatives that mark one callout (`<div data-callout-fold><details>`)
 *   count once. The rewriter of Bun closes no element by itself, so an end
 *   tag that the HTML leaves out (`<p>One<p>Two`) nests the next element: use
 *   `hasText` to count a text.
 * - `lacks`: a text that must not be anywhere in the HTML, markup and comments
 *   included, before and after the entities are read.
 * - `hasText`: a text that the text of the page holds at least once, or
 *   exactly `count` times (occurrences that do not overlap). The markup does
 *   not matter, so a missing end tag cannot hide a repeated text.
 * - `lacksText`: a text that must not be in the text of the page.
 * - `distinctIds`: every element that the selector matches has an id, and no
 *   two have the same one.
 * - `anchorsResolve`: at least one element that the selector matches links to
 *   a fragment (`href` that starts with `#`), and each such fragment, read as
 *   a URL, is the id of an element of the page. With `target` and `nth`, it is
 *   the id of element `nth` (1 is the first) of the elements that `target`
 *   matches, in the order of the page: the heading that a link must reach.
 */
export type FormCheck =
    | { has: string; text?: string; count?: number }
    | { lacks: string }
    | { hasText: string; count?: number }
    | { lacksText: string }
    | { distinctIds: string }
    | { anchorsResolve: string; target?: string; nth?: number }

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
    const {
        has,
        text,
        count,
        lacks,
        hasText,
        lacksText,
        distinctIds,
        anchorsResolve,
        target,
        nth
    } = value
    const validCount =
        count === undefined || (Number.isInteger(count) && typeof count === 'number' && count >= 0)
    if (typeof has === 'string') {
        const allowed = ['count', 'has', 'text']
        if (!Object.keys(value).every((key) => allowed.includes(key))) return fail()
        if (text !== undefined && typeof text !== 'string') return fail()
        if (!validCount) return fail()
        return {
            has,
            ...(typeof text === 'string' ? { text } : {}),
            ...(typeof count === 'number' ? { count } : {})
        }
    }
    if (typeof hasText === 'string') {
        if (!['hasText', 'count,hasText'].includes(keys) || hasText.trim() === '') return fail()
        if (!validCount) return fail()
        return { hasText, ...(typeof count === 'number' ? { count } : {}) }
    }
    if (keys === 'lacks' && typeof lacks === 'string' && lacks !== '') return { lacks }
    if (keys === 'lacksText' && typeof lacksText === 'string' && lacksText !== '') {
        return { lacksText }
    }
    if (keys === 'distinctIds' && typeof distinctIds === 'string') return { distinctIds }
    if (keys === 'anchorsResolve' && typeof anchorsResolve === 'string') return { anchorsResolve }
    if (
        keys === 'anchorsResolve,nth,target' &&
        typeof anchorsResolve === 'string' &&
        typeof target === 'string' &&
        typeof nth === 'number' &&
        Number.isInteger(nth) &&
        nth >= 1
    ) {
        return { anchorsResolve, target, nth }
    }
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

// The text of a page reads as a reader sees it: a block element starts and
// ends a word, an inline element does not.
const BLOCK_ELEMENTS = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'br',
    'caption',
    'dd',
    'details',
    'dialog',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'hr',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul'
])

// Elements whose text is code, not text of the page.
const HIDDEN_TEXT = new Set(['script', 'style'])

interface Match {
    id: string | null
    href: string | null
    text: string
    /** The nearest open match around this one. */
    parent: Match | undefined
}

interface Reading {
    /** Every element that the selector matches, in the order of the page. */
    matches: Match[]
    /** The text of the whole page. */
    text: string
}

/**
 * Reads the text of the page and of each element that the selector matches:
 * the text nodes only (no markup, no attribute, no comment, no script, no
 * style), a space at each edge of a block element, entities read, white space
 * folded.
 */
async function read(html: string, selector?: string): Promise<Reading> {
    const found: Match[] = []
    const open: Match[] = []
    let page = ''
    let hidden = 0
    // The rewriter runs the handlers of one element in the order they were
    // added, and keeps only the last end tag handler of an element: the
    // selector handler marks the match, and the handler of every element
    // opens and closes it.
    let matched: Match | undefined
    const add = (text: string): void => {
        if (hidden > 0) return
        page += text
        for (const match of open) match.text += text
    }
    let rewriter = new HTMLRewriter()
    if (selector !== undefined) {
        rewriter = rewriter.on(selector, {
            element(element) {
                matched = {
                    id: element.getAttribute('id'),
                    href: element.getAttribute('href'),
                    text: '',
                    parent: open.at(-1)
                }
                found.push(matched)
            }
        })
    }
    rewriter = rewriter
        .on('*', {
            element(element) {
                const match = matched
                matched = undefined
                const tag = element.tagName.toLowerCase()
                const block = BLOCK_ELEMENTS.has(tag)
                const code = HIDDEN_TEXT.has(tag)
                if (block) add(' ')
                if (!element.canHaveContent) return
                if (match !== undefined) open.push(match)
                if (code) hidden += 1
                element.onEndTag(() => {
                    if (code) hidden -= 1
                    if (match !== undefined) open.splice(open.lastIndexOf(match), 1)
                    if (block) add(' ')
                })
            }
        })
        .onDocument({
            text(chunk) {
                add(chunk.text)
            }
        })
    await rewriter.transform(new Response(html)).text()
    for (const match of found) match.text = fold(readEntities(match.text))
    return { matches: found, text: fold(readEntities(page)) }
}

async function matches(html: string, selector: string): Promise<Match[]> {
    return (await read(html, selector)).matches
}

async function textOf(html: string): Promise<string> {
    return (await read(html)).text
}

async function failureOf(html: string, check: FormCheck): Promise<string | undefined> {
    if ('lacks' in check) {
        const present = html.includes(check.lacks) || readEntities(html).includes(check.lacks)
        return present ? `the HTML holds "${check.lacks}"` : undefined
    }
    if ('hasText' in check) {
        const text = await textOf(html)
        const wanted = fold(check.hasText)
        let times = 0
        for (
            let at = text.indexOf(wanted);
            at !== -1;
            at = text.indexOf(wanted, at + wanted.length)
        ) {
            times += 1
        }
        if (check.count === undefined) {
            return times > 0 ? undefined : `the text does not hold "${check.hasText}"`
        }
        return times === check.count
            ? undefined
            : `the text holds "${check.hasText}" ${String(times)} times, not ${String(check.count)}`
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
        let wanted: string | null | undefined
        if (check.target !== undefined && check.nth !== undefined) {
            const targets = await matches(html, check.target)
            const element = targets[check.nth - 1]
            if (element === undefined) {
                return `"${check.target}" matches ${String(targets.length)} elements, so it has no element ${String(check.nth)}`
            }
            wanted = element.id
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
            if (wanted !== undefined && id !== wanted) {
                return `"${check.anchorsResolve}" links to "${href}", which is not the id of element ${String(check.nth)} of "${String(check.target)}"`
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
    // Of nested matches, only the deepest counts.
    const outer = new Set<Match>()
    for (const match of holding) {
        for (let parent = match.parent; parent !== undefined; parent = parent.parent) {
            outer.add(parent)
        }
    }
    const counted = holding.filter((match) => !outer.has(match)).length
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
