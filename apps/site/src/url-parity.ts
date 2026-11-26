import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { readingsOf } from '@dsebastien-website/resolver'
import type { Ask } from './url-table.ts'

// The URL parity test (story 161 and RES-06 of the spec, issue 44; issue 60
// runs it before the switch): every URL that is known of the current site,
// from several sources, is asked of a host, and each answer that is not the
// expected one is put in a class. The sources are private files of the
// author (the redirect list, the sitemap of the current site, the reports of
// the search engines, a crawl): the command reads them from where they are
// and never writes one of their paths into the repository. It uses no test
// runner.

/** What a known URL must answer. */
export type Expectation =
    /** 200, or one redirect to a page that answers 200: a URL of a sitemap, a report or a crawl. */
    | { kind: 'works' }
    /** 200 with the content of a note, or one redirect to the same decoded path: a canonical row. */
    | { kind: 'page' }
    /** One redirect to the target, compared decoded, and the target answers 200. */
    | { kind: 'redirect'; to: string }
    /** 410. */
    | { kind: 'gone' }
    /** 404. */
    | { kind: 'not-found' }
    /** A row that waits for a decision of the author (OPEN-14). */
    | { kind: 'pending' }

/** A URL that is known of the current site: its path, the sources that name it, and what it must answer. */
export interface KnownUrl {
    readonly path: string
    readonly sources: readonly string[]
    readonly expect: Expectation
    /** True when a source says that the URL must work and another that it is gone or not found. */
    readonly conflict?: true
}

/** The class of the answer for a known URL. */
export type Verdict =
    | 'ok'
    | 'pending'
    | 'not-found'
    | 'gone'
    | 'wrong-status'
    | 'wrong-target'
    | 'chain'
    | 'no-content'
    | 'server-error'
    | 'no-answer'
    | 'conflict'

/** The answer for one known URL. */
export interface UrlCheck {
    readonly url: KnownUrl
    readonly verdict: Verdict
    readonly status?: number
    readonly location?: string
}

