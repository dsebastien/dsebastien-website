import {
    FIRST_REQUEST_BUDGET,
    firstRequestTimes,
    judgeFirstRequests,
    type FirstRequestTimes,
    type FirstRequestVerdict
} from '../src/budgets.ts'

// The check of the first request of a new instance of the Worker (issue 121,
// PERF-29, R94): what `scripts/first-request.ts` reads from the answers of a
// host and of the floor, a Worker with no map (`floor.ts`), in the same run.
// Both mark the first answer of an instance with a `Server-Timing` entry
// (`NEW_INSTANCE_TIMING` of `instance.ts`), so a client can tell which
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
export type Times = FirstRequestTimes

/** What the check found on one side: the host or the floor. */
export interface SideSummary {
    readonly requests: number
    /** The requests that met a new instance, and their share of all requests. */
    readonly newInstances: number
    readonly share: number
    /** The time of the server part of a first request: the first byte after the TLS handshake. */
    readonly afterHandshake: Times
    /** The other requests. */
    readonly later: Times
    /** The requests whose answer was not 200. */
    readonly notOk: number
}

/** What the check found. */
export interface Summary {
    readonly host: SideSummary
    readonly floor: SideSummary
    /** The first requests of new instances of the host against those of the floor. */
    readonly first: FirstRequestVerdict
    readonly budget: typeof FIRST_REQUEST_BUDGET
}

const firsts = (samples: readonly Sample[]): Sample[] =>
    samples.filter((sample) => sample.newInstance)

const answered = (samples: readonly Sample[]): Sample[] =>
    samples.filter((sample) => sample.status === 200)

function sideOf(samples: readonly Sample[]): SideSummary {
    const first = firsts(samples)
    return {
        requests: samples.length,
        newInstances: first.length,
        share: samples.length === 0 ? 0 : Math.round((first.length / samples.length) * 1000) / 1000,
        afterHandshake: firstRequestTimes(
            first.map((sample) => Math.round((sample.firstByte - sample.connected) * 1000) / 1000)
        ),
        later: firstRequestTimes(
            samples.filter((sample) => !sample.newInstance).map((sample) => sample.firstByte)
        ),
        notOk: samples.filter((sample) => sample.status !== 200).length
    }
}

/** The summary of the samples of a run, on the host and on the floor. */
export function summaryOf(host: readonly Sample[], floor: readonly Sample[]): Summary {
    return {
        host: sideOf(host),
        floor: sideOf(floor),
        // Only the answers 200 are judged: an error page is not the first request of a reader.
        first: judgeFirstRequests(
            answered(firsts(host)).map((sample) => sample.firstByte),
            answered(firsts(floor)).map((sample) => sample.firstByte)
        ),
        budget: FIRST_REQUEST_BUDGET
    }
}

/** The name of the floor Worker of a run: the name of the Worker of the host, cut to fit, then `-floor-` and a random part. */
export function floorWorkerName(worker: string, random: string): string {
    const suffix = `-floor-${random}`
    return `${worker.slice(0, 63 - suffix.length)}${suffix}`
}

/** The wrangler configuration of the floor Worker: on the `workers.dev` name of the account, with no route. */
export function floorConfiguration(options: {
    readonly accountId: string
    readonly name: string
    readonly main: string
    readonly dist: string
}): Record<string, unknown> {
    return {
        name: options.name,
        account_id: options.accountId,
        main: options.main,
        compatibility_date: '2026-11-01',
        workers_dev: true,
        preview_urls: false,
        assets: {
            directory: options.dist,
            binding: 'ASSETS',
            html_handling: 'none',
            not_found_handling: 'none',
            run_worker_first: true
        }
    }
}

/** The `workers.dev` address that wrangler prints after a deployment. `undefined` when it prints none. */
export function workersDevAddress(output: string): string | undefined {
    return /https:\/\/[a-z0-9.-]+\.workers\.dev/u.exec(output)?.[0]
}
