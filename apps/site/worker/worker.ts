import {
    ASSET_FOLDERS,
    failureResponse,
    MAP_HEAD_FILE,
    mapHeadFrom,
    mapPartFile,
    mapPartFrom,
    partedResolver,
    partOfKey,
    SERVER_ERROR_FILE,
    siteHandler,
    type MapHead,
    type MapLookup,
    type MapPart,
    type StoredFile
} from '@dsebastien-website/resolver'
import { markedNewInstance, NEW_INSTANCE_TIMING } from './instance.ts'

export { NEW_INSTANCE_TIMING }

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
    /**
     * The count of the parts of the resolver map of the release (issue 121).
     * The deployment sets it, so the first request of an instance reads the
     * part of its path while it reads the head. A value that is not the count
     * of the head is not used.
     */
    readonly MAP_PARTS?: string
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
        await discard(response)
        return response.status === 404 ? undefined : 'missing'
    }
    const tag = response.headers.get('etag')
    return {
        size: Number(response.headers.get('content-length') ?? 0),
        ...(tag === null ? {} : { tag }),
        read: () => response.body ?? '',
        discard: () => discard(response)
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

/**
 * What the Worker reads of a release one time: the head of its resolver map
 * in parts, with the lookup that reads the parts that a request needs (issue
 * 121), and its server error page.
 */
interface OpenedRelease {
    readonly map: MapLookup
    readonly serverErrorPage: string | undefined
}

/**
 * A failure of a read of the release that can be short: a fetch that fails,
 * a status 5xx of the host, or a body that breaks while it is read. A missing
 * file or a file that is not right stays so for the life of the release.
 */
class ShortFailure extends Error {}

/** The status of the host for a file of the release, as a failure. */
function statusFailure(status: number, file: string): Error {
    const message = `the host answers ${String(status)} for ${file}`
    return status >= 500 ? new ShortFailure(message) : new Error(message)
}

/**
 * Lets the host free a body that the Worker does not read. A cancel that fails
 * is let go: it must not replace the failure that the Worker reports.
 */
async function discard(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined)
}

/**
 * The text of a body of the release. A body that breaks while the Worker
 * reads it is a short failure (issue 130); a whole body that is not right is
 * checked after, and stays so.
 */
async function bodyText(response: Response, file: string): Promise<string> {
    try {
        return await response.text()
    } catch (error) {
        throw new ShortFailure(`the body of ${file} breaks while it is read`, { cause: error })
    }
}

/**
 * A part of the resolver map, from the static files. A read that fails for a
 * reason that can be short is done again one time, after a short pause; a
 * part that fails then fails its request, and the next request reads it
 * again (`partedResolver()`).
 */
async function readPart(
    files: StaticFiles,
    head: MapHead,
    index: number,
    report: (error: unknown) => void,
    pause: (milliseconds: number) => Promise<void>,
    early?: Promise<unknown>
): Promise<MapPart> {
    const file = mapPartFile(index)
    const read = async (value: Promise<unknown> = partValue(files, index)): Promise<MapPart> =>
        mapPartFrom(await value, head, index)
    try {
        return await read(early)
    } catch (error) {
        if (!(error instanceof ShortFailure)) {
            throw error
        }
        report(new Error(`first read of ${file} failed, reading it again`, { cause: error }))
    }
    await pause(PAUSE_BEFORE_SECOND_READ)
    return await read()
}

/** The value of the JSON text of a part of the resolver map, from the static files. */
async function partValue(files: StaticFiles, index: number): Promise<unknown> {
    const file = mapPartFile(index)
    let response: Response
    try {
        response = await files.fetch(new Request(`${STATIC_ORIGIN}${pathOfFile(file)}`))
    } catch (error) {
        throw new ShortFailure(`the host fails to give ${file}`, { cause: error })
    }
    if (response.status !== 200) {
        await discard(response)
        throw statusFailure(response.status, file)
    }
    return JSON.parse(await bodyText(response, file)) as unknown
}

/** The read of the part of the first path of an instance, started with the read of the head. */
interface EarlyPart {
    /** The count of the parts that the deployment gave. */
    readonly count: number
    readonly index: number
    readonly value: Promise<unknown>
}

/**
 * Starts the read of the part of a path, when the variable `MAP_PARTS` gives
 * a count of parts (a power of two). `undefined` without one.
 */
