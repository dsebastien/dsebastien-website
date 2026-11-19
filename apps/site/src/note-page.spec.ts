import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'
import { modeScript, modeSwitchScript } from './mode.ts'

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
    const device = nodeDevice({ vault, contentStore, attachmentStorage: stores.attachmentStorage })
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
        expect(html).toContain('<title>Frost dates explained</title>')
        expect(html).toMatch(/<h1[^>]*>Frost dates explained<\/h1>/)
        expect(html).toContain(
            '<p>The last frost date is the average day of the last frost in spring. Tender plants go out after it.</p>'
        )
    })

    test('does not read the vault: a change after the publication is not on the page', async () => {
        expect(await readOutput(NOTE_FILE)).not.toContain('never published')
    })

    // The page works without JavaScript (PAGE-01): its only scripts are the
    // two inline scripts of the mode (MODE-01), with no attribute.
    test('makes a page without JavaScript, but for the mode', async () => {
        const html = await readOutput(NOTE_FILE)
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)].map(
            ([whole, attributes = '', text = '']) => (attributes.trim() === '' ? text : whole)
        )
        const [head = '', ...rest] = scripts
        expect(rest).toEqual([modeSwitchScript])
        // The head script holds the function as the build writes it (its run is tested in build.spec.ts).
        expect(head).toContain('localStorage.getItem("mode")')
        expect(modeScript).toContain('localStorage.getItem("mode")')
    })

    test('does not write the properties of the note as text of the page', async () => {
        const html = await readOutput(NOTE_FILE)
        expect(html).not.toContain('ai_generated')
        expect(html).not.toContain('type/note')
    })

    // The vault has more than 40 files. Only what the content store holds is built.
    test('makes no page for a note that is not published', async () => {
        expect(await readdir(join(outputPath(), '-', 'note'))).toEqual([`${NOTE_ID}.html`])
    })

    test('writes the resolver map: the canonical path of the note leads to its page', async () => {
        const map: unknown = JSON.parse(await readOutput('-/resolver-map.json'))
        // The folder of the note has no folder note, so it gets a generated
        // list. The name of its file is the SHA-256 of "10 Garden", computed
        // with sha256sum.
        expect(map).toEqual({
            pages: {
                '/': 'index.html',
                [NOTE_URL]: NOTE_FILE,
                '/10+Garden': '-/folder/e824100b642854a7.html'
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
            notFound: '404.html'
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