/** The path of a URL or a path, without its query and its fragment. */
function pathOnly(path: string): string {
    const at = path.search(/[?#]/u)
    return at < 0 ? path : path.slice(0, at)
}

/** The decoded forms of a path: each reading of the resolver, in the composed Unicode form. */
function decodedForms(path: string): Set<string> {
    // A path that a report shows decoded can hold a space or a letter that a
    // URL encodes: its request form reads the same.
    return new Set(readingsOf(requestPathOf(pathOnly(path))).map((text) => text.normalize('NFC')))
}

/**
 * True when two paths are one path, decoded (RES-06): the analytics tool
 * shows paths decoded, and a literal `+` and a space both show as `+`. The
 * query is left aside. The letter case counts: the site answers another
 * letter case with a redirect.
 */
export function samePath(one: string, two: string): boolean {
    const forms = decodedForms(one)
    return [...decodedForms(two)].some((form) => forms.has(form))
}

/**
 * The characters of a path that a request encodes: a `%` that starts no
 * encoding, and every code point but the ones that a path keeps as they are.
 */
const ENCODED = /%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/gu

/**
 * The path to ask for a known path: an encoded path stays as it is, and a
 * path that a report shows decoded gets the encoding of a browser. A `%` that
 * starts no encoding, a `?` and a `#` of a name are encoded too.
 */
export function requestPathOf(path: string): string {
    return path.replaceAll(ENCODED, (character) =>
        character === '%' ? '%25' : encodeURIComponent(character)
    )
}

/** The fields of a line of CSV, with quoted fields (RFC 4180). */
function csvRows(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let quoted = false
    for (let index = 0; index < text.length; index++) {
        const character = text[index] ?? ''
        if (quoted) {
            if (character === '"' && text[index + 1] === '"') {
                field += '"'
                index++
            } else if (character === '"') {
                quoted = false
            } else {
                field += character
            }
        } else if (character === '"') {
            quoted = true
        } else if (character === ',') {
            row.push(field)
            field = ''
        } else if (character === '\n' || character === '\r') {
            if (character === '\r' && text[index + 1] === '\n') {
                index++
            }
            row.push(field)
            rows.push(row)
            row = []
            field = ''
        } else {
            field += character
        }
    }
    if (field !== '' || row.length > 0) {
        row.push(field)
        rows.push(row)
    }
    return rows.filter((fields) => fields.some((value) => value !== ''))
}

/**
 * The known URLs of the redirect list (the private CSV of the author): each
 * row with the answer that its status code and its target say. A row
 * without a status code waits for a decision.
 */
export function knownUrlsFromList(text: string, source: string): KnownUrl[] {
    const [header = [], ...rows] = csvRows(text)
    const column = (name: string): number => header.indexOf(name)
    const [path, to, status] = [
        column('source_url_path'),
        column('target_path'),
        column('status_code')
    ]
    if (path < 0 || to < 0 || status < 0) {
        throw new Error(
            `the list ${source} has not the columns source_url_path, target_path and status_code`
        )
    }
    return rows.map((fields): KnownUrl => {
        const code = fields[status] ?? ''
        const target = fields[to] ?? ''
        const expect: Expectation =
            code === '200'
                ? { kind: 'page' }
                : code === '410'
                  ? { kind: 'gone' }
                  : code === '404'
                    ? { kind: 'not-found' }
                    : (code === '301' || code === '302') && target !== ''
                      ? { kind: 'redirect', to: target }
                      : { kind: 'pending' }
        const known = fields[path] ?? ''
        // A canonical row of a report that shows paths decoded: the request
        // that a reader sent is the canonical form of the same decoded path
        // (RES-06). A `+` of such a row can be a space or a literal `+`.
        const asked =
            code === '200' && target !== '' && target !== known && samePath(known, target)
                ? target
                : known
        return { path: asked, sources: [source], expect }
    })
}

/** The path of a line that is a URL or a path, without its query. */
function pathOfLine(line: string): string | undefined {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) {
        return undefined
    }
    if (/^https?:\/\//u.test(text)) {
        // The path as the URL writes it, with its percent-encoding.
        const start = text.indexOf('/', text.indexOf('//') + 2)
        return start < 0 ? '/' : pathOnly(text.slice(start))
    }
    return text.startsWith('/') ? pathOnly(text) : undefined
}

/** The known URLs of a sitemap: each `<loc>` must work. */
export function knownUrlsFromSitemap(xml: string, source: string): KnownUrl[] {
    const entities: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'"
    }
    return [...xml.matchAll(/<loc>([^<]*)<\/loc>/gu)].flatMap((match) => {
        const url = (match[1] ?? '').replaceAll(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => {
            return entities[entity] ?? entity
        })
        const path = pathOfLine(url)
        return path === undefined ? [] : [{ path, sources: [source], expect: { kind: 'works' } }]
    })
}

/** The known URLs of a text with one URL or path per line (a report, a crawl): each must work. `#` starts a comment. */
export function knownUrlsFromLines(text: string, source: string): KnownUrl[] {
    return text.split(/\r?\n/u).flatMap((line) => {
        const path = pathOfLine(line)
        return path === undefined ? [] : [{ path, sources: [source], expect: { kind: 'works' } }]
    })
}

/** How precise an expectation is: the most precise one of a path wins. */
const PRECISION: Record<Expectation['kind'], number> = {
    'works': 0,
    'pending': 1,
    'page': 2,
    'redirect': 2,
    'gone': 2,
    'not-found': 2
}

/**
 * The decoded forms of a path for the merge of the sources: the strict one
 * (`+` a space, `%2B` a `+`), and for a path with no `%` (a report that
 * shows paths decoded) also the one with `+` as itself.
 */
function mergeForms(path: string): string[] {
    const [strict, literal] = readingsOf(requestPathOf(pathOnly(path))).map((text) =>
        text.normalize('NFC')
    )
    const forms = strict === undefined ? [] : [strict]
    if (!path.includes('%') && literal !== undefined && literal !== strict) {
        forms.push(literal)
    }
    return forms.length === 0 ? [path] : forms
}

/** The expectations that say a URL does not work. */
const BROKEN: ReadonlySet<Expectation['kind']> = new Set(['gone', 'not-found'])

/** The expectations that say exactly what a URL answers. */
const EXACT: ReadonlySet<Expectation['kind']> = new Set(['page', 'redirect', 'gone', 'not-found'])

/**
 * True when two expectations of one URL cannot both hold. A page and a
 * redirect to that same path, from another form of it, both hold.
 */
