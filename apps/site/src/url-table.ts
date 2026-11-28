import { fileURLToPath } from 'node:url'
import { canonicalPath } from '@dsebastien-website/resolver'

// The check of one case of the URL table over HTTP (SEAM-04 of the spec,
// issue 21): what a host must answer for a request of `fixtures/urls.json`.
// It asks through a function, so the same check runs on the plain local
// server, on the Worker in a test, and on a real host by its address
// (`scripts/url-table.ts`, HOST-02). It gives its findings as texts and uses
// no test runner.

const TABLE = fileURLToPath(new URL('../../../fixtures/urls.json', import.meta.url))

/** The origin of the canonical links of the built site. */
const ORIGIN = 'https://notes.dsebastien.net'

/** A case of the URL table. */
export interface UrlCase {
    name: string
    request: string
    status: number
    page?: string
    canonical?: string
    file?: string
    location?: string
    cacheControl?: string
    suggestions?: string[]
    accept?: string
    format?: 'html' | 'markdown'
    /**
     * The `Content-Disposition` header of the Markdown of a note: the file
     * name of its download form (issue 137). Without it, the Markdown has
     * no such header and opens in the browser.
     */
    disposition?: string
    /**
     * Also asks again with the tag of the answer (304), and checks that the
     * other form of the note has a tag of its own (URL-11, URL-18).
     */
    notModified?: boolean
    /**
     * The answer of the edge of a real host, before the Worker runs (R87): a
     * check of a real host expects this status and no page of the site. The
     * local server and the Worker in a test give the answer of the case.
     */
    realHost?: { status: number }
}

/** Where a check asks. */
export interface UrlCheckOptions {
    /** A real host by its address: its edge answers some requests before the Worker (R87). */
    readonly realHost?: boolean
}

/** A note of the table: a note with former paths was published at the first one. */
export interface UrlTableNote {
    path: string
    aliases: string[]
    formerPaths?: string[]
    /** The text of an invented note that is not in the fixture vault: the table site writes it into its copy. */
    text?: string
}

/** The URL table: its published notes, its unpublished notes, its redirect list and its cases. */
export interface UrlTable {
    notes: UrlTableNote[]
    removed: UrlTableNote[]
    /** The redirect list of the content store of the table site, as `redirects.json` holds it (issue 44). */
    redirects?: unknown
    cases: UrlCase[]
}

/** Reads the URL table of the repository. */
export async function readUrlTable(): Promise<UrlTable> {
    // The file is test data of this repository, and the tests read every
    // case of it. The cast is the boundary: a wrong shape gives findings or
    // an error, in a test and in the command that checks a host.
    return (await Bun.file(TABLE).json()) as UrlTable
}

/**
 * Says whether an address is a real host: the plain server and a local
 * runtime of the host listen on this machine, and no edge stands before them.
 */
export function isRealHost(base: string): boolean {
    const name = new URL(base).hostname.toLowerCase().replace(/\.$/u, '')
    return !(
        name === 'localhost' ||
        name.endsWith('.localhost') ||
        name === '0.0.0.0' ||
        name === '[::1]' ||
        /^127(?:\.\d{1,3}){3}$/u.test(name)
    )
}

/** Asks a host for a path, and follows no redirect. */
export type Ask = (path: string, headers?: Record<string, string>) => Promise<Response>

/** What a check knows about the site that the host serves. */
export interface UrlTableSite {
    readonly table: UrlTable
    /** The cleaned note of the content store, by its vault path: the Markdown that the site gives. */
    readonly markdownOf: (path: string) => Promise<string>
}

/** The prefix of the Markdown path of a note (URL-10). */
const MARKDOWN_PREFIX = '/-/md/'

/** A tag without the mark of its weak form: two tags are compared weakly (RFC 9110, section 13.1.2). */
function strongForm(tag: string): string {
    return tag.startsWith('W/') ? tag.slice(2) : tag
}

/**
 * The checks of a conditional request of a note at its canonical URL, in the
 * form of the case (URL-18): its tag answers 304 with no body and with
 * `Vary`, and the other form of the note has another tag, which is no tag of
 * this form.
 */
