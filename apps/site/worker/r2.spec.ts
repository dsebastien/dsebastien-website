import { describe, expect, test } from 'bun:test'
import { variantKey } from '@dsebastien-website/resolver'
import { rejectionOf } from '@dsebastien-website/testing'
import { r2Storage, type Fetch } from './r2.ts'

// The object storage of the host through the REST API of Cloudflare
// (issue 32): the deployment lists, uploads and deletes the attachments of
// a release with the token of the deployment. These tests never reach the
// host: a fake `fetch` answers as the API does. The names are invented.

const ACCOUNT = 'ab'.repeat(16)
const BUCKET = 'notes-attachments'
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects`
const KEY = 'cd'.repeat(32)
// Built at run time: a fake secret is never stored as text.
const TOKEN = ['fake', 'token', String(Date.now())].join('-')

interface Asked {
    readonly method: string
    readonly url: string
    readonly authorization: string | null
    readonly type: string | null
    readonly body: Uint8Array | undefined
}

/** A fake API: each request gets the next answer of the list. */
function api(answers: Response[]): { asked: Asked[]; fetch: Fetch } {
    const asked: Asked[] = []
    return {
        asked,
        fetch: async (url, init) => {
            const headers = new Headers(init.headers)
            asked.push({
                method: init.method ?? 'GET',
                url,
                authorization: headers.get('authorization'),
                type: headers.get('content-type'),
                body:
                    init.body === undefined || init.body === null
                        ? undefined
                        : new Uint8Array(await new Response(init.body).arrayBuffer())
            })
            const answer = answers.shift()
            if (answer === undefined) {
                throw new Error('the fake API has no more answers')
            }
            return answer
        }
    }
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

function page(keys: string[], cursor = '', truncated = false): Response {
    return json({
        success: true,
        errors: [],
        messages: [],
        result: keys.map((key) => ({ key, size: 3, etag: 'e' })),
        result_info: { cursor, is_truncated: truncated, per_page: 1000 }
    })
}

/** The pauses of a storage, in milliseconds: the tests never sleep. */
function pauses(): { waited: number[]; wait: (ms: number) => Promise<void> } {
    const waited: number[] = []
    return {
        waited,
        wait: (ms) => {
            waited.push(ms)
            return Promise.resolve()
        }
    }
}

function storage(
    fetch: Fetch,
    wait: (ms: number) => Promise<void> = pauses().wait
): ReturnType<typeof r2Storage> {
    return r2Storage({ accountId: ACCOUNT, bucket: BUCKET, token: TOKEN, fetch, wait })
}

/** An answer 429 of the host, with or without `Retry-After`. */
function tooMany(retryAfter?: string): Response {
    return new Response(
        JSON.stringify({ success: false, errors: [{ code: 971, message: 'Please wait' }] }),
        {
            status: 429,
            headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter }
        }
    )
}

const STORED = (): Response => json({ success: true, errors: [], messages: [], result: {} })

describe('the object storage through the API', () => {
    test('lists every name of the bucket, page after page, with the token', async () => {
        const fake = api([page(['a', 'b'], 'next', true), page(['c'])])
        expect(await storage(fake.fetch).list()).toEqual(['a', 'b', 'c'])
        expect(fake.asked.map((request) => request.url)).toEqual([
            `${BASE}?per_page=1000`,
            `${BASE}?per_page=1000&cursor=next`
        ])
        expect(fake.asked.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(
            true
        )
    })

    test('stops at a page that gives its own cursor again', async () => {
        const fake = api([page(['a'], 'same', true), page(['b'], 'same', true)])
        expect(await rejectionOf(storage(fake.fetch).list())).toContain('cursor')
    })

    // A full page that does not say whether the list ends could hide names.
    test('fails on a full page that does not say whether the list ends', async () => {
        const full = Array.from({ length: 1000 }, (_, index) => `name-${String(index)}`)
        const fake = api([
            json({ success: true, errors: [], messages: [], result: full.map((key) => ({ key })) })
        ])
        expect(await rejectionOf(storage(fake.fetch).list())).toContain('whether the list ends')
    })

    test('takes a short page with no paging as the whole list', async () => {
        const fake = api([
            json({ success: true, errors: [], messages: [], result: [{ key: 'a' }] })
        ])
        expect(await storage(fake.fetch).list()).toEqual(['a'])
    })

    test('uploads the bytes of a key as the body of one request', async () => {
        const fake = api([json({ success: true, errors: [], messages: [], result: {} })])
        await storage(fake.fetch).put(KEY, new Uint8Array([1, 2, 3]))
        expect(fake.asked).toEqual([
            {
                method: 'PUT',
                url: `${BASE}/${KEY}`,
                authorization: `Bearer ${TOKEN}`,
                type: 'application/octet-stream',
                body: new Uint8Array([1, 2, 3])
            }
        ])
    })

    // Issue 87: a variant of an image goes beside its image.
    test('uploads a variant of an image under its name', async () => {
        const fake = api([json({ success: true, errors: [], messages: [], result: {} })])
        await storage(fake.fetch).put(variantKey(KEY, 800), new Uint8Array([1]))
        expect(fake.asked.map((call) => call.url)).toEqual([`${BASE}/${variantKey(KEY, 800)}`])
    })

    test('uploads nothing under a name that is not a key', async () => {
        const fake = api([])
        expect(await rejectionOf(storage(fake.fetch).put('../x', new Uint8Array()))).toContain(
            'not a key'
        )
        expect(fake.asked).toEqual([])
    })

    test('deletes a file by its name, with the parts of the name encoded', async () => {
        const fake = api([json({ success: true, errors: [], messages: [], result: {} })])
        expect(await storage(fake.fetch).remove('notes/a b?.png')).toBe(true)
        expect(fake.asked.map((request) => `${request.method} ${request.url}`)).toEqual([
            `DELETE ${BASE}/notes/a%20b%3F.png`
        ])
    })

    test('says that a file it deletes was not there', async () => {
        const fake = api([
            json({ success: false, errors: [{ code: 10007, message: 'gone' }] }, 404)
        ])
        expect(await storage(fake.fetch).remove(KEY)).toBe(false)
    })

    // The API also answers 200 with the error 10007 for a key that is not there.
    test('says that a file it deletes was not there when the API answers 200 with the error 10007', async () => {
        const fake = api([
            json({
                success: false,
                errors: [{ code: 10007, message: 'The specified key does not exist.' }]
            })
        ])
        expect(await storage(fake.fetch).remove(KEY)).toBe(false)
    })

    test('fails with the status and the messages of the API, never with the token', async () => {
        const fake = api([
            json(
                { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
                403
            )
        ])
        const message = await rejectionOf(storage(fake.fetch).list())
        expect(message).toContain('403')
        expect(message).toContain('Authentication error')
        expect(message).not.toContain(TOKEN)
    })

    test('fails on an answer that is not the answer of a list', async () => {
        const fake = api([json({ success: true, result: [{ name: 'a' }] })])
        expect(await rejectionOf(storage(fake.fetch).list())).toContain('list')
    })

    test('fails on an upload that the API refuses', async () => {
        const fake = api([new Response('upstream', { status: 500 })])
        expect(await rejectionOf(storage(fake.fetch).put(KEY, new Uint8Array([1])))).toContain(
            '500'
        )
    })

    // Issue 60, R102: a first deployment of thousands of attachments meets the
    // rate limit of the host. A request that gets 429 is sent again after a pause.
    describe('on an answer 429', () => {
        test('waits for the seconds of Retry-After, then sends the same upload again', async () => {
            const fake = api([tooMany('7'), STORED()])
            const clock = pauses()
            await storage(fake.fetch, clock.wait).put(KEY, new Uint8Array([4, 5]))
            expect(clock.waited).toEqual([7000])
            expect(fake.asked.map((request) => [request.method, request.body])).toEqual([
                ['PUT', new Uint8Array([4, 5])],
                ['PUT', new Uint8Array([4, 5])]
            ])
        })

        test('waits a pause that doubles, up to two minutes, when there is no Retry-After', async () => {
            const fake = api([
                ...Array.from({ length: 9 }, (_, index) =>
                    tooMany(index === 4 ? 'soon' : undefined)
                ),
                page(['a'])
            ])
            const clock = pauses()
            expect(await storage(fake.fetch, clock.wait).list()).toEqual(['a'])
            expect(clock.waited).toEqual([
                1000, 2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000
            ])
        })

        test('waits five minutes at most for a long Retry-After', async () => {
            const fake = api([tooMany('3600'), STORED()])
            const clock = pauses()
            await storage(fake.fetch, clock.wait).put(KEY, new Uint8Array([1]))
            expect(clock.waited).toEqual([300000])
        })

        test('also sends a delete again', async () => {
            const fake = api([tooMany('2'), json({ success: true, errors: [], result: {} })])
            const clock = pauses()
            expect(await storage(fake.fetch, clock.wait).remove('a/b c')).toBe(true)
            expect(clock.waited).toEqual([2000])
            expect(fake.asked).toHaveLength(2)
        })

        test('fails with a clear message after ten tries', async () => {
            const fake = api(Array.from({ length: 10 }, () => tooMany('1')))
            const clock = pauses()
            const message = await rejectionOf(
                storage(fake.fetch, clock.wait).put(KEY, new Uint8Array([1]))
            )
            expect(message).toBe(
                `the object storage refused to store ${KEY} (429): too many requests, still after 10 tries: Please wait`
            )
            expect(fake.asked).toHaveLength(10)
            expect(clock.waited).toHaveLength(9)
        })

        test('waits for nothing when the host answers at once', async () => {
            const fake = api([STORED()])
            const clock = pauses()
            await storage(fake.fetch, clock.wait).put(KEY, new Uint8Array([1]))
            expect(clock.waited).toEqual([])
        })
    })
})
