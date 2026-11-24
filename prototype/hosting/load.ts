import { parseArgs } from 'node:util'

// PROTOTYPE (issue 21, hosting). Throwaway code.
//
// Asks a host for every address of a built site and for invented wrong
// addresses, at a high rate, and counts the answers (checks 2 and 6 of the
// hosting research, section 6).
//
//     bun prototype/hosting/load.ts --base <address> --map <resolver-map.json> \
//         [--wrong 50000] [--concurrency 64] [--limit <per kind>] [--kinds pages,files,variants,wrong]
//
// Kinds: `pages` (each canonical path, 200 HTML), `files` (each Markdown
// file and text file, 200), `variants` (a canonical path in small letters and
// with `%20`, one redirect to the canonical path), `wrong` (an invented path,
// 404 that is never kept).

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        base: { type: 'string' },
        map: { type: 'string' },
        wrong: { type: 'string', default: '50000' },
        concurrency: { type: 'string', default: '64' },
        limit: { type: 'string' },
        kinds: { type: 'string', default: 'pages,files,variants,wrong' }
    },
    strict: true
})
if (values.base === undefined || values.map === undefined) {
    throw new Error('--base and --map are required')
}
const base = values.base.replace(/\/+$/u, '')
const limit = values.limit === undefined ? Infinity : Number(values.limit)
const kinds = new Set(values.kinds.split(','))

interface Job {
    kind: string
    path: string
    status: number
    location?: string
    type?: string
}

const map = (await Bun.file(values.map).json()) as {
    pages: Record<string, string>
    files?: Record<string, { type: string }>
}

// The same "random" values at each run.
let seed = 21
const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed
}

const jobs: Job[] = []
const pages = Object.keys(map.pages)
if (kinds.has('pages')) {
    for (const path of pages.slice(0, limit)) {
        jobs.push({ kind: 'pages', path, status: 200, type: 'text/html; charset=utf-8' })
    }
}
if (kinds.has('files')) {
    for (const [path, file] of Object.entries(map.files ?? {}).slice(0, limit)) {
        jobs.push({
            kind: 'files',
            path,
            status: 200,
            type:
                file.type === 'markdown'
                    ? 'text/markdown; charset=utf-8'
                    : 'text/plain; charset=utf-8'
        })
    }
}
if (kinds.has('variants')) {
    let count = 0
    for (const path of pages) {
        if (count >= Math.min(limit, 5000)) {
            break
        }
        // Small letters outside of the percent-encodings, and `%20` for `+`.
        const small = path.replace(/%[0-9A-F]{2}|[^%]+/gu, (part) =>
            part.startsWith('%') ? part : part.toLowerCase()
        )
        const spaces = path.replaceAll('+', '%20')
        const variant = count % 2 === 0 ? small : spaces
        if (variant !== path && !path.startsWith('/-/')) {
            jobs.push({ kind: 'variants', path: variant, status: 301, location: path })
            count += 1
        }
    }
}
if (kinds.has('wrong')) {
    const words = ['nettle', 'quince', 'trellis', 'mulch', 'cloche', 'dibber', 'loam', 'sorrel']
    for (let index = 0; index < Math.min(Number(values.wrong), limit); index += 1) {
        const first = words[next() % words.length] ?? ''
        const second = words[next() % words.length] ?? ''
        jobs.push({
            kind: 'wrong',
            path: `/zz-no-such-note-${String(index)}/${first}+${second}`,
            status: 404
        })
    }
}

// Mixed order, so that no kind comes in one block.
for (let index = jobs.length - 1; index > 0; index -= 1) {
    const other = next() % (index + 1)
    const job = jobs[index]
    const swap = jobs[other]
    if (job !== undefined && swap !== undefined) {
        jobs[index] = swap
        jobs[other] = job
    }
}

const counts = new Map<string, number>()
const failures: string[] = []
const times: number[] = []
let failed = 0
let bytes = 0

async function run(job: Job): Promise<void> {
    const started = performance.now()
    let finding: string | undefined
    try {
        const response = await fetch(`${base}${job.path}`, { redirect: 'manual' })
        const body = await response.arrayBuffer()
        bytes += body.byteLength
        times.push(performance.now() - started)
        const key = `${job.kind} ${String(response.status)}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        if (response.status !== job.status) {
            finding = `status ${String(response.status)}, expected ${String(job.status)}`
        } else if (
            job.location !== undefined &&
            response.headers.get('location') !== job.location
        ) {
            finding = `location ${response.headers.get('location') ?? 'none'}, expected ${job.location}`
        } else if (job.type !== undefined && response.headers.get('content-type') !== job.type) {
            finding = `type ${response.headers.get('content-type') ?? 'none'}, expected ${job.type}`
        } else if (job.status === 404 && response.headers.get('cache-control') !== 'no-store') {
            finding = `a 404 that a cache can keep: ${response.headers.get('cache-control') ?? 'none'}`
        }
    } catch (error) {
        const key = `${job.kind} no answer`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        finding = `no answer: ${error instanceof Error ? error.message : String(error)}`
    }
    if (finding !== undefined) {
        failed += 1
        if (failures.length < 30) {
            failures.push(`${job.kind} ${job.path}: ${finding}`)
        }
    }
}

const started = performance.now()
let cursor = 0
await Promise.all(
    Array.from({ length: Number(values.concurrency) }, async () => {
        for (;;) {
            const job = jobs[cursor]
            cursor += 1
            if (job === undefined) {
                return
            }
            await run(job)
        }
    })
)
const seconds = (performance.now() - started) / 1000
times.sort((a, b) => a - b)
const at = (part: number): number =>
    Math.round(times[Math.min(times.length - 1, Math.floor(times.length * part))] ?? 0)

process.stdout.write(
    JSON.stringify(
        {
            requests: jobs.length,
            seconds: Math.round(seconds),
            perSecond: Math.round(jobs.length / seconds),
            megabytes: Math.round(bytes / 1e6),
            counts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
            failed,
            milliseconds: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) },
            failures
        },
        null,
        2
    )
)
process.exitCode = failed === 0 ? 0 : 1
