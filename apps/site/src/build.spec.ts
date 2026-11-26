import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { BAR_MEDIA, modeScript, modeSwitchScript } from './mode.ts'
import { BAR_COLORS } from './styles/themes/knowii-bar.ts'

// Acceptance criterion of issue 16: an empty Astro and Tailwind site builds.
// The test runs the build script of the site and reads the files of the output.
const SITE = fileURLToPath(new URL('..', import.meta.url))

let outDir: string | undefined
let exitCode = -1

function outputPath(): string {
    if (outDir === undefined) {
        throw new Error('the output folder does not exist')
    }
    return outDir
}

async function readOutput(path: string): Promise<string> {
    return await Bun.file(join(outputPath(), path)).text()
}

async function readStylesheets(): Promise<string> {
    const files = await readdir(outputPath(), { recursive: true })
    const sheets = files.filter((file) => file.endsWith('.css'))
    const texts = await Promise.all(sheets.map((sheet) => readOutput(sheet)))
    return texts.join('\n')
}

beforeAll(async () => {
    // The output folder is inside the site, in a folder that git ignores: Astro
    // moves files into it, and a move to another file system fails.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'build-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        stdout: 'ignore',
        stderr: 'ignore'
    })
    exitCode = await child.exited
}, 180_000)

afterAll(async () => {
    // Remove only a folder that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
})

/** Every script of a page, as its text. A script with an attribute or a source is given whole, so that it never equals a script of the mode. */
function scriptsOf(html: string): string[] {
    return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)].map(
        ([whole, attributes = '', text = '']) => (attributes.trim() === '' ? text : whole)
    )
}

/** The loader of the command palette of the header (issue 122): a module file, deferred. */
const PALETTE_LOADER = /^<script type="module" src="\/_astro\/PaletteLoader[^"]*\.js"><\/script>$/u

/** The text of each class attribute of a page, cut in classes. */
function classesOf(html: string): Set<string> {
    return new Set(
        [...html.matchAll(/\sclass="([^"]*)"/gu)]
            .flatMap(([, list = '']) => list.split(/\s+/u))
            .filter((name) => name !== '')
    )
}

/** A class name as a CSS selector writes it. */
function selectorOf(name: string): string {
    return `.${name.replace(/[^\w-]/gu, (character) => `\\${character}`)}`
}

describe('build of the empty site', () => {
    test('completes', () => {
        expect(exitCode).toBe(0)
    })

    test('writes the home page as plain HTML, with the scripts of the mode, of the palette and of the network', async () => {
        const html = await readOutput('index.html')
        expect(html).toContain('<html lang="en"')
        expect(html).toContain('<h1')
        // The head script holds the function as the build writes it: the
        // tests below run it. The switch script is the same text. The loader
        // of the palette and the script of the network are module files:
        // deferred, after the first paint.
        const [head = '', palette = '', network = '', ...rest] = scriptsOf(html)
        expect(palette).toMatch(PALETTE_LOADER)
        expect(network).toMatch(
            /^<script type="module" src="\/_astro\/NetworkBackground[^"]+\.js"><\/script>$/u
        )
        expect(rest).toEqual([modeSwitchScript])
        expect(head).toContain('localStorage.getItem("mode")')
        expect(head.startsWith('{')).toBe(true)
        expect(modeScript.startsWith('{')).toBe(true)
    })

    // AN-01: the settings come from the deploy target. A build without them
    // (here: the preload of the tests clears them) sends nothing.
    test.each([['index.html'], ['404.html'], ['410.html']])(
        'has no analytics in %s without the settings of a target',
        async (file) => {
            const html = await readOutput(file)
            expect(html).not.toContain('plausible')
            expect(html).not.toContain('data-domain')
        }
    )

    // Issue 81: the network behind the hero is decoration, takes no space and is not printed.
    test('has the network layer behind the hero, hidden from assistive technology', async () => {
        const html = await readOutput('index.html')
        const canvas = /<canvas\b[^>]*data-network[^>]*>/u.exec(html)?.[0] ?? ''
        expect(canvas).toContain('aria-hidden="true"')
        expect(canvas).toMatch(/class="[^"]*\babsolute\b[^"]*\binset-0\b[^"]*\bprint:hidden\b/u)
        expect(canvas).toContain('pointer-events-none')
        const hero = /<section\b[^>]*data-network-scope[^>]*>[\s\S]*?<\/section>/u.exec(html)?.[0]
        expect(hero).toMatch(/<h1\b[^>]*data-network-quiet/u)
        expect(hero).toContain('class="relative')
        const script =
            /<script type="module" src="(\/_astro\/NetworkBackground[^"]+\.js)"/u.exec(html)?.[1] ??
            ''
        const code = await readOutput(script)
        expect(code).toContain('prefers-reduced-motion: reduce')
        expect(code).toContain('visibilitychange')
        expect(code).toContain('IntersectionObserver')
    })

    // Issue 122 and issue 100, point 3: a finger needs 44 px on a phone.
    test('the controls of the header and the rows of the palette are 44 px high on a phone', async () => {
        const html = await readOutput('index.html')
        const control = /<a\b[^>]*\sdata-palette\b[^>]*>/u.exec(html)?.[0] ?? ''
        const mode = /<button\b[^>]*\sdata-mode-switch\b[^>]*>/u.exec(html)?.[0] ?? ''
        expect(control).toMatch(/class="[^"]*\bh-11\b[^"]*\bmin-w-11\b/u)
        expect(mode).toMatch(/class="[^"]*\bh-11\b[^"]*\bw-11\b/u)
        const css = await readStylesheets()
        expect(css).toContain('.h-11{')
        expect(css).toContain('.min-w-11{')
        // The style of the palette is text of its module (R93).
        const files = await readdir(join(outputPath(), '_astro'))
        const palette = files.find(
            (file) => file.startsWith('palette-bundle') && file.endsWith('.js')
        )
        const code = await readOutput(join('_astro', palette ?? ''))
        for (const rule of ['.palette-option{', '.palette-field{', '.palette-close{']) {
            const block = code.slice(code.indexOf(rule), code.indexOf('}', code.indexOf(rule)))
            expect(block, rule).toContain('min-height:calc(var(--spacing,.25rem) * 11)')
        }
    })

    test('compiles the Tailwind classes that the home page uses', async () => {
        const css = await readStylesheets()
        expect(css).toContain('.bg-background')
        expect(css).toContain('.text-primary')
    })
})

