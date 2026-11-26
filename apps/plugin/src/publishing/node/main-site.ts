import { get as httpsGet } from 'node:https'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import {
    CHECK_REDIRECTS,
    CHECK_SIZE_LIMIT,
    CHECK_TIME_LIMIT,
    CHECK_USER_AGENT
} from '../originals.ts'
import type { MainSite, PageAnswer } from '../ports.ts'

// The main site over the network, for the check of the original of a note
// (PUB-100): a `GET` with a time limit for the whole check, a limit on the
// bytes read, redirects followed within `https` only, and a user agent that
// names the tool and nothing of the person who runs it. It runs in Obsidian
// on a computer and in Bun (`bun run originals`). The Rust twin calls `curl`
// (`cli/src/originals.rs`). No test reaches the real main site.

/** One answer of one request, before any redirect. */
export interface OneAnswer {
    readonly status: number
    /** The `Location` header, when the answer has one. */
    readonly location: string | undefined
    /** The first bytes of the body, as UTF-8 text. */
    readonly body: string
}

/** One request with no redirect: it throws when there is no answer. */
export type OneRequest = (url: string, timeLimit: number) => Promise<OneAnswer>

/** The `get` of `node:https` or of `node:http` (the tests). */
type Get = (
    url: string,
    options: RequestOptions,
    callback: (answer: IncomingMessage) => void
) => ClientRequest

/** A status of a redirect that has a `Location`. */
function isRedirect(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status)
}

/**
 * One request through a `get` function: the body is read up to the size
 * limit, and a body above it fails the request. The time limit covers the
 * whole request.
 */
export function requestWith(get: Get, sizeLimit: number = CHECK_SIZE_LIMIT): OneRequest {
    return (url, timeLimit) =>
        new Promise<OneAnswer>((resolve, reject) => {
            let settled = false
            const settle = (done: () => void): void => {
                if (!settled) {
                    settled = true
                    clearTimeout(timer)
                    done()
                }
            }
            const request = get(
                url,
                { headers: { 'user-agent': CHECK_USER_AGENT, 'accept': 'text/html' } },
                (answer) => {
                    const status = answer.statusCode ?? 0
                    const location = answer.headers.location
                    if (isRedirect(status)) {
                        // The body of a redirect is never read.
                        answer.resume()
                        settle(() => {
                            resolve({ status, location, body: '' })
                        })
                        return
                    }
                    const chunks: Buffer[] = []
                    let size = 0
                    answer.on('data', (chunk: Buffer) => {
                        size += chunk.length
                        if (size > sizeLimit) {
                            request.destroy()
                            settle(() => {
                                reject(
                                    new Error(`the page is larger than ${String(sizeLimit)} bytes`)
                                )
                            })
                            return
                        }
                        chunks.push(chunk)
                    })
                    answer.on('end', () => {
                        settle(() => {
                            resolve({
                                status,
                                location,
                                body: Buffer.concat(chunks).toString('utf8')
                            })
                        })
                    })
                    answer.on('error', (error) => {
                        settle(() => {
                            reject(error)
                        })
                    })
                }
            )
            const timer = setTimeout(() => {
                request.destroy()
                settle(() => {
                    reject(
                        new Error(
                            `the main site did not answer in ${String(Math.round(timeLimit / 1000))} seconds`
                        )
                    )
                })
            }, timeLimit)
            request.on('error', (error) => {
                settle(() => {
                    reject(error)
                })
            })
        })
}

/**
 * Asks for a page and follows its redirects within `https`, at most
 * `CHECK_REDIRECTS` of them, in the time limit of the whole check. The
 * answer names the URL of the last request.
 */
export async function followPage(
    url: string,
    request: OneRequest,
    timeLimit: number = CHECK_TIME_LIMIT,
    now: () => number = Date.now
): Promise<PageAnswer> {
    const end = now() + timeLimit
    let current = url
    for (let redirects = 0; ; redirects += 1) {
        if (!current.startsWith('https://')) {
            throw new Error(`the check follows https only, not ${current}`)
        }
        const left = end - now()
        if (left <= 0) {
            throw new Error(
                `the main site did not answer in ${String(Math.round(timeLimit / 1000))} seconds`
            )
        }
        const answer = await request(current, left)
        if (!isRedirect(answer.status) || answer.location === undefined) {
            return { status: answer.status, url: current, body: answer.body }
        }
        if (redirects >= CHECK_REDIRECTS) {
            throw new Error(`more than ${String(CHECK_REDIRECTS)} redirects from ${url}`)
        }
        current = new URL(answer.location, current).href
    }
}

/** The main site over the network, through `node:https`. */
export function httpsMainSite(): MainSite {
    const request = requestWith(httpsGet)
    return { page: (url) => followPage(url, request) }
}
