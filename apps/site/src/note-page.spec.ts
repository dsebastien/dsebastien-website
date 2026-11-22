import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
    FIXTURE_NOTE_TYPES,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'
import { modeScript, modeSwitchScript } from './mode.ts'
import { propertiesScript } from './properties-panel.ts'
import { oldAnchorScript } from './rendering/anchors.ts'

// The first slice (issue 31), from the content store to a served page: the
// build makes one page from a published note, and a plain local server serves
// it under its canonical URL through the resolver (SEAM-04 and SEAM-05 of the
// spec).
//
// The note is published by the publishing tool into a content store made for
// the test, so the build reads what a real publication writes.
const SITE = fileURLToPath(new URL('..', import.meta.url))

const NOTE = '10 Garden/Frost dates explained.md'
const NOTE_ID = '203d446940c02032'
const NOTE_URL = '/10+Garden/Frost+dates+explained'
const NOTE_FILE = `-/note/${NOTE_ID}.html`

let stores: TestStores | undefined
let outDir: string | undefined
let server: Server | undefined
let exitCode = -1

function outputPath(): string {
    if (outDir === undefined) {
        throw new Error('the output folder does not exist')
    }
    return outDir
}

function serverUrl(): string {
    if (server === undefined) {
        throw new Error('the server does not run')
    }
    return server.url
}

async function readOutput(path: string): Promise<string> {
    return await Bun.file(join(outputPath(), path)).text()
}

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const planned = await plan(device, { include: [NOTE] })
    await publish(device, planned.id, {
        time: '2031-04-01T08:00:00Z',
        device: 'garden-shed',
        face: 'plugin'
    })
    // The build reads the content store and never the vault (BUILD-01): after
    // the publication the note of the vault says something else.
    await Bun.write(
        join(vault, NOTE),
        '# Frost dates explained\n\nA text that was never published.\n'
    )

    // The output folder is inside the site, in a folder that git ignores: Astro
    // moves files into it, and a move to another file system fails.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'note-page-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'ignore'
    })
    exitCode = await child.exited
    if (exitCode === 0) {
        server = await startServer({ dist: outDir, port: 0 })
    }
}, 180_000)