// The design base (issue 46): the header, the mode and the fonts.
describe('design base', () => {
    test('has a header with the site name that leads home (NAV-01)', async () => {
        const html = await readOutput('index.html')
        expect(html).toMatch(
            /<header[^>]*>[\s\S]*<a href="\/"[^>]*>[\s\S]*Sébastien’s Notes[\s\S]*<\/header>/u
        )
    })

    // Issue 133: the logo of the main site leads home with the site name, in
    // the page itself (no request, a fixed size: nothing moves, CLS), also on
    // the server error page, which loads no other file (NAV-20).
    test.each([['index.html'], ['404.html'], ['500.html']])(
        '%s shows the logo in the header, with the site name as the name of its link',
        async (file) => {
            const html = await readOutput(file)
            const link =
                /<header[^>]*>[\s\S]*?(<a href="\/"[^>]*>[\s\S]*?<\/a>)/u.exec(html)?.[1] ?? ''
            const logo = /<svg\b[^>]*>/u.exec(link)?.[0] ?? ''
            expect(logo).toContain('viewBox="0 0 192 192"')
            expect(logo).toContain('width="32" height="32"')
            expect(logo).toContain('aria-hidden="true"')
            expect(link).not.toMatch(/<img\b/u)
            // The text of the link, without the hidden logo, is the site name.
            const text = link
                .replace(/<svg\b[\s\S]*?<\/svg>/gu, '')
                .replace(/<[^>]*>/gu, '')
                .trim()
            expect(text).toBe('Sébastien’s Notes')
        }
    )

    test('sets the mode before any style, with no flash (MODE-01)', async () => {
        const html = await readOutput('index.html')
        const script = html.indexOf('prefers-color-scheme: light')
        const style = html.search(/<link rel="stylesheet"|<style/u)
        expect(script).toBeGreaterThan(0)
        expect(style).toBeGreaterThan(0)
        expect(script).toBeLessThan(style)
        expect(html).toContain('data-theme="dark"')
    })

    // The head runs the built script: a stored choice, then the system, then dark.
    test.each([
        ['a stored choice', 'light', false, 'light'],
        ['the system', null, true, 'light'],
        ['the default, also when the storage refuses to be read', 'throws', false, 'dark']
    ] as const)(
        'runs the built script of the head with %s',
        async (_name, stored, prefersLight, mode) => {
            const [head = ''] = scriptsOf(await readOutput('index.html'))
            const dataset: Record<string, string> = {}
            runInNewContext(head, {
                localStorage: {
                    getItem: () => {
                        if (stored === 'throws') {
                            throw new Error('the storage is off')
                        }
                        return stored
                    }
                },
                matchMedia: (query: string) => ({
                    matches: query === '(prefers-color-scheme: light)' && prefersLight
                }),
                document: { documentElement: { dataset }, querySelectorAll: () => [] }
            })
            expect(dataset['theme']).toBe(mode)
        }
    )

    test('has a switch of the mode, hidden until its script runs, and a skip link (DES-11)', async () => {
        const html = await readOutput('index.html')
        expect(html).toMatch(/<button[^>]*data-mode-switch[^>]*hidden/u)
        const css = await readStylesheets()
        expect(css).toMatch(/\[hidden\][^{]*\{[^}]*display:none/u)
        expect(html).toMatch(/<a [^>]*href="#content"[^>]*>Skip to the content<\/a>/u)
        expect(html).toContain('id="content"')
    })

    test('serves its fonts itself (DES-08)', async () => {
        const css = await readStylesheets()
        const sources = [...css.matchAll(/@font-face\{[^}]*\}/gu)].map(([face]) => face)
        expect(sources.length).toBeGreaterThan(0)
        for (const face of sources) {
            expect(face).not.toMatch(/url\((?:https?:)?\/\//u)
        }
        const files = await readdir(outputPath(), { recursive: true })
        expect(files.some((file) => file.endsWith('.woff2'))).toBe(true)
    })

    test('has no color of the default palette of Tailwind (DES-12)', async () => {
        const css = await readStylesheets()
        expect(css).not.toMatch(/--color-(?:red|gray|slate|blue|green|white|black)\b/u)
        expect(css).toContain('--color-background')
    })

    // A note is Markdown: its headings and links get the look of the theme.
    test('gives the heading and the links of a note their look', async () => {
        const css = await readStylesheets()
        expect(css).toMatch(/\.note-text h1\{[^}]*font-weight/u)
        expect(css).toMatch(/\.note-text a\[href\]\{[^}]*text-decoration-line:underline/u)
    })

    // A class with no rule is a token or a utility that compiles to nothing.
    test.each([['index.html'], ['404.html']])('has a rule for each class of %s', async (file) => {
        const css = await readStylesheets()
        const missing = [...classesOf(await readOutput(file))].filter(
            (name) => !css.includes(selectorOf(name))
        )
        expect(missing).toEqual([])
    })

    test('shows a hand cursor on buttons and on what a click opens', async () => {
        const css = await readStylesheets()
        const rule = /([^{}]*)\{[^}]*cursor:pointer/u.exec(css)
        expect(rule).not.toBeNull()
        for (const selector of ['button', 'summary', 'select', '[role=button]']) {
            expect(rule?.[1] ?? '').toContain(selector)
        }
    })
})

// The error pages (issue 62, NAV-19, NAV-20, decision R64).
describe('error pages', () => {
    test.each([['410.html'], ['500.html']])('%s is not indexed and leads home', async (file) => {
        const html = await readOutput(file)
        expect(html).toContain('<meta name="robots" content="noindex, follow">')
        expect(html).not.toContain('rel="canonical"')
        expect(html).toMatch(/<main[^>]*>[\s\S]*<a [^>]*href="\/"[\s\S]*<\/main>/u)
        expect(html).toMatch(/<title>[^<]*Sébastien’s Notes<\/title>/u)
    })

    test('the gone page offers the search with an empty field, and runs only the scripts of the mode and of the palette', async () => {
        const html = await readOutput('410.html')
        const form = /<form role="search"[^>]*action="\/-\/search"[\s\S]*?<\/form>/u.exec(html)
        expect(form).not.toBeNull()
        expect(form?.[0] ?? '').toMatch(/<input[^>]*name="q"/u)
        expect(form?.[0] ?? '').not.toMatch(/<input[^>]*\svalue=/u)
        // The loader of the palette names nothing of a note (issue 122).
        const [palette = '', ...rest] = scriptsOf(html).slice(1)
        expect(palette).toMatch(PALETTE_LOADER)
        expect(rest).toEqual([modeSwitchScript])
    })

    // Only the page with no script needs the mode of the system.
    test('the other pages do not load the mode of the system', async () => {
        expect(await readStylesheets()).not.toContain('data-theme=system')
    })

    test.each([['410.html']])('has a rule for each class of %s', async (file) => {
        const css = await readStylesheets()
        const missing = [...classesOf(await readOutput(file))].filter(
            (name) => !css.includes(selectorOf(name))
        )
        expect(missing).toEqual([])
    })

    test('the server error page is one file: no script, no style sheet, no font, no other file of the release', async () => {
        const html = await readOutput('500.html')
        expect(html).not.toMatch(/<script/iu)
        expect(html).not.toMatch(/<link[^>]*rel="(?:stylesheet|preload|modulepreload)"/u)
        expect(html).not.toContain('/_astro/')
        expect(html).not.toMatch(/@font-face/u)
        expect(html).not.toMatch(/url\(/u)
        expect(html).toMatch(/<style>[\s\S]*\.button[\s\S]*<\/style>/u)
        expect(html).not.toContain('data-mode-switch')
    })

    test('the server error page has a rule for each of its classes in its own style', async () => {
        const html = await readOutput('500.html')
        const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gu)]
            .map(([, text]) => text)
            .join('\n')
        const missing = [...classesOf(html)].filter((name) => !css.includes(selectorOf(name)))
        expect(missing).toEqual([])
    })

    // No script reads the stored choice: the page follows the mode of the
    // system, dark when the system states none.
    test('the server error page follows the mode of the system', async () => {
        const html = await readOutput('500.html')
        // The block of the system comes after the dark values of `:root`, which it overrides.
        const dark = html.indexOf(':root,[data-theme=dark]{')
        expect(dark).toBeGreaterThan(0)
        expect(html.indexOf('[data-theme=system]{')).toBeGreaterThan(dark)
        expect(html).toContain('<html lang="en" data-theme="system">')
        expect(html).toMatch(
            /@media \(prefers-color-scheme:light\)\{\[data-theme=system\]\{color-scheme:light;/u
        )
    })
})

/** The value of an attribute of each element of a page that matches a pattern of its start tag. */
function attributeOf(html: string, element: RegExp, name: string): string[] {
    return [...html.matchAll(new RegExp(element.source, 'gu'))].map(
        ([tag]) => new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag)?.[1] ?? ''
    )
}

// Issue 133: the icon of the site, the color of the bar of the browser in
// each mode, and the facts of a card of a shared page.
describe('head of a page', () => {
    test('names the icon of the site: the old icon, the vector icon and the icon of a home screen', async () => {
        const html = await readOutput('index.html')
        expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">')
        const [vector = ''] = attributeOf(
            html,
            /<link rel="icon"[^>]*type="image\/svg\+xml"[^>]*>/u,
            'href'
        )
        const [touch = ''] = attributeOf(html, /<link rel="apple-touch-icon"[^>]*>/u, 'href')
        expect(vector).toMatch(/^\/_astro\/icon\.[\w-]+\.svg$/u)
        expect(touch).toMatch(/^\/_astro\/apple-touch-icon\.[\w-]+\.png$/u)
        const svg = await readOutput(vector.slice(1))
        expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">')
        expect(svg).not.toMatch(/<script|\son\w+=|href=/iu)
        const png = new Uint8Array(await Bun.file(join(outputPath(), touch.slice(1))).arrayBuffer())
        expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47])
        // The width and the height of the PNG: 180 by 180, the size of a home screen.
        const size = new DataView(png.buffer)
        expect([size.getUint32(16), size.getUint32(20)]).toEqual([180, 180])
    })

    test('writes /favicon.ico at the root of the output, with the sizes of a tab', async () => {
        const icon = new Uint8Array(await Bun.file(join(outputPath(), 'favicon.ico')).arrayBuffer())
        // An ICO file: reserved 0, type 1, then the number of its images.
        expect([...icon.slice(0, 4)]).toEqual([0, 0, 1, 0])
        const count = icon[4] ?? 0
        const widths = Array.from({ length: count }, (_, index) => icon[6 + index * 16])
        expect(widths.sort()).toEqual([16, 32])
    })

    test.each([['index.html'], ['404.html'], ['500.html']])(
        '%s gives the bar of the browser the color of each mode',
        async (file) => {
            const html = await readOutput(file)
            for (const mode of ['dark', 'light'] as const) {
                expect(html).toContain(
                    `<meta name="theme-color" content="${BAR_COLORS[mode]}" media="${BAR_MEDIA[mode]}" data-mode="${mode}">`
                )
            }
            // Before the script of the mode, which follows the mode of the page.
            const bar = html.indexOf('name="theme-color"')
            const script = html.indexOf('<script')
            expect(bar).toBeGreaterThan(0)
            expect(script === -1 || bar < script).toBe(true)
        }
    )

    test('the home page has the facts of a card', async () => {
        const html = await readOutput('index.html')
        for (const tag of [
            '<meta name="author" content="Sébastien Dubois">',
            '<meta property="og:site_name" content="Sébastien’s Notes">',
            '<meta property="og:type" content="website">',
            '<meta property="og:title" content="Sébastien’s Notes">',
            '<meta property="og:url" content="https://notes.dsebastien.net/">',
            '<meta name="twitter:card" content="summary">',
            '<meta name="twitter:site" content="@dsebastien">'
        ]) {
            expect(html).toContain(tag)
        }
        const [description = ''] = attributeOf(html, /<meta name="description"[^>]*>/u, 'content')
        expect(description).not.toBe('')
        expect(html).toContain(`<meta property="og:description" content="${description}">`)
    })

    // A page with no canonical address is no page to share.
    test.each([['404.html'], ['410.html'], ['500.html']])('%s has no card', async (file) => {
        expect(await readOutput(file)).not.toContain('property="og:')
    })
})
