import { errorFormat, errorText, type ErrorStatus } from './errors.ts'
import { resolve, type ResolverMap, type SiteFile } from './resolver.ts'
import { SITE_ORIGIN } from './url.ts'

// The answer of a request (MOD-09 and HOST-02 of the spec): the URL contract
// over HTTP, in plain TypeScript with the `Request` and `Response` of the web
// platform. It knows no host. The files of a release and of the attachment
// storage are behind a port (`Release`): the plain local server gives them
// from folders, the edge from the static files and the object storage of the
// host. So both give the same answers, and the tests of the URL contract run
// against both.

/** A part of a file: its first and its last byte. */
export interface ByteRange {
    readonly start: number
    readonly end: number
}

/** A file as a host stores it: a file of a release, or a file of the attachment storage. */
export interface StoredFile {
    /** The size of the whole file, in bytes. */
    readonly size: number
    /**
     * The entity tag of the file, with its quotes, in its strong or its weak
     * form. It changes when the file changes. A file without a tag never
     * answers 304.
     */
    readonly tag?: string
    /** The bytes of the file, or of a part of it. */
    readonly read: (range?: ByteRange) => BodyInit | Promise<BodyInit>
    /** Lets go of the file. The handler calls it when an answer needs no byte of the file. */
    readonly discard?: () => void | Promise<void>
}

/** The files of one release of the site, as a host gives them. */
export interface Release {
    /** The resolver map of the release. */
    readonly map: ResolverMap
    /**
     * A file of the output of the build, by its name in the resolver map.
     * `undefined` when the release lacks it.
     */
    readonly file: (name: string) => Promise<StoredFile | undefined>
    /**
     * A file that the pages load (a style sheet, a script, a file of the
     * search), by the path of its URL. `undefined` when the path names no
     * such file, `'missing'` when the release names the file and lacks it.
     */
    readonly asset: (path: string) => Promise<StoredFile | 'missing' | undefined>
    /**
     * A file of the attachment storage, by its key. `undefined` when the
     * storage lacks it. A host without an attachment storage has no such
     * function: an attachment then answers 404.
     */
    readonly attachment?: (key: string) => Promise<StoredFile | undefined>
    /**
     * The server error page, read before any request: a failure never
     * depends on a file of the release, which can be the missing file
     * (NAV-20).
     */
    readonly serverErrorPage?: string
    /**
     * The origin of the absolute addresses of the Markdown texts of the
     * errors (`errorText()`), such as the listening address of the plain
     * server. Without it, the origin of the URL of the request, which a
     * host may give only when the host, not a header of the client, sets
     * it (see `errorText()`).
     */
    readonly origin?: string
    /** Takes the detail of a failure, which never goes into an answer. */
    readonly report?: (error: unknown) => void
}

/**
 * The folders of the files that the pages load, in the output of the build:
 * the style sheets and the scripts, which Astro names with a hash, and the
 * indexes of the search (decision R63). Each host gives a file of these
 * folders by the path of its URL, and every other file by the resolver map.
 */
export const ASSET_FOLDERS: readonly string[] = ['_astro', '-/search']

/**
 * The deployment record of a release (STORE-08), in the output of the build:
 * which revisions of the content store and of the code are live, and the
 * time of the build. The deployment writes it after the build, so the
 * resolver map never names it. Every host gives it at its path, never kept.
 */
export const DEPLOYMENT_RECORD_FILE = '-/deployment.json'

const HTML = 'text/html; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'

// The kinds of files are maps, not objects: the end of a name such as
// `constructor` is a key like any other.
const ASSET_TYPES = new Map(
    Object.entries({
        css: 'text/css; charset=utf-8',
        js: 'text/javascript; charset=utf-8',
        json: 'application/json; charset=utf-8',
        svg: 'image/svg+xml',
        png: 'image/png',
        webp: 'image/webp',
        woff2: 'font/woff2'
    })
)

/** The kinds of the attachments, by the end of their names. Every other file is plain bytes. */
const ATTACHMENT_TYPES = new Map(
    Object.entries({
        '3gp': 'video/3gpp',
        'avif': 'image/avif',
        'bmp': 'image/bmp',
        'flac': 'audio/flac',
        'gif': 'image/gif',
        'jpeg': 'image/jpeg',
        'jpg': 'image/jpeg',
        'm4a': 'audio/mp4',
        'mkv': 'video/x-matroska',
        'mov': 'video/quicktime',
        'mp3': 'audio/mpeg',
        'mp4': 'video/mp4',
        'ogg': 'audio/ogg',
        'ogv': 'video/ogg',
        'pdf': 'application/pdf',
        'png': 'image/png',
        'svg': 'image/svg+xml',
        'wav': 'audio/wav',
        'webm': 'video/webm',
        'webp': 'image/webp'
    })
)

