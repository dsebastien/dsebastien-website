import {
    ASSET_FOLDERS,
    failureResponse,
    RESOLVER_MAP_FILE,
    resolverMapFrom,
    SERVER_ERROR_FILE,
    siteHandler,
    type ResolverMap,
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

/** What the object storage knows about a file. */
export interface StoredObjectFacts {
    /** The size of the whole file, in bytes. */
    readonly size: number
    /** The entity tag of the file, with its quotes. */
    readonly httpEtag: string
}

/** A file of the object storage, or a part of it. */
export interface StoredObject extends StoredObjectFacts {
    readonly body: ReadableStream<Uint8Array>
}

/** The object storage of the host: the binding of the bucket of the attachments. */
export interface ObjectStorage {
    /** The facts of a file, without its bytes. `null` when the storage lacks it. */
    head(key: string): Promise<StoredObjectFacts | null>
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
    /**
     * `true` on a preview host (IDX-26): every answer says `X-Robots-Tag:
     * noindex`. The deployment sets it; any other value marks nothing.
     */
    readonly NOINDEX?: string
}

/** An answer with the header that keeps it out of the search engines. */
function markedNoindex(response: Response): Response {
    const marked = new Response(response.body, response)
    marked.headers.set('x-robots-tag', 'noindex')
    return marked
}

/** The address of a file of the static files. Only its path counts. */
const STATIC_ORIGIN = 'https://static.invalid'

/** The path of a file of the output of the build, by its name, as the static files take it. */
function pathOfFile(name: string): string {
    return `/${name.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * True when a path of a request can name a file that the pages load: a path
 * of one of their folders, written plainly. A path with a percent-encoding,
 * a backslash or an empty part is never given to the static files: the host
 * could read it as a way out of the folder. The build writes no such name.
 */
function isAssetPath(path: string): boolean {
    return (
        ASSET_FOLDERS.some((folder) => path.startsWith(`/${folder}/`)) &&
        !/[%\\]|\/\/|\/\.{1,2}(?:\/|$)/u.test(path)
    )
}

/**
 * A file of the static files, by the path of its URL. `undefined` when they
 * have no such file, `'missing'` when the host fails for it.
 */
async function staticFile(
    files: StaticFiles,
    path: string
): Promise<StoredFile | 'missing' | undefined> {
    const response = await files.fetch(new Request(`${STATIC_ORIGIN}${path}`))
    if (response.status !== 200) {
        await response.body?.cancel()
        return response.status === 404 ? undefined : 'missing'
    }
    const tag = response.headers.get('etag')
    return {
        size: Number(response.headers.get('content-length') ?? 0),
        ...(tag === null ? {} : { tag }),
        read: () => response.body ?? '',
        discard: async () => {
            await response.body?.cancel()
        }
    }
}

/**
 * A file of the object storage, by its key. `undefined` when the storage
 * lacks it.
 *
 * @param facts true for a request that does not need the whole file (a range,
 * the headers only): the storage is asked for the facts of the file first,
 * and for the bytes of the part only. Else the file is opened with one read.
 */
async function storedObject(
    storage: ObjectStorage,
    key: string,
    facts: boolean
): Promise<StoredFile | undefined> {
    if (!facts) {
        const object = await storage.get(key)
        if (object === null) {
            return undefined
        }
        return {
            size: object.size,
            tag: object.httpEtag,
            read: () => object.body,
            discard: async () => {
                await object.body.cancel()
            }
        }
    }
    const object = await storage.head(key)
    if (object === null) {
        return undefined
    }
    return {
        size: object.size,
        tag: object.httpEtag,
        async read(range) {
            const part = await storage.get(
                key,
                range === undefined
                    ? undefined
                    : { range: { offset: range.start, length: range.end - range.start + 1 } }
            )
            if (part === null) {
                throw new Error('an attachment left the storage during a request')
            }
            return part.body
        }
    }
}

/** What the Worker reads of a release one time: its resolver map and its server error page. */
interface OpenedRelease {
    readonly map: ResolverMap
    readonly serverErrorPage: string | undefined
}

async function openRelease(files: StaticFiles): Promise<OpenedRelease> {
    const [map, page] = await Promise.all([
        files.fetch(new Request(`${STATIC_ORIGIN}${pathOfFile(RESOLVER_MAP_FILE)}`)),
        files.fetch(new Request(`${STATIC_ORIGIN}${pathOfFile(SERVER_ERROR_FILE)}`))
    ])
    // A release can have no server error page. A page that the host fails to
    // give is another case: the Worker must not keep "no page" for its life.
    if (page.status !== 200 && page.status !== 404) {
        throw new Error(`the host answers ${String(page.status)} for ${SERVER_ERROR_FILE}`)
    }
    const serverErrorPage = page.status === 200 ? await page.text() : undefined
    if (map.status !== 200) {
        throw new Error(`the release has no ${RESOLVER_MAP_FILE}`)
    }
    return { map: resolverMapFrom(await map.json()), serverErrorPage }
}

/**
 * Reads the release, and reads it again at once when that read fails (issue
 * 128): a short failure of the host at the start of an isolate must not
 * reach a reader. It reports the first failure and throws the second one.
 */
async function openReleaseWithRetry(
    files: StaticFiles,
    report: (error: unknown) => void
): Promise<OpenedRelease> {
    try {
        return await openRelease(files)
    } catch (error) {
        report(error)
        return await openRelease(files)
    }
}

/** How long the Worker waits before it reads again a release that it could not read two times in a row. */
const RETRY_AFTER = 10_000

/** What a Worker takes from its host. */
export interface WorkerOptions {
    /** Takes the detail of a failure, which never goes into an answer. By default it goes to the log of the host. */
    readonly report?: (error: unknown) => void
    /** The time in milliseconds. By default the clock of the host. */
    readonly now?: () => number
}

/**
 * A Worker: one per isolate of the host. It reads the resolver map and the
 * server error page of its release at its first request, and keeps them. A
 * new release is a new Worker version, so a new isolate. A release that it
 * cannot read is read again at once, one time. A release that it cannot read
 * two times in a row answers 500, and it reads it again after ten seconds, not
 * at each request: the resolver map is large.
 */
export function createWorker(options: WorkerOptions = {}): {
    fetch(request: Request, env: Environment): Promise<Response>
} {
    const report =
        options.report ??
        ((error: unknown): void => {
            console.error(error)
        })
    const now = options.now ?? ((): number => Date.now())
    let opened: Promise<OpenedRelease> | undefined
    let failedAt: number | undefined
    async function answer(request: Request, env: Environment): Promise<Response> {
        if (failedAt !== undefined && now() - failedAt < RETRY_AFTER) {
            return failureResponse(request)
        }
        let release: OpenedRelease
        try {
            opened ??= openReleaseWithRetry(env.ASSETS, report)
            release = await opened
            failedAt = undefined
        } catch (error) {
            // Requests that waited for the same read report it one time.
            if (opened !== undefined) {
                opened = undefined
                failedAt = now()
                report(error)
            }
            return failureResponse(request)
        }
        const storage = env.ATTACHMENTS
        // A request that does not need the whole file of an attachment.
        const facts = request.headers.has('range') || request.method === 'HEAD'
        const handle = siteHandler({
            map: release.map,
            // The name comes from the resolver map, never from the request.
            file: async (name) => {
                const file = await staticFile(env.ASSETS, pathOfFile(name))
                return file === 'missing' ? undefined : file
            },
            asset: (path) =>
                isAssetPath(path) ? staticFile(env.ASSETS, path) : Promise.resolve(undefined),
            ...(storage === undefined
                ? {}
                : { attachment: (key: string) => storedObject(storage, key, facts) }),
            ...(release.serverErrorPage === undefined
                ? {}
                : { serverErrorPage: release.serverErrorPage }),
            report
        })
        return await handle(request)
    }
    return {
        async fetch(request, env) {
            const response = await answer(request, env)
            return env.NOINDEX === 'true' ? markedNoindex(response) : response
        }
    }
}

export default createWorker()