function conflicts(path: string, one: Expectation, two: Expectation): boolean {
    const kinds = [one.kind, two.kind]
    if (kinds.includes('works') && kinds.some((kind) => BROKEN.has(kind))) {
        return true
    }
    if (!EXACT.has(one.kind) || !EXACT.has(two.kind)) {
        return false
    }
    if (one.kind !== two.kind) {
        const redirect = one.kind === 'redirect' ? one : two.kind === 'redirect' ? two : undefined
        const page = one.kind === 'page' || two.kind === 'page'
        return !(page && redirect !== undefined && samePath(redirect.to, path))
    }
    return one.kind === 'redirect' && two.kind === 'redirect' && !samePath(one.to, two.to)
}

/**
 * The known URLs of several sources, one time each decoded path (RES-06), in
 * the order where they come first, asked in the form where they come first.
 * Two paths are one URL when they share any decoded form. A URL whose
 * sources say two things that cannot both hold is a conflict: one says it
 * must work and another that it is gone or not found, or two exact
 * expectations differ in kind or in target.
 */
export function mergeKnownUrls(lists: readonly (readonly KnownUrl[])[]): KnownUrl[] {
    const urls: KnownUrl[] = []
    const byForm = new Map<string, number>()
    for (const url of lists.flat()) {
        const forms = mergeForms(url.path)
        const index = forms.map((form) => byForm.get(form)).find((one) => one !== undefined)
        const known = index === undefined ? undefined : urls[index]
        if (index === undefined || known === undefined) {
            for (const form of forms) {
                byForm.set(form, urls.length)
            }
            urls.push(url)
            continue
        }
        for (const form of forms) {
            if (!byForm.has(form)) {
                byForm.set(form, index)
            }
        }
        const sources = [...new Set([...known.sources, ...url.sources])]
        const expect =
            PRECISION[url.expect.kind] > PRECISION[known.expect.kind] ? url.expect : known.expect
        const conflict =
            known.conflict === true ||
            url.conflict === true ||
            conflicts(known.path, known.expect, url.expect)
        urls[index] = { path: known.path, sources, expect, ...(conflict ? { conflict } : {}) }
    }
    return urls
}

/**
 * True when a file can hold a report of the parity run: outside the clone,
 * or in its private folder. A report names private paths. The folders are
 * compared after their links are followed; a file in a folder that does not
 * exist is refused.
 *
 * @param root the folder of the clone
 */
export async function isPrivatePlace(file: string, root: string): Promise<boolean> {
    let folder: string
    let clone: string
    try {
        folder = await realpath(dirname(file))
        clone = await realpath(root)
    } catch {
        return false
    }
    const inside = relative(clone, join(folder, basename(file)))
    return (
        inside === '..' ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside) ||
        (inside.split(sep).length >= 2 && inside.split(sep)[0] === '.private')
    )
}

/** True when an HTML page holds the content of a note: a heading in its main part (RES-03). */
function hasContent(html: string): boolean {
    return /<main\b[^>]*>[\s\S]*<h1\b/u.test(html)
}

/** The class of an error status. */
function errorVerdict(status: number): Verdict {
    if (status === 404) {
        return 'not-found'
    }
    if (status === 410) {
        return 'gone'
    }
    return status >= 500 ? 'server-error' : 'wrong-status'
}

const REDIRECT = new Set([301, 302, 307, 308])

/** The answer of a page that a redirect leads to: it must answer 200 (URL-05). */
async function targetVerdict(location: string, ask: Ask): Promise<Verdict> {
    if (/^https?:/u.test(location)) {
        // A target on another host of the author is not asked: the run counts it as ok.
        return 'ok'
    }
    // The location is a URL: its query stays a query.
    const at = location.indexOf('?')
    const path = at < 0 ? location : location.slice(0, at)
    const target = await ask(requestPathOf(path) + (at < 0 ? '' : location.slice(at)))
    await target.arrayBuffer()
    if (target.status === 200) {
        return 'ok'
    }
    return REDIRECT.has(target.status) ? 'chain' : errorVerdict(target.status)
}

