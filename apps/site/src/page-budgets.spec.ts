import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Element, Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
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
import { FRAME_IDS } from './rendering/anchors.ts'

// The budgets of the note page in CI (issue 47, PERF-20, PERF-22, R57): the
// tool publishes every note of a copy of the fixture vault, which holds a
// note of each note type, and the budget sample (a long note, a media note
// and a hub note at the 99th percentile of the published notes), the site is
// built, and every note page must pass the byte and request budgets. They
// give the same result at each run, so they block at once. The times of
// Lighthouse run in their own job (`scripts/page-budgets.ts`).
//
// The same build checks the ids of every page (issue 124): no page has two
// elements with one id, and the frame of a note page has only the ids of
// `FRAME_IDS`, which no id of a note takes, and each link and label of a note
// body leads to the element that the build meant (a footnote reference to its
// footnote, a back link to its reference, a label of a diagram into its
// diagram). A note of traps writes ids of the frame, repeated ids, and the ids
// that the build writes for a footnote and a diagram, in its raw HTML.
const SITE = fileURLToPath(new URL('..', import.meta.url))

let stores: TestStores | undefined
let outDir: string | undefined
let exitCode = -1
const checks = new Map<string, PageCheck>()
let sampleFiles: Record<string, string> = {}
/** The parsed pages of the build, by their path in the output folder. */
const pages = new Map<string, Root>()

/**
 * The note of traps of the ids (issue 124): ids of the frame, repeated ids,
 * and raw HTML with the ids that the build writes for a footnote and a
 * diagram, before them.
 */
const ID_TRAPS = '96 Id traps/Ids of the frame.md'
const ID_TRAPS_TEXT = [
    '# Content',
    '',
    '<p id="user-content-fn-1">Raw HTML with the id of a footnote.</p>',
    '',
    '<section data-footnotes><p id="content">Raw footnotes with the id of the main element.</p></section>',
    '',
    '<section data-footnotes><p id="user-content-fn-1">Raw footnotes with the id of a footnote.</p></section>',
    '',
    '<p id="user-content-fnref-1">Raw HTML with the id of a footnote reference.</p>',
    '',
    '<p id="footnote-label">Raw HTML with the id of the title of the footnotes.</p>',
    '',
    '<p id="diagram-1-title">Raw HTML with the id of the title of a diagram.</p>',
    '',
    'A text with a footnote.[^1]',
    '',
    '```mermaid',
    'graph TD',
    '  accTitle: Garden',
    '  A --> B',
    '```',
    '',
    'A block named as the main element. ^content',
    '',
    'A block with a repeated name. ^twice',
    '',
    'Another block with the same name. ^twice',
    '',
    '<div id="content">Raw HTML with the id of the main element.</div>',
    '',
    '<p id="notes">Raw HTML with an id.</p>',
    '',
    '<p id="notes">Raw HTML with the same id.</p>',
    '',
    '## Notes',
    '',
    '[^1]: The footnote.',
    ''
].join('\n')

/** Every element of a tree, with the elements above it. */
function* elementsOf(
    node: Root | Element,
    above: readonly Element[] = []
): Generator<{ element: Element; above: readonly Element[] }> {
    for (const child of node.children) {
        if (child.type !== 'element') continue
        yield { element: child, above }
        yield* elementsOf(child, [...above, child])
        if (child.content !== undefined) yield* elementsOf(child.content, [...above, child])
    }
}

/** The ids of a page that more than one element has. */
function repeatedIds(page: Root): string[] {
    const seen = new Set<string>()
    const repeated = new Set<string>()
    for (const { element } of elementsOf(page)) {
        const id = element.properties['id']
        if (typeof id !== 'string') continue
        if (seen.has(id)) repeated.add(id)
        seen.add(id)
    }
    return [...repeated]
}

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
    await mkdir(join(vault, '96 Id traps'), { recursive: true })
    await Bun.write(join(vault, ID_TRAPS), ID_TRAPS_TEXT)
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
    for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.html')) continue
        const file = join(entry.parentPath, entry.name)
        pages.set(relative(dist, file), fromHtml(await readFile(file, 'utf8')))
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

