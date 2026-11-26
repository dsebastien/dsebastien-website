import { SITE_ORIGIN } from '@dsebastien-website/resolver'
import { textProperty } from './frontmatter.ts'
import type { NoteType } from './note-types.ts'
import type { MainSite, PageAnswer } from './ports.ts'

// The original of a note on the main site (ADR 0010, IDX-11 to IDX-13,
// PUB-100): a note of a type that the main site also publishes names the post
// there in its canonical link, once the tool checked at publication that the
// post answers 200 and names itself. The manifest entry keeps the result of
// the check (`original`); the build reads only that and opens no connection.
// The rules are in `documentation/Canonical Form.md`, section "The original
// of a note", with the shared cases of `fixtures/canonical/originals.json`.
// The Rust twin is `cli/src/originals.rs`.

/** The origin of the main site. A post URL names a page of it. */
export const MAIN_SITE_ORIGIN = 'https://www.dsebastien.net'

/** The host of the main site. */
const MAIN_SITE_HOST = 'www.dsebastien.net'

/** The host of this site: a post that names it as its original makes a loop. */
const NOTES_HOST = new URL(SITE_ORIGIN).host

/**
 * The note types whose notes also exist on the main site: articles, news
 * posts and newsletters (decision of the author on issue 55). Only the type
 * counts: a note of another type keeps its own canonical link, also when its
 * `url` names the main site.
 */
export const ORIGINAL_NOTE_TYPES: readonly string[] = [
    'own-articles',
    'own-news',
    'own-newsletters'
]

/** The property of a note that holds the URL of its post. */
export const POST_URL_PROPERTY = 'url'

/** The most notes that the check asks the main site for at one time. */
export const CHECK_CONCURRENCY = 4

/** The time limit of one check, redirects included, in milliseconds. */
export const CHECK_TIME_LIMIT = 10_000

/** The most bytes of a page that a check reads: the canonical link is in its head. */
export const CHECK_SIZE_LIMIT = 1024 * 1024

/** The most redirects that a check follows. */
export const CHECK_REDIRECTS = 5

/** The user agent of a check. It names the tool and nothing of the person who runs it. */
export const CHECK_USER_AGENT = 'dsebastien-vault-publish (check of the original)'

/** The result of a check that passed, as the manifest entry keeps it. */
// A type alias, not an interface: the canonical form takes any object of data.
export type Original = {
    /** The time of the run of the check. */
    readonly checked: string
    /** The post URL, in its comparison form. */
    readonly url: string
}

/** What the main site gave for one request: a page, or why there is none. */
export type Answer = PageAnswer | { readonly failure: string }

/** True when notes of this type also exist on the main site (IDX-11). */
export function hasOriginal(noteType: NoteType | string | undefined): boolean {
    const name = typeof noteType === 'string' ? noteType : noteType?.name
    return name !== undefined && ORIGINAL_NOTE_TYPES.includes(name)
}

/** The text with its ASCII capital letters in small letters. No other character changes. */
function asciiLower(text: string): string {
    return text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase())
}

/**
 * The comparison form of a URL (rule 2 of "The original of a note"): the
 * scheme `https`, the host in small letters, no default port, a path that
 * ends in a slash, the query when it is not empty, and no fragment.
 * `undefined` when the text is not an `http` or `https` URL in the form that
 * the check reads.
 */
export function comparisonForm(text: string): string | undefined {
    const trimmed = text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/gu, '')
    const separator = trimmed.indexOf('://')
    if (separator < 0) {
        return undefined
    }
    const scheme = asciiLower(trimmed.slice(0, separator))
    if (scheme !== 'https' && scheme !== 'http') {
        return undefined
    }
    const rest = trimmed.slice(separator + 3)
    for (const character of rest) {
        if (character <= ' ' || character === '\u007f' || '\\"<>'.includes(character)) {
            return undefined
        }
    }
    let end = rest.length
    for (const mark of ['/', '?', '#']) {
        const at = rest.indexOf(mark)
        if (at >= 0 && at < end) {
            end = at
        }
    }
    const authority = rest.slice(0, end)
    const colon = authority.indexOf(':')
    const host = asciiLower(colon < 0 ? authority : authority.slice(0, colon))
    const port = colon < 0 ? undefined : authority.slice(colon + 1)
    if (!/^[a-z0-9.-]+$/u.test(host) || (port !== undefined && !/^[0-9]+$/u.test(port))) {
        return undefined
    }
    const tail = rest.slice(end)
    const fragment = tail.indexOf('#')
    const kept = fragment < 0 ? tail : tail.slice(0, fragment)
    const question = kept.indexOf('?')
    const path = question < 0 ? kept : kept.slice(0, question)
    const query = question < 0 ? '' : kept.slice(question)
    const shown = port === undefined || port === '443' || port === '80' ? host : `${host}:${port}`
    const slashed = path === '' ? '/' : path.endsWith('/') ? path : `${path}/`
    return `https://${shown}${slashed}${query === '?' ? '' : query}`
}

