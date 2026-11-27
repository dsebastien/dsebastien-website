import { describe, expect, test } from 'bun:test'
import { signUp } from './signup.ts'

// The signup of the newsletter bar (NEWS-04): the members API of the main site
// (Ghost 6), as `ghost-subscribe.js` calls it: an integrity token first, then
// the request of a signup with it. The network is a fake: no test sends a
// real signup.

interface Call {
    url: string
    method: string
    headers: Record<string, string>
    body?: unknown
}

/** A fake network that answers each call with the next answer, and records the calls. */
function network(...answers: (Response | Error)[]): {
    fetch: typeof fetch
    calls: Call[]
    signals: (AbortSignal | null | undefined)[]
} {
    const calls: Call[] = []
    const signals: (AbortSignal | null | undefined)[] = []
    const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        signals.push(init?.signal)
        const headers = Object.fromEntries(new Headers(init?.headers).entries())
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
        calls.push({
            url: input instanceof Request ? input.url : input.toString(),
            method: init?.method ?? 'GET',
            headers,
            ...(body === undefined ? {} : { body })
        })
        const answer = answers.shift()
        if (answer === undefined) return Promise.reject(new Error('no more answers'))
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    }
    return { fetch: fake as typeof fetch, calls, signals }
}

/** A fresh answer with an integrity token: a body is read one time. */
const token = (): Response => new Response('a-token', { status: 200 })

describe('the signup of the newsletter', () => {
    test('asks for an integrity token, then sends the signup with it', async () => {
        const fake = network(token(), new Response('{}', { status: 201 }))

        expect(await signUp('reader@example.com', fake.fetch)).toEqual({ kind: 'sent' })
        expect(fake.calls).toEqual([
            {
                url: 'https://www.dsebastien.net/members/api/integrity-token/',
                method: 'GET',
                headers: { 'app-pragma': 'no-cache', 'x-ghost-version': '6.0' }
            },
            {
                url: 'https://www.dsebastien.net/members/api/send-magic-link',
                method: 'POST',
                headers: { 'content-type': 'application/json; charset=utf-8' },
                body: {
                    email: 'reader@example.com',
                    emailType: 'subscribe',
                    integrityToken: 'a-token'
                }
            }
        ])
    })

    // A signup never waits more than 10 s in all: one time limit for both calls.
    test('gives both calls one time limit', async () => {
        const fake = network(token(), new Response('{}', { status: 201 }))
        await signUp('reader@example.com', fake.fetch)
        const [first, second] = fake.signals
        expect(first).toBeInstanceOf(AbortSignal)
        expect(second).toBe(first)
    })

    test('sends nothing for an address with no @', async () => {
        const fake = network()

        expect(await signUp('reader', fake.fetch)).toEqual({ kind: 'invalid' })
        expect(fake.calls).toEqual([])
    })

    test('says when the reader is already subscribed', async () => {
        const answer = Response.json(
            { errors: [{ message: 'Member already exists' }] },
            { status: 400 }
        )

        expect(await signUp('reader@example.com', network(token(), answer).fetch)).toEqual({
            kind: 'already'
        })
    })

    test('gives the message of a refusal', async () => {
        const answer = Response.json(
            { errors: [{ message: 'Too many attempts, try again later' }] },
            { status: 429 }
        )

        expect(await signUp('reader@example.com', network(token(), answer).fetch)).toEqual({
            kind: 'refused',
            message: 'Too many attempts, try again later'
        })
    })

    test('gives the message of today for a refusal with no message', async () => {
        const answer = new Response('not JSON', { status: 500 })

        expect(await signUp('reader@example.com', network(token(), answer).fetch)).toEqual({
            kind: 'refused',
            message: 'Subscription failed. Please try again.'
        })
    })

    test('fails when the network fails, or when the token is refused', async () => {
        expect(await signUp('reader@example.com', network(new Error('offline')).fetch)).toEqual({
            kind: 'failed'
        })
        expect(
            await signUp('reader@example.com', network(new Response('', { status: 403 })).fetch)
        ).toEqual({ kind: 'failed' })
    })
})
