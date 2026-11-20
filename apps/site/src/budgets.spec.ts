import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    brotliSize,
    checkNotePage,
    judgeTimes,
    notePageBudget,
    oversizedPages,
    PAGE_BUDGET,
    TIME_BUDGET,
    type TimeRun
} from './budgets.ts'

// The budgets of the default note page (PERF-20, PERF-22, R57), checked on a
// built page. Each check has a page that passes it and a page that fails it.

/** Text that Brotli cannot make much smaller: the decimals of a random walk. */
function noise(bytes: number, seed = 1): string {
    let state = seed
    let text = ''
    while (text.length < bytes) {
        state = (state * 1103515245 + 12345) % 2147483648
        text += state.toString(36)
    }
    return text.slice(0, bytes)
}

const FONT = '/_astro/noto-sans-latin-wght-normal.abc123.woff2'
const STYLE = '/_astro/page.abc123.css'

/** A page as the build writes it, with the parts that a test changes. */
function page(parts: { head?: string; body?: string } = {}): string {
    const head =
        parts.head ??
        `<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin>` +
            `<link rel="stylesheet" href="${STYLE}">`
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A note</title>' +
        `<script>document.documentElement.dataset.mode = 'dark'</script>${head}</head>` +
        `<body><main><h1>A note</h1><article data-note-body>${parts.body ?? '<p>Text.</p>'}</article></main></body></html>`
    )
}

/** The files of the site of a test, by their path. */
function files(extra: Record<string, Uint8Array> = {}): (path: string) => Promise<Uint8Array> {
    const all: Record<string, Uint8Array> = {
        [FONT]: new Uint8Array(35_820),
        [STYLE]: new TextEncoder().encode(`@font-face{src:url(${FONT})}body{color:red}`),
        ...extra
    }
    return (path) => {
        const bytes = all[path]
        return bytes === undefined
            ? Promise.reject(new Error(`no file ${path}`))
            : Promise.resolve(bytes)
    }
}

