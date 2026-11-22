import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { attachmentPath, canonicalPath, markdownPath } from '@dsebastien-website/resolver'
import {
    FIXTURE_NOTE_TYPES,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import type { Device } from '../../plugin/src/publishing/ports.ts'
import { plan, publish, status, takedown, unpublish } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'
import { createSearch, type Search } from './search/engine.ts'
import { SITE_CHECKS_MODE } from './site-checks.ts'
import { pagefindEngine } from './search/full-text.ts'
import { partFile, type TitleRow } from './search/titles.ts'

// A takedown on the built site (issue 38, TEST-16, PUB-82, PUB-83, URL-27,
// URL-28): the tool publishes the fixture vault but one note, and the site is
// built. Then it unpublishes two notes, takes down one of them and two
// published notes, and the site is built again from that content store, as a
// build of real notes (without the strict mode of the tests: a removal never
// blocks a build, R65). The first build shows that each note was there, so
// the checks of the second build cannot pass by construction.
const SITE = fileURLToPath(new URL('..', import.meta.url))

/** The note that the author did not select: it stays in the vault. */
const NOT_SELECTED = '10 Garden/Winter plan (draft).md'
/** A map of content with an alias, which other notes link to and one note embeds. */
const COMPOST = '10 Garden/Compost basics.md'
/** A sentence of its text, and of no other note. */
const COMPOST_TEXT = 'A heap needs green matter'
/** A note with the only link to a sound file. */
const SOUND = '50 Field guide/Embeds/Embed of a sound.md'
/** A note with an alias: unpublished, then taken down. */
const BARREL = '10 Garden/Rain barrel.md'
/** A note that stays unpublished: it answers 410. */
const TRELLIS = '10 Garden/Bean trellis.md'
/** The note that embeds the map of content. */
const EMBEDS = '50 Field guide/Embeds/Embed of a note.md'

/** One build of the site, read with the plain server and the search of the page. */
interface Build {
    readonly dir: string
    readonly exitCode: number
    readonly server: Server | undefined
    readonly search: Search
}

let stores: TestStores | undefined
let device: Device | undefined
let contentStore = ''
let before: Build | undefined
let after: Build | undefined
let report: Awaited<ReturnType<typeof takedown>> | undefined
/** The path of the sound file on the site, as the first build gave it. */
let soundPath = ''
let soundKey = ''
/** The answer of the first build for the sound file, before the takedown deleted it. */
let soundBefore = 0
/** True when the cache of the build held the text of the note after the first build. */
let cachedBefore = false

/** The cache of the build, where Astro keeps the markup of each note between two builds (AGENTS.md). */
const DATA_STORE = join(SITE, 'node_modules', '.astro', 'data-store.json')

/** The folder of the attachment storage of the test. */
function storage(): string {
    if (stores === undefined) {
        throw new Error('the stores do not exist')
    }
    return stores.attachmentStorage
}

/** Builds the site of the content store into a new folder, and serves it. */
async function build(
    name: string,
    environment: Record<string, string | undefined>
): Promise<Build> {
    // The output folder is inside the site, in a folder that git ignores: Astro
    // moves files into it, and a move to another file system fails.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    const dir = await mkdtemp(join(cache, `takedown-spec-${name}-`))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', dir], {
        cwd: SITE,
        env: { ...environment, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    const exitCode = await child.exited
    const server =
        exitCode === 0
            ? await startServer({ dist: dir, port: 0, attachments: storage() })
            : undefined
    const json = async (file: string): Promise<unknown> =>
        JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown
    const search = createSearch({
        keys: async () =>
            ((await json('-/search/titles.json')) as { keys: Record<string, boolean> }).keys,
        part: async (key) => (await json(`-/search/titles/${partFile(key)}.json`)) as TitleRow[],
        fullText: pagefindEngine(pathToFileURL(join(dir, '-', 'search', 'pagefind')).href + '/')
    })
    return { dir, exitCode, server, search }
}

function ready(build: Build | undefined): Build & { server: Server } {
    if (build?.server === undefined) {
        throw new Error('the site was not built')
    }
    return { ...build, server: build.server }
}

async function get(build: Build | undefined, path: string): Promise<Response> {
    return await fetch(`${ready(build).server.url}${path}`, { redirect: 'manual' })
}

/** Every file of an output that is text, by its path in the output. */
async function textFiles(dir: string): Promise<Map<string, string>> {
    const files = new Map<string, string>()
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const path = join(entry.parentPath, entry.name)
        // The Pagefind files are compressed: the search of the page reads them.
        if (/\.(?:html|json|md|txt|xml|js|css)$/u.test(entry.name)) {
            files.set(path.slice(dir.length + 1), await readFile(path, 'utf8'))
        }
    }
    return files
}

/** The links of a built page that lead to a path, with or without a fragment. */
function linksTo(html: string, path: string): boolean {
    return html.includes(`href="${path}"`) || html.includes(`href="${path}#`)
}

const RUN = { device: 'garden-shed', face: 'command-line' } as const

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    contentStore = await makeContentStoreCopy(stores)
    device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const queue = await status(device)
    const planned = await plan(device, {
        include: queue.new.filter((path) => path !== NOT_SELECTED)
    })
    await publish(device, planned.id, { ...RUN, time: '2031-05-01T00:00:00Z' })
    for (const name of await readdir(join(contentStore, 'manifest'))) {
        const entry = JSON.parse(await readFile(join(contentStore, 'manifest', name), 'utf8')) as {
            path: string
            attachments: { hash: string; path: string }[]
        }
        const sound = entry.attachments[0]
        if (entry.path === SOUND && sound !== undefined) {
            soundPath = attachmentPath(sound.hash, sound.path)
            soundKey = sound.hash.slice('sha256:'.length)
        }
    }
    before = await build('before', process.env)
    // The two builds share the attachment storage, which the takedown changes.
    soundBefore = (await get(before, soundPath)).status
    cachedBefore = (await readFile(DATA_STORE, 'utf8')).includes(COMPOST_TEXT)

    await unpublish(device, [BARREL, TRELLIS], { ...RUN, time: '2031-05-02T00:00:00Z' })
    report = await takedown(device, [COMPOST, SOUND, BARREL], {
        ...RUN,
        time: '2031-05-03T00:00:00Z'
    })
    // A build of real notes: the strict mode of the tests is off.
    const real = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== SITE_CHECKS_MODE)
    )
    after = await build('after', real)
}, 600_000)

