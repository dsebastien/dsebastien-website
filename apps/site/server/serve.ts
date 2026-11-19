import { readdir } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'
import { resolve, type ResolverMap } from '@dsebastien-website/resolver'

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

async function readResolverMap(dist: string): Promise<ResolverMap> {
    const map: unknown = await Bun.file(join(dist, RESOLVER_MAP)).json()
    const pages = isRecord(map) ? map['pages'] : undefined
    const attachments = isRecord(map) ? (map['attachments'] ?? {}) : undefined
    if (
        !isRecord(pages) ||
        !Object.values(pages).every((file) => typeof file === 'string') ||
        !isRecord(attachments) ||
        !Object.values(attachments).every(
            (key) => typeof key === 'string' && ATTACHMENT_KEY.test(key)
        )
    ) {
        throw new Error(`${RESOLVER_MAP} is not a resolver map`)
    }
    return {
        pages: pages as Record<string, string>,
        attachments: attachments as Record<string, string>
    }
}

/** The folder of the style sheets and of the other files that the pages load. Astro names each file with a hash. */
const ASSETS = '_astro'

const CONTENT_TYPES: Record<string, string> = {
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    webp: 'image/webp',
    woff2: 'font/woff2'
}

/** The kinds of the attachments, by the end of their names. Every other file is plain bytes. */
const ATTACHMENT_TYPES: Record<string, string> = {
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
}

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
async function attachmentResponse(request: Request, file: string, name: string): Promise<Response> {
    const blob = Bun.file(file)
    if (!(await blob.exists())) {
        return notFound()
    }
    const size = blob.size
    const type =
        ATTACHMENT_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ??
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

function notFound(): Response {
    return new Response('Not found\n', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
}

/**
 * The files that the pages load, by the path of their URL. The list is read
 * from the output of the build one time: the server gives a file of that list
 * and nothing else, so a request can never name a file itself.
 */
async function readAssets(dist: string): Promise<{ get(path: string): Response | undefined }> {
    let names: string[]
    try {
        names = await readdir(join(dist, ASSETS))
    } catch {
        names = []
    }
    const files = new Map(names.map((name) => [`/${ASSETS}/${name}`, join(dist, ASSETS, name)]))
    return {
        get(path) {
            const file = files.get(path)
            if (file === undefined) {
                return undefined
            }
            const type = CONTENT_TYPES[file.split('.').at(-1) ?? ''] ?? 'application/octet-stream'
            return new Response(Bun.file(file), { headers: { 'content-type': type } })
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
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: options.port,
        fetch(request) {
            // The path is read as it is requested, with its percent-encoding.
            const { pathname } = new URL(request.url)
            const resolution = resolve(pathname, map)
            if (resolution.kind === 'not-found') {
                return assets.get(pathname) ?? notFound()
            }
            if (resolution.kind === 'attachment') {
                // The file comes from the key of the resolver map, never from the request.
                return storage === undefined
                    ? notFound()
                    : attachmentResponse(request, join(storage, resolution.key), resolution.name)
            }
            // The file comes from the resolver map, never from the request.
            return new Response(Bun.file(join(dist, resolution.file)), {
                headers: { 'content-type': 'text/html; charset=utf-8' }
            })
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
