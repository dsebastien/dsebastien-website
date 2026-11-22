import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { parseArgs } from 'node:util'
import {
    errorFormat,
    errorText,
    resolve,
    SERVER_ERROR_FILE,
    type ErrorStatus,
    type ResolverMap,
    type SiteFile
} from '@dsebastien-website/resolver'

// The plain server (MOD-09 and HOST-02 of the spec): it serves the output of
// the build through the resolver, as the edge does on the real host. It is
// for local work and for the tests of the URL contract. It is not a server
// for production.
//
//   bun run serve [--dist <folder>] [--port <number>] [--attachments <folder>]
//
// With `--attachments`, it also gives the attachments that the pages use,
// from that folder, which stands for the attachment storage (HOST-05).

/** The place of the resolver map in the output of the build. */
const RESOLVER_MAP = '-/resolver-map.json'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The form of a key of the attachment storage. It names a file of the storage. */
const ATTACHMENT_KEY = /^[0-9a-f]{64}$/

/** True when every value of the record passes the check. */
function everyValue(value: unknown, check: (item: unknown) => boolean): boolean {
    return isRecord(value) && Object.values(value).every(check)
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isTextList = (value: unknown): boolean => Array.isArray(value) && value.every(isText)
const isSet = (value: unknown): boolean => everyValue(value, (item) => item === true)
const isGoneMap = (value: unknown): boolean =>
    isRecord(value) &&
    (value['file'] === undefined || isText(value['file'])) &&
    isSet(value['paths']) &&
    isSet(value['folded']) &&
    isSet(value['names']) &&
    isSet(value['aliases'])
const isSiteFile = (value: unknown): value is SiteFile =>
    isRecord(value) &&
    isText(value['file']) &&
    (value['type'] === 'markdown' || value['type'] === 'text')

async function readResolverMap(dist: string): Promise<ResolverMap> {
    const map: unknown = await Bun.file(join(dist, RESOLVER_MAP)).json()
    if (
        !isRecord(map) ||
        !everyValue(map['pages'], isText) ||
        !everyValue(map['files'] ?? {}, isSiteFile) ||
        !everyValue(
            map['attachments'] ?? {},
            (key) => typeof key === 'string' && ATTACHMENT_KEY.test(key)
        ) ||
        !everyValue(map['folded'] ?? {}, isText) ||
        !everyValue(map['names'] ?? {}, isTextList) ||
        !everyValue(map['aliases'] ?? {}, isTextList) ||
        !everyValue(map['choices'] ?? {}, isText) ||
        !(map['notFound'] === undefined || isText(map['notFound'])) ||
        !(map['gone'] === undefined || isGoneMap(map['gone']))
    ) {
        throw new Error(`${RESOLVER_MAP} is not a resolver map`)
    }
    // Checked above, member by member.
    return map as unknown as ResolverMap
}

/**
 * The folders of the files that the pages load: the style sheets and the
 * scripts, which Astro names with a hash, and the indexes of the search
 * (decision R63).
 */
const ASSET_FOLDERS = ['_astro', '-/search']

// The kinds of files are maps, not objects: the end of a name such as
// `constructor` is a key like any other.
const CONTENT_TYPES = new Map(
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

/**
 * The part of a file that a range request asks for, as the first and the
 * last byte. `undefined` when the request asks for the whole file: no range,
 * or a range in a form that the server does not take (several ranges), which
 * HTTP lets a server answer with the whole file. `null` when the range is
 * outside the file.
 */
function rangeOf(
    header: string | null,
    size: number
): { start: number; end: number } | undefined | null {
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
    file: string,
    name: string,
    fail: () => Response
): Promise<Response> {
    const blob = Bun.file(file)
    if (!(await blob.exists())) {
        // The map names the file, so the storage lacks it: a failure of the
        // release, never "not found" that a cache keeps (URL-33).
        return fail()
    }
    const size = blob.size
    const type =
        ATTACHMENT_TYPES.get(name.slice(name.lastIndexOf('.') + 1).toLowerCase()) ??
        'application/octet-stream'
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
    const range = rangeOf(request.headers.get('range'), size)
    if (range === null) {
        return new Response(null, {
            status: 416,
            headers: { ...headers, 'content-range': `bytes */${String(size)}` }
        })
    }
    if (range === undefined) {
        return new Response(blob, { headers })
    }
    return new Response(blob.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
            ...headers,
            'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`
        }
    })
}

