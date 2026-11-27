import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { deployToken, targetFrom, withoutTokens } from '../apps/site/worker/deployment.ts'
import {
    CURL_WRITE_OUT,
    floorConfiguration,
    floorRemoval,
    floorWorkerName,
    locationsOf,
    sampleOf,
    summaryOf,
    workersDevAddress,
    type Sample
} from '../apps/site/worker/first-request.ts'
import { FLOOR_PAGE } from '../apps/site/worker/floor.ts'
import { NEW_INSTANCE_TIMING } from '../apps/site/worker/instance.ts'

// The check of the first request of a new instance of the Worker (issue 121,
// PERF-29, R94): what the resolver map adds, at the 95th percentile, to the
// time to the first byte of the requests that meet a new instance, against a
// Worker with no map (the floor) in the same run (`FIRST_REQUEST_BUDGET` of
// `apps/site/src/budgets.ts`: 60 ms at most). It also gives the share of the
// requests that meet a new instance. Each request goes with curl on a new
// connection, as a first visit does, so a time holds the TCP connection and
// the TLS handshake, on both sides. Run it from a machine near the edge, on
// the preview host, with the map of the published notes.
//
//     bun run first-request --base <address> (--floor-target <file> | --floor <address>)
//         [--paths <file>] [--requests <count>] [--parallel <count>] [--every <seconds>]
//         [--out <file>]
//
// The floor: `--floor-target` names the private target file of the host; the
// check deploys a temporary floor Worker (`apps/site/worker/floor.ts`) on the
// `workers.dev` name of that account, with one page of the host as its only
// static file, and deletes it at the end, also after a failure or a signal
// (Ctrl-C, SIGTERM, SIGHUP). The
// token is the one of the deployment (`NOTES_DEPLOY_CLOUDFLARE_API_TOKEN`,
// else `CLOUDFLARE_API_TOKEN`). `--floor` takes the address of a floor that
// exists already; it is not deleted. A new floor has only new instances: so
// does a host right after its deployment.
//
// Two ways to run it:
//
// 1. Right after a deployment (every instance is new): a burst of `--requests`
//    requests on each side (60 by default), `--parallel` at a time on each
//    side (4 by default). Run it after a few deployments until the first
//    requests reach the count of the budget on both sides.
// 2. `--every <seconds>`: one request on each side at a time, at a random
//    moment around that interval (half of it to one and a half), for the
//    count of `--requests`: a host with few readers. The share of new
//    instances is the measure of the issue; leave it a day (for example
//    `--every 600 --requests 144`).
//
// The paths are those of `--paths` (one per line), else a sample of the
// sitemaps of the host. No address of a host is written into this
// repository. With `--out`, each sample is a JSON line of that file, with its
// side. Only the answers 200 are judged. The last line of the standard output
// is the summary, as JSON. The exit code is 1 when the map adds more than the
// budget, and when a side has too few first requests for a verdict.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WRANGLER = join(ROOT, 'apps', 'site', 'node_modules', '.bin', 'wrangler')

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        'base': { type: 'string' },
        'floor': { type: 'string' },
        'floor-target': { type: 'string' },
        'paths': { type: 'string' },
        'requests': { type: 'string', default: '60' },
        'parallel': { type: 'string', default: '4' },
        'every': { type: 'string' },
        'out': { type: 'string' }
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
if ((values.floor === undefined) === (values['floor-target'] === undefined)) {
    throw new Error('give one of --floor-target <file> and --floor <address>')
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
const pick = (): string => paths[Math.floor(Math.random() * paths.length)] ?? '/'

/**
 * Deletes the temporary floor Worker, once its name is known. A signal
 * (Ctrl-C, the end of a session, a stop) runs it before the end: the signals
 * are set before the floor is deployed.
 */
let cleanup: (() => Promise<void>) | undefined
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
        void (cleanup?.() ?? Promise.resolve())
            .catch((error: unknown) => {
                // The reader must know when the floor Worker is still on the host.
                process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
            })
            .finally(() => process.exit(130))
    })
}

/** A temporary floor Worker: its address, and how to delete it. */
interface Floor {
    readonly address: URL
    readonly remove: () => Promise<void>
}

