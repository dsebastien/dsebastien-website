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
 * The checks read the HTML of the body of the note only, not of a whole page:
 * a count (`count`, `nth`) over a page with a header, an outline or a list of
 * related notes counts their elements too. The site gives `checkHtml` the
 * HTML of the note body (issue 45).
 *
 * A text is read as a reader sees it: the text nodes only (no markup, no
 * attribute, no comment, no script, no style, no title, no template, no
 * fallback of a script or a frame), a space at each edge of a block element
 * (`p`, `li`, `br`, a heading, a cell and the like), entities read, white
 * space folded. An element whose end tag the HTML leaves out (`<li>a<li>b`,
 * `<td>a<td>b`, `<p>a<div>`) is closed as a browser does. A text split by an
 * inline element (`LINK: <a>url</a>`) or by two blocks
 * (`<p>LINK:</p><ul><li>url`) is found.
 *
 * - `has`: a CSS selector (a list with commas is a list of alternatives). At
 *   least one element matches, or exactly `count`. With `text`, only the
 *   elements whose text (descendants included) holds that text count. Of
 *   nested matches only the deepest counts, with or without a text: a list
 *   item that holds the text through an inner item does not count, and two
 *   alternatives that mark one callout (`<div data-callout-fold><details>`)
 *   count once. Use `hasText` to count a text whatever its markup.
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

/**
 * Reads one check of the forms file. Throws when it is of no kind, mixes two
 * kinds, has an empty text or a wrong number.
 */