async function notModifiedFindings(
    entry: UrlCase,
    ask: Ask,
    tag: string | null,
    markdownForm: boolean
): Promise<string[]> {
    if (tag === null) {
        return ['etag: expected a tag, got null']
    }
    const findings: string[] = []
    const accept: Record<string, string> =
        entry.accept === undefined ? {} : { accept: entry.accept }
    const again = await ask(entry.request, { ...accept, 'if-none-match': tag })
    const body = await again.text()
    if (again.status !== 304 || body !== '') {
        findings.push(
            `asked with its tag: expected 304 with no body, got ${String(again.status)}${body === '' ? '' : ' with a body'}`
        )
    } else if (again.headers.get('vary') !== 'Accept') {
        findings.push(
            `vary of the 304: expected "Accept", got ${JSON.stringify(again.headers.get('vary'))}`
        )
    }
    const other = await ask(entry.request, {
        accept: markdownForm ? 'text/html' : 'text/markdown'
    })
    await other.arrayBuffer()
    const otherTag = other.headers.get('etag')
    if (otherTag === null) {
        return [...findings, 'etag of the other form: expected a tag, got null']
    }
    if (strongForm(otherTag) === strongForm(tag)) {
        findings.push(`etag: the other form has the same tag ${JSON.stringify(otherTag)}`)
    }
    const crossed = await ask(entry.request, { ...accept, 'if-none-match': otherTag })
    await crossed.arrayBuffer()
    if (crossed.status !== 200) {
        findings.push(
            `asked with the tag of the other form: expected 200, got ${String(crossed.status)}`
        )
    }
    return findings
}

/** The canonical link of a page: `<link rel="canonical" href="...">`. */
function canonicalLinkOf(html: string): string | undefined {
    return /<link rel="canonical" href="([^"]*)"/u.exec(html)?.[1]
}

/**
 * Checks the answer of a host for one case of the table.
 *
 * @returns the findings: an empty list when the answer is the one of the table
 */
export async function checkUrlCase(
    entry: UrlCase,
    ask: Ask,
    site: UrlTableSite,
    options: UrlCheckOptions = {}
): Promise<string[]> {
    const findings: string[] = []
    const same = (what: string, got: unknown, wanted: unknown): void => {
        if (got !== wanted) {
            findings.push(`${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`)
        }
    }
    const holds = (what: string, text: string, part: string): void => {
        if (!text.includes(part)) {
            findings.push(`${what}: ${JSON.stringify(part)} is missing`)
        }
    }
    const response = await ask(
        entry.request,
        entry.accept === undefined ? {} : { accept: entry.accept }
    )
    if (options.realHost === true && entry.realHost !== undefined) {
        // The edge refuses the request before the Worker runs: its own short
        // page, never the page of the site.
        same('status', response.status, entry.realHost.status)
        if ((await response.text()).includes('>Not found</h1>')) {
            findings.push('body: it is the not found page of the site, not the answer of the edge')
        }
        return findings
    }
    same('status', response.status, entry.status)
    if (entry.location !== undefined) {
        same('location', response.headers.get('location'), entry.location)
        same('cache-control', response.headers.get('cache-control'), entry.cacheControl ?? '')
        // A target on another host of the author is not asked: the run counts it as ok.
        if (/^https?:/u.test(entry.location)) {
            return findings
        }
        // URL-05: the target is a page, reached in one hop, with a clean
        // canonical link.
        const target = await ask(entry.location)
        same('status of the target', target.status, 200)
        // The Markdown of a note has no canonical link.
        // A page that says noindex (a folder list) has none (R85).
        if (!entry.location.startsWith('/-/md/')) {
            const html = await target.text()
            same(
                'canonical link of the target',
                canonicalLinkOf(html),
                html.includes('<meta name="robots" content="noindex')
                    ? undefined
                    : `${ORIGIN}${entry.location.split('?')[0] ?? ''}`
            )
        }
        return findings
    }
    const body = await response.text()
    if (entry.status === 404 || entry.status === 410) {
        // An error answer is never kept, and its form follows the header or
        // the path (NAV-21).
        same('cache-control', response.headers.get('cache-control'), 'no-store')
        same('vary', response.headers.get('vary'), 'Accept')
        if (entry.format === 'markdown') {
            same(
                'content-type',
                response.headers.get('content-type'),
                'text/markdown; charset=utf-8'
            )
            const first = entry.status === 410 ? '# Removed\n\n' : '# Not found\n\n'
            if (!body.startsWith(first)) {
                findings.push(`body: it does not start with ${JSON.stringify(first)}`)
            }
            for (const path of entry.suggestions ?? []) {
                holds('body', body, `- ${path}\n`)
            }
            return findings
        }
        same('content-type', response.headers.get('content-type'), 'text/html; charset=utf-8')
        holds(
            'body',
            body,
            entry.status === 410 ? '>This note was removed</h1>' : '>Not found</h1>'
        )
        for (const path of entry.suggestions ?? []) {
            holds('body', body, `href="${path}"`)
        }
        // The gone page shows nothing of the removed note (NAV-19).
        for (const note of site.table.removed) {
            for (const text of [note.path, ...note.aliases, ...(note.formerPaths ?? [])]) {
                const name = text.replace(/\.md$/u, '').split('/').at(-1) ?? ''
                if (body.includes(name) || body.includes(canonicalPath(note.path))) {
                    findings.push(`body: it names the removed note ${JSON.stringify(text)}`)
                }
            }
        }
        return findings
    }
    if (entry.file !== undefined) {
        const [kind = '', path = ''] = entry.file.split(/:(.*)/su)
        if (kind === 'markdown') {
            same(
                'content-type',
                response.headers.get('content-type'),
                'text/markdown; charset=utf-8'
            )
            same(
                'content-disposition',
                response.headers.get('content-disposition'),
                entry.disposition ?? null
            )
            // A cache that ignores the query (U12) never keeps the download form.
            same(
                'cache-control',
                response.headers.get('cache-control'),
                entry.disposition === undefined ? 'public, max-age=0, must-revalidate' : 'no-store'
            )
            same('body', body, await site.markdownOf(path))
            // The Markdown form of a note at its canonical URL follows the
            // `Accept` header (URL-11); the Markdown path has one form.
            const canonicalForm = !entry.request.startsWith(MARKDOWN_PREFIX)
            same('vary', response.headers.get('vary'), canonicalForm ? 'Accept' : null)
            if (entry.notModified === true) {
                findings.push(
                    ...(await notModifiedFindings(entry, ask, response.headers.get('etag'), true))
                )
            }
        } else if (kind === 'icon') {
            same('content-type', response.headers.get('content-type'), 'image/x-icon')
            same(
                'cache-control',
                response.headers.get('cache-control'),
                'public, max-age=0, must-revalidate'
            )
            if (body === '') {
                findings.push('body: it is empty')
            }
        } else {
            same('content-type', response.headers.get('content-type'), 'text/plain; charset=utf-8')
            holds('body', body, 'User-agent: *')
        }
        return findings
    }
    same('content-type', response.headers.get('content-type'), 'text/html; charset=utf-8')
    // A query gives the same page, with a clean canonical link (URL-12). A
    // folder list says noindex and has no canonical link (R85).
    same(
        'canonical link',
        canonicalLinkOf(body),
        entry.canonical === undefined ? undefined : `${ORIGIN}${entry.canonical}`
    )
    // The page of a note has a Markdown form too (URL-11); another page has
    // one form, whatever the header asks.
    if (entry.page !== undefined) {
        const note = entry.page.startsWith('note:')
        same('vary', response.headers.get('vary'), note ? 'Accept' : null)
    }
    if (entry.notModified === true) {
        findings.push(
            ...(await notModifiedFindings(entry, ask, response.headers.get('etag'), false))
        )
    }
    return findings
}

