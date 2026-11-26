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

/**
 * A failure of a read of the release that can be short: a fetch that fails,
 * or a status 5xx of the host. A missing file or a file that is not right
 * stays so for the life of the release.
 */
class ShortFailure extends Error {}

/** The status of the host for a file of the release, as a failure. */
function statusFailure(status: number, file: string): Error {
    const message = `the host answers ${String(status)} for ${file}`
    return status >= 500 ? new ShortFailure(message) : new Error(message)
}

/** Lets the host free a body that the Worker does not read. */
async function discard(response: Response): Promise<void> {
    await response.body?.cancel()
}

async function openRelease(files: StaticFiles): Promise<OpenedRelease> {
    const [mapRead, pageRead] = await Promise.allSettled([
        files.fetch(new Request(`${STATIC_ORIGIN}${pathOfFile(RESOLVER_MAP_FILE)}`)),
        files.fetch(new Request(`${STATIC_ORIGIN}${pathOfFile(SERVER_ERROR_FILE)}`))
    ])
    if (mapRead.status === 'rejected' || pageRead.status === 'rejected') {
        for (const read of [mapRead, pageRead]) {
            if (read.status === 'fulfilled') {
                await discard(read.value)
            }
        }
        const reason: unknown =
            mapRead.status === 'rejected'
                ? mapRead.reason
                : pageRead.status === 'rejected'
                  ? pageRead.reason
                  : undefined
        throw new ShortFailure('the host fails to give a file of the release', { cause: reason })
    }
    const map = mapRead.value
    const page = pageRead.value
    // A release can have no server error page. A page that the host fails to
    // give is another case: the Worker must not keep "no page" for its life.
    if (page.status !== 200 && page.status !== 404) {
        await discard(map)
        await discard(page)
        throw statusFailure(page.status, SERVER_ERROR_FILE)
    }
    const serverErrorPage = page.status === 200 ? await page.text() : undefined
    if (map.status !== 200) {
        await discard(map)
        if (map.status === 404) {
            throw new Error(`the release has no ${RESOLVER_MAP_FILE}`)
        }
        throw statusFailure(map.status, RESOLVER_MAP_FILE)
    }
    return { map: resolverMapFrom(await map.json()), serverErrorPage }
}

/** How long the Worker waits before its second read of the release, in milliseconds. */
const PAUSE_BEFORE_SECOND_READ = 50

/**
 * Reads the release, and reads it again one time, after a short pause, when
 * that read fails for a reason that can be short (issue 128): a short failure
 * of the host at the start of an isolate must not reach a reader. It reports
 * the first failure, wrapped so that the log tells it apart, and throws the
 * second one. Any other failure it throws at once.
 */
async function openReleaseWithRetry(
    files: StaticFiles,
    report: (error: unknown) => void,
    pause: (milliseconds: number) => Promise<void>
): Promise<OpenedRelease> {
    try {
        return await openRelease(files)
    } catch (error) {
        if (!(error instanceof ShortFailure)) {
            throw error
        }
        report(new Error('first read of the release failed, reading it again', { cause: error }))
    }
    await pause(PAUSE_BEFORE_SECOND_READ)
    return await openRelease(files)
}

/**
 * How long the Worker waits before it reads again a release that it could not
 * read, in milliseconds.
 */
const RETRY_AFTER = 10_000

/**
 * The most time that the whole read of the release can take, in milliseconds:
 * its two reads and the pause between them (issue 129). A read that hangs then
 * fails as any other, and does not keep every request of the isolate waiting.
 */
const READ_TIME_LIMIT = 5_000

/** Starts a timer that calls `expire` after a time in milliseconds. It gives the function that stops it. */
type StartTimer = (milliseconds: number, expire: () => void) => () => void

/**
 * The value of `read`, or a failure when it does not settle within the time.
 * The timer stops when `read` settles.
 */
async function withinTime<T>(
    read: Promise<T>,
    milliseconds: number,
    startTimer: StartTimer
): Promise<T> {
    let stop = (): void => undefined
    const expired = new Promise<never>((_resolve, reject) => {
        stop = startTimer(Math.max(0, milliseconds), () => {
            reject(
                new Error(`the read of the release takes more than ${String(READ_TIME_LIMIT)} ms`)
            )
        })
    })
    try {
        return await Promise.race([read, expired])
    } finally {
        stop()
    }
}

/** A read of the release that the requests of an isolate share, and when it must end. */
interface SharedRead {
    readonly read: Promise<OpenedRelease>
    /** The time at which the read fails if it has not settled, in milliseconds. */
    readonly deadline: number
}

/** What a Worker takes from its host. */
export interface WorkerOptions {
    /** Takes the detail of a failure, which never goes into an answer. By default it goes to the log of the host. */
    readonly report?: (error: unknown) => void
    /** The time in milliseconds. By default the clock of the host. */
    readonly now?: () => number
    /** Waits for a time in milliseconds. By default a timer of the host. */
    readonly pause?: (milliseconds: number) => Promise<void>
    /** Starts the timer of the time limit of a read of the release. By default a timer of the host. */
    readonly startTimer?: StartTimer
}

/**
 * A Worker: one per isolate of the host. It reads the resolver map and the
 * server error page of its release at its first request, and keeps them. A
 * new release is a new Worker version, so a new isolate. A read of the release
 * that fails for a reason that can be short (a failed fetch, a status 5xx) is
 * done again once, after a short pause. The whole read has a time limit of five
 * seconds. A release that it cannot read answers 500, and it reads it again
 * after ten seconds, not at each request: the resolver map is large.
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
    const pause =
        options.pause ??
        ((milliseconds: number): Promise<void> =>
            new Promise((resolve) => setTimeout(resolve, milliseconds)))
    const startTimer =
        options.startTimer ??
        ((milliseconds: number, expire: () => void): (() => void) => {
            const timer = setTimeout(expire, milliseconds)
            return () => {
                clearTimeout(timer)
            }
        })
    let opened: SharedRead | undefined
    let failedAt: number | undefined
    async function answer(request: Request, env: Environment): Promise<Response> {
        if (failedAt !== undefined && now() - failedAt < RETRY_AFTER) {
            return failureResponse(request)
        }
        let release: OpenedRelease
        opened ??= {
            read: openReleaseWithRetry(env.ASSETS, report, pause),
            deadline: now() + READ_TIME_LIMIT
        }
        const shared = opened
        try {
            // Each request has a timer of its own, to the end of the shared
            // read: the timer of a request that the host cancels may never fire.
            release = await withinTime(shared.read, shared.deadline - now(), startTimer)
            failedAt = undefined
        } catch (error) {
            // Requests that waited for the same read report it one time.
            if (opened === shared) {
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