export function parseFormCheck(value: unknown, form: string): FormCheck {
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
    const filled = (each: unknown): each is string => typeof each === 'string' && each.trim() !== ''
    const validCount =
        count === undefined || (Number.isInteger(count) && typeof count === 'number' && count >= 0)
    if (!validCount) return fail()
    if (filled(has) && ['has', 'count,has', 'has,text', 'count,has,text'].includes(keys)) {
        if (text !== undefined && !filled(text)) return fail()
        return {
            has,
            ...(typeof text === 'string' ? { text } : {}),
            ...(typeof count === 'number' ? { count } : {})
        }
    }
    if (filled(hasText) && ['hasText', 'count,hasText'].includes(keys)) {
        return { hasText, ...(typeof count === 'number' ? { count } : {}) }
    }
    if (keys === 'lacks' && filled(lacks)) return { lacks }
    if (keys === 'lacksText' && filled(lacksText)) return { lacksText }
    if (keys === 'distinctIds' && filled(distinctIds)) return { distinctIds }
    if (keys === 'anchorsResolve' && filled(anchorsResolve)) return { anchorsResolve }
    if (
        keys === 'anchorsResolve,nth,target' &&
        filled(anchorsResolve) &&
        filled(target) &&
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
    return { id, note, covers, source, checks: checks.map((check) => parseFormCheck(check, id)) }
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

// Elements whose text a reader does not see: code, the title of the window,
// the fallbacks of a script and a frame, and a template.
const HIDDEN_TEXT = new Set(['iframe', 'noscript', 'script', 'style', 'template', 'title'])

// The start tags that close an open element whose end tag the HTML leaves
// out, as a browser does (the rules of the HTML standard, in short): the
// element, and where the search for it stops.
const BLOCK_STARTS_CLOSE_P = [
    'address',
    'article',
    'aside',
    'blockquote',
    'details',
    'dialog',
    'div',
    'dl',
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
    'main',
    'menu',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'summary',
    'table',
    'ul'
]
const P_SCOPE = ['button', 'caption', 'html', 'object', 'table', 'td', 'template', 'th']
const TABLE_SCOPE = ['html', 'table', 'template']
const IMPLIED_ENDS: Record<string, { closes: string[]; stops: string[] }> = {
    li: { closes: ['li'], stops: ['menu', 'ol', 'ul', ...P_SCOPE] },
    dt: { closes: ['dd', 'dt'], stops: ['dl', ...P_SCOPE] },
    dd: { closes: ['dd', 'dt'], stops: ['dl', ...P_SCOPE] },
    td: { closes: ['td', 'th'], stops: ['tr', ...TABLE_SCOPE] },
    th: { closes: ['td', 'th'], stops: ['tr', ...TABLE_SCOPE] },
    tr: { closes: ['td', 'th', 'tr'], stops: ['tbody', 'tfoot', 'thead', ...TABLE_SCOPE] },
    tbody: { closes: ['tbody', 'td', 'tfoot', 'th', 'thead', 'tr'], stops: TABLE_SCOPE },
    thead: { closes: ['tbody', 'td', 'tfoot', 'th', 'thead', 'tr'], stops: TABLE_SCOPE },
    tfoot: { closes: ['tbody', 'td', 'tfoot', 'th', 'thead', 'tr'], stops: TABLE_SCOPE },
    option: { closes: ['option'], stops: ['datalist', 'optgroup', 'select'] },
    optgroup: { closes: ['optgroup', 'option'], stops: ['datalist', 'select'] },
    ...Object.fromEntries(
        BLOCK_STARTS_CLOSE_P.map((tag) => [tag, { closes: ['p'], stops: P_SCOPE }])
    )
}

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

/** An element that the reader holds open. */
interface Open {
    tag: string
    match: Match | undefined
    block: boolean
    hidden: boolean
    closed: boolean
}

/**
 * Reads the text of the page and of each element that the selector matches:
 * the text nodes only (no markup, no attribute, no comment, nothing that a
 * reader does not see), a space at each edge of a block element, entities
 * read, white space folded. An element whose end tag the HTML leaves out
 * (`<li>a<li>b`, `<td>a<td>b`, `<p>a<div>`) is closed as a browser does, and
 * nothing inside a hidden element (`template`, `noscript`) is a match.
 */
async function read(html: string, selector?: string): Promise<Reading> {
    const found: Match[] = []
    const open: Match[] = []
    const stack: Open[] = []
    let page = ''
    let hidden = 0
    // The rewriter runs the handlers of one element in the order they were
    // added, and keeps only the last end tag handler of an element: the
    // selector handler marks the match, and the handler of every element
    // opens and closes it. The rewriter closes no element by itself: it
    // gives the end tags of left out ones late, at the end tag of a parent.
    let matched: Match | undefined
    const add = (text: string): void => {
        if (hidden > 0) return
        page += text
        for (const match of open) match.text += text
    }
    const close = (entry: Open): void => {
        if (entry.closed) return
        entry.closed = true
        stack.splice(stack.lastIndexOf(entry), 1)
        if (entry.hidden) hidden -= 1
        if (entry.match !== undefined) open.splice(open.lastIndexOf(entry.match), 1)
        if (entry.block) add(' ')
    }
    const closeImplied = (tag: string): void => {
        const rule = IMPLIED_ENDS[tag]
        if (rule === undefined) return
        // The outermost element that the tag closes, before the search
        // stops: a new row closes the open cell and the open row.
        let from: number | undefined
        for (let index = stack.length - 1; index >= 0; index -= 1) {
            const entry = stack[index]
            if (entry === undefined || rule.stops.includes(entry.tag)) break
            if (rule.closes.includes(entry.tag)) from = index
        }
        if (from === undefined) return
        for (const above of stack.slice(from).reverse()) close(above)
    }
    let rewriter = new HTMLRewriter()
    if (selector !== undefined) {
        rewriter = rewriter.on(selector, {
            element(element) {
                matched = {
                    id: element.getAttribute('id'),
                    href: element.getAttribute('href'),
                    text: '',
                    parent: undefined
                }
            }
        })
    }
    rewriter = rewriter
        .on('*', {
            element(element) {
                const tag = element.tagName.toLowerCase()
                closeImplied(tag)
                let match = matched
                matched = undefined
                if (hidden > 0) match = undefined
                if (match !== undefined) {
                    match.parent = open.at(-1)
                    found.push(match)
                }
                const block = BLOCK_ELEMENTS.has(tag)
                if (block) add(' ')
                if (!element.canHaveContent) return
                const entry: Open = {
                    tag,
                    match,
                    block,
                    hidden: HIDDEN_TEXT.has(tag),
                    closed: false
                }
                stack.push(entry)
                if (match !== undefined) open.push(match)
                if (entry.hidden) hidden += 1
                element.onEndTag(() => {
                    close(entry)
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
        // Read before any return, so a target selector that does not parse
        // throws on every page.
        const targets = check.target === undefined ? [] : await matches(html, check.target)
        if (fragments.length === 0) {
            return `no element matches "${check.anchorsResolve}" with a link to a fragment`
        }
        let wanted: string | null | undefined
        if (check.target !== undefined && check.nth !== undefined) {
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