/** The host of a URL in the comparison form. */
function hostOf(form: string): string {
    const rest = form.slice('https://'.length)
    const end = rest.indexOf('/')
    return end < 0 ? rest : rest.slice(0, end)
}

/**
 * The post URL of a note (rule 3): its property `url`, in the comparison
 * form, when it names a page of the main site: its host with no other port,
 * a path that is not the root, and no query. `undefined` in every other case.
 */
export function postUrlOf(source: string): string | undefined {
    const value = textProperty(source, POST_URL_PROPERTY)
    const form = value === undefined ? undefined : comparisonForm(value)
    if (form === undefined || hostOf(form) !== MAIN_SITE_HOST) {
        return undefined
    }
    const path = form.slice(`https://${MAIN_SITE_HOST}`.length)
    return path === '/' || path.includes('?') ? undefined : form
}

/** The characters that end the name of an attribute or a tag. */
function isSpace(character: string | undefined): boolean {
    return (
        character === ' ' ||
        character === '\t' ||
        character === '\n' ||
        character === '\r' ||
        character === '\f'
    )
}

/** The references of characters that an address of a link can hold, in small letters. */
const REFERENCES: readonly (readonly [string, string])[] = [
    ['&amp;', '&'],
    ['&quot;', '"'],
    ['&#39;', "'"],
    ['&#x27;', "'"],
    ['&#47;', '/'],
    ['&#x2f;', '/']
]

/** The value of an attribute with its references of characters read (rule 4). */
function decoded(value: string): string {
    let result = ''
    let at = 0
    while (at < value.length) {
        if (value[at] === '&') {
            const reference = REFERENCES.find(
                ([name]) => asciiLower(value.slice(at, at + name.length)) === name
            )
            if (reference !== undefined) {
                result += reference[1]
                at += reference[0].length
                continue
            }
        }
        result += value[at] ?? ''
        at += 1
    }
    return result
}

/** The attributes of a tag from a place after its name, up to its `>`: each name one time, the first one counts. */
function attributesOf(html: string, start: number): Map<string, string> {
    const attributes = new Map<string, string>()
    let at = start
    while (at < html.length) {
        while (isSpace(html[at]) || html[at] === '/') {
            at += 1
        }
        if (at >= html.length || html[at] === '>') {
            break
        }
        const nameStart = at
        while (
            at < html.length &&
            !isSpace(html[at]) &&
            html[at] !== '/' &&
            html[at] !== '>' &&
            html[at] !== '='
        ) {
            at += 1
        }
        // A `=` that starts a name is part of it, as in HTML.
        if (at === nameStart) {
            at += 1
        }
        const name = asciiLower(html.slice(nameStart, at))
        let after = at
        while (isSpace(html[after])) {
            after += 1
        }
        let value = ''
        if (html[after] === '=') {
            at = after + 1
            while (isSpace(html[at])) {
                at += 1
            }
            const quote = html[at]
            if (quote === '"' || quote === "'") {
                const close = html.indexOf(quote, at + 1)
                const end = close < 0 ? html.length : close
                value = html.slice(at + 1, end)
                at = end + 1
            } else {
                const valueStart = at
                while (at < html.length && !isSpace(html[at]) && html[at] !== '>') {
                    at += 1
                }
                value = html.slice(valueStart, at)
            }
        }
        if (!attributes.has(name)) {
            attributes.set(name, decoded(value))
        }
    }
    return attributes
}

/**
 * The canonical links of a page (rule 4): the address of each `link` element
 * whose `rel` has the word `canonical`, in the head of the page (up to its
 * first `</head`, or the whole page without one), in the order of the page.
 * An address from the root of the host or without a scheme is read from the
 * URL of the page; any other address stays as it is written.
 */
