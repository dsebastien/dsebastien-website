import { appendFile, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
    CURL_WRITE_OUT,
    locationsOf,
    sampleOf,
    summaryOf,
    type Sample
} from '../apps/site/worker/first-request.ts'
import { NEW_INSTANCE_TIMING } from '../apps/site/worker/worker.ts'

// The check of the first request of a new instance of the Worker (issue 121,
// PERF-29, R94): the time to the first byte of the requests that meet a new
// instance, against the budget (`FIRST_REQUEST_BUDGET` of
// `apps/site/src/budgets.ts`), and the share of the requests that meet one.
// Each request goes with curl on a new connection, as a first visit does, so
// a time holds the TCP connection and the TLS handshake. Run it from a
// machine near the edge, on the preview host, with the map of the published
// notes.
//
//     bun run first-request --base <address> [--paths <file>] [--requests <count>]
//         [--parallel <count>] [--every <seconds>] [--out <file>]
//
// Two ways to run it:
//
// 1. Right after a deployment (every instance is new): a burst of `--requests`
//    requests (60 by default), `--parallel` at a time (4 by default). Run it
//    after a few deployments until the first requests reach the count of the
//    budget.
// 2. `--every <seconds>`: one request at a time, at a random moment around
//    that interval (half of it to one and a half), for the count of
//    `--requests`: a host with few readers. The share of new instances is the
//    measure of the issue; leave it a day (for example `--every 600
//    --requests 144`).
//
// The paths are those of `--paths` (one per line), else a sample of the
// sitemaps of the host. The address of the host is never written into this
// repository. With `--out`, each sample is a JSON line of that file. The last
// line of the standard output is the summary, as JSON. The exit code is 1
// when the first requests break the budget.

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        base: { type: 'string' },
        paths: { type: 'string' },
        requests: { type: 'string', default: '60' },
        parallel: { type: 'string', default: '4' },
        every: { type: 'string' },
        out: { type: 'string' }
    },
    strict: true
})

function count(text: string, name: string): number {
    const value = Number(text)
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--${name} takes a whole number above 0`)
    }
    return value
}

if (values.base === undefined) {
    throw new Error('--base <address> is required')
}
const base = new URL(values.base)
const requests = count(values.requests, 'requests')
const parallel = count(values.parallel, 'parallel')
const every = values.every === undefined ? undefined : count(values.every, 'every')
const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null'

/** The paths of the sitemaps of the host: the paths only, asked at the base. */
async function sitemapPaths(): Promise<string[]> {
    const read = async (address: string): Promise<string> => {
        const response = await fetch(new URL(new URL(address).pathname, base))
        if (!response.ok) {
            throw new Error(
                `the host answers ${String(response.status)} for ${new URL(address).pathname}`
            )
        }
        return await response.text()
    }
    const files = locationsOf(await read(new URL('/sitemap.xml', base).href))
    const paths: string[] = []
    for (const file of files) {
        paths.push(...locationsOf(await read(file)).map((address) => new URL(address).pathname))
    }
    return paths
}

const paths =
    values.paths === undefined
        ? await sitemapPaths()
        : (await readFile(values.paths, 'utf8'))
              .split(/\r?\n/u)
              .filter((line) => line.startsWith('/'))
if (paths.length === 0) {
    throw new Error('no path to ask for')
}

/** One request on a new connection. */
async function ask(path: string): Promise<Sample | undefined> {
    const at = Date.now()
    const child = Bun.spawn(
        [
            'curl',
            '--silent',
            '--header',
            'accept: text/html',
            '--output',
            NULL_FILE,
            '--write-out',
            CURL_WRITE_OUT.replaceAll('\\n', '\n'),
            new URL(path, base).href
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return sampleOf(output, path, at, NEW_INSTANCE_TIMING)
}

const samples: Sample[] = []
let failed = 0
const pick = (): string => paths[Math.floor(Math.random() * paths.length)] ?? '/'

async function record(sample: Sample | undefined): Promise<void> {
    if (sample === undefined) {
        failed += 1
        return
    }
    samples.push(sample)
    process.stderr.write(
        `${new Date(sample.at).toISOString()} ${String(sample.status)} ${String(sample.firstByte)} ms${sample.newInstance ? ' new instance' : ''}\n`
    )
    if (values.out !== undefined) {
        await appendFile(values.out, `${JSON.stringify(sample)}\n`)
    }
}

if (every === undefined) {
    for (let done = 0; done < requests; done += parallel) {
        const batch = Array.from({ length: Math.min(parallel, requests - done) }, () => ask(pick()))
        for (const sample of await Promise.all(batch)) {
            await record(sample)
        }
    }
} else {
    for (let done = 0; done < requests; done += 1) {
        await record(await ask(pick()))
        if (done + 1 < requests) {
            await Bun.sleep(Math.round(every * 1000 * (0.5 + Math.random())))
        }
    }
}

const summary = summaryOf(samples)
process.stdout.write(`${JSON.stringify({ ...summary, failedRequests: failed })}\n`)
process.exitCode = summary.first.verdict === 'fail' ? 1 : 0