afterAll(async () => {
    await before?.server?.stop()
    await after?.server?.stop()
    // Remove only the folders that this test made.
    for (const build of [before, after]) {
        if (build !== undefined) {
            await rm(build.dir, { recursive: true, force: true })
        }
    }
    await stores?.remove()
})

describe('the site before the takedown', () => {
    test('is built in the strict mode, with every note that the test removes', async () => {
        expect(before?.exitCode).toBe(0)
        for (const path of [COMPOST, SOUND, BARREL, TRELLIS]) {
            expect((await get(before, canonicalPath(path))).status, path).toBe(200)
        }
        const alias = await get(before, '/Composting')
        expect([alias.status, alias.headers.get('location')]).toEqual([302, canonicalPath(COMPOST)])
        expect(soundBefore).toBe(200)
        expect(cachedBefore).toBe(true)
        const embeds = await (await get(before, canonicalPath(EMBEDS))).text()
        expect(embeds).toContain(COMPOST_TEXT)
        const search = ready(before).search
        expect((await search.titles('compost basics')).map((row) => row.path)).toContain(
            canonicalPath(COMPOST)
        )
        const hits = await (await search.fullText('heap')).hits(0, 10)
        expect(hits.map((hit) => hit.path)).toContain(canonicalPath(COMPOST))
    })
})

describe('a takedown on the built site', () => {
    test('reports the three notes and the file that no other note uses', () => {
        expect(report?.takenDown).toEqual([COMPOST, BARREL, SOUND])
        expect(report?.attachmentsDeleted).toEqual([soundKey])
    })

    test('is built again as a build of real notes', () => {
        expect(after?.exitCode).toBe(0)
    })

    test('answers 404 at every address of a note that was taken down, also of an unpublished one', async () => {
        for (const path of [
            canonicalPath(COMPOST),
            markdownPath(COMPOST),
            '/Composting',
            canonicalPath(SOUND),
            canonicalPath(BARREL),
            markdownPath(BARREL),
            '/Water+butt',
            '/Rain+barrel'
        ]) {
            expect((await get(after, path)).status, path).toBe(404)
        }
    })

    // Another note has the file name of the note as its alias: a published note wins (R64).
    test('gives an address that another published note has to that note', async () => {
        const answer = await get(after, '/Compost+basics')
        expect([answer.status, answer.headers.get('location')]).toEqual([
            302,
            canonicalPath('10 Garden/Wormery.md')
        ])
    })

    test('answers 404 for the file that only a note that was taken down used', async () => {
        expect((await get(after, soundPath)).status).toBe(404)
        expect(await readdir(storage())).not.toContain(soundKey)
    })

    test('keeps the answer 410 of the note that is only unpublished', async () => {
        expect((await get(after, canonicalPath(TRELLIS))).status).toBe(410)
    })

    test('leaves no text of the note and no link to it in any file of the output', async () => {
        const files = await textFiles(ready(after).dir)
        expect(files.size).toBeGreaterThan(50)
        for (const [file, text] of files) {
            expect(text.includes(COMPOST_TEXT), file).toBe(false)
            // Its alias, which no other note writes.
            expect(text.includes('Composting'), file).toBe(false)
            for (const path of [COMPOST, SOUND, BARREL]) {
                expect(linksTo(text, canonicalPath(path)), `${file}: ${path}`).toBe(false)
            }
            expect(text.includes(soundPath), file).toBe(false)
        }
        // The page that embedded the note shows the link as plain text (rule 5).
        expect((await get(after, canonicalPath(EMBEDS))).status).toBe(200)
    })

    test('leaves the note in no search index', async () => {
        const search = ready(after).search
        expect((await search.titles('compost basics')).map((row) => row.path)).not.toContain(
            canonicalPath(COMPOST)
        )
        expect((await search.titles('water butt')).map((row) => row.path)).not.toContain(
            canonicalPath(BARREL)
        )
        const results = await search.fullText('heap')
        const hits = await results.hits(0, results.total)
        expect(hits.map((hit) => hit.path)).not.toContain(canonicalPath(COMPOST))
    })

    test('leaves no text of the note in the cache of the build', async () => {
        // Astro keeps the markup of each note between two builds (AGENTS.md):
        // a cached copy that the site controls (PUB-82). The builds of the
        // tests share this file; Bun runs the test files one after the other.
        const store = await readFile(DATA_STORE, 'utf8')
        expect(store.includes(COMPOST_TEXT)).toBe(false)
    })
})