describe('the budget of the bytes of a note page', () => {
    test('a page in every budget passes', async () => {
        const result = await checkNotePage(page(), files())

        expect(result.failures).toEqual([])
        expect(result.measure.requests).toEqual(['the page', FONT, STYLE])
        expect(result.measure.fonts).toEqual([{ href: FONT, bytes: 35_820 }])
    })

    test('fails when the HTML is above its budget with Brotli', async () => {
        const body = `<p>${noise(PAGE_BUDGET.htmlBrotli * 2)}</p>`

        const result = await checkNotePage(page({ body }), files())

        expect(result.measure.html).toBeGreaterThan(PAGE_BUDGET.htmlBrotli)
        expect(result.failures).toEqual([
            `HTML: ${String(result.measure.html)} bytes with Brotli, the budget is 30000`
        ])
    })

    test('counts the HTML with Brotli, so a large page of repeated text passes', async () => {
        const body = `<p>${'The same sentence again. '.repeat(4_000)}</p>`

        expect((await checkNotePage(page({ body }), files())).failures).toEqual([])
    })

    test('fails with more than 50 backlinks in the HTML', async () => {
        const backlink = (index: number): string =>
            `<li data-backlink><a href="/n${String(index)}">Note ${String(index)}</a></li>`
        const fifty = Array.from({ length: 50 }, (_, index) => backlink(index)).join('')

        expect(
            (await checkNotePage(page({ body: `<ul>${fifty}</ul>` }), files())).failures
        ).toEqual([])
        expect(
            (await checkNotePage(page({ body: `<ul>${fifty}${backlink(50)}</ul>` }), files()))
                .failures
        ).toEqual(['backlinks: 51 in the HTML, the budget is 50'])
    })

    test('fails with a second style sheet, and with a style sheet above its budget', async () => {
        const second = '/_astro/more.css'
        const twoSheets = page({
            head:
                `<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin>` +
                `<link rel="stylesheet" href="${STYLE}"><link rel="stylesheet" href="${second}">`
        })

        const result = await checkNotePage(
            twoSheets,
            files({ [second]: new TextEncoder().encode('p{margin:0}') })
        )
        expect(result.failures).toContain('CSS: 2 files, the budget is 1')
        expect(result.failures).toContain(
            'requests before the page shows: 4 (the page, /_astro/noto-sans-latin-wght-normal.abc123.woff2, /_astro/page.abc123.css, /_astro/more.css), the budget is 3'
        )

        const large = await checkNotePage(
            page(),
            files({
                [STYLE]: new TextEncoder().encode(
                    `@font-face{src:url(${FONT})}/*${noise(PAGE_BUDGET.cssBrotli * 2)}*/`
                )
            })
        )
        expect(large.failures).toEqual([
            `CSS: ${String(large.measure.css)} bytes with Brotli, the budget is 12000`
        ])
    })

    test('counts a style element of the page in the CSS', async () => {
        const result = await checkNotePage(
            page({ body: `<style>/*${noise(PAGE_BUDGET.cssBrotli * 2)}*/</style>` }),
            files()
        )

        expect(result.failures).toContain(
            `CSS: ${String(result.measure.css)} bytes with Brotli, the budget is 12000`
        )
    })

    test('fails when the scripts of the page, inline and in files, are above their budget', async () => {
        const script = '/_astro/palette.js'
        const body = `<script type="module" src="${script}"></script><script>var a = "${noise(6_000, 2)}"</script>`

        const result = await checkNotePage(
            page({ body }),
            files({ [script]: new TextEncoder().encode(`var b = "${noise(12_000, 3)}"`) })
        )

        expect(result.measure.script).toBeGreaterThan(PAGE_BUDGET.scriptBrotli)
        expect(result.failures).toEqual([
            `script: ${String(result.measure.script)} bytes with Brotli, the budget is 10000`
        ])
    })

    test('fails without a preloaded font, with two, and with one above its budget', async () => {
        const other = '/_astro/noto-sans-latin-ext.woff2'
        const preload = (href: string): string =>
            `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`
        const sheet = `<link rel="stylesheet" href="${STYLE}">`

        expect((await checkNotePage(page({ head: sheet }), files())).failures).toEqual([
            'fonts: 0 preloaded font files, the budget is exactly 1'
        ])
        expect(
            (
                await checkNotePage(
                    page({ head: preload(FONT) + preload(other) + sheet }),
                    files({ [other]: new Uint8Array(10) })
                )
            ).failures
        ).toContain('fonts: 2 preloaded font files, the budget is exactly 1')
        expect(
            (
                await checkNotePage(
                    page(),
                    files({ [FONT]: new Uint8Array(PAGE_BUDGET.fontBytes + 1) })
                )
            ).failures
        ).toEqual([`fonts: ${FONT} has 40001 bytes, the budget is 40000`])
    })

    test('fails with a script file that stops the page, and with a request to another host', async () => {
        const blocking = '/_astro/old.js'
        const result = await checkNotePage(
            page({
                head:
                    `<link rel="preload" href="https://fonts.example.org/a.woff2" as="font" type="font/woff2" crossorigin>` +
                    `<link rel="stylesheet" href="${STYLE}"><script src="${blocking}"></script>`
            }),
            files({
                'https://fonts.example.org/a.woff2': new Uint8Array(10),
                [blocking]: new TextEncoder().encode('var a = 1')
            })
        )

        expect(result.failures).toContain(
            'requests before the page shows: 4 (the page, https://fonts.example.org/a.woff2, /_astro/page.abc123.css, /_astro/old.js), the budget is 3'
        )
        expect(result.failures).toContain(
            'files: https://fonts.example.org/a.woff2 is not on the host of the notes'
        )
    })

    test('a script with async, defer or of type module does not stop the page', async () => {
        const body =
            '<script async src="/a.js"></script><script defer src="/b.js"></script><script type="module" src="/c.js"></script>'
        const small = new TextEncoder().encode('var a = 1')

        const result = await checkNotePage(
            page({ body }),
            files({ '/a.js': small, '/b.js': small, '/c.js': small })
        )

        expect(result.failures).toEqual([])
    })
})