/** Deploys a temporary floor Worker on the `workers.dev` name of the account of the target. */
async function deployFloor(targetFile: string): Promise<Floor> {
    const target = targetFrom(JSON.parse(await readFile(targetFile, 'utf8')))
    const token = deployToken(process.env)
    if (token === undefined) {
        throw new Error('NOTES_DEPLOY_CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN are not set')
    }
    // The page of the floor is a page of the host, of the same size: a page, not an error page.
    const page = await fetch(new URL(paths[0] ?? '/', base))
    if (page.status !== 200) {
        throw new Error(
            `the host answers ${String(page.status)} for ${paths[0] ?? '/'}: the floor needs a page of the host`
        )
    }
    const bytes = new Uint8Array(await page.arrayBuffer())
    const name = floorWorkerName(target.worker, crypto.randomUUID().replaceAll('-', '').slice(0, 6))
    const folder = await mkdtemp(join(tmpdir(), 'first-request-floor-'))
    const dist = join(folder, 'dist')
    await mkdir(dist)
    await writeFile(join(dist, FLOOR_PAGE), bytes)
    const configuration = join(folder, 'wrangler.json')
    await writeFile(
        configuration,
        JSON.stringify(
            floorConfiguration({
                accountId: target.accountId,
                name,
                main: join(ROOT, 'apps', 'site', 'worker', 'floor.ts'),
                dist
            })
        )
    )
    let child: ReturnType<typeof Bun.spawn> | undefined
    const remove = floorRemoval({
        // A deployment that still runs is stopped first: it could finish after the delete.
        stop: async () => {
            if (child !== undefined && child.exitCode === null) {
                child.kill()
                await child.exited
            }
        },
        remove: async () => {
            const answer = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/${name}?force=true`,
                { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }
            )
            await rm(folder, { recursive: true, force: true })
            if (!answer.ok && answer.status !== 404) {
                throw new Error(
                    `the floor Worker ${name} could not be deleted (${String(answer.status)}): delete it by hand`
                )
            }
            process.stderr.write(`The floor Worker ${name} is deleted.\n`)
        }
    })
    // From now on a signal deletes the floor Worker, also while wrangler deploys it.
    cleanup = remove
    try {
        const deploying = Bun.spawn([WRANGLER, 'deploy', '--config', configuration], {
            cwd: folder,
            env: { ...withoutTokens(process.env), CLOUDFLARE_API_TOKEN: token },
            stdio: ['ignore', 'pipe', 'pipe']
        })
        child = deploying
        const [output, errors, code] = await Promise.all([
            new Response(deploying.stdout).text(),
            new Response(deploying.stderr).text(),
            deploying.exited
        ])
        const address = workersDevAddress(output)
        if (code !== 0 || address === undefined) {
            throw new Error(
                `the floor Worker ${name} was not deployed (code ${String(code)}): ${errors.slice(-500)}`
            )
        }
        process.stderr.write(`The floor Worker ${name} is deployed.\n`)
        // As after a deployment of the host: the new version reaches the edge.
        await Bun.sleep(15_000)
        return { address: new URL(address), remove }
    } catch (error) {
        await remove()
        throw error
    }
}

/** One request on a new connection. */
async function ask(origin: URL, path: string): Promise<Sample | undefined> {
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
            new URL(path, origin).href
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return sampleOf(output, path, at, NEW_INSTANCE_TIMING)
}

type Side = 'host' | 'floor'
const samples: Record<Side, Sample[]> = { host: [], floor: [] }
let failed = 0

async function record(side: Side, sample: Sample | undefined): Promise<void> {
    if (sample === undefined) {
        failed += 1
        return
    }
    samples[side].push(sample)
    process.stderr.write(
        `${new Date(sample.at).toISOString()} ${side} ${String(sample.status)} ${String(sample.firstByte)} ms${sample.newInstance ? ' new instance' : ''}\n`
    )
    if (values.out !== undefined) {
        await appendFile(values.out, `${JSON.stringify({ side, ...sample })}\n`)
    }
}

async function measure(floor: URL): Promise<void> {
    const both = async (size: number): Promise<void> => {
        const asked = [
            ...Array.from({ length: size }, () => ['host', ask(base, pick())] as const),
            ...Array.from({ length: size }, () => ['floor', ask(floor, pick())] as const)
        ]
        for (const [side, sample] of asked) {
            await record(side, await sample)
        }
    }
    if (every === undefined) {
        for (let done = 0; done < requests; done += parallel) {
            await both(Math.min(parallel, requests - done))
        }
        return
    }
    for (let done = 0; done < requests; done += 1) {
        await both(1)
        if (done + 1 < requests) {
            await Bun.sleep(Math.round(every * 1000 * (0.5 + Math.random())))
        }
    }
}

const floor =
    values['floor-target'] === undefined
        ? { address: new URL(values.floor ?? ''), remove: () => Promise.resolve() }
        : await deployFloor(values['floor-target'])
try {
    await measure(floor.address)
} finally {
    await floor.remove()
}

const summary = summaryOf(samples.host, samples.floor)
process.stdout.write(`${JSON.stringify({ ...summary, failedRequests: failed })}\n`)
// A run with too few first requests proves nothing: it does not pass either.
process.exitCode = summary.first.verdict === 'pass' ? 0 : 1
