import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath } from '@dsebastien-website/resolver'
import {
    checkHtml,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    readMarkdownForms,
    type MarkdownForm,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'

// The rendering of a note (issue 45), on the corpus of the Markdown forms
// (issue 26): the tool publishes every new note of the fixture vault, the
// site is built from that content store and served, and each form runs its
// checks on the HTML of the note body of its page. Each form also has a
// snapshot of that HTML (the acceptance of issue 45).
const SITE = fileURLToPath(new URL('..', import.meta.url))

/** The note that the tests never select (catalog entry link-to-unpublished-note). */
const NEVER_SELECTED = '10 Garden/Winter plan (draft).md'

/** The forms that the site does not render yet. Empty at the end of issue 45. */
const PENDING = new Set<string>([])

const forms: MarkdownForm[] = await readMarkdownForms()
let stores: TestStores | undefined
let outDir: string | undefined
let server: Server | undefined
let exitCode = -1

/** The HTML of the note body of a page: the content of its element `data-note-body`. */
function noteBody(page: string): string | undefined {
    const start = /<article\b[^>]*\bdata-note-body\b[^>]*>/u.exec(page)
    const end = page.lastIndexOf('</article>')
    if (start === null || end < start.index) {
        return undefined
    }
    return page.slice(start.index + start[0].length, end)
}

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({ vault, contentStore, attachmentStorage: stores.attachmentStorage })
    const queue = await status(device)
    const planned = await plan(device, {
        include: queue.new.filter((path) => path !== NEVER_SELECTED)
    })
    await publish(device, planned.id, {
        time: '2031-05-01T00:00:00Z',
        device: 'garden-shed',
        face: 'command-line'
    })
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'rendering-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    exitCode = await child.exited
    if (exitCode === 0) {
        server = await startServer({
            dist: outDir,
            port: 0,
            attachments: stores.attachmentStorage
        })
    }
}, 300_000)

afterAll(async () => {
    await server?.stop()
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

async function bodyOf(form: MarkdownForm): Promise<string> {
    if (server === undefined) {
        throw new Error('the server does not run')
    }
    const answer = await fetch(new URL(canonicalPath(form.note), server.url))
    expect(answer.status).toBe(200)
    const body = noteBody(await answer.text())
    if (body === undefined) {
        throw new Error(`the page of ${form.note} has no note body`)
    }
    return body
}

describe('rendering of the Markdown forms on the site', () => {
    test('the build completes', () => {
        expect(exitCode).toBe(0)
    })

    for (const form of forms) {
        const run = PENDING.has(form.id) ? test.skip : test
        run(`${form.id}: ${form.covers}`, async () => {
            const body = await bodyOf(form)
            expect(await checkHtml(body, form.checks)).toEqual([])
            expect(body).toMatchSnapshot()
        })
    }
})

// REN-09: a note in French is marked as French (the property `language`).
describe('language of a note page', () => {
    async function pageOf(note: string): Promise<string> {
        if (server === undefined) {
            throw new Error('the server does not run')
        }
        return await (await fetch(new URL(canonicalPath(note), server.url))).text()
    }

    test('a note with the property language: fr is marked as French', async () => {
        expect(await pageOf('40 Writing/Le potager en hiver.md')).toContain('<html lang="fr"')
    })

    test('a note with language: en, and a note without the property, are in English', async () => {
        expect(await pageOf('40 Writing/The vegetable garden in winter.md')).toContain(
            '<html lang="en"'
        )
        expect(await pageOf('10 Garden/Rain barrel.md')).toContain('<html lang="en"')
    })
})
