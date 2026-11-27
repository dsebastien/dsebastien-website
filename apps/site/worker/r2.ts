import type { AttachmentStorage } from '../../plugin/src/publishing/ports.ts'
import { imageKeyOf } from '@dsebastien-website/resolver'

// The object storage of the host as the deployment reaches it (issue 32):
// the REST API of Cloudflare for the objects of a bucket of an account, with
// the token of the deployment. It is the port `AttachmentStorage` of the
// publishing logic, so the logic of a deployment is tested with a fake, and
// this adapter with a fake `fetch`. The publishing tool never holds a key of
// the object storage: only the deployment does.
//
// The API (developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/):
// `GET .../objects` lists 1,000 objects at most per page, with a cursor while
// `result_info.is_truncated` is true; `PUT .../objects/<key>` stores the body
// of the request as the object; `DELETE .../objects/<key>` deletes it. An
// object of the storage is complete or does not exist: the storage shows an
// object only when its upload ended.
//
// The API has a rate limit: a first deployment of thousands of attachments
// meets it, and the host answers 429 (issue 60, R102). A request that gets 429
// is sent again after a pause: the seconds of `Retry-After` when the answer
// gives a number (five minutes at most), else a pause that doubles from 1 s
// up to 2 min. After {@link MOST_TRIES} tries it fails and says so. The pauses
// of 1 s to 2 min add up to more than the 5 min block of the API.

/** The `fetch` of the platform, as the adapter uses it. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** What the adapter needs to reach a bucket. */
export interface R2Access {
    /** The account of the host: 32 hexadecimal digits. */
    readonly accountId: string
    /** The name of the bucket. */
    readonly bucket: string
    /** The API token of the deployment. It never goes into a message. */
    readonly token: string
    /** By default the `fetch` of the platform. */
    readonly fetch?: Fetch
    /** A pause of a number of milliseconds, before a try again. By default a timer. */
    readonly wait?: (ms: number) => Promise<void>
}

const API = 'https://api.cloudflare.com/client/v4'

/** The most objects that one page of a list gives. */
const PAGE_SIZE = 1000

/** The most tries of one request that the host answers with 429. */
export const MOST_TRIES = 10

/** The first pause after a 429 without `Retry-After`, in milliseconds; it doubles at each try. */
const FIRST_PAUSE = 1000

/** The longest pause that doubles, in milliseconds. */
const LONGEST_PAUSE = 120_000

/** The longest pause that `Retry-After` can ask for, in milliseconds. */
const LONGEST_RETRY_AFTER = 300_000

/** The status of an answer that says: too many requests. */
const TOO_MANY_REQUESTS = 429

/** The pause before the next try, after a 429 at the try `tried` (1 for the first). */
function pauseAfter(response: Response, tried: number): number {
    const header = response.headers.get('retry-after')?.trim() ?? ''
    if (/^\d+$/u.test(header)) {
        return Math.min(Number(header) * 1000, LONGEST_RETRY_AFTER)
    }
    return Math.min(FIRST_PAUSE * 2 ** (tried - 1), LONGEST_PAUSE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the value is the `result` of a list: objects with their names. */
function isObjectList(value: unknown): value is { key: string }[] {
    return (
        Array.isArray(value) &&
        value.every((item) => isRecord(item) && typeof item['key'] === 'string')
    )
}

/** The messages of the errors of an answer of the API, when it has some. */
function errorsOf(body: unknown): string {
    if (!isRecord(body) || !Array.isArray(body['errors'])) {
        return ''
    }
    const messages = body['errors']
        .map((error: unknown) =>
            isRecord(error) && typeof error['message'] === 'string' ? error['message'] : undefined
        )
        .filter((message) => message !== undefined)
    return messages.length === 0 ? '' : `: ${messages.join('; ')}`
}

/** The JSON body of an answer, or `undefined` when it has none. */
/** The code of the API for a key that the bucket does not have. */
const NO_SUCH_KEY = 10007

/** True when the answer of the API says that the key is not in the bucket. */
function isMissingKey(body: unknown): boolean {
    return (
        isRecord(body) &&
        body['success'] !== true &&
        Array.isArray(body['errors']) &&
        body['errors'].length > 0 &&
        body['errors'].every((error) => isRecord(error) && error['code'] === NO_SUCH_KEY)
    )
}

async function bodyOf(response: Response): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        return undefined
    }
}

