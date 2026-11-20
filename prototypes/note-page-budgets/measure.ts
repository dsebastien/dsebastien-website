import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'
import { cpus, loadavg } from 'node:os'
import { canonicalPath } from '@dsebastien-website/resolver'
import { makeContentStoreCopy, makeTestStores } from '@dsebastien-website/testing'
import { nodeDevice } from '../../apps/plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../../apps/plugin/src/publishing/tool.ts'
import { startServer } from '../../apps/site/server/serve.ts'
import { HUB_NOTE, LONG_NOTE, MEDIA_NOTE, writeBudgetVault } from './vault.ts'

// The measure of the prototype of issue 25 (PROTO-07). It publishes the
// invented vault of `vault.ts`, builds the site with the note page of
// variant B, serves it behind a proxy that compresses as the host does
// (Brotli), and runs Lighthouse on the three notes: mobile (simulated slow 4G
// and a slow CPU, the default of Lighthouse) and desktop, several runs each.
// The output goes to `.cache/budgets/`. Nothing reads the real vault.
//
//     bun prototypes/note-page-budgets/measure.ts [--runs 5] [--lighthouse 13.6.0]

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SITE = join(ROOT, 'apps/site')
const OUT = join(ROOT, '.cache/budgets')

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        runs: { type: 'string', default: '5' },
        lighthouse: { type: 'string', default: '13.6.0' },
        cap: { type: 'string', default: '50' },
        keep: { type: 'boolean', default: false }
    },
    strict: true
})
const RUNS = Number(values.runs)
/** The highest load of the last minute at which a run starts. */
const MAX_LOAD = Math.max(2, cpus().length / 3)

async function build(
    contentStore: string,
    outDir: string,
    cap: string,
    preload: boolean
): Promise<void> {
    await rm(join(SITE, 'node_modules/.astro/data-store.json'), { force: true })
    const process = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: {
            ...Bun.env,
            CONTENT_STORE: contentStore,
            BUDGET_BACKLINKS: cap,
            BUDGET_PRELOAD: preload ? '1' : '0'
        },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    if ((await process.exited) !== 0) {
        throw new Error('the build of the site failed')
    }
}

const COMPRESSED = /^(text\/|application\/(javascript|json|xml)|image\/svg)/

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
            const type = answer.headers.get('content-type') ?? ''
            const headers = new Headers(answer.headers)
            if (!COMPRESSED.test(type) || answer.status !== 200) {
                return new Response(answer.body, { status: answer.status, headers })
            }
            const body = new Uint8Array(await answer.arrayBuffer())
            const compressed = brotliCompressSync(body, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
            })
            headers.set('content-encoding', 'br')
            headers.set('content-length', String(compressed.byteLength))
            headers.delete('etag')
            return new Response(compressed, { status: 200, headers })
        }
    })
    return { url: `http://127.0.0.1:${String(server.port)}`, stop: () => server.stop(true) }
}

interface Sizes {
    raw: number
    gzip: number
    brotli: number
}

function sizes(bytes: Uint8Array): Sizes {
    return {
        raw: bytes.byteLength,
        gzip: gzipSync(bytes, { level: 9 }).byteLength,
        brotli: brotliCompressSync(bytes, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
        }).byteLength
    }
}

/** The bytes of the HTML, of its styles and of its scripts, with inline scripts apart. */
async function pageBytes(origin: string, path: string): Promise<Record<string, unknown>> {
    const html = new Uint8Array(await (await fetch(`${origin}${path}`)).arrayBuffer())
    const text = new TextDecoder().decode(html)
    const styles = [...text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
        (match) => match[1] ?? ''
    )
    const scripts = [...text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1] ?? '')
    const inline = [...text.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1] ?? '')
        .join('')
    const styleBytes = await Promise.all(
        styles.map(async (href) =>
            sizes(new Uint8Array(await (await fetch(`${origin}${href}`)).arrayBuffer()))
        )
    )
    const scriptBytes = await Promise.all(
        scripts.map(async (src) =>
            sizes(new Uint8Array(await (await fetch(`${origin}${src}`)).arrayBuffer()))
        )
    )
    const article = /<article[^>]*data-note-body[^>]*>([\s\S]*?)<\/article>/.exec(text)?.[1] ?? ''
    const shell = text.replace(article, '')
    return {
        html: sizes(html),
        noteBody: sizes(new TextEncoder().encode(article)),
        shell: sizes(new TextEncoder().encode(shell)),
        inlineScripts: sizes(new TextEncoder().encode(inline)),
        styles: styleBytes,
        scripts: scriptBytes,
        elements: (text.match(/<[a-z][^>]*>/g) ?? []).length
    }
}

interface LighthouseRun {
    lcp: number
    fcp: number
    tbt: number
    cls: number
    si: number
    tti: number
    bytes: number
    requests: number
    lcpElement: string
    /** The CPU benchmark of Lighthouse for the run, and the load of the machine before it. */
    benchmark: number
    load: number
    byType: Record<string, { requests: number; bytes: number }>
}

