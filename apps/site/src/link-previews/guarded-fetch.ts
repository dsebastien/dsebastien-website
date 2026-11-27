import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { isIP } from 'node:net'
import type { FetchPort } from './previews.ts'

// The requests of the previews reach the public web only (CARD-06): a page of
// another site names the address of its image, and must not make the build
// fetch and publish a file of the machine or of its network. For each request
// (each hop of a redirect is one), the host is resolved one time, every
// address that it gives is checked, and the connection goes to a checked
// address: a second answer of the DNS (a rebinding) cannot switch it. An
// address literal is checked as it is. The answer is one hop: the caller
// follows the redirects, through this port again.

/** An address that a name resolves to. */
export interface ResolvedAddress {
    readonly address: string
    readonly family: 4 | 6
}

/** The resolution of a name: the DNS of the machine, or a fake in a test. */
export type ResolvePort = (hostname: string) => Promise<readonly ResolvedAddress[]>

export interface GuardOptions {
    readonly resolve?: ResolvePort
    /** The addresses that a request may reach: by default, the public ones. */
    readonly isAllowed?: (address: string) => boolean
}

/** The four bytes of a dotted IPv4 address, or `undefined`. */
function ipv4Bytes(address: string): number[] | undefined {
    if (isIP(address) !== 4) return undefined
    return address.split('.').map(Number)
}

/** The sixteen bytes of an IPv6 address (without its zone), or `undefined`. */
function ipv6Bytes(written: string): number[] | undefined {
    const address = written.replace(/%.*$/u, '')
    if (isIP(address) !== 6) return undefined
    let text = address
    const tail: number[] = []
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text)
    if (dotted?.[1] !== undefined) {
        tail.push(...(ipv4Bytes(dotted[1]) ?? []))
        text = `${text.slice(0, dotted.index)}0:0`
    }
    const [head = '', rest] = text.split('::')
    const groups = (part: string): number[] =>
        part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16))
    const before = groups(head)
    const after = rest === undefined ? [] : groups(rest)
    const words = [...before, ...Array<number>(8 - before.length - after.length).fill(0), ...after]
    const bytes = words.flatMap((word) => [word >> 8, word & 0xff])
    if (tail.length === 4) bytes.splice(12, 4, ...tail)
    return bytes
}

