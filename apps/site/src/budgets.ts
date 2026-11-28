import { hasVariants, VARIANT_WIDTHS } from '@dsebastien-website/resolver'
import type { AstroIntegration } from 'astro'
import type { Element, Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toText } from 'hast-util-to-text'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'
import type { AnalyticsSettings } from './analytics/analytics.ts'

// The budgets of the default note page (PERF-20 to PERF-25, R57,
// `documentation/research/2026-11-20-note-page-budgets.md`). A KB of the
// budgets is 1,000 bytes. Text is counted with Brotli at quality 11, as the
// host sends it.
//
// The bytes and the requests give the same result at each run: they block at
// once. The times of Lighthouse vary with the machine: a time above its budget
// gets a second median of five runs, and blocks only when it fails again. A
// layout shift always blocks (R57).

/** The byte and request budgets of the default note page. */
export const PAGE_BUDGET = {
    /** The HTML of the page, with Brotli. */
    htmlBrotli: 30_000,
    /** The backlinks in the HTML (elements marked `data-backlink`); the rest are on their own page. */
    backlinks: 50,
    /** The style sheet files of the page. */
    stylesheets: 1,
    /** The CSS of the page, files and style elements, with Brotli. */
    cssBrotli: 12_000,
    /** The script that loads with the page, inline and in files, with Brotli. */
    scriptBrotli: 10_000,
    /** The bytes of the one preloaded font file (WOFF2 is compressed already). */
    fontBytes: 40_000,
    /** The requests before the page shows: the page, its style sheet, its font. */
    requests: 3
} as const

/**
 * The size with Brotli of the script of the analytics (`script.manual.js` of
 * the proxy, AN-01), measured on 2026-11-26: 989 bytes, with a margin. The check
 * counts it in the script of a page that loads it, as the test cannot read a
 * file of another host. Measure it again when the script of the proxy changes.
 */
export const ANALYTICS_SCRIPT_BROTLI = 1_100

/**
 * The budget of the first search of a reader (R57, PERF-21): what the title
 * index and the full-text index load for one query, with Brotli where the
 * host compresses a file. A page loads nothing of the search before it.
 */
export const FIRST_SEARCH_BROTLI = 350_000

/**
 * The budget of the first opening of the command palette (issue 122, R93):
 * its code and its style, with Brotli. A page loads only its loader before;
 * the title index and the full text come after, in the budget of the first
 * search.
 */
export const FIRST_PALETTE_BROTLI = 10_000

/**
 * The budget of the music of a note page (R57, PERF-21, issue 53), loaded
 * after the page shows and only on a page with a music block (REN-07): the
 * diagram part of the library (its code and its style sheet), with Brotli;
 * the tab part on top of it (alphaTab and the tab code of the library), with
 * Brotli; and the music font of alphaTab, a WOFF2 file that only a tab or a
 * score loads (R105: the budget of 2026-11-20 counted the scripts only). The
 * sounds come at the first Play, apart from these.
 */
export const MUSIC_BUDGET = {
    diagramsBrotli: 160_000,
    tabsBrotli: 300_000,
    musicFontBytes: 320_000
} as const

/** A budget of the times of Lighthouse, for one preset. */
export interface TimeBudget {
    /** Largest Contentful Paint, in milliseconds. */
    lcp: number
    /** Total Blocking Time, in milliseconds. */
    tbt: number
    /** Cumulative Layout Shift. */
    cls: number
}

/** The time budgets of the default note page, for the median of five Lighthouse runs. */
export const TIME_BUDGET = {
    mobile: { lcp: 1_200, tbt: 100, cls: 0.02 },
    /**
     * A media note: its cover is the largest paint. 2.0 s (R57), with the
     * variants of the cover in WebP (PERF-25, issue 87, R92; 2.2 s before, R58).
     */
    mobileMedia: { lcp: 2_000, tbt: 100, cls: 0.02 },
    /**
     * A note with music blocks: the drawing of a chord chart in the library
     * blocks the main thread for 38 to 121 ms from one run to the next. 150 ms
     * (R105, decision of the author, 2026-11-28) until the library draws faster.
     */
    mobileMusic: { lcp: 1_200, tbt: 150, cls: 0.02 },
    desktop: { lcp: 800, tbt: 50, cls: 0.02 }
} as const satisfies Record<string, TimeBudget>