/** The object storage of a bucket, through the REST API. */
export function r2Storage(access: R2Access): AttachmentStorage {
    const platformFetch = access.fetch ?? ((url, init) => globalThis.fetch(url, init))
    const wait =
        access.wait ??
        ((ms: number) =>
            new Promise<void>((done) => {
                setTimeout(done, ms)
            }))
    const objects = `${API}/accounts/${access.accountId}/r2/buckets/${access.bucket}/objects`
    const authorization = `Bearer ${access.token}`

    /**
     * The answer of a request, sent again after a pause while the host answers
     * 429, {@link MOST_TRIES} tries at most. The last answer 429 is given back
     * with `tooMany` set, so that the caller says how many tries it took.
     */
    async function fetch(
        url: string,
        init: RequestInit
    ): Promise<{ response: Response; tooMany: boolean }> {
        for (let tried = 1; ; tried++) {
            const response = await platformFetch(url, init)
            if (response.status !== TOO_MANY_REQUESTS) {
                return { response, tooMany: false }
            }
            if (tried >= MOST_TRIES) {
                return { response, tooMany: true }
            }
            await response.body?.cancel()
            await wait(pauseAfter(response, tried))
        }
    }

    /** What a refusal adds after its status: the tries of a 429 that did not end. */
    function triesOf(tooMany: boolean): string {
        return tooMany ? `: too many requests, still after ${String(MOST_TRIES)} tries` : ''
    }

    /** The JSON body of a request that must succeed. */
    async function call(what: string, url: string, init: RequestInit = {}): Promise<unknown> {
        const headers = new Headers(init.headers)
        headers.set('authorization', authorization)
        const { response, tooMany } = await fetch(url, { ...init, headers })
        const body = await bodyOf(response)
        if (!response.ok || !isRecord(body) || body['success'] !== true) {
            throw new Error(
                `the object storage refused to ${what} (${String(response.status)})${triesOf(tooMany)}${errorsOf(body)}`
            )
        }
        return body
    }

    /** The URL of an object: each part of its name encoded, the slashes as they are. */
    function objectUrl(name: string): string {
        return `${objects}/${name.split('/').map(encodeURIComponent).join('/')}`
    }

    return {
        async list() {
            const names: string[] = []
            let cursor: string | undefined
            for (;;) {
                const query = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
                const body = await call(
                    'list the bucket',
                    `${objects}?per_page=${String(PAGE_SIZE)}${query}`
                )
                const result = isRecord(body) ? body['result'] : undefined
                const info = isRecord(body) ? body['result_info'] : undefined
                if (!isObjectList(result)) {
                    throw new Error('the object storage gave an answer that is not a list')
                }
                names.push(...result.map((item) => item.key))
                const next = isRecord(info) ? info['cursor'] : undefined
                const truncated = isRecord(info) ? info['is_truncated'] : undefined
                if (typeof truncated !== 'boolean' && result.length >= PAGE_SIZE) {
                    throw new Error(
                        'the object storage gave a full page and did not say whether the list ends'
                    )
                }
                if (truncated !== true) {
                    return names
                }
                if (typeof next !== 'string' || next === '' || next === cursor) {
                    throw new Error('the object storage gave no new cursor for the next page')
                }
                cursor = next
            }
        },
        async put(key, bytes) {
            // A key, or a variant of the image of a key (issue 87).
            if (imageKeyOf(key) === undefined) {
                throw new Error(`"${key}" is not a key of the attachment storage`)
            }
            await call(`store ${key}`, objectUrl(key), {
                method: 'PUT',
                headers: { 'content-type': 'application/octet-stream' },
                // A copy in its own buffer: the type that a body takes.
                body: new Uint8Array(bytes)
            })
        },
        async remove(name) {
            const { response, tooMany } = await fetch(objectUrl(name), {
                method: 'DELETE',
                headers: { authorization }
            })
            if (response.status === 404) {
                await response.body?.cancel()
                return false
            }
            const body = await bodyOf(response)
            // The API also answers 200 with the error 10007 for a key that is not there.
            if (isMissingKey(body)) {
                return false
            }
            if (!response.ok || !isRecord(body) || body['success'] !== true) {
                throw new Error(
                    `the object storage refused to delete ${name} (${String(response.status)})${triesOf(tooMany)}${errorsOf(body)}`
                )
            }
            return true
        }
    }
}