/** The findings of one case of the table. */
export interface UrlCaseFindings {
    readonly name: string
    readonly request: string
    readonly findings: readonly string[]
}

/**
 * Checks every case of the table on a host, one after the other.
 *
 * @returns the cases with a finding: an empty list when the host answers as the table says
 */
export async function checkUrlTable(
    ask: Ask,
    site: UrlTableSite,
    options: UrlCheckOptions = {}
): Promise<UrlCaseFindings[]> {
    const wrong: UrlCaseFindings[] = []
    for (const entry of site.table.cases) {
        let findings: string[]
        try {
            findings = await checkUrlCase(entry, ask, site, options)
        } catch (error) {
            // A host that cannot be reached is a finding of the case, not the end of the run.
            findings = [`no answer: ${error instanceof Error ? error.message : String(error)}`]
        }
        if (findings.length > 0) {
            wrong.push({ name: entry.name, request: entry.request, findings })
        }
    }
    return wrong
}

/**
 * Checks that a file that did not change answers 304 to a request that names
 * its tag, and 200 to a request that names another tag (URL-18). A host can
 * give the tag in its weak form.
 *
 * @returns the findings: an empty list when the host answers so
 */
export async function checkNotModified(path: string, ask: Ask): Promise<string[]> {
    const first = await ask(path)
    await first.arrayBuffer()
    const tag = first.headers.get('etag')
    if (first.status !== 200 || tag === null) {
        return [
            `${path}: expected 200 with a tag, got ${String(first.status)} and the tag ${String(tag)}`
        ]
    }
    const findings: string[] = []
    const same = await ask(path, { 'if-none-match': tag })
    const body = await same.text()
    if (same.status !== 304 || body !== '') {
        findings.push(
            `${path} asked with its tag: expected 304 with no body, got ${String(same.status)} with ${String(body.length)} characters`
        )
    }
    const other = await ask(path, { 'if-none-match': '"another"' })
    await other.arrayBuffer()
    if (other.status !== 200) {
        findings.push(`${path} asked with another tag: expected 200, got ${String(other.status)}`)
    }
    return findings
}