/** What the check measured on a page. */
export interface PageMeasure {
    /** The bytes of the HTML with Brotli. */
    html: number
    backlinks: number
    stylesheets: number
    /** The bytes of the CSS with Brotli. */
    css: number
    /** The bytes of the script with Brotli. */
    script: number
    /** The preloaded font files. */
    fonts: { href: string; bytes: number }[]
    /** The requests before the page shows, in the order of the page. */
    requests: string[]
    /** The images of the page, and the address of the first. */
    images: { count: number; first?: string }
}

/** The result of the check of a page. */
export interface PageCheck {
    measure: PageMeasure
    /** One line per budget that the page breaks. Empty when the page passes. */
    failures: string[]
}

/** The size of these bytes with Brotli at quality 11. */
export function brotliSize(bytes: Uint8Array): number {
    return brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
    }).byteLength
}

const encoder = new TextEncoder()

/**
 * Checks a built note page against its byte and request budgets, and its
 * images against PERF-25. `read` gives the bytes of a file of the page by its
 * address (a style sheet, a script, a font).
 */
export async function checkNotePage(
    html: string,
    read: (address: string) => Promise<Uint8Array>,
    options: { readonly analytics?: AnalyticsSettings } = {}
): Promise<PageCheck> {
    const elements = elementsOf(fromHtml(html))
    const failures: string[] = []
    // The script of the analytics is the one file of another host that a page
    // may load (the proxy of the author, AN-01): it counts with its measured size.
    const analyticsScript = options.analytics?.script
    const allowed = (address: string): boolean => onHost(address) || address === analyticsScript
    // A file of another host is not read: it fails on its own (see below).
    const readFile = (address: string): Promise<Uint8Array> =>
        onHost(address) ? read(withoutQuery(address)) : Promise.resolve(new Uint8Array(0))

    const sheets = elements.filter((element) => relOf(element).includes('stylesheet'))
    const styleTexts = elements
        .filter((element) => element.tagName === 'style')
        .map((element) => toText(element))
    const sheetBytes = await Promise.all(sheets.map((sheet) => readFile(hrefOf(sheet))))
    const sheetTexts = sheetBytes.map((bytes) => new TextDecoder().decode(bytes))
    const css =
        sheetBytes.reduce((total, bytes) => total + brotliSize(bytes), 0) +
        (styleTexts.length === 0 ? 0 : brotliSize(encoder.encode(styleTexts.join('\n'))))

    // Only a script that runs counts: data in a script element (structured
    // data) is part of the HTML.
    const scripts = elements.filter(
        (element) => element.tagName === 'script' && RUNS.test(typeOf(element).trim())
    )
    const inline = scripts
        .filter((script) => typeof script.properties['src'] !== 'string')
        .map((script) => toText(script))
    const sources = scripts
        .map((script) => script.properties['src'])
        .filter((src) => typeof src === 'string')
    const scriptFiles = await Promise.all(
        sources.filter((src) => src !== analyticsScript).map((src) => readFile(src))
    )
    const script =
        (inline.length === 0 ? 0 : brotliSize(encoder.encode(inline.join('\n')))) +
        scriptFiles.reduce((total, bytes) => total + brotliSize(bytes), 0) +
        (sources.some((src) => src === analyticsScript) ? ANALYTICS_SCRIPT_BROTLI : 0)

    const fontLinks = elements.filter(
        (element) => relOf(element).includes('preload') && element.properties['as'] === 'font'
    )
    const fonts = await Promise.all(
        fontLinks.map(async (link) => ({
            href: hrefOf(link),
            bytes: (await readFile(hrefOf(link))).byteLength,
            // An anonymous request, as the style sheet makes it for a font.
            crossOrigin:
                typeof link.properties['crossOrigin'] === 'string' &&
                ANONYMOUS.test(link.properties['crossOrigin'])
        }))
    )

    // Before the page shows: the page, each preload, each style sheet, and each
    // script file that the browser runs before it goes on (no `async`, no
    // `defer`, not a module).
    const blocking = elements.filter(
        (element) =>
            relOf(element).includes('preload') ||
            relOf(element).includes('stylesheet') ||
            (element.tagName === 'script' &&
                typeof element.properties['src'] === 'string' &&
                element.properties['async'] === undefined &&
                element.properties['defer'] === undefined &&
                element.properties['type'] !== 'module')
    )
    const requests = [
        'the page',
        ...blocking.map((element) =>
            element.tagName === 'script' ? String(element.properties['src']) : hrefOf(element)
        )
    ]

    const measure: PageMeasure = {
        html: brotliSize(encoder.encode(html)),
        backlinks: elements.filter((element) => element.properties['dataBacklink'] !== undefined)
            .length,
        stylesheets: sheets.length,
        css,
        script,
        fonts: fonts.map(({ href, bytes }) => ({ href, bytes })),
        requests,
        images: imagesOf(elements)
    }

    if (measure.html > PAGE_BUDGET.htmlBrotli) {
        failures.push(
            `HTML: ${String(measure.html)} bytes with Brotli, the budget is ${String(PAGE_BUDGET.htmlBrotli)}`
        )
    }
    if (measure.backlinks > PAGE_BUDGET.backlinks) {
        failures.push(
            `backlinks: ${String(measure.backlinks)} in the HTML, the budget is ${String(PAGE_BUDGET.backlinks)}`
        )
    }
    if (measure.stylesheets > PAGE_BUDGET.stylesheets) {
        failures.push(
            `CSS: ${String(measure.stylesheets)} files, the budget is ${String(PAGE_BUDGET.stylesheets)}`
        )
    }
    if (measure.css > PAGE_BUDGET.cssBrotli) {
        failures.push(
            `CSS: ${String(measure.css)} bytes with Brotli, the budget is ${String(PAGE_BUDGET.cssBrotli)}`
        )
    }
    if (measure.script > PAGE_BUDGET.scriptBrotli) {
        failures.push(
            `script: ${String(measure.script)} bytes with Brotli, the budget is ${String(PAGE_BUDGET.scriptBrotli)}`
        )
    }
    if (fonts.length !== 1) {
        failures.push(
            `fonts: ${String(fonts.length)} preloaded font files, the budget is exactly 1`
        )
    }
    sheets.forEach((sheet, index) => {
        if (/@import\b/iu.test(sheetTexts[index] ?? '')) {
            failures.push(
                `CSS: ${hrefOf(sheet)} imports another file, a request before the page shows`
            )
        }
    })
    if (styleTexts.some((text) => /@import\b/iu.test(text))) {
        failures.push('CSS: a style element imports another file, a request before the page shows')
    }
    const cssTexts = [...sheetTexts, ...styleTexts]
    for (const font of fonts) {
        // Without crossorigin, or when the style sheet uses another file, the
        // browser downloads the font a second time.
        if (!font.crossOrigin) {
            failures.push(`fonts: the preload of ${font.href} has no crossorigin`)
        }
        if (onHost(font.href) && !cssTexts.some((text) => text.includes(withoutQuery(font.href)))) {
            failures.push(`fonts: the style sheet does not use the preloaded font ${font.href}`)
        }
        if (font.bytes > PAGE_BUDGET.fontBytes) {
            failures.push(
                `fonts: ${font.href} has ${String(font.bytes)} bytes, the budget is ${String(PAGE_BUDGET.fontBytes)}`
            )
        }
    }
    if (requests.length > PAGE_BUDGET.requests) {
        failures.push(
            `requests before the page shows: ${String(requests.length)} (${requests.join(', ')}), the budget is ${String(PAGE_BUDGET.requests)}`
        )
    }
    // Every file of the page is on the host of the notes, also one that does
    // not stop the page: a file of another host is not measured.
    const addresses = new Set([
        ...sheets.map(hrefOf),
        ...fontLinks.map(hrefOf),
        ...elements.filter((element) => relOf(element).includes('preload')).map(hrefOf),
        ...scripts
            .map((script) => script.properties['src'])
            .filter((src) => typeof src === 'string')
    ])
    for (const address of addresses) {
        if (!allowed(address)) {
            failures.push(`files: ${address} is not on the host of the notes`)
        }
    }
    failures.push(...imageFailures(elements.filter((element) => element.tagName === 'img')))
    return { measure, failures }
}