afterAll(async () => {
    await server?.stop()
    // Remove only the folders that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

describe('build of a content store with one published note', () => {
    test('completes', () => {
        expect(exitCode).toBe(0)
    })

    test('makes one page that holds the text of the note', async () => {
        const html = await readOutput(NOTE_FILE)
        // The title of the page: the display title, the type word and the site name (IDX-01, R61).
        expect(html).toContain(
            '<title>Frost dates explained · Permanent note · Sébastien’s Notes</title>'
        )
        expect(html).toMatch(/<h1[^>]*>Frost dates explained<\/h1>/)
        expect(html).toContain(
            '<p>The last frost date is the average day of the last frost in spring. Tender plants go out after it.</p>'
        )
    })

    // The title band of variant B (issue 47, R58): the H1 at the top of the
    // note becomes the title of the band, with its id, so the page has one H1.
    test('shows the title in the band, as the only H1 of the page, with the id of the heading', async () => {
        const html = await readOutput(NOTE_FILE)
        expect(html.match(/<h1\b/gu)).toHaveLength(1)
        expect(html).toMatch(
            /<h1 id="frost-dates-explained" data-note-title data-heading="Frost dates explained"[^>]*>Frost dates explained<\/h1>/u
        )
        expect(html.indexOf('data-note-title')).toBeLessThan(html.indexOf('data-note-body'))
    })

    test('shows the type badge and the created and updated dates of the properties of the note', async () => {
        const html = await readOutput(NOTE_FILE)
        // The label of the note type that the Starter Kit gives the note, a link to its hub (R61).
        expect(html).toContain(
            '<a class="badge-link" href="/-/types/permanent-notes" aria-label="Permanent note: all Permanent notes" data-type-badge data-pagefind-meta="type">Permanent note</a>'
        )
        expect(html).toContain('Created <time datetime="2031-03-07">2031-03-07</time>')
        expect(html).toContain('Updated <time datetime="2031-03-07">2031-03-07</time>')
    })

    // A late font moves the text (CLS 0.18 on mobile in issue 25): the head
    // preloads the one font file that the style sheet uses for Latin text.
    test('preloads the Latin font file that the style sheet uses', async () => {
        const html = await readOutput(NOTE_FILE)
        const preloads = [
            ...html.matchAll(
                /<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin\b[^>]*>/gu
            )
        ].map((match) => match[1] ?? '')
        expect(preloads).toHaveLength(1)
        const font = preloads[0] ?? ''
        expect(font).toMatch(/noto-sans-latin-wght-normal\.[\w-]+\.woff2$/u)
        const style = /<link rel="stylesheet" href="([^"]+)"/u.exec(html)?.[1] ?? ''
        expect(await readOutput(style)).toContain(font)
    })

    test('does not read the vault: a change after the publication is not on the page', async () => {
        expect(await readOutput(NOTE_FILE)).not.toContain('never published')
    })

    // The page works without JavaScript (PAGE-01): its only scripts are the
    // two inline scripts of the mode (MODE-01), the one of the properties
    // panel, which is a folding block without it (PAGE-02), and the one that
    // reads an old heading anchor (URL-14), with no attribute.
    test('makes a page without JavaScript, but for the mode, the properties panel and the old anchors', async () => {
        const html = await readOutput(NOTE_FILE)
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)].map(
            ([whole, attributes = '', text = '']) => (attributes.trim() === '' ? text : whole)
        )
        const [head = '', panel, ...rest] = scripts
        // The script of the panel as the build wrote it (its run is tested in properties-panel.spec.ts).
        expect(panel).toBe(propertiesScript)
        expect(rest).toHaveLength(2)
        expect(rest[1]).toBe(modeSwitchScript)
        // The script of the old anchors holds a function as the build writes it
        // (its run is tested in rendering/page.spec.ts).
        expect(rest[0]).toContain('function headingFor(headings, path)')
        expect(oldAnchorScript).toContain('function headingFor(headings, path)')
        // The script as the build wrote it runs, and reads an old hash.
        let scrolled = ''
        const heading = {
            tagName: 'H2',
            textContent: 'Panels: a review',
            id: 'panels-a-review',
            scrollIntoView: () => {
                scrolled = heading.id
            }
        }
        runInNewContext(rest[0] ?? '', {
            location: { hash: '#panels+a+review' },
            document: {
                getElementById: (id: string) => (id === heading.id ? heading : null),
                querySelectorAll: () => [heading],
                getElementsByName: () => []
            },
            history: { replaceState: () => undefined },
            addEventListener: () => undefined
        })
        expect(scrolled).toBe('panels-a-review')
        // The head script holds the function as the build writes it (its run is tested in build.spec.ts).
        expect(head).toContain('localStorage.getItem("mode")')
        expect(modeScript).toContain('localStorage.getItem("mode")')
    })

    // The properties are in the panel of the page (issue 48), never in the text of the note.
    test('does not write the properties of the note as text of the note', async () => {
        const html = await readOutput(NOTE_FILE)
        const text = /<article\b[^>]*data-note-body[^>]*>([\s\S]*?)<\/article>/u.exec(html)?.[1]
        expect(text).toContain('The last frost date')
        expect(text).not.toContain('ai_generated')
        expect(text).not.toContain('type/note')
    })

    // The vault has more than 40 files. Only what the content store holds is built.
    test('makes no page for a note that is not published', async () => {
        expect(await readdir(join(outputPath(), '-', 'note'))).toEqual([`${NOTE_ID}.html`])
    })

    test('writes the resolver map: the canonical path of the note leads to its page', async () => {
        const map: unknown = JSON.parse(await readOutput('-/resolver-map.json'))
        // The folder of the note has no folder note, so it gets a generated
        // list. The name of its file is the SHA-256 of "10 Garden", computed
        // with sha256sum. The library, the type hub of the note and the pages
        // of its tag and of the parent level of the tag are generated pages
        // (issue 49); the names of the files of the tags are the SHA-256 of
        // "type" and of "type/note", computed with sha256sum. The recent lists
        // and the filter of the type of the note are generated pages too (issue 50),
        // and so is the search page (issue 51).
        expect(map).toEqual({
            pages: {
                '/': 'index.html',
                [NOTE_URL]: NOTE_FILE,
                '/10+Garden': '-/folder/e824100b642854a7.html',
                '/-/library': '-/library.html',
                '/-/search': '-/search.html',
                '/-/recent/added': '-/recent/added.html',
                '/-/recent/added/permanent-notes': '-/recent/added.permanent-notes.html',
                '/-/recent/updated': '-/recent/updated.html',
                '/-/recent/updated/permanent-notes': '-/recent/updated.permanent-notes.html',
                '/-/tags/type': '-/tags/1303c06b0b014d0c.html',
                '/-/tags/type/note': '-/tags/8cf4e21b748bf742.html',
                '/-/types/permanent-notes': '-/types/permanent-notes.html'
            },
            files: {
                '/robots.txt': { file: 'robots.txt', type: 'text' },
                [`/-/md${NOTE_URL}.md`]: { file: `-/md/${NOTE_ID}.md`, type: 'markdown' }
            },
            attachments: {},
            folded: { '10 garden/frost dates explained': NOTE_URL, '10 garden': '/10+Garden' },
            names: { 'frost dates explained': [NOTE_URL] },
            aliases: {},
            choices: {},
            notFound: '404.html',
            // No note was unpublished (URL-27, R64).
            gone: { file: '410.html', paths: {}, folded: {}, names: {}, aliases: {} }
        })
    })
})

