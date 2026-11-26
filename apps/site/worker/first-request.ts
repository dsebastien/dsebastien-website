import { FIRST_REQUEST_BUDGET, judgeFirstRequests, percentileOf } from '../src/budgets.ts'
import type { FirstRequestVerdict } from '../src/budgets.ts'

// The check of the first request of a new instance of the Worker (issue 121,
// PERF-29): what `scripts/first-request.ts` reads from the answers of a host.
// The Worker marks the first answer of an instance with a `Server-Timing`
// entry (`NEW_INSTANCE_TIMING` of `worker.ts`), so a client can tell which
// requests met a new instance.

/** One request of the check, as curl measured it, in milliseconds from its start. */
export interface Sample {
    readonly path: string
    readonly status: number
    /** The TCP connection and the TLS handshake are done. */
    readonly connected: number
    /** The first byte of the answer. */
    readonly firstByte: number
    /** True when the answer is the first one of an instance of the Worker. */
    readonly newInstance: boolean
    /** When the request started, in milliseconds since the epoch. */
    readonly at: number
}

/** The `--write-out` of curl that `sampleOf()` reads: the status and the times on one line, then the `Server-Timing` header. */
export const CURL_WRITE_OUT =
    '%{http_code} %{time_appconnect} %{time_starttransfer}\\n%header{server-timing}\\n'

/** True when a `Server-Timing` header holds the entry of the given name with the given description. */
export function hasTiming(header: string, entry: string): boolean {
    return header
        .split(',')
        .map((part) => part.replaceAll(/\s+/gu, ''))
        .some((part) => part === entry || part.startsWith(`${entry};`))
}

/**
 * The sample of a request from the output of curl with `CURL_WRITE_OUT`.
 * `undefined` when the output is not that.
 */
export function sampleOf(
    output: string,
    path: string,
    at: number,
    marker: string
): Sample | undefined {
    const [times = '', timing = ''] = output.split(/\r?\n/u)
    const match = /^(\d{3}) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/u.exec(times.trim())
    if (match === null) {
        return undefined
    }
    const seconds = (text: string | undefined): number =>
        Math.round(Number(text ?? 'NaN') * 1_000_000) / 1000
    return {
        path,
        status: Number(match[1]),
        connected: seconds(match[2]),
        firstByte: seconds(match[3]),
        newInstance: hasTiming(timing, marker),
        at
    }
}

/** The addresses of the `<loc>` elements of a sitemap or of a sitemap index. */
export function locationsOf(xml: string): string[] {
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gu)].map((match) =>
        (match[1] ?? '').replaceAll('&amp;', '&')
    )
}

/** The times of a group of requests, in milliseconds: the first byte at the 50th and 95th percentiles and the longest. */
export interface Times {
    readonly count: number
    readonly p50: number
    readonly p95: number
    readonly max: number
}

function timesOf(values: readonly number[]): Times {
    const sorted = [...values].sort((one, two) => one - two)
    return {
        count: sorted.length,
        p50: percentileOf(sorted, 50),
        p95: percentileOf(sorted, 95),
        max: sorted.at(-1) ?? Number.NaN
    }
}

/** What the check found. */
export interface Summary {
    readonly requests: number
    /** The requests that met a new instance, and their share of all requests. */
    readonly newInstances: number
    readonly share: number
    /** The first requests of an instance, against the budget. */
    readonly first: FirstRequestVerdict
    /** The time of the server part of a first request: the first byte after the TLS handshake. */
    readonly firstAfterHandshake: Times
    /** The other requests. */
    readonly later: Times
    /** The requests whose answer was not 200. */
    readonly notOk: number
    readonly budget: typeof FIRST_REQUEST_BUDGET
}

/** The summary of the samples of a run. */
export function summaryOf(samples: readonly Sample[]): Summary {
    const first = samples.filter((sample) => sample.newInstance)
    const later = samples.filter((sample) => !sample.newInstance)
    return {
        requests: samples.length,
        newInstances: first.length,
        share: samples.length === 0 ? 0 : Math.round((first.length / samples.length) * 1000) / 1000,
        first: judgeFirstRequests(first.map((sample) => sample.firstByte)),
        firstAfterHandshake: timesOf(
            first.map((sample) => Math.round((sample.firstByte - sample.connected) * 1000) / 1000)
        ),
        later: timesOf(later.map((sample) => sample.firstByte)),
        notOk: samples.filter((sample) => sample.status !== 200).length,
        budget: FIRST_REQUEST_BUDGET
    }
}