/**
 * The types of a script element that the browser runs (the JavaScript MIME
 * types of the HTML standard, and `module`). Any other type is a data block.
 */
const RUNS =
    /^(?:|module|(?:application|text)\/(?:x-)?(?:ecmascript|javascript)|text\/javascript1\.[0-5]|text\/(?:jscript|livescript))$/iu

/** The value of `crossorigin` of an anonymous request. */
const ANONYMOUS = /^(?:|anonymous)$/iu

/** The address without its query and its fragment. */
function withoutQuery(address: string): string {
    return address.replace(/[?#].*$/su, '')
}

/** True when the address is a path of the host of the notes. */
function onHost(address: string): boolean {
    return address.startsWith('/') && !address.startsWith('//')
}

/** The type attribute of an element, or an empty text. */
function typeOf(element: Element): string {
    const type = element.properties['type']
    return typeof type === 'string' ? type : ''
}

function imagesOf(elements: readonly Element[]): PageMeasure['images'] {
    const images = elements.filter((element) => element.tagName === 'img')
    const first = images[0]?.properties['src']
    return typeof first === 'string' ? { count: images.length, first } : { count: images.length }
}

/** The first image loads at once with a high priority, the others lazily, and each has its size (PERF-25). */
function imageFailures(images: readonly Element[]): string[] {
    const failures: string[] = []
    images.forEach((image, index) => {
        const lazy = image.properties['loading'] === 'lazy'
        if (index === 0) {
            if (lazy) failures.push('images: the first image is lazy')
            if (image.properties['fetchPriority'] !== 'high') {
                failures.push('images: the first image has no high priority')
            }
        } else if (!lazy) {
            failures.push(`images: image ${String(index + 1)} is not lazy`)
        }
        if (image.properties['width'] === undefined || image.properties['height'] === undefined) {
            failures.push(`images: image ${String(index + 1)} has no width and height`)
        }
        failures.push(...variantFailures(image, index + 1))
    })
    return failures
}

/**
 * An image of a note that is wider than the smallest variant comes with its
 * variants in `srcset` and its size on the page in `sizes`, each a WebP of
 * the host of the notes (issue 87, PERF-25).
 */
function variantFailures(image: Element, number: number): string[] {
    const failures: string[] = []
    const src = image.properties['src']
    const srcset = image.properties['srcSet']
    const candidates = (
        Array.isArray(srcset) ? srcset.join(', ') : typeof srcset === 'string' ? srcset : ''
    )
        .split(',')
        .map((candidate) => candidate.trim().split(/\s+/u)[0] ?? '')
        .filter((address) => address !== '')
    if (candidates.length === 0) {
        const width = Number(image.properties['width'])
        if (
            typeof src === 'string' &&
            src.startsWith('/-/attachments/') &&
            hasVariants(withoutQuery(src)) &&
            width > VARIANT_WIDTHS[0]
        ) {
            failures.push(`images: image ${String(number)} has no variants in srcset`)
        }
        return failures
    }
    if (image.properties['sizes'] === undefined) {
        failures.push(`images: image ${String(number)} has a srcset and no sizes`)
    }
    for (const address of candidates) {
        if (!onHost(address)) {
            failures.push(
                `images: image ${String(number)} has a variant on another host: ${address}`
            )
        } else if (!withoutQuery(address).toLowerCase().endsWith('.webp')) {
            failures.push(
                `images: image ${String(number)} has a variant that is not a WebP: ${address}`
            )
        }
    }
    return failures
}

/** Every element of the tree, in the order of the document, outside templates. */
function elementsOf(tree: Root): Element[] {
    const found: Element[] = []
    const visit = (nodes: readonly RootContent[]): void => {
        for (const node of nodes) {
            if (node.type !== 'element') continue
            found.push(node)
            visit(node.children)
        }
    }
    visit(tree.children)
    return found
}

function relOf(element: Element): string[] {
    const rel = element.properties['rel']
    return element.tagName === 'link' && Array.isArray(rel) ? rel.map(String) : []
}

function hrefOf(element: Element): string {
    const href = element.properties['href']
    return typeof href === 'string' ? href : ''
}

/** A note page of a build above the HTML budget. */
export interface OversizedPage {
    /** The canonical URL of the page, or the name of its file when it has none. */
    page: string
    /** The bytes of its HTML with Brotli. */
    bytes: number
}

/**
 * The note pages of a build whose HTML is above its budget with Brotli. A real
 * note can be larger than the budget: the build names it in a warning and
 * goes on (R57). Only a page of more raw bytes than the budget is compressed.
 */
export async function oversizedPages(dist: string): Promise<OversizedPage[]> {
    const folder = join(dist, '-', 'note')
    let names: string[]
    try {
        names = await readdir(folder)
    } catch {
        return []
    }
    const pages: OversizedPage[] = []
    for (const name of names.filter((file) => file.endsWith('.html')).sort()) {
        const bytes = new Uint8Array(await readFile(join(folder, name)))
        if (bytes.byteLength <= PAGE_BUDGET.htmlBrotli) continue
        const size = brotliSize(bytes)
        if (size <= PAGE_BUDGET.htmlBrotli) continue
        const canonical = /<link rel="canonical" href="([^"]+)"/u.exec(
            new TextDecoder().decode(bytes)
        )?.[1]
        pages.push({ page: canonical ?? name, bytes: size })
    }
    return pages
}