export function canonicalLinksOf(html: string, page: string): string[] {
    const lower = asciiLower(html)
    const close = lower.indexOf('</head')
    const head = close < 0 ? lower.length : close
    const origin = `https://${hostOf(comparisonForm(page) ?? 'https://')}`
    const links: string[] = []
    let at = lower.indexOf('<link')
    while (at >= 0 && at < head) {
        const after = at + '<link'.length
        const next = html[after]
        if (isSpace(next) || next === '/' || next === '>') {
            const attributes = attributesOf(html, after)
            const rel = attributes.get('rel') ?? ''
            const href = (attributes.get('href') ?? '').replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/gu, '')
            const words = asciiLower(rel).split(/[ \t\n\r\f]+/u)
            if (words.includes('canonical') && href !== '') {
                links.push(
                    href.startsWith('//')
                        ? `https:${href}`
                        : href.startsWith('/')
                          ? `${origin}${href}`
                          : href
                )
            }
        }
        at = lower.indexOf('<link', after)
    }
    return links
}

/**
 * The judgment of the answer of the main site for a post URL (rule 5): the
 * post is verified when the request ended at the post URL with 200, and every
 * canonical link of the page names the post URL. Else the reason, for the
 * publication report.
 */
export function judgePost(
    url: string,
    answer: Answer
): { readonly verified: true } | { readonly verified: false; readonly reason: string } {
    if ('failure' in answer) {
        return { verified: false, reason: `the check of ${url} failed: ${answer.failure}` }
    }
    if (comparisonForm(answer.url) !== url) {
        return {
            verified: false,
            reason: `${url} redirects to ${answer.url}: write the address of the post into the property url`
        }
    }
    if (answer.status !== 200) {
        return { verified: false, reason: `${url} answers ${String(answer.status)}, not 200` }
    }
    const links = canonicalLinksOf(answer.body, url)
    const forms = new Set(links.map((link) => comparisonForm(link) ?? link))
    const [named, ...others] = [...forms]
    if (named === undefined) {
        return { verified: false, reason: `the post ${url} has no canonical link` }
    }
    if (others.length > 0) {
        return {
            verified: false,
            reason: `the post ${url} has canonical links to more than one URL: ${links.join(', ')}`
        }
    }
    if (named === url) {
        return { verified: true }
    }
    if (named.startsWith('https://') && hostOf(named) === NOTES_HOST) {
        return {
            verified: false,
            reason: `the post ${url} names ${named} as its original: each site would name the other (a loop). The post must name itself`
        }
    }
    return {
        verified: false,
        reason: `the post ${url} names ${named} as its original, not itself`
    }
}

/** A note of a publication, for the check. */
export interface CheckedNote {
    readonly path: string
    readonly noteType: NoteType | undefined
    /** The source of the note. */
    readonly source: string
}

/** The result of the check of one note: the original to record, or why there is none. */
export type CheckResult = { readonly original: Original } | { readonly reason: string }

/**
 * Checks the post of each note of a type with an original (rule 6), with at
 * most `CHECK_CONCURRENCY` requests at one time. A note of another type has
 * no result. Without the port of the main site, nothing is checked. The
 * check never throws: a failure is a reason.
 */
export async function checkOriginals(
    mainSite: MainSite | undefined,
    notes: readonly CheckedNote[],
    time: string
): Promise<Map<string, CheckResult>> {
    const results = new Map<string, CheckResult>()
    const asked: { path: string; url: string }[] = []
    for (const note of notes) {
        if (!hasOriginal(note.noteType)) {
            continue
        }
        const url = postUrlOf(note.source)
        if (url === undefined) {
            results.set(note.path, {
                reason: `the note has no property ${POST_URL_PROPERTY} with the address of a post of ${MAIN_SITE_ORIGIN}`
            })
        } else if (mainSite === undefined) {
            results.set(note.path, {
                reason: `the post ${url} was not checked: this face has no check of the main site`
            })
        } else {
            asked.push({ path: note.path, url })
        }
    }
    let next = 0
    const worker = async (site: MainSite): Promise<void> => {
        while (next < asked.length) {
            const item = asked[next]
            next += 1
            if (item === undefined) {
                return
            }
            let answer: Answer
            try {
                answer = await site.page(item.url)
            } catch (error) {
                answer = { failure: error instanceof Error ? error.message : String(error) }
            }
            const judged = judgePost(item.url, answer)
            results.set(
                item.path,
                judged.verified ? { original: { checked: time, url: item.url } } : judged
            )
        }
    }
    if (mainSite !== undefined) {
        await Promise.all(
            Array.from({ length: Math.min(CHECK_CONCURRENCY, asked.length) }, () =>
                worker(mainSite)
            )
        )
    }
    return results
}