describe('ids of the built pages (issue 124)', () => {
    test('no page has two elements with one id', () => {
        const repeated = Object.fromEntries(
            [...pages]
                .map(([path, page]) => [path, repeatedIds(page)] as const)
                .filter(([, ids]) => ids.length > 0)
        )

        expect(pages.size).toBeGreaterThan(checks.size)
        expect(repeated).toEqual({})
    })

    test('the note of traps gives each id that it names to its first element, and a number to a repeat', () => {
        const page = pages.get(join('-', 'note', sampleFiles[ID_TRAPS] ?? ''))
        const ids = [...elementsOf(page ?? { type: 'root', children: [] })]
            .map(({ element }) => element.properties['id'])
            .filter((id) => typeof id === 'string')

        for (const id of [
            'content',
            'content-2',
            'content-3',
            '^content',
            '^twice',
            '^twice-2',
            'notes',
            'notes-2',
            'user-content-fn-1-2',
            'user-content-fnref-1-2',
            'footnote-label-2',
            'diagram-1-title-2',
            'content-4',
            'user-content-fn-1-3'
        ]) {
            expect(ids).toContain(id)
        }
        expect(ids.filter((id) => id === 'content')).toHaveLength(1)
    })

    test('each link and label of a note body leads to the element that the build meant', () => {
        const wrong: string[] = []
        const inFootnotes = (above: readonly Element[]): boolean =>
            above.some((node) => node.properties['dataFootnotes'] !== undefined)
        const figureOf = (above: readonly Element[]): Element | undefined =>
            above.findLast((node) => node.tagName === 'figure')
        for (const [path, page] of pages) {
            if (!path.startsWith(join('-', 'note'))) continue
            const byId = new Map<string, { element: Element; above: readonly Element[] }>()
            for (const found of elementsOf(page)) {
                const id = found.element.properties['id']
                if (typeof id === 'string') byId.set(id, found)
            }
            for (const { element, above } of elementsOf(page)) {
                if (!above.some((node) => node.properties['dataNoteBody'] !== undefined)) continue
                const href = element.properties['href']
                if (element.tagName === 'a' && typeof href === 'string' && href.startsWith('#')) {
                    // A footnote reference leads to its footnote, a back link to its reference.
                    const target = byId.get(decodeURIComponent(href.slice(1)))
                    const ok =
                        target !== undefined &&
                        (element.properties['dataFootnoteRef'] === undefined ||
                            (target.element.tagName === 'li' && inFootnotes(target.above))) &&
                        (element.properties['dataFootnoteBackref'] === undefined ||
                            target.element.properties['dataFootnoteRef'] !== undefined)
                    if (!ok) wrong.push(`${path}: ${href}`)
                }
                // A label of a diagram is in its diagram; a footnote reference is described by the footnotes.
                for (const name of ['ariaLabelledBy', 'ariaDescribedBy']) {
                    const value = element.properties[name]
                    const list = Array.isArray(value) ? value : value === undefined ? [] : [value]
                    for (const id of list.map(String)) {
                        const target = byId.get(id)
                        const ok =
                            target !== undefined &&
                            (element.properties['dataFootnoteRef'] === undefined
                                ? figureOf([...above, element]) === figureOf(target.above)
                                : inFootnotes([...target.above, target.element]))
                        if (!ok) wrong.push(`${path}: ${name} ${id}`)
                    }
                }
            }
        }

        expect(wrong).toEqual([])
    })

    // `FRAME_IDS` is one set for every page; this check reads the note pages
    // only, the one kind of page that shows the text of a note.
    test('the frame of every note page has only the ids of FRAME_IDS, which no id of a note takes', () => {
        const outside = new Set<string>()
        for (const [path, page] of pages) {
            if (!path.startsWith(join('-', 'note'))) continue
            for (const { element, above } of elementsOf(page)) {
                const id = element.properties['id']
                const inNote =
                    element.properties['dataNoteTitle'] !== undefined ||
                    [element, ...above].some(
                        (node) => node.properties['dataNoteBody'] !== undefined
                    )
                if (typeof id === 'string' && !inNote) outside.add(id)
            }
        }

        expect(outside.size).toBeGreaterThan(0)
        expect([...outside].filter((id) => !FRAME_IDS.has(id))).toEqual([])
    })
})