/** The integration that warns, after a build, about each note page above the HTML budget (R57). */
export function notePageBudget(): AstroIntegration {
    return {
        name: 'note-page-budget',
        hooks: {
            'astro:build:done': async ({ dir, logger }) => {
                for (const page of await oversizedPages(fileURLToPath(dir))) {
                    logger.warn(
                        `the note page ${page.page} has ${String(page.bytes)} bytes of HTML with Brotli, above the budget of ${String(PAGE_BUDGET.htmlBrotli)} (R57)`
                    )
                }
            }
        }
    }
}

/** One run of Lighthouse, as the budgets read it. */
export interface TimeRun {
    /** Largest Contentful Paint, in milliseconds. */
    lcp: number
    /** Total Blocking Time, in milliseconds. */
    tbt: number
    /** Cumulative Layout Shift. */
    cls: number
}

/** The verdict on the times of a page. */
export interface TimeVerdict {
    /** `again`: a time is above its budget, run five more and judge their median. */
    verdict: 'pass' | 'again' | 'fail'
    failures: string[]
}

/**
 * Judges the times of a page (R57): the median of the first runs, and of the
 * second runs when the first median of a time failed. A layout shift above
 * its budget fails at once.
 */
export function judgeTimes(
    budget: TimeBudget,
    first: readonly TimeRun[],
    second?: readonly TimeRun[]
): TimeVerdict {
    if (first.length === 0 || second?.length === 0) {
        throw new Error('the times of a page cannot be judged with no run')
    }
    const cls = median(first.map((run) => run.cls))
    if (cls > budget.cls) {
        return {
            verdict: 'fail',
            failures: [`CLS: median ${String(cls)}, the budget is ${String(budget.cls)}`]
        }
    }
    const times = (runs: readonly TimeRun[]): string[] => {
        const failures: string[] = []
        const lcp = median(runs.map((run) => run.lcp))
        const tbt = median(runs.map((run) => run.tbt))
        if (lcp > budget.lcp) {
            failures.push(
                `LCP: median ${String(Math.round(lcp))} ms, the budget is ${String(budget.lcp)} ms`
            )
        }
        if (tbt > budget.tbt) {
            failures.push(
                `TBT: median ${String(Math.round(tbt))} ms, the budget is ${String(budget.tbt)} ms`
            )
        }
        return failures
    }
    const firstFailures = times(first)
    if (firstFailures.length === 0) {
        return { verdict: 'pass', failures: [] }
    }
    if (second === undefined) {
        return { verdict: 'again', failures: firstFailures }
    }
    const secondCls = median(second.map((run) => run.cls))
    const secondFailures = [
        ...(secondCls > budget.cls
            ? [`CLS: median ${String(secondCls)}, the budget is ${String(budget.cls)}`]
            : []),
        ...times(second)
    ]
    return secondFailures.length === 0
        ? { verdict: 'pass', failures: [] }
        : { verdict: 'fail', failures: secondFailures }
}