/** The check of one known URL. */
async function checkOne(url: KnownUrl, ask: Ask): Promise<UrlCheck> {
    if (url.conflict === true) {
        return { url, verdict: 'conflict' }
    }
    if (url.expect.kind === 'pending') {
        return { url, verdict: 'pending' }
    }
    let response: Response
    try {
        response = await ask(requestPathOf(url.path))
    } catch {
        return { url, verdict: 'no-answer' }
    }
    const status = response.status
    const location = response.headers.get('location') ?? undefined
    const body = await response.text()
    const answer = { url, status, ...(location === undefined ? {} : { location }) }
    const expect = url.expect
    const followed = async (): Promise<UrlCheck> => {
        try {
            return { ...answer, verdict: await targetVerdict(location ?? '', ask) }
        } catch {
            return { ...answer, verdict: 'no-answer' }
        }
    }
    switch (expect.kind) {
        case 'gone':
            return { ...answer, verdict: status === 410 ? 'ok' : errorVerdict(status) }
        case 'not-found':
            return { ...answer, verdict: status === 404 ? 'ok' : errorVerdict(status) }
        case 'works':
            if (status === 200) {
                return { ...answer, verdict: 'ok' }
            }
            return REDIRECT.has(status) && location !== undefined
                ? await followed()
                : { ...answer, verdict: errorVerdict(status) }
        case 'page':
            if (status === 200) {
                // A file of the site (the Markdown of a note, a text file) is no page.
                const html = response.headers.get('content-type')?.startsWith('text/html') === true
                return { ...answer, verdict: !html || hasContent(body) ? 'ok' : 'no-content' }
            }
            if (REDIRECT.has(status) && location !== undefined) {
                return samePath(location, url.path)
                    ? await followed()
                    : { ...answer, verdict: 'wrong-target' }
            }
            return { ...answer, verdict: errorVerdict(status) }
        case 'redirect':
            if (!REDIRECT.has(status) || location === undefined) {
                return {
                    ...answer,
                    verdict: status === 200 ? 'wrong-status' : errorVerdict(status)
                }
            }
            return samePath(location, expect.to) ||
                (await endsOf(expect.to, ask)).some((end) => samePath(location, end))
                ? await followed()
                : { ...answer, verdict: 'wrong-target' }
    }
}

/** How many redirects of an expected target the run follows to find where it ends. */
const TARGET_HOPS = 3

/**
 * Where an expected target leads on the host, up to a few redirects: the
 * list can write a target in another letter case or encoding, and the host
 * leads it to the same page as the known URL.
 */
async function endsOf(target: string, ask: Ask): Promise<string[]> {
    const ends: string[] = []
    let next = target
    for (let hop = 0; hop < TARGET_HOPS && !/^https?:/u.test(next); hop++) {
        const at = next.indexOf('?')
        const response = await ask(
            requestPathOf(at < 0 ? next : next.slice(0, at)) + (at < 0 ? '' : next.slice(at))
        ).catch(() => undefined)
        const location = response?.headers.get('location') ?? undefined
        await response?.arrayBuffer()
        if (response === undefined || !REDIRECT.has(response.status) || location === undefined) {
            break
        }
        ends.push(location)
        next = location
    }
    return ends
}

/** The result of a parity run. */
export interface ParityResult {
    readonly checks: readonly UrlCheck[]
    /** The count of each class, by source. */
    readonly counts: Readonly<Record<string, Readonly<Partial<Record<Verdict, number>>>>>
    /** The URLs whose answer is not the expected one. */
    readonly failed: number
    /** The rows that wait for a decision. */
    readonly pending: number
}

/**
 * Asks a host for each known URL, a few at a time, and follows one redirect
 * at most.
 *
 * @param options.concurrency how many requests run at once
 */
export async function checkKnownUrls(
    urls: readonly KnownUrl[],
    ask: Ask,
    options: { concurrency: number }
): Promise<ParityResult> {
    const checks: UrlCheck[] = new Array<UrlCheck>(urls.length)
    let next = 0
    const worker = async (): Promise<void> => {
        while (next < urls.length) {
            const index = next++
            const url = urls[index]
            if (url !== undefined) {
                checks[index] = await checkOne(url, ask)
            }
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker))
    const counts: Record<string, Partial<Record<Verdict, number>>> = {}
    for (const check of checks) {
        for (const source of check.url.sources) {
            const count = (counts[source] ??= {})
            count[check.verdict] = (count[check.verdict] ?? 0) + 1
        }
    }
    return {
        checks,
        counts,
        failed: checks.filter((check) => check.verdict !== 'ok' && check.verdict !== 'pending')
            .length,
        pending: checks.filter((check) => check.verdict === 'pending').length
    }
}