describe('plain local server', () => {
    test('answers 200 with the page for the canonical URL of the note', async () => {
        const response = await fetch(`${serverUrl()}${NOTE_URL}`)

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(await response.text()).toContain('The last frost date is the average day')
    })

    test('answers 404 for a path that no note has', async () => {
        const response = await fetch(`${serverUrl()}/10+Garden/No+such+note`)

        expect(response.status).toBe(404)
    })

    // The file of a page is not a second URL of the note.
    test('answers 404 for the file of the page', async () => {
        const response = await fetch(`${serverUrl()}/${NOTE_FILE}`)

        expect(response.status).toBe(404)
    })

    test('answers 404 for a path that tries to leave the output of the build', async () => {
        const response = await fetch(`${serverUrl()}/..%2F..%2Fpackage.json`)

        expect(response.status).toBe(404)
    })

    // The page must not point to a file that the server does not give.
    test('answers 200 for each style sheet of the page', async () => {
        const html = await readOutput(NOTE_FILE)
        const sheets = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(
            (match) => match[1] ?? ''
        )
        expect(sheets.length).toBeGreaterThan(0)

        for (const sheet of sheets) {
            const response = await fetch(`${serverUrl()}${sheet}`)
            expect(response.status, sheet).toBe(200)
            expect(response.headers.get('content-type'), sheet).toBe('text/css; charset=utf-8')
        }
    })

    test('answers 404 for a file of the assets folder that the build did not write', async () => {
        for (const path of ['/_astro/none.css', '/_astro/..%2F-%2Fresolver-map.json', '/_astro/']) {
            const response = await fetch(`${serverUrl()}${path}`)
            expect(response.status, path).toBe(404)
        }
    })

    test('answers 200 for the home page', async () => {
        const response = await fetch(`${serverUrl()}/`)

        expect(response.status).toBe(200)
        expect(await response.text()).toContain('<h1')
    })
})
