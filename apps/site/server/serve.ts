import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { parseArgs } from 'node:util'
import {
    errorText,
    RESOLVER_MAP_FILE,
    resolverMapFrom,
    SERVER_ERROR_FILE,
    siteHandler,
    type StoredFile
} from '@dsebastien-website/resolver'

// The plain server (MOD-09 and HOST-02 of the spec): it serves the output of
// the build through the resolver, as the edge does on the real host. It is
// an adapter of the handler of the site (`siteHandler` of the resolver
// package, which holds the URL contract): it gives the files of the output
// and of the attachment storage from folders. It is for local work and for
// the tests of the URL contract. It is not a server for production.
//
//   bun run serve [--dist <folder>] [--port <number>] [--attachments <folder>]
//
// With `--attachments`, it also gives the attachments that the pages use,
// from that folder, which stands for the attachment storage (HOST-05).

/**
 * The folders of the files that the pages load: the style sheets and the
 * scripts, which Astro names with a hash, and the indexes of the search
 * (decision R63).
 */
const ASSET_FOLDERS = ['_astro', '-/search']

/**
 * A file of a folder of this machine. Its tag is its size and its time.
 * `undefined` when the file does not exist.
 */
async function storedFile(file: string): Promise<StoredFile | undefined> {
    const blob = Bun.file(file)
    if (!(await blob.exists())) {
        return undefined
    }
    return {
        size: blob.size,
        tag: `"${blob.size.toString(16)}-${blob.lastModified.toString(16)}"`,
        read: (range) => (range === undefined ? blob : blob.slice(range.start, range.end + 1))
    }
}

/**
 * The files that the pages load, by the path of their URL. The list is read
 * from the output of the build one time: the server gives a file of that list
 * and nothing else, so a request can never name a file itself.
 */
async function readAssets(dist: string): Promise<Map<string, string>> {
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
    return files
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
    const map = resolverMapFrom(await Bun.file(join(dist, RESOLVER_MAP_FILE)).json())
    const assets = await readAssets(dist)
    // Read one time at the start: a failure never depends on a file of the
    // release, which can be the missing file (NAV-20).
    const errorPage = Bun.file(join(dist, SERVER_ERROR_FILE))
    const serverErrorPage = (await errorPage.exists()) ? await errorPage.text() : undefined

    const handle = siteHandler({
        map,
        // The name comes from the resolver map, never from the request.
        file: (name) => storedFile(join(dist, name)),
        async asset(path) {
            const file = assets.get(path)
            // A file of the list that is gone since the start is a failure
            // of the release (URL-33).
            return file === undefined ? undefined : ((await storedFile(file)) ?? 'missing')
        },
        ...(storage === undefined
            ? {}
            : { attachment: (key: string) => storedFile(join(storage, key)) }),
        ...(serverErrorPage === undefined ? {} : { serverErrorPage }),
        // The detail goes to the log of the machine, never to the answer.
        report: (error) => {
            console.error(error)
        }
    })

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: options.port,
        // A failure outside a request gives the server error page with no
        // detail, never the error page of Bun with the paths of the machine
        // (NAV-20).
        error(error) {
            console.error(error)
            return new Response(serverErrorPage ?? errorText(500, this.url.origin), {
                status: 500,
                headers: {
                    'content-type':
                        serverErrorPage === undefined
                            ? 'text/plain; charset=utf-8'
                            : 'text/html; charset=utf-8',
                    'cache-control': 'no-store',
                    'vary': 'Accept'
                }
            })
        },
        fetch: handle
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