/** True when the first `bits` of two byte lists are the same. */
function inPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
    for (let bit = 0; bit < bits; bit += 1) {
        const index = bit >> 3
        const mask = 0x80 >> (bit & 7)
        if (((bytes[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false
    }
    return true
}

/** The IPv4 ranges that are not the public web: this network, private, CGNAT, loopback, link-local, special, test, multicast, reserved. */
const NOT_PUBLIC_V4: readonly (readonly [readonly number[], number])[] = [
    [[0, 0, 0, 0], 8],
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10],
    [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12],
    [[192, 0, 0, 0], 24],
    [[192, 0, 2, 0], 24],
    [[192, 88, 99, 0], 24],
    [[192, 168, 0, 0], 16],
    [[198, 18, 0, 0], 15],
    [[198, 51, 100, 0], 24],
    [[203, 0, 113, 0], 24],
    [[224, 0, 0, 0], 4],
    [[240, 0, 0, 0], 4]
]

function isPublicV4(bytes: readonly number[]): boolean {
    return !NOT_PUBLIC_V4.some(([prefix, bits]) => inPrefix(bytes, prefix, bits))
}

/**
 * True for an address of the public web. An IPv6 address must be global
 * unicast (`2000::/3`, which leaves out `::`, `::1`, `fc00::/7`, `fe80::/10`
 * and `ff00::/8`); one that carries an IPv4 address (mapped, compatible,
 * NAT64, 6to4) is checked by that address; Teredo and the documentation range
 * are refused. Anything that is no address literal is refused.
 */
export function isPublicAddress(address: string): boolean {
    const v4 = ipv4Bytes(address)
    if (v4 !== undefined) return isPublicV4(v4)
    const v6 = ipv6Bytes(address)
    if (v6 === undefined) return false
    const zero = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    const embedded = v6.slice(12)
    if (inPrefix(v6, [...zero.slice(0, 10), 0xff, 0xff], 96)) return isPublicV4(embedded)
    if (inPrefix(v6, zero, 96)) return isPublicV4(embedded)
    if (inPrefix(v6, [0, 0x64, 0xff, 0x9b], 32)) return isPublicV4(embedded)
    if (!inPrefix(v6, [0x20], 3)) return false
    if (inPrefix(v6, [0x20, 0x01, 0x0d, 0xb8], 32)) return false
    // 2001::/23: special IPv6 blocks (Teredo, benchmarking, ORCHID), not routed as hosts.
    if (inPrefix(v6, [0x20, 0x01, 0], 23)) return false
    if (inPrefix(v6, [0x20, 0x02], 16)) return isPublicV4(v6.slice(2, 6))
    return true
}

const systemResolve: ResolvePort = async (hostname) =>
    (await dnsLookup(hostname, { all: true, order: 'verbatim' })).map(({ address, family }) => ({
        address,
        family: family === 6 ? 6 : 4
    }))

/** The checked addresses of the host of an address; throws when one of them is not allowed. */
async function checkedAddresses(
    hostname: string,
    resolve: ResolvePort,
    isAllowed: (address: string) => boolean
): Promise<readonly ResolvedAddress[]> {
    const literal = isIP(hostname)
    const addresses =
        literal === 0
            ? await resolve(hostname)
            : [{ address: hostname, family: literal === 6 ? (6 as const) : (4 as const) }]
    if (addresses.length === 0) throw new Error(`${hostname} has no address`)
    const refused = addresses.find(({ address }) => !isAllowed(address))
    if (refused !== undefined) {
        throw new Error(`${hostname} is ${refused.address}, not an address of the public web`)
    }
    return addresses
}

/** The headers of a request, as a plain record. */
function headersOf(init: RequestInit): Record<string, string> {
    const record: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => {
        record[name] = value
    })
    return record
}

/** An answer of Node as an answer of the web, its body read as the caller reads it. */
function responseOf(message: IncomingMessage): Response {
    const headers = new Headers()
    for (const [name, value] of Object.entries(message.headers)) {
        if (value === undefined) continue
        for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
    }
    const status = message.statusCode ?? 0
    if ([101, 204, 205, 304].includes(status)) {
        message.destroy()
        return new Response(null, { status, headers })
    }
    message.pause()
    // Closed when the body ends, fails, or the caller cancels it.
    let closed = false
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            message.on('data', (chunk: Buffer) => {
                if (closed) return
                controller.enqueue(new Uint8Array(chunk))
                if ((controller.desiredSize ?? 0) <= 0) message.pause()
            })
            message.on('end', () => {
                if (closed) return
                closed = true
                controller.close()
            })
            message.on('error', (error) => {
                if (closed) return
                closed = true
                controller.error(error)
            })
        },
        pull() {
            message.resume()
        },
        cancel() {
            closed = true
            message.destroy()
        }
    })
    return new Response(body, { status, headers })
}

/**
 * A `fetch` of one hop that reaches only allowed addresses, at the address
 * that it checked. It never follows a redirect and sends no cookie.
 */
export function guardedFetch(options: GuardOptions = {}): FetchPort {
    const resolve = options.resolve ?? systemResolve
    const isAllowed = options.isAllowed ?? isPublicAddress
    return async (address, init) => {
        const url = new URL(address)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error(`${url.href} is not an address of the web`)
        }
        const hostname = url.hostname.replace(/^\[(.*)\]$/u, '$1')
        const addresses = await checkedAddresses(hostname, resolve, isAllowed)
        // The connection takes the checked addresses: no second resolution.
        const pinned: LookupFunction = (_name, lookupOptions, callback) => {
            const [first] = addresses
            if (lookupOptions.all === true) {
                callback(
                    null,
                    addresses.map(({ address: one, family }) => ({ address: one, family }))
                )
            } else if (first !== undefined) {
                callback(null, first.address, first.family)
            }
        }
        const requestOptions: RequestOptions = {
            method: 'GET',
            hostname,
            port: url.port === '' ? undefined : Number(url.port),
            path: `${url.pathname}${url.search}`,
            headers: headersOf(init),
            lookup: pinned,
            agent: false
        }
        const request = url.protocol === 'https:' ? httpsRequest : httpRequest
        const signal = init.signal ?? undefined
        signal?.throwIfAborted()
        return new Promise<Response>((done, fail) => {
            const sent = request(requestOptions, (message) => {
                done(responseOf(message))
            })
            const abort = (): void => {
                sent.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
            }
            signal?.addEventListener('abort', abort, { once: true })
            sent.on('error', fail)
            sent.on('close', () => {
                signal?.removeEventListener('abort', abort)
            })
            sent.end()
        })
    }
}
