import {
    errorText,
    RESOLVER_MAP_FILE,
    resolverMapFrom,
    SERVER_ERROR_FILE,
    siteHandler,
    type Release,
    type StoredFile
} from '@dsebastien-website/resolver'

// The Worker of the host (HOST-01 and HOST-03 of the spec, issue 21): it
// serves a release through the resolver at the edge. It is an adapter of the
// handler of the site (`siteHandler` of the resolver package, which holds the
// URL contract): it gives the files of the release from the static files of
// the Worker version, and the attachments from the object storage. The plain
// local server (`../server/serve.ts`) is the other adapter.
//
// The types below name only what the Worker uses of the host, so the code
// needs no package of the host and runs in the tests as it is.

/** The static files of a Worker version: the binding of its assets. */
export interface StaticFiles {
    fetch(request: Request): Promise<Response>
}

/** A file of the object storage, or a part of it. */
export interface StoredObject {
    /** The size of the whole file, in bytes. */
    readonly size: number
    /** The entity tag of the file, with its quotes. */
    readonly httpEtag: string
    readonly body: ReadableStream<Uint8Array>
}

/** The object storage of the host: the binding of the bucket of the attachments. */
export interface ObjectStorage {
    get(
        key: string,
        options?: { range: { offset: number; length: number } }
    ): Promise<StoredObject | null>
}

/** The bindings of the Worker. */
export interface Environment {
    /** The files of the output of the build. */
    readonly ASSETS: StaticFiles
    /** The attachment storage. Without it, an attachment answers 404. */
    readonly ATTACHMENTS?: ObjectStorage
}

/**
 * The folders of the files that the pages load: the style sheets and the
 * scripts, which Astro names with a hash, and the indexes of the search
 * (decision R63). Only a path of these folders is given as the request names
 * it: every other file comes from the resolver map.
 */
const ASSET_PREFIXES = ['/_astro/', '/-/search/']

/** The address of a file of the static files. Only its path counts. */
const STATIC_ORIGIN = 'https://static.invalid'

/** The path of a file of the output of the build, by its name, as the static files take it. */
function pathOfFile(name: string): string {
    return `/${name.split('/').map(encodeURIComponent).join('/')}`
}

/** A file of the static files, by the path of its URL. `undefined` when they have no such file. */
async function staticFile(files: StaticFiles, path: string): Promise<StoredFile | undefined> {
    const response = await files.fetch(new Request(`${STATIC_ORIGIN}${path}`))
    if (response.status !== 200) {
        await response.body?.cancel()
        return undefined
    }
    return {
        size: Number(response.headers.get('content-length') ?? 0),
        tag: response.headers.get('etag') ?? '""',
        read: () => response.body ?? ''
    }
}

/** A file of the object storage, by its key. `undefined` when the storage lacks it. */
async function storedObject(storage: ObjectStorage, key: string): Promise<StoredFile | undefined> {
    const object = await storage.get(key)
    if (object === null) {
        return undefined
    }
    return {
        size: object.size,
        tag: object.httpEtag,
        async read(range) {
            if (range === undefined) {
                return object.body
            }
            // The whole file was asked for its size: a part is a second read.
            await object.body.cancel()
            const part = await storage.get(key, {
                range: { offset: range.start, length: range.end - range.start + 1 }
            })
            if (part === null) {
                throw new Error('an attachment left the storage during a request')
            }
            return part.body
        }
    }
}

/** What the Worker reads of a release one time: its resolver map and its server error page. */
interface Start {
    readonly map: Release['map']
    readonly serverErrorPage: string | undefined
}

async function start(files: StaticFiles): Promise<Start> {
    const [map, page] = await Promise.all([
        files.fetch(new Request(`${STATIC_ORIGIN}${pathOfFile(RESOLVER_MAP_FILE)}`)),
        files.fetch(new Request(`${STATIC_ORIGIN}${pathOfFile(SERVER_ERROR_FILE)}`))
    ])
    const serverErrorPage = page.status === 200 ? await page.text() : undefined
    if (map.status !== 200) {
        throw new Error(`the release has no ${RESOLVER_MAP_FILE}`)
    }
    return { map: resolverMapFrom(await map.json()), serverErrorPage }
}

/**
 * A Worker: one per isolate of the host. It reads the resolver map and the
 * server error page of its release at its first request, and keeps them. A
 * new release is a new Worker version, so a new isolate.
 *
 * @param report takes the detail of a failure, which never goes into an answer.
 * By default it goes to the log of the host
 */
export function createWorker(
    report: (error: unknown) => void = (error) => {
        console.error(error)
    }
): { fetch(request: Request, env: Environment): Promise<Response> } {
    let started: Promise<Start> | undefined
    return {
        async fetch(request, env) {
            let release: Start
            try {
                started ??= start(env.ASSETS)
                release = await started
            } catch (error) {
                // The next request reads the release again.
                started = undefined
                report(error)
                return new Response(errorText(500, new URL(request.url).origin), {
                    status: 500,
                    headers: {
                        'content-type': 'text/plain; charset=utf-8',
                        'cache-control': 'no-store',
                        'vary': 'Accept'
                    }
                })
            }
            const storage = env.ATTACHMENTS
            const handle = siteHandler({
                map: release.map,
                // The name comes from the resolver map, never from the request.
                file: (name) => staticFile(env.ASSETS, pathOfFile(name)),
                asset: (path) =>
                    ASSET_PREFIXES.some((prefix) => path.startsWith(prefix))
                        ? staticFile(env.ASSETS, path)
                        : Promise.resolve(undefined),
                ...(storage === undefined
                    ? {}
                    : { attachment: (key: string) => storedObject(storage, key) }),
                ...(release.serverErrorPage === undefined
                    ? {}
                    : { serverErrorPage: release.serverErrorPage }),
                report
            })
            return await handle(request)
        }
    }
}

export default createWorker()
