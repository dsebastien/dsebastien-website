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
    const device = nodeDevice({ vault, contentStore })
    const planned = await plan(device, { include: [NOTE] })
    await publish(device, planned.id, '2031-04-01T08:00:00Z')

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

    test('makes a page without JavaScript', async () => {
        expect(await readOutput(NOTE_FILE)).not.toContain('<script')
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
        expect(map).toEqual({ pages: { '/': 'index.html', [NOTE_URL]: NOTE_FILE } })
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

    test('answers 200 for the home page', async () => {
        const response = await fetch(`${serverUrl()}/`)

        expect(response.status).toBe(200)
        expect(await response.text()).toContain('<h1')
    })
})