function earlyPart(
    files: StaticFiles,
    count: string | undefined,
    path: string
): EarlyPart | undefined {
    const parts = Number(count)
    if (
        count === undefined ||
        !Number.isInteger(parts) ||
        parts < 1 ||
        Math.log2(parts) % 1 !== 0
    ) {
        return undefined
    }
    const index = partOfKey(path, parts)
    const value = partValue(files, index)
    // A read that no request takes (a count that is not the one of the head)
    // must not fail as a rejection that nobody handles.
    value.catch(() => undefined)
    return { count: parts, index, value }
}

async function openRelease(
    files: StaticFiles,
    report: (error: unknown) => void,
    pause: (milliseconds: number) => Promise<void>,
    early?: EarlyPart
): Promise<OpenedRelease> {
    const [mapRead, pageRead] = await Promise.allSettled([
        files.fetch(new Request(`${STATIC_ORIGIN}${pathOfFile(MAP_HEAD_FILE)}`)),
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
    let serverErrorPage: string | undefined
    if (page.status === 200) {
        try {
            serverErrorPage = await bodyText(page, SERVER_ERROR_FILE)
        } catch (error) {
            await discard(map)
            throw error
        }
    } else {
        await discard(page)
    }
    if (map.status !== 200) {
        await discard(map)
        if (map.status === 404) {
            throw new Error(`the release has no ${MAP_HEAD_FILE}`)
        }
        throw statusFailure(map.status, MAP_HEAD_FILE)
    }
    const head = mapHeadFrom(JSON.parse(await bodyText(map, MAP_HEAD_FILE)))
    return {
        map: partedResolver(head, (index) => {
            // The early read serves one read of its part, with the count of the head only.
            const value =
                early?.count === head.parts && early.index === index ? early.value : undefined
            if (value !== undefined) {
                early = undefined
            }
            return readPart(files, head, index, report, pause, value)
        }),
        serverErrorPage
    }
}

/** How long the Worker waits before its second read of the release, in milliseconds. */
const PAUSE_BEFORE_SECOND_READ = 50

/** The failure of a read of the release that went past its time limit, and goes no further. */
const ABANDONED = 'the read of the release went past its time limit'

/**
 * Reads the release, and reads it again one time, after a short pause, when
 * that read fails for a reason that can be short (issue 128): a short failure
 * of the host at the start of an isolate must not reach a reader. It reports
 * the first failure, wrapped so that the log tells it apart, and throws the
 * second one. Any other failure it throws at once.
 *
 * @param abandoned true once the read went past its time limit (issue 129):
 * the read then reports nothing more, and does not pause or read again.
 */
async function openReleaseWithRetry(
    files: StaticFiles,
    report: (error: unknown) => void,
    pause: (milliseconds: number) => Promise<void>,
    abandoned: () => boolean,
    early?: EarlyPart
): Promise<OpenedRelease> {
    try {
        return await openRelease(files, report, pause, early)
    } catch (error) {
        if (!(error instanceof ShortFailure) || abandoned()) {
            throw error
        }
        report(new Error('first read of the release failed, reading it again', { cause: error }))
    }
    await pause(PAUSE_BEFORE_SECOND_READ)
    if (abandoned()) {
        throw new Error(ABANDONED)
    }
    return await openRelease(files, report, pause, early)
}

/**
 * How long the Worker waits before it reads again a release that it could not
 * read, in milliseconds.
 */
const RETRY_AFTER = 10_000

/**
 * The most time that the whole read of the release can take, in milliseconds,
 * from the start of the shared read: its two reads and the pause between them
 * (issue 129). A read that hangs then fails, and does not keep every request
 * of the isolate waiting.
 */
const READ_TIME_LIMIT = 5_000

/** Starts a timer that calls `expire` after a time in milliseconds. It gives the function that stops it. */
type StartTimer = (milliseconds: number, expire: () => void) => () => void

/** A read of the release that went past its time limit. */
class TimeLimitFailure extends Error {}

/**
 * The value of `read`, or a `TimeLimitFailure` when it does not settle within
 * `milliseconds`, the time left of `limit`. The timer stops when `read` settles.
 */
async function withinTime<T>(
    read: Promise<T>,
    milliseconds: number,
    limit: number,
    startTimer: StartTimer
): Promise<T> {
    let stop = (): void => undefined
    const expired = new Promise<never>((_resolve, reject) => {
        stop = startTimer(Math.max(0, milliseconds), () => {
            reject(
                new TimeLimitFailure(`the read of the release takes more than ${String(limit)} ms`)
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
    /** Marks the read as past its time limit: it then goes no further. */
    readonly abandon: () => void
    /** The release, once the read gives it: a request then races no timer (issue 131). */
    release: OpenedRelease | undefined
}

/** What the Worker uses of the context of a request of the host. */
export interface RequestContext {
    /** Keeps the isolate working for a promise after the answer, or after the request is cancelled. */
    waitUntil(promise: Promise<unknown>): void
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
 * A Worker: one per isolate of the host. It reads the head of the resolver
 * map in parts and the server error page of its release at its first request,
 * and keeps them; it reads a part of the map when a request needs it (issue
 * 121). Its first answer says so (`NEW_INSTANCE_TIMING`). A
 * new release is a new Worker version, so a new isolate. A read of the release
 * that fails for a reason that can be short (a failed fetch, a status 5xx, a
 * body that breaks while it is read) is done again once, after a short pause. The whole read has a time limit of five
 * seconds: past it, the request answers 500 and the next request reads again
 * at once; after two time-outs in a row, it waits ten seconds. A read that
 * settles after its time limit is kept. A release that it cannot read answers
 * 500, and it reads it again after ten seconds, not at each request.
 */
export function createWorker(options: WorkerOptions = {}): {
    fetch(request: Request, env: Environment, context?: RequestContext): Promise<Response>
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
    /** The time-outs of the shared read in a row. */
    let timeOuts = 0
    /** Starts the shared read, kept alive by the context of the request that starts it. */
    function startRead(
        env: Environment,
        context: RequestContext | undefined,
        path: string
    ): SharedRead {
        const deadline = now() + READ_TIME_LIMIT
        let abandoned = false
        // The part of the first path is read with the head (issue 121).
        const early = earlyPart(env.ASSETS, env.MAP_PARTS, path)
        const read = openReleaseWithRetry(env.ASSETS, report, pause, () => abandoned, early)
        const shared: SharedRead = {
            read,
            deadline,
            abandon: () => {
                abandoned = true
            },
            release: undefined
        }
        const kept = read.then(
            (release) => {
                shared.release = release
                // A read that settles after its time limit is kept, also when
                // no request waits for it and while a newer read is still open.
                if (opened === undefined || opened === shared || opened.release === undefined) {
                    opened = shared
                    failedAt = undefined
                    timeOuts = 0
                }
            },
            () => undefined
        )
        // A cancelled request may stop its fetches and its timers; this keeps
        // them going for the requests that wait, within the limits of the host.
        context?.waitUntil(kept)
        return shared
    }
    async function answer(
        request: Request,
        env: Environment,
        context: RequestContext | undefined
    ): Promise<Response> {
        if (failedAt !== undefined && now() - failedAt < RETRY_AFTER) {
            return failureResponse(request)
        }
        opened ??= startRead(env, context, new URL(request.url).pathname)
        const shared = opened
        let release = shared.release
        if (release === undefined) {
            try {
                // Each request has a timer of its own, to the end of the shared
                // read: the timer of a request that the host cancels may never fire.
                release = await withinTime(
                    shared.read,
                    shared.deadline - now(),
                    READ_TIME_LIMIT,
                    startTimer
                )
            } catch (error) {
                // Requests that waited for the same read report it one time. A
                // request of an older read never changes the state of a newer one.
                if (opened === shared) {
                    opened = undefined
                    if (error instanceof TimeLimitFailure) {
                        shared.abandon()
                        timeOuts += 1
                        // The next request reads again at once after the first
                        // time-out, and after ten seconds from the second one in
                        // a row on: a host that stays hung (issue 131).
                        if (timeOuts >= 2) {
                            failedAt = now()
                        }
                    } else {
                        timeOuts = 0
                        failedAt = now()
                    }
                    report(error)
                }
                return failureResponse(request)
            }
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
    /** True once the instance gave its first answer. */
    let answered = false
    return {
        async fetch(request, env, context) {
            let response = await answer(request, env, context)
            if (!answered) {
                answered = true
                response = markedNewInstance(response)
            }
            return env.NOINDEX === 'true' ? markedNoindex(response) : response
        }
    }
}

export default createWorker()