describe('the font and the style sheet of a note page', () => {
    const sheet = `<link rel="stylesheet" href="${STYLE}">`
    const css = (text: string): Record<string, Uint8Array> => ({
        [STYLE]: new TextEncoder().encode(text)
    })

    test('pass when the style sheet uses the preloaded font', async () => {
        const result = await checkNotePage(
            page(),
            files(css(`@font-face{src:url(${FONT}) format("woff2")}`))
        )

        expect(result.failures).toEqual([])
    })

    // Without crossorigin, or with another file, the browser downloads the font twice.
    test('fail when the preload of the font has no crossorigin', async () => {
        const head = `<link rel="preload" href="${FONT}" as="font" type="font/woff2">${sheet}`

        expect((await checkNotePage(page({ head }), files())).failures).toEqual([
            `fonts: the preload of ${FONT} has no crossorigin`
        ])
    })

    test('fail when the style sheet does not use the preloaded font', async () => {
        const result = await checkNotePage(
            page(),
            files(css('@font-face{src:url(/_astro/other.woff2) format("woff2")}'))
        )

        expect(result.failures).toEqual([
            `fonts: the style sheet does not use the preloaded font ${FONT}`
        ])
    })

    test('pass when a style element of the page uses the preloaded font', async () => {
        const result = await checkNotePage(
            page({ body: `<style>@font-face{src:url(${FONT})}</style>` }),
            files(css('body{color:red}'))
        )

        expect(result.failures).toEqual([])
    })

    test('compare the font without the query of its address', async () => {
        const head =
            `<link rel="preload" href="${FONT}?v=1" as="font" type="font/woff2" crossorigin>` +
            `<link rel="stylesheet" href="${STYLE}">`

        expect((await checkNotePage(page({ head }), files())).failures).toEqual([])
    })

    test('fail when the preload of the font sends credentials', async () => {
        const head =
            `<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin="use-credentials">` +
            `<link rel="stylesheet" href="${STYLE}">`

        expect((await checkNotePage(page({ head }), files())).failures).toEqual([
            `fonts: the preload of ${FONT} has no crossorigin`
        ])
    })

    test('fail when a style element imports another file', async () => {
        const result = await checkNotePage(
            page({ body: '<style>@import url("/_astro/more.css");</style>' }),
            files()
        )

        expect(result.failures).toEqual([
            'CSS: a style element imports another file, a request before the page shows'
        ])
    })

    test('fail when the style sheet imports another one', async () => {
        const result = await checkNotePage(
            page(),
            files(css(`@import url("/_astro/more.css");@font-face{src:url(${FONT})}`))
        )

        expect(result.failures).toEqual([
            `CSS: ${STYLE} imports another file, a request before the page shows`
        ])
    })

    test('reads a file without the query and the fragment of its address', async () => {
        const result = await checkNotePage(
            page({
                head:
                    `<link rel="preload" href="${FONT}?v=1" as="font" type="font/woff2" crossorigin>` +
                    `<link rel="stylesheet" href="${STYLE}#top">`
            }),
            files(css(`@font-face{src:url(${FONT}?v=1)}`))
        )

        expect(result.failures).toEqual([])
    })

    test('reads no file of another host', async () => {
        const result = await checkNotePage(
            page({
                head:
                    `<link rel="preload" href="https://fonts.example.org/a.woff2" as="font" type="font/woff2" crossorigin>` +
                    sheet
            }),
            files()
        )

        expect(result.failures).toContain(
            'files: https://fonts.example.org/a.woff2 is not on the host of the notes'
        )
    })
})

describe('the files of another host', () => {
    test('fail also when they do not stop the page, and are not counted as nothing', async () => {
        const body =
            '<script type="module" src="https://cdn.example.org/app.js"></script>' +
            '<script async src="_astro/relative.js"></script>' +
            '<link rel="stylesheet" href="https://cdn.example.org/late.css" media="print">'

        const result = await checkNotePage(page({ body }), files())

        expect(result.failures).toContain(
            'files: https://cdn.example.org/app.js is not on the host of the notes'
        )
        expect(result.failures).toContain(
            'files: _astro/relative.js is not on the host of the notes'
        )
        expect(result.failures).toContain(
            'files: https://cdn.example.org/late.css is not on the host of the notes'
        )
    })
})

describe('the script of a note page', () => {
    test('counts a script of an older JavaScript type', async () => {
        const body = `<script type="text/ecmascript">var a = "${noise(30_000, 5)}"</script>`

        const result = await checkNotePage(page({ body }), files())

        expect(result.failures.filter((line) => line.startsWith('script'))).toHaveLength(1)
    })

    test('does not count data in a script element, such as structured data', async () => {
        const body = `<script type="application/ld+json">{"name":"${noise(30_000, 4)}"}</script>`

        const result = await checkNotePage(page({ body }), files())

        expect(result.failures.filter((line) => line.startsWith('script'))).toEqual([])
    })
})

