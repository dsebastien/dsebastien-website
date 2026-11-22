import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    FIXTURE_NOTE_TYPES,
    BUDGET_SAMPLE,
    BUDGET_SAMPLE_BACKLINKS,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    writeBudgetSample,
    type TestStores
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../../plugin/src/publishing/tool.ts'
import { checkNotePage, PAGE_BUDGET, type PageCheck } from './budgets.ts'

// The budgets of the note page in CI (issue 47, PERF-20, PERF-22, R57): the
// tool publishes every note of a copy of the fixture vault, which holds a
// note of each note type, and the budget sample (a long note, a media note
// and a hub note at the 99th percentile of the published notes), the site is
// built, and every note page must pass the byte and request budgets. They
// give the same result at each run, so they block at once. The times of
// Lighthouse run in their own job (`scripts/page-budgets.ts`).
const SITE = fileURLToPath(new URL('..', import.meta.url))

let stores: TestStores | undefined
let outDir: string | undefined
let exitCode = -1
const checks = new Map<string, PageCheck>()
let sampleFiles: Record<string, string> = {}

beforeAll(async () => {
    stores = await makeTestStores()
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
        device: 'garden-shed',
        face: 'command-line'
    })
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'page-budgets-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    exitCode = await child.exited
    if (exitCode !== 0) return
    const dist = outDir
    const read = async (address: string): Promise<Uint8Array> =>
        new Uint8Array(await readFile(join(dist, decodeURIComponent(address))))
    for (const name of await readdir(join(dist, '-', 'note'))) {
        const html = await readFile(join(dist, '-', 'note', name), 'utf8')
        checks.set(name, await checkNotePage(html, read))
    }
    const manifest = join(contentStore, 'manifest')
    for (const name of await readdir(manifest)) {
        const entry = JSON.parse(await readFile(join(manifest, name), 'utf8')) as {
            id: string
            path: string
        }
        sampleFiles = { ...sampleFiles, [entry.path]: `${entry.id}.html` }
    }
}, 300_000)

afterAll(async () => {
    // Remove only the folders that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

describe('budgets of the note page', () => {
    test('the build completes', () => {
        expect(exitCode).toBe(0)
    })

    test('every note page passes its byte and request budgets', () => {
        const failures = Object.fromEntries(
            [...checks]
                .filter(([, check]) => check.failures.length > 0)
                .map(([name, check]) => [name, check.failures])
        )

        expect(checks.size).toBeGreaterThan(500)
        expect(failures).toEqual({})
    })

    test('the pages of the sample are measured: a long note, a media note with its cover first, a hub note', () => {
        const long = checks.get(sampleFiles[BUDGET_SAMPLE.long] ?? '')
        const media = checks.get(sampleFiles[BUDGET_SAMPLE.media] ?? '')
        const hub = checks.get(sampleFiles[BUDGET_SAMPLE.hub] ?? '')

        expect(long?.measure.html).toBeGreaterThan(5_000)
        expect(long?.measure.requests).toHaveLength(3)
        // The images are on the pages, so the check of the first image is not empty.
        expect(long?.measure.images.count).toBe(4)
        expect(long?.measure.images.first).toEndWith('/long-1.png')
        expect(media?.measure.images.count).toBe(4)
        expect(media?.measure.images.first).toEndWith('/cover.png')
        expect(hub?.measure.html).toBeGreaterThan(0)
    })

    // PAGE-03, PERF-20, PERF-26 (issue 48): the page of a note with very many
    // backlinks holds the number of its budget, and a page of its own holds
    // them all, so the large link data is not in the HTML of the note page.
    test('the hub note holds the backlinks of its budget, and a page of its own holds them all', async () => {
        const file = sampleFiles[BUDGET_SAMPLE.hub] ?? ''
        const id = file.replace(/\.html$/u, '')
        const dist = outDir ?? ''
        const count = (html: string): number =>
            html.match(/<li\b[^>]*\sdata-backlink\b/gu)?.length ?? 0

        expect(checks.get(file)?.measure.backlinks).toBe(PAGE_BUDGET.backlinks)
        const page = await readFile(join(dist, '-', 'note', file), 'utf8')
        expect(count(page)).toBe(50)
        expect(page).toContain(
            `Notes that link here <span class="ml-1">${String(BUDGET_SAMPLE_BACKLINKS)}</span>`
        )
        expect(page).toMatch(
            new RegExp(
                `<a class="link" href="/-/backlinks/${id}"[^>]*>\\s*All ${String(BUDGET_SAMPLE_BACKLINKS)} notes that link here\\s*</a>`,
                'u'
            )
        )

        // Only the hub note has more backlinks than a note page holds.
        expect(await readdir(join(dist, '-', 'backlinks'))).toEqual([file])
        const all = await readFile(join(dist, '-', 'backlinks', file), 'utf8')
        expect(count(all)).toBe(BUDGET_SAMPLE_BACKLINKS)
        expect(all).toContain('<meta name="robots" content="noindex, follow">')
        expect(all).not.toContain('rel="canonical"')
        expect(all).toMatch(
            /<a class="link" href="\/95\+Budget\+sample\/Hub\+note"[^>]*>Hub note<\/a>/u
        )
        const map = JSON.parse(await readFile(join(dist, '-', 'resolver-map.json'), 'utf8')) as {
            pages: Record<string, string>
        }
        expect(map.pages[`/-/backlinks/${id}`]).toBe(`-/backlinks/${file}`)
    })
})
