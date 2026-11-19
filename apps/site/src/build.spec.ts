import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('build of the empty site', () => {
    test('completes', () => {
        expect(exitCode).toBe(0)
    })

    test('writes the home page as plain HTML, with inline scripts only', async () => {
        const html = await readOutput('index.html')
        expect(html).toContain('<html lang="en"')
        expect(html).toContain('<h1')
        // The scripts of the mode are inline: no script file to load.
        expect(html).not.toMatch(/<script[^>]* src=/u)
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

    test('sets the mode before any style, with no flash (MODE-01)', async () => {
        const html = await readOutput('index.html')
        const script = html.indexOf('prefers-color-scheme: light')
        const style = html.search(/<link rel="stylesheet"|<style/u)
        expect(script).toBeGreaterThan(0)
        expect(style).toBeGreaterThan(0)
        expect(script).toBeLessThan(style)
        expect(html).toContain('data-theme="dark"')
    })

    test('has a switch of the mode and a skip link (DES-11)', async () => {
        const html = await readOutput('index.html')
        expect(html).toContain('data-mode-switch')
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

    test('shows a hand cursor on buttons and on what a click opens', async () => {
        const css = await readStylesheets()
        const rule = /([^{}]*)\{[^}]*cursor:pointer/u.exec(css)
        expect(rule).not.toBeNull()
        for (const selector of ['button', 'summary', 'select', '[role=button]']) {
            expect(rule?.[1] ?? '').toContain(selector)
        }
    })
})