/** The median of the values. */
function median(values: readonly number[]): number {
    const sorted = [...values].sort((one, two) => one - two)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1
        ? (sorted[middle] ?? Number.NaN)
        : ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2
}

/**
 * The budget of the first request of a new instance of the Worker of the host
 * (issue 121, PERF-29, decision of the author R94): the resolver map adds at
 * most `added` milliseconds at the 95th percentile to the time to the first
 * byte of the first request of a new instance, against a Worker with no map
 * (the floor) measured in the same run, from the same client, with a new
 * connection per request. The host and the network are in both times, so the
 * difference is what the map costs. Fewer first requests than `requests` on
 * either side give no verdict.
 */
export const FIRST_REQUEST_BUDGET = { percentile: 95, added: 60, requests: 20 } as const

/** The times of the first requests of one side, in milliseconds (nearest rank). */
export interface FirstRequestTimes {
    count: number
    p50: number
    p95: number
    max: number
}

/** The verdict on the first requests of new instances of a host, against the floor. */
export interface FirstRequestVerdict {
    /** `too few`: fewer first requests than the budget needs on one side. */
    verdict: 'pass' | 'fail' | 'too few'
    host: FirstRequestTimes
    floor: FirstRequestTimes
    /** What the map adds at the 95th percentile, in milliseconds: the host less the floor. */
    added: number
    failures: string[]
}