/** The kinds of the files of the site that are not pages. */
const FILE_TYPES: Record<SiteFile['type'], string> = {
    markdown: 'text/markdown; charset=utf-8',
    text: TEXT,
    icon: 'image/x-icon'
}

/**
 * The headers of the Markdown form of a note (IDX-16): it stays out of the
 * index, and names the page of its note as canonical, at the canonical host
 * on every host, as the canonical link of the page does. The resolver gives
 * the Markdown of a note only at its path `/-/md/<canonical path>.md`.
 */
function markdownHeaders(pathname: string): Record<string, string> {
    const page = new URL(pathname.slice('/-/md'.length, -'.md'.length), SITE_ORIGIN).href
    return { 'x-robots-tag': 'noindex', 'link': `<${page}>; rel="canonical"` }
}

/**
 * How long a client keeps a file that the pages load: a year for a file of
 * `/_astro/`, which Astro names with a hash of its bytes, and a check at
 * each use for the files of the search, whose names stay. The host gives the
 * same headers to the files that it serves without the Worker (the
 * `_headers` file of `apps/site/worker/deployment.ts`).
 */
function assetCacheControl(path: string): string {
    return path.startsWith('/_astro/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate'
}

/** The end of a name after its last dot, as written. */
function extensionOf(name: string): string {
    return name.slice(name.lastIndexOf('.') + 1)
}

/**
 * An answer with the bytes of a file, or of a part of it. A request of the
 * headers only (`HEAD`) gets no byte: the file is let go, and the answer
 * says the size that the bytes would have.
 */
async function fileResponse(
    request: Request,
    file: StoredFile,
    init: { status?: number; headers: Record<string, string> },
    range?: ByteRange
): Promise<Response> {
    if (request.method !== 'HEAD') {
        return new Response(await file.read(range), init)
    }
    await file.discard?.()
    const length = range === undefined ? file.size : range.end - range.start + 1
    return new Response(null, {
        ...init,
        // A host that does not know the size of a file gives 0 for it.
        headers: length > 0 ? { ...init.headers, 'content-length': String(length) } : init.headers
    })
}

/**
 * The part of a file that a range request asks for. `undefined` when the
 * request asks for the whole file: no range, or a range in a form that the
 * handler does not take (several ranges), which HTTP lets a server answer
 * with the whole file. `null` when the range is outside the file.
 */
function rangeOf(header: string | null, size: number): ByteRange | undefined | null {
    const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (match === null) {
        return undefined
    }
    const [, first = '', last = ''] = match
    if (first === '' && last === '') {
        return undefined
    }
    if (first === '') {
        // The last bytes of the file.
        const length = Number(last)
        return length === 0 || size === 0
            ? null
            : { start: Math.max(size - length, 0), end: size - 1 }
    }
    const start = Number(first)
    const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
    return start >= size || end < start ? null : { start, end }
}

/**
 * The answer for an attachment: the whole file, or the part that a range
 * request asks for (HOST-05). The content of a hashed URL never changes, so
 * it can be kept for a year. An attachment is never a page: it runs no
 * script and loads nothing, also an SVG that is opened alone.
 */
async function attachmentResponse(
    request: Request,
    file: StoredFile,
    name: string
): Promise<Response> {
    const type = ATTACHMENT_TYPES.get(extensionOf(name).toLowerCase()) ?? 'application/octet-stream'
    const headers: Record<string, string> = {
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': type,
        'x-content-type-options': 'nosniff'
    }
    // An SVG or any other file opened alone runs no script. The viewer of a
    // browser refuses a PDF in a sandbox, and it runs the PDF apart anyway.
    if (type !== 'application/pdf') {
        headers['content-security-policy'] =
            "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    }
    const range = rangeOf(request.headers.get('range'), file.size)
    if (range === null) {
        await file.discard?.()
        return new Response(null, {
            status: 416,
            headers: { ...headers, 'content-range': `bytes */${String(file.size)}` }
        })
    }
    if (range === undefined) {
        return await fileResponse(request, file, { headers })
    }
    return await fileResponse(
        request,
        file,
        {
            status: 206,
            headers: {
                ...headers,
                'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(file.size)}`
            }
        },
        range
    )
}

/**
 * The headers of every error answer: it is never kept, and its form follows
 * the `Accept` header (NAV-21, decision R64).
 */
const ERROR_HEADERS = { 'cache-control': 'no-store', 'vary': 'Accept' } as const

/** The short Markdown text of an error answer, for an agent (NAV-21). */
function errorMarkdown(
    status: ErrorStatus,
    origin: string,
    suggestions: readonly string[] = []
): Response {
    return new Response(errorText(status, origin, suggestions), {
        status,
        headers: { 'content-type': 'text/markdown; charset=utf-8', ...ERROR_HEADERS }
    })
}

/** A short text with the status of an error, for a release without the page of that error. */
function errorPlain(status: ErrorStatus, text: string): Response {
    return new Response(text, { status, headers: { 'content-type': TEXT, ...ERROR_HEADERS } })
}

/**
 * The answer when the release lacks a file that the resolver map names, and
 * for every other failure: the server error page, or its short text, with no
 * detail of the failure (URL-33, NAV-20).
 */
function serverError(
    format: 'html' | 'markdown',
    page: string | undefined,
    origin: string
): Response {
    if (format === 'markdown') {
        return errorMarkdown(500, origin)
    }
    return page === undefined
        ? errorPlain(500, errorText(500, origin))
        : new Response(page, { status: 500, headers: { 'content-type': HTML, ...ERROR_HEADERS } })
}

/**
 * The answer of a failure for a request, with no detail of the failure: the
 * server error page, its short text when the host has no such page, or the
 * short Markdown text for an agent (NAV-20, NAV-21). The handler gives it
 * itself for a failure inside it. A host gives it for a failure outside of
 * the handler, such as a release that it cannot read.
 *
 * @param page the server error page, when the host has it
 * @param origin the origin of the addresses of the Markdown text (`Release.origin`)
 */
export function failureResponse(request: Request, page?: string, origin?: string): Response {
    const url = urlOf(request)
    if (url === undefined) {
        return badRequest()
    }
    return serverError(
        errorFormat(url.pathname, request.headers.get('accept')),
        page,
        origin ?? url.origin
    )
}

/**
 * The URL of a request. `undefined` when it does not parse: a plain server
 * builds it from the `Host` header of the client, which can be any text.
 */
function urlOf(request: Request): URL | undefined {
    try {
        return new URL(request.url)
    } catch {
        return undefined
    }
}

/** The answer to a request whose URL does not parse: the fault of the client, never kept. */
function badRequest(): Response {
    return new Response('Bad request\n', {
        status: 400,
        headers: { 'content-type': TEXT, 'cache-control': 'no-store' }
    })
}

/** A tag without the mark of its weak form: a 304 compares two tags weakly (RFC 9110, section 13.1.2). */
function strongForm(tag: string): string {
    return tag.startsWith('W/') ? tag.slice(2) : tag
}

/**
 * One step of the list of tags of an `If-None-Match` header: a tag in its
 * strong or its weak form, and the comma after it. A tag is read whole by its
 * quotes, so a tag that holds a comma is one tag (RFC 9110, section 8.8.3;
 * issue 117).
 */
const WANTED_TAG = /\s*(W\/"[^"]*"|"[^"]*")\s*(?:,|$)/uy

/**
 * True when an `If-None-Match` header names the tag, or any version of the
 * file (`*`, only as the whole header). A header that is not a list of
 * quoted tags names no tag.
 */
function namesTag(wanted: string, tag: string): boolean {
    if (wanted.trim() === '*') {
        return true
    }
    const strong = strongForm(tag)
    const step = new RegExp(WANTED_TAG)
    let named = false
    while (step.lastIndex < wanted.length) {
        const match = step.exec(wanted)
        if (match?.[1] === undefined) {
            return false
        }
        named ||= strongForm(match[1]) === strong
    }
    return named
}

/**
 * A file of the output of the build: a page or another file of the site. It
 * answers 304 when the request names its tag (URL-18). A client checks it
 * again at each use, so a new publication shows at once. With the status of
 * an error, it is the page of that error: never kept, and never 304.
 */
async function siteFileResponse(
    request: Request,
    file: StoredFile,
    type: string,
    status: 200 | 404 | 410 = 200,
    extra: Readonly<Record<string, string>> = {}
): Promise<Response> {
    if (status !== 200) {
        return await fileResponse(request, file, {
            status,
            headers: { 'content-type': type, ...ERROR_HEADERS }
        })
    }
    const headers: Record<string, string> = {
        'content-type': type,
        'cache-control': 'public, max-age=0, must-revalidate',
        ...extra
    }
    if (file.tag !== undefined) {
        headers['etag'] = file.tag
        const wanted = request.headers.get('if-none-match')
        if (wanted !== null && namesTag(wanted, file.tag)) {
            await file.discard?.()
            return new Response(null, { status: 304, headers })
        }
    }
    return await fileResponse(request, file, { headers })
}

/**
 * The handler of a release: the answer of each request, through the
 * resolver. Each file comes from the resolver map or from the files that the
 * pages load, never from the request.
 */
export function siteHandler(release: Release): (request: Request) => Promise<Response> {
    /** The answer of a request. `undefined` when the release lacks a file that it names. */
    async function answer(
        request: Request,
        pathname: string,
        search: string,
        origin: string,
        format: 'html' | 'markdown'
    ): Promise<Response | undefined> {
        // A file of the build comes first: an alias or a variant never hides it.
        const asset = await release.asset(pathname)
        if (asset === 'missing') {
            return undefined
        }
        if (asset !== undefined) {
            return await fileResponse(request, asset, {
                headers: {
                    'content-type':
                        ASSET_TYPES.get(extensionOf(pathname)) ?? 'application/octet-stream',
                    'cache-control': assetCacheControl(pathname)
                }
            })
        }
        if (pathname === `/${DEPLOYMENT_RECORD_FILE}`) {
            const record = await release.file(DEPLOYMENT_RECORD_FILE)
            if (record !== undefined) {
                return await fileResponse(request, record, {
                    headers: {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store'
                    }
                })
            }
        }
        const resolution = resolve(pathname, release.map, search)
        /** A file of the release as an answer. `undefined` when the release lacks it. */
        const fileOf = async (
            name: string,
            type: string,
            status: 200 | 404 | 410 = 200,
            extra: Readonly<Record<string, string>> = {}
        ): Promise<Response | undefined> => {
            const file = await release.file(name)
            return file === undefined
                ? undefined
                : await siteFileResponse(request, file, type, status, extra)
        }
        switch (resolution.kind) {
            case 'not-found':
                if (format === 'markdown') {
                    return errorMarkdown(404, origin, resolution.suggestions)
                }
                return resolution.file === undefined
                    ? errorPlain(404, 'Not found\n')
                    : await fileOf(resolution.file, HTML, 404)
            case 'gone':
                // An unpublished note (URL-27, NAV-19).
                if (format === 'markdown') {
                    return errorMarkdown(410, origin)
                }
                return resolution.file === undefined
                    ? errorPlain(410, errorText(410, origin))
                    : await fileOf(resolution.file, HTML, 410)
            case 'attachment': {
                if (release.attachment === undefined) {
                    return errorPlain(404, 'Not found\n')
                }
                const file = await release.attachment(resolution.key)
                // The map names the file, so the storage lacks it: a failure
                // of the release, never "not found" that a cache keeps (URL-33).
                return file === undefined
                    ? undefined
                    : await attachmentResponse(request, file, resolution.name)
            }
            case 'redirect':
                return new Response(null, {
                    status: resolution.status,
                    headers: {
                        'location': resolution.location,
                        'cache-control': resolution.cacheControl
                    }
                })
            case 'file':
                return await fileOf(
                    resolution.file,
                    FILE_TYPES[resolution.type],
                    200,
                    resolution.type === 'markdown' ? markdownHeaders(pathname) : {}
                )
            case 'page':
                return await fileOf(resolution.file, HTML)
        }
    }

    return async (request) => {
        const url = urlOf(request)
        if (url === undefined) {
            return badRequest()
        }
        // The path is read as it is requested, with its percent-encoding.
        const { pathname, search } = url
        const origin = release.origin ?? url.origin
        const format = errorFormat(pathname, request.headers.get('accept'))
        try {
            return (
                (await answer(request, pathname, search, origin, format)) ??
                serverError(format, release.serverErrorPage, origin)
            )
        } catch (error) {
            // The detail goes to the log of the host, never to the answer.
            release.report?.(error)
            return serverError(format, release.serverErrorPage, origin)
        }
    }
}