describe('the images of a note page (PERF-25)', () => {
    const image = (attributes: string): string =>
        `<img src="/i.png" alt="" width="4" height="3" ${attributes}>`

    test('pass when the first image loads at once with a high priority and the others lazily', async () => {
        const body =
            image('fetchpriority="high"') + image('loading="lazy"') + image('loading="lazy"')

        expect((await checkNotePage(page({ body }), files())).failures).toEqual([])
    })

    test('are counted, with the address of the first', async () => {
        const body = image('fetchpriority="high"') + image('loading="lazy"')

        expect((await checkNotePage(page({ body }), files())).measure.images).toEqual({
            count: 2,
            first: '/i.png'
        })
        expect((await checkNotePage(page(), files())).measure.images).toEqual({ count: 0 })
    })

    test('fail when the first image is lazy or has no high priority', async () => {
        expect(
            (
                await checkNotePage(
                    page({ body: image('loading="lazy" fetchpriority="high"') }),
                    files()
                )
            ).failures
        ).toEqual(['images: the first image is lazy'])
        expect((await checkNotePage(page({ body: image('') }), files())).failures).toEqual([
            'images: the first image has no high priority'
        ])
    })

    test('fail when another image is not lazy', async () => {
        const body = image('fetchpriority="high"') + image('')

        expect((await checkNotePage(page({ body }), files())).failures).toEqual([
            'images: image 2 is not lazy'
        ])
    })

    test('fail when an image has no width and no height', async () => {
        const body = '<img src="/i.png" alt="" fetchpriority="high">'

        expect((await checkNotePage(page({ body }), files())).failures).toEqual([
            'images: image 1 has no width and height'
        ])
    })
})

describe('the times of a note page in Lighthouse (R57)', () => {
    const run = (lcp: number, tbt = 0, cls = 0): TimeRun => ({ lcp, tbt, cls })
    const budget = TIME_BUDGET.mobile

    test('the median of five runs in the budget passes', () => {
        const runs = [run(900), run(1_500), run(1_000), run(1_300), run(800)]

        expect(judgeTimes(budget, runs)).toEqual({ verdict: 'pass', failures: [] })
    })

    test('a time above its budget gets a second median of five', () => {
        const runs = [run(1_300), run(1_250), run(1_000), run(1_400), run(800, 150)]

        expect(judgeTimes(budget, runs)).toEqual({
            verdict: 'again',
            failures: ['LCP: median 1250 ms, the budget is 1200 ms']
        })
    })

    test('a second median in the budget passes, and one above it fails', () => {
        const slow = [run(1_300), run(1_250), run(1_000), run(1_400), run(800)]
        const fast = [run(1_100), run(1_000), run(1_150), run(900), run(1_300)]
        const blocking = [
            run(1_000, 120),
            run(1_000, 130),
            run(1_000, 90),
            run(1_000, 200),
            run(1_000, 10)
        ]

        expect(judgeTimes(budget, slow, fast)).toEqual({ verdict: 'pass', failures: [] })
        expect(judgeTimes(budget, slow, blocking)).toEqual({
            verdict: 'fail',
            failures: ['TBT: median 120 ms, the budget is 100 ms']
        })
    })

    test('refuses a judgement with no run', () => {
        expect(() => judgeTimes(budget, [])).toThrow('no run')
        expect(() => judgeTimes(budget, [run(900, 0, 0.1)], [])).toThrow('no run')
    })

    test('a layout shift above its budget fails at once', () => {
        const runs = [
            run(900, 0, 0.18),
            run(900, 0, 0.18),
            run(900, 0, 0),
            run(900, 0, 0.1),
            run(900)
        ]

        expect(judgeTimes(budget, runs)).toEqual({
            verdict: 'fail',
            failures: ['CLS: median 0.1, the budget is 0.02']
        })
    })

    test('the budget of a media note and of the desktop', () => {
        expect(TIME_BUDGET.mobileMedia.lcp).toBe(2_200)
        expect(TIME_BUDGET.desktop).toEqual({ lcp: 800, tbt: 50, cls: 0.02 })
        expect(
            judgeTimes(TIME_BUDGET.mobileMedia, [run(2_050), run(2_100), run(1_950)]).verdict
        ).toBe('pass')
    })
})

