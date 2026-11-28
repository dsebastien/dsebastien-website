import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { brotliCompressSync, constants } from 'node:zlib'
import { canonicalPath } from '@dsebastien-website/resolver'
import {
    FIXTURE_NOTE_TYPES,
    BUDGET_SAMPLE,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    writeBudgetSample,
    testSealKey
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../apps/plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../apps/plugin/src/publishing/tool.ts'
import { judgeTimes, TIME_BUDGET, type TimeBudget, type TimeRun } from '../apps/site/src/budgets.ts'
import { startServer } from '../apps/site/server/serve.ts'
import { writePreviewSample } from '../apps/site/src/link-previews/preview-sample.ts'
import { writeReleaseVariants } from '../apps/site/worker/image-variants.ts'

// The invented stores are sealed with the key of the tests (R104): every
// device of this run, and every program that it starts, uses that key.
process.env['VAULT_PUBLISH_SEAL_KEY'] = testSealKey()

// The time budgets of the note page (issue 47, PERF-20, PERF-22, R57). The
// tool publishes a copy of the fixture vault with the budget sample, the site
// is built and served behind a proxy that compresses text with Brotli, as the
// host does, and Lighthouse runs five times per page on the three pages of
// the sample and on the note with music blocks, on mobile (its default: slow
// 4G and a CPU four times slower) and on desktop. A median above its time budget gets five more runs, and
// blocks only when their median fails too. A median of the layout shift
// above its budget blocks at once. In the second runs every budget counts
// again, the layout shift too. The byte budgets are a test (`apps/site/src/page-budgets.spec.ts`).
//
//     bun scripts/page-budgets.ts [--runs 5] [--page 'music note']
//
// Lighthouse is the version of `package.json`. Chrome is found by Lighthouse,
// or named by CHROME_PATH. A run waits for a quiet machine: a backup made the
// blocking time of one page go from 18 ms to 1,700 ms (issue 25). Everything
// lives in `.cache/` and is removed at the end, but the reports. The
// variants of the images (issue 87) are made as a deploy makes them, into a
// folder that the plain server reads. A fourth page is a note of the fixture
// vault with link cards, whose previews come from the preview sample (issue 86).

/** The invented note with one block of each music language. */
const MUSIC_NOTE = '20 Library/20.03 Music/Campfire song.md'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'apps', 'site')
const REPORTS = join(ROOT, '.cache', 'page-budgets')

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { runs: { type: 'string', default: '5' }, page: { type: 'string' } },
    strict: true
})
const RUNS = Number(values.runs)
if (!Number.isSafeInteger(RUNS) || RUNS < 1) {
    throw new Error('--runs must be a whole number of at least 1')
}
/** The highest load of the last minute at which a run starts, and the longest wait for it. */
const MAX_LOAD = Math.max(2, cpus().length / 3)
const MAX_WAIT_MS = 10 * 60_000

/** The pages that Lighthouse measures, with their mobile budget. */
const PAGES: { name: string; vaultPath: string; mobile: TimeBudget }[] = [
    { name: 'long note', vaultPath: BUDGET_SAMPLE.long, mobile: TIME_BUDGET.mobile },
    { name: 'media note', vaultPath: BUDGET_SAMPLE.media, mobile: TIME_BUDGET.mobileMedia },
    { name: 'hub note', vaultPath: BUDGET_SAMPLE.hub, mobile: TIME_BUDGET.mobile },
    {
        name: 'note with cards',
        vaultPath: '40 Writing/Reading list.md',
        mobile: TIME_BUDGET.mobile
    },
    // The invented note with one block of each music language (PERF-21, issue 53): the
    // music loads after the page shows; its blocked time has a budget of its own (R105).
    { name: 'music note', vaultPath: MUSIC_NOTE, mobile: TIME_BUDGET.mobileMusic }
]
/** The pages of this run: all, or the one that `--page` names. */
const MEASURED = PAGES.filter((page) => values.page === undefined || page.name === values.page)
if (MEASURED.length === 0) {
    throw new Error(`--page names none of: ${PAGES.map((page) => page.name).join(', ')}`)
}

const COMPRESSED = /^(text\/|application\/(javascript|json|xml)|image\/svg)/u

/** A proxy in front of the local server that compresses text with Brotli, as the host does. */
function compressingProxy(origin: string): { url: string; stop: () => Promise<void> } {
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const url = new URL(request.url)
            const answer = await fetch(`${origin}${url.pathname}${url.search}`, {
                headers: request.headers,
                redirect: 'manual'
            })
            const headers = new Headers(answer.headers)
            if (!COMPRESSED.test(headers.get('content-type') ?? '') || answer.status !== 200) {
                return new Response(answer.body, { status: answer.status, headers })
            }
            const compressed = brotliCompressSync(new Uint8Array(await answer.arrayBuffer()), {
                params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
            })
            headers.set('content-encoding', 'br')
            headers.set('content-length', String(compressed.byteLength))
            headers.delete('etag')
            return new Response(compressed, { status: 200, headers })
        }
    })
    return {
        url: `http://127.0.0.1:${String(server.port)}`,
        stop: () => server.stop(true)
    }
}

/** Waits until the load of the machine is low, at most MAX_WAIT_MS. */
async function quietMachine(): Promise<void> {
    const start = Date.now()
    while ((loadavg()[0] ?? 0) > MAX_LOAD) {
        if (Date.now() - start > MAX_WAIT_MS) {
            console.error(
                `The load of the machine stays above ${String(MAX_LOAD)}: the times can be wrong.`
            )
            return
        }
        await Bun.sleep(15_000)
    }
}