/**
 * The headers of every error answer: it is never kept, and its form follows
 * the `Accept` header (NAV-21, decision R64).
 */
const ERROR_HEADERS = { 'cache-control': 'no-store', 'vary': 'Accept' } as const

/** The short Markdown text of an error answer, for an agent (NAV-21). */
function errorMarkdown(status: ErrorStatus, suggestions: readonly string[] = []): Response {
    return new Response(errorText(status, suggestions), {
        status,
        headers: { 'content-type': 'text/markdown; charset=utf-8', ...ERROR_HEADERS }
    })
}

/** A plain "not found", for a build with no "not found" page and for an attachment without a storage. */
function notFound(): Response {
    return new Response('Not found\n', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...ERROR_HEADERS }
    })
}

/**
 * The answer when the release lacks a file that the resolver map names, and
 * for every other failure: the server error page that the server read at its
 * start, or its short text, with no detail of the failure (URL-33, NAV-20).
 *
 * @param page the server error page, or `undefined` when the build had none
 */
function serverError(format: 'html' | 'markdown', page: string | undefined): Response {
    if (format === 'markdown') {
        return errorMarkdown(500)
    }
    return page === undefined
        ? new Response(errorText(500), {
              status: 500,
              headers: { 'content-type': 'text/plain; charset=utf-8', ...ERROR_HEADERS }
          })
        : new Response(page, {
              status: 500,
              headers: { 'content-type': 'text/html; charset=utf-8', ...ERROR_HEADERS }
          })
}

/** The kinds of the files of the site that are not pages. */
const FILE_TYPES: Record<SiteFile['type'], string> = {
    markdown: 'text/markdown; charset=utf-8',
    text: 'text/plain; charset=utf-8'
}

/**
 * A file of the output of the build: a page or another file of the site. It
 * has a tag of its size and of its time, and it answers 304 when the request
 * names that tag (URL-18). A client checks it again at each use, so a new
 * publication shows at once.
 */
async function siteFileResponse(
    request: Request,
    file: string,
    type: string,
    fail: () => Response,
    status = 200
): Promise<Response> {
    const blob = Bun.file(file)
    if (!(await blob.exists())) {
        // The map names the file, so the release lacks it: a failure of the
        // release, never a page "not found" that a cache keeps (URL-33).
        return fail()
    }
    const tag = `"${blob.size.toString(16)}-${blob.lastModified.toString(16)}"`
    const headers: Record<string, string> =
        status === 200
            ? {
                  'content-type': type,
                  'cache-control': 'public, max-age=0, must-revalidate',
                  'etag': tag
              }
            : { 'content-type': type, ...ERROR_HEADERS }
    const wanted = request.headers.get('if-none-match')
    if (
        status === 200 &&
        wanted !== null &&
        wanted.split(',').some((item) => item.trim() === tag)
    ) {
        return new Response(null, { status: 304, headers })
    }
    return new Response(blob, { status, headers })
}

/**
 * The files that the pages load, by the path of their URL. The list is read
 * from the output of the build one time: the server gives a file of that list
 * and nothing else, so a request can never name a file itself.
 */
async function readAssets(
    dist: string
): Promise<{ get(path: string, fail: () => Response): Promise<Response> | undefined }> {
    const files = new Map<string, string>()
    for (const folder of ASSET_FOLDERS) {
        const root = join(dist, folder)
        let entries: Dirent[]
        try {
            entries = await readdir(root, { recursive: true, withFileTypes: true })
        } catch {
            entries = []
        }
        // Files only: a folder, and a link that could lead out of the output, are never given.
        for (const entry of entries) {
            if (entry.isFile()) {
                const file = join(entry.parentPath, entry.name)
                files.set(`/${folder}/${relative(root, file).split(sep).join('/')}`, file)
            }
        }
    }
    return {
        get(path, fail) {
            const file = files.get(path)
            if (file === undefined) {
                return undefined
            }
            const type =
                CONTENT_TYPES.get(file.split('.').at(-1) ?? '') ?? 'application/octet-stream'
            const blob = Bun.file(file)
            // A file of the list that is gone since the start is a failure
            // of the release (URL-33).
            return blob
                .exists()
                .then((exists) =>
                    exists ? new Response(blob, { headers: { 'content-type': type } }) : fail()
                )
        }
    }
}