describe('Brotli size', () => {
    test('is the size with the quality of the host (11)', () => {
        expect(brotliSize(new TextEncoder().encode('a'.repeat(10_000)))).toBeLessThan(30)
    })
})

// A real note can be larger than the budget (29 published notes have more than
// 100 KB of Markdown): the build names its page in a warning, and does not
// stop (R57).
describe('note pages above the HTML budget, after a build', () => {
    const SITE = fileURLToPath(new URL('..', import.meta.url))
    let dist: string | undefined

    afterEach(async () => {
        // Remove only a folder that this test made.
        if (dist !== undefined) {
            await rm(dist, { recursive: true, force: true })
            dist = undefined
        }
    })

    async function build(pages: Record<string, string>): Promise<string> {
        const cache = join(SITE, '.cache')
        await mkdir(cache, { recursive: true })
        dist = await mkdtemp(join(cache, 'budgets-spec-'))
        await mkdir(join(dist, '-', 'note'), { recursive: true })
        for (const [name, html] of Object.entries(pages)) {
            await Bun.write(join(dist, '-', 'note', name), html)
        }
        await Bun.write(join(dist, 'index.html'), `<p>${noise(PAGE_BUDGET.htmlBrotli * 2)}</p>`)
        return dist
    }

    const withCanonical = (path: string, body: string): string =>
        `<html><head><link rel="canonical" href="https://notes.dsebastien.net${path}"></head><body>${body}</body></html>`

    test('are named by their canonical URL, with their size with Brotli', async () => {
        const folder = await build({
            'aaaaaaaaaaaaaaaa.html': withCanonical(
                '/Big+note',
                `<p>${noise(PAGE_BUDGET.htmlBrotli * 2)}</p>`
            ),
            'bbbbbbbbbbbbbbbb.html': withCanonical('/Small+note', '<p>Small.</p>'),
            'cccccccccccccccc.html': withCanonical(
                '/Repeated',
                `<p>${'Same text. '.repeat(10_000)}</p>`
            )
        })

        const pages = await oversizedPages(folder)

        expect(pages.map((page) => page.page)).toEqual(['https://notes.dsebastien.net/Big+note'])
        expect(pages[0]?.bytes).toBeGreaterThan(PAGE_BUDGET.htmlBrotli)
    })

    test('are none when every note page is in the budget, and when the build has no note page', async () => {
        expect(
            await oversizedPages(await build({ 'a.html': withCanonical('/A', '<p>A.</p>') }))
        ).toEqual([])
        await rm(join(dist ?? '', '-'), { recursive: true })
        expect(await oversizedPages(dist ?? '')).toEqual([])
    })
})

describe('the warning of the build', () => {
    test('names each note page above the HTML budget, and does not stop the build', async () => {
        const SITE = fileURLToPath(new URL('..', import.meta.url))
        const cache = join(SITE, '.cache')
        await mkdir(cache, { recursive: true })
        const dist = await mkdtemp(join(cache, 'budgets-warning-spec-'))
        try {
            await Bun.write(
                join(dist, '-', 'note', 'aaaaaaaaaaaaaaaa.html'),
                `<link rel="canonical" href="https://notes.dsebastien.net/Big+note"><p>${noise(PAGE_BUDGET.htmlBrotli * 2)}</p>`
            )
            const warnings: string[] = []
            const hook = notePageBudget().hooks['astro:build:done']

            await hook?.({
                dir: new URL(`file://${dist}/`),
                logger: { warn: (text: string) => warnings.push(text) }
            } as unknown as Parameters<NonNullable<typeof hook>>[0])

            expect(warnings).toHaveLength(1)
            expect(warnings[0]).toMatch(
                /^the note page https:\/\/notes\.dsebastien\.net\/Big\+note has \d+ bytes of HTML with Brotli, above the budget of 30000 \(R57\)$/u
            )
        } finally {
            await rm(dist, { recursive: true, force: true })
        }
    })
})