let reportCount = 0

/** One Lighthouse run of a page. */
async function lighthouse(url: string, preset: 'mobile' | 'desktop'): Promise<TimeRun> {
    await quietMachine()
    reportCount += 1
    const file = join(REPORTS, `run-${String(reportCount)}-${preset}.json`)
    const args = [
        'bunx',
        'lighthouse',
        url,
        '--quiet',
        '--only-categories=performance',
        '--output=json',
        `--output-path=${file}`,
        '--chrome-flags=--headless=new --no-sandbox'
    ]
    if (preset === 'desktop') {
        args.push('--preset=desktop')
    }
    // Chrome can fail to start on a CI runner ("waiting for dynamic debugging
    // port"): a run that crashes is tried again, three times in all. A run
    // that ends is never run again, whatever its times.
    let attempt = 1
    while (
        (await Bun.spawn(args, { cwd: ROOT, stdout: 'ignore', stderr: 'inherit' }).exited) !== 0
    ) {
        if (attempt === 3) {
            throw new Error(`Lighthouse failed three times on ${url}`)
        }
        attempt += 1
        console.error(`Lighthouse failed on ${url}: try ${String(attempt)} of 3`)
        await Bun.sleep(5_000)
    }
    const report = JSON.parse(await readFile(file, 'utf8')) as {
        audits: Record<string, { numericValue?: number } | undefined>
    }
    const value = (id: string): number => {
        const number = report.audits[id]?.numericValue
        if (number === undefined) {
            throw new Error(`the report of Lighthouse has no ${id}`)
        }
        return number
    }
    return {
        lcp: value('largest-contentful-paint'),
        tbt: value('total-blocking-time'),
        cls: value('cumulative-layout-shift')
    }
}

async function runs(url: string, preset: 'mobile' | 'desktop'): Promise<TimeRun[]> {
    const result: TimeRun[] = []
    for (let run = 0; run < RUNS; run += 1) {
        result.push(await lighthouse(url, preset))
    }
    return result
}

function describe(list: readonly TimeRun[]): string {
    const sorted = (pick: (run: TimeRun) => number): string =>
        list
            .map(pick)
            .sort((one, two) => one - two)
            .map((value) => (value < 1 ? value.toFixed(3) : String(Math.round(value))))
            .join(' ')
    return `LCP ${sorted((run) => run.lcp)} ms, TBT ${sorted((run) => run.tbt)} ms, CLS ${sorted((run) => run.cls)}`
}

const stores = await makeTestStores()
const cache = join(SITE, '.cache')
await mkdir(cache, { recursive: true })
await rm(REPORTS, { recursive: true, force: true })
await mkdir(REPORTS, { recursive: true })
const outDir = await mkdtemp(join(cache, 'page-budgets-'))
/** The variants of the images, made as a deploy makes them (issue 87). */
const variants = `${outDir}-variants`
/** The previews of the link cards (issue 86). */
const previews = `${outDir}-previews`
let failed = false
try {
    const vault = await copyFixtureVault(stores)
    await writeBudgetSample(vault)
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const queue = await status(device)
    const planned = await plan(device, { include: queue.new })
    await publish(device, planned.id, {
        time: '2031-05-01T00:00:00Z',
        device: 'budgets',
        face: 'command-line'
    })
    // A fresh build: the markup that Astro keeps can be older than the code.
    await rm(join(SITE, 'node_modules', '.astro', 'data-store.json'), { force: true })
    await writePreviewSample(previews)
    const build = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: {
            ...process.env,
            CONTENT_STORE: contentStore,
            LINK_PREVIEWS: 'cache',
            LINK_PREVIEWS_CACHE: previews
        },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    if ((await build.exited) !== 0) {
        throw new Error('the build of the site failed')
    }
    await writeReleaseVariants(contentStore, stores.attachmentStorage, variants)
    const server = await startServer({
        dist: outDir,
        port: 0,
        attachments: stores.attachmentStorage,
        variants
    })
    const proxy = compressingProxy(server.url)
    try {
        for (const page of MEASURED) {
            const url = `${proxy.url}${canonicalPath(page.vaultPath)}`
            const answer = await fetch(url)
            if (answer.status !== 200) {
                throw new Error(`the ${page.name} answers ${String(answer.status)}`)
            }
            for (const preset of ['mobile', 'desktop'] as const) {
                const budget = preset === 'mobile' ? page.mobile : TIME_BUDGET.desktop
                const first = await runs(url, preset)
                let verdict = judgeTimes(budget, first)
                console.error(`${page.name}, ${preset}: ${describe(first)}`)
                if (verdict.verdict === 'again') {
                    console.error(`  ${verdict.failures.join('; ')}: five more runs`)
                    const second = await runs(url, preset)
                    console.error(`  second runs: ${describe(second)}`)
                    verdict = judgeTimes(budget, first, second)
                }
                if (verdict.verdict === 'fail') {
                    failed = true
                    console.error(`  FAILS: ${verdict.failures.join('; ')}`)
                } else {
                    console.error('  passes')
                }
            }
        }
    } finally {
        await proxy.stop()
        await server.stop()
    }
} finally {
    await rm(outDir, { recursive: true, force: true })
    await rm(variants, { recursive: true, force: true })
    await rm(previews, { recursive: true, force: true })
    await stores.remove()
}
console.error(`The reports of Lighthouse are in ${REPORTS}.`)
if (failed) {
    console.error('A note page is above a time budget (R57).')
    process.exit(1)
}
console.error('Every measured note page is within its time budgets.')