/** A running server. */
export interface Server {
    /** The address of the server, without a slash at the end. */
    url: string
    stop(): Promise<void>
}

/**
 * Starts the server on this machine only.
 *
 * @param options.dist the output of the build
 * @param options.port the port. 0 takes a free port
 * @param options.attachments the folder of the attachment storage. Without it, an attachment answers 404
 */
export async function startServer(options: {
    dist: string
    port: number
    attachments?: string
}): Promise<Server> {
    const dist = resolvePath(options.dist)
    const storage = options.attachments === undefined ? undefined : resolvePath(options.attachments)
    const map = await readResolverMap(dist)
    const assets = await readAssets(dist)
    // Read one time at the start: a failure never depends on a file of the
    // release, which can be the missing file (NAV-20).
    const errorPage = Bun.file(join(dist, SERVER_ERROR_FILE))
    const serverErrorPage = (await errorPage.exists()) ? await errorPage.text() : undefined

    /** The answer of a request, through the resolver. */
    async function answer(
        request: Request,
        pathname: string,
        search: string,
        fail: () => Response
    ): Promise<Response> {
        // A file of the build comes first: an alias or a variant never hides it.
        const asset = assets.get(pathname, fail)
        if (asset !== undefined) {
            return await asset
        }
        const resolution = resolve(pathname, map, search)
        const format = errorFormat(pathname, request.headers.get('accept'))
        const html = 'text/html; charset=utf-8'
        // Each file comes from the resolver map or from the list of the
        // assets, never from the request.
        switch (resolution.kind) {
            case 'not-found':
                if (format === 'markdown') {
                    return errorMarkdown(404, resolution.suggestions)
                }
                return resolution.file === undefined
                    ? notFound()
                    : await siteFileResponse(request, join(dist, resolution.file), html, fail, 404)
            case 'gone':
                // An unpublished note (URL-27, NAV-19).
                if (format === 'markdown') {
                    return errorMarkdown(410)
                }
                return resolution.file === undefined
                    ? new Response(errorText(410), {
                          status: 410,
                          headers: { 'content-type': 'text/plain; charset=utf-8', ...ERROR_HEADERS }
                      })
                    : await siteFileResponse(request, join(dist, resolution.file), html, fail, 410)
            case 'attachment':
                return storage === undefined
                    ? notFound()
                    : await attachmentResponse(
                          request,
                          join(storage, resolution.key),
                          resolution.name,
                          fail
                      )
            case 'redirect':
                return new Response(null, {
                    status: resolution.status,
                    headers: {
                        'location': resolution.location,
                        'cache-control': resolution.cacheControl
                    }
                })
            case 'file':
                return await siteFileResponse(
                    request,
                    join(dist, resolution.file),
                    FILE_TYPES[resolution.type],
                    fail
                )
            case 'page':
                return await siteFileResponse(request, join(dist, resolution.file), html, fail)
        }
    }

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: options.port,
        // A failure outside a request gives the server error page with no
        // detail, never the error page of Bun with the paths of the machine
        // (NAV-20).
        error(error) {
            // The detail goes to the log of the machine, never to the answer.
            console.error(error)
            return serverError('html', serverErrorPage)
        },
        async fetch(request) {
            // The path is read as it is requested, with its percent-encoding.
            const { pathname, search } = new URL(request.url)
            const fail = (): Response =>
                serverError(errorFormat(pathname, request.headers.get('accept')), serverErrorPage)
            try {
                return await answer(request, pathname, search, fail)
            } catch (error) {
                console.error(error)
                return fail()
            }
        }
    })
    return {
        url: `http://127.0.0.1:${String(server.port)}`,
        stop: () => server.stop(true)
    }
}

if (import.meta.main) {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            dist: { type: 'string', default: 'dist' },
            port: { type: 'string', default: '4322' },
            attachments: { type: 'string' }
        },
        strict: true
    })
    const server = await startServer({
        dist: values.dist,
        port: Number(values.port),
        ...(values.attachments === undefined ? {} : { attachments: values.attachments })
    })
    console.error(`The built site is on ${server.url}`)
}