/** The value at a percentile of sorted values, by the nearest rank. */
export function percentileOf(sorted: readonly number[], percentile: number): number {
    const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length))
    return sorted[rank - 1] ?? Number.NaN
}

/** The times of some first requests, in milliseconds. */
export function firstRequestTimes(times: readonly number[]): FirstRequestTimes {
    const sorted = [...times].sort((one, two) => one - two)
    return {
        count: sorted.length,
        p50: percentileOf(sorted, 50),
        p95: percentileOf(sorted, FIRST_REQUEST_BUDGET.percentile),
        max: sorted.at(-1) ?? Number.NaN
    }
}

/**
 * Judges the times to the first byte of first requests of new instances of a
 * host against those of the floor, in milliseconds (`FIRST_REQUEST_BUDGET`).
 */
export function judgeFirstRequests(
    host: readonly number[],
    floor: readonly number[]
): FirstRequestVerdict {
    const facts = { host: firstRequestTimes(host), floor: firstRequestTimes(floor) }
    const added = Math.round((facts.host.p95 - facts.floor.p95) * 1000) / 1000
    const few = (
        [
            ['the host', facts.host.count],
            ['the floor', facts.floor.count]
        ] as const
    ).filter(([, count]) => count < FIRST_REQUEST_BUDGET.requests)
    if (few.length > 0) {
        return {
            verdict: 'too few',
            ...facts,
            added,
            failures: few.map(
                ([side, count]) =>
                    `${String(count)} first requests of an instance on ${side}, the budget needs ${String(FIRST_REQUEST_BUDGET.requests)}`
            )
        }
    }
    const round = (value: number): string => String(Math.round(value))
    return added > FIRST_REQUEST_BUDGET.added
        ? {
              verdict: 'fail',
              ...facts,
              added,
              failures: [
                  `first request of an instance: the map adds ${round(added)} ms at p95 (${round(facts.host.p95)} ms against ${round(facts.floor.p95)} ms with no map), the budget is ${String(FIRST_REQUEST_BUDGET.added)} ms`
              ]
          }
        : { verdict: 'pass', ...facts, added, failures: [] }
}