async function lighthouse(
    url: string,
    preset: 'mobile' | 'desktop',
    file: string
): Promise<LighthouseRun> {
    const args = [
        'bunx',
        `lighthouse@${values.lighthouse}`,
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
    // A busy machine gives wrong times: wait until the load of the last minute is low.
    let load = loadavg()[0] ?? 0
    while (load > MAX_LOAD) {
        await Bun.sleep(15_000)
        load = loadavg()[0] ?? 0
    }
    const process = Bun.spawn(args, {
        env: { ...Bun.env, CHROME_PATH: Bun.env['CHROME_PATH'] ?? '/usr/bin/google-chrome-stable' },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    if ((await process.exited) !== 0) {
        throw new Error(`lighthouse failed on ${url}`)
    }
    const report = JSON.parse(await readFile(file, 'utf8')) as {
        environment?: { benchmarkIndex?: number }
        audits: Record<string, { numericValue?: number; details?: { items?: unknown[] } }>
    }
    const value = (id: string): number => report.audits[id]?.numericValue ?? Number.NaN
    const summary = (report.audits['resource-summary']?.details?.items ?? []) as {
        resourceType: string
        requestCount: number
        transferSize: number
    }[]
    const byType: Record<string, { requests: number; bytes: number }> = {}
    for (const item of summary) {
        byType[item.resourceType] = { requests: item.requestCount, bytes: item.transferSize }
    }
    const lcpItems = (report.audits['largest-contentful-paint-element']?.details?.items ?? []) as {
        items?: { node?: { nodeLabel?: string; selector?: string } }[]
    }[]
    const node = lcpItems[0]?.items?.[0]?.node
    return {
        lcp: value('largest-contentful-paint'),
        fcp: value('first-contentful-paint'),
        tbt: value('total-blocking-time'),
        cls: value('cumulative-layout-shift'),
        si: value('speed-index'),
        tti: value('interactive'),
        bytes: value('total-byte-weight'),
        requests: byType['total']?.requests ?? Number.NaN,
        benchmark: report.environment?.benchmarkIndex ?? Number.NaN,
        load,
        lcpElement: `${node?.selector ?? ''} ${(node?.nodeLabel ?? '').slice(0, 40)}`.trim(),
        byType
    }
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1
        ? (sorted[middle] ?? Number.NaN)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

const stores = await makeTestStores()
try {
    await mkdir(OUT, { recursive: true })
    const vault = join(stores.root, 'vault')
    await writeBudgetVault(vault)
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({ vault, contentStore, attachmentStorage: stores.attachmentStorage })
    const queue = await status(device)
    const planned = await plan(device, { include: queue.new })
    await publish(device, planned.id, {
        time: '2026-11-20T12:00:00Z',
        device: 'budget',
        face: 'command-line'
    })
    console.error(`Published ${String(queue.new.length)} invented notes.`)
    const markdown: Record<string, number> = {}
    for (const note of [LONG_NOTE, MEDIA_NOTE, HUB_NOTE]) {
        markdown[note] = (await readFile(join(vault, note))).byteLength
    }

    const results: Record<string, unknown> = { markdown, runs: RUNS, lighthouse: values.lighthouse }
    const builds: [string, string, boolean][] = [
        ['capped', values.cap, false],
        ['tuned', values.cap, true],
        ['uncapped', '100000', false]
    ]
    for (const [label, cap, preload] of builds) {
        const outDir = join(stores.root, `dist-${label}`)
        await build(contentStore, outDir, cap, preload)
        const server = await startServer({
            dist: outDir,
            port: 0,
            attachments: stores.attachmentStorage
        })
        const proxy = compressingProxy(server.url)
        try {
            const pages = label === 'uncapped' ? [HUB_NOTE] : [LONG_NOTE, MEDIA_NOTE, HUB_NOTE]
            for (const note of pages) {
                const path = canonicalPath(note)
                const key = `${label}:${note}`
                const bytes = await pageBytes(server.url, path)
                const measured: Record<string, unknown> = { path, bytes }
                for (const preset of ['mobile', 'desktop'] as const) {
                    const runs: LighthouseRun[] = []
                    for (let run = 0; run < RUNS; run += 1) {
                        const file = join(
                            OUT,
                            `${label}-${note.replace(/\W+/g, '-')}-${preset}-${String(run)}.json`
                        )
                        runs.push(await lighthouse(`${proxy.url}${path}`, preset, file))
                    }
                    measured[preset] = {
                        median: {
                            lcp: median(runs.map((run) => run.lcp)),
                            fcp: median(runs.map((run) => run.fcp)),
                            tbt: median(runs.map((run) => run.tbt)),
                            cls: median(runs.map((run) => run.cls)),
                            si: median(runs.map((run) => run.si)),
                            tti: median(runs.map((run) => run.tti)),
                            bytes: median(runs.map((run) => run.bytes)),
                            requests: median(runs.map((run) => run.requests))
                        },
                        max: {
                            lcp: Math.max(...runs.map((run) => run.lcp)),
                            cls: Math.max(...runs.map((run) => run.cls)),
                            tbt: Math.max(...runs.map((run) => run.tbt))
                        },
                        benchmark: median(runs.map((run) => run.benchmark)),
                        load: Math.max(...runs.map((run) => run.load)),
                        lcpElement: runs[0]?.lcpElement,
                        byType: runs[0]?.byType
                    }
                    console.error(`${key} ${preset}: ${JSON.stringify(measured[preset])}`)
                }
                results[key] = measured
            }
        } finally {
            await proxy.stop()
            await server.stop()
        }
    }
    await writeFile(join(OUT, 'results.json'), `${JSON.stringify(results, null, 4)}\n`)
    console.error(`Results in ${join(OUT, 'results.json')}`)
} finally {
    if (!values.keep) {
        await stores.remove()
    }
}
