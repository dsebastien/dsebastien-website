import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Element, Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { select, selectAll } from 'hast-util-select'
import { toText } from 'hast-util-to-text'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    FIXTURE_NOTE_TYPES,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { resolve, type ResolverMap } from '@dsebastien-website/resolver'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../../plugin/src/publishing/tool.ts'

// The note types on the built site (issue 49, decision R61): the title of a
// page with its type word, the display title without the prefix and the
// suffix of the type, the type badge, the descriptions, the type hubs, the
// tag pages, the library and the home page. The tool publishes the fixture
// vault with the answers of an invented Starter Kit, the site is built, and
// the tests read the output. The build itself checks that no two indexable
// pages share a title or a description and that every note is near the home
// page (`site-checks.ts`): a build that completes passed those checks.
const SITE = fileURLToPath(new URL('..', import.meta.url))

const PATIENT = '20 Library/20.04 Books/The Patient Gardener (Book).md'
const SEEDS = '20 Library/20.04 Books/Seeds of Time (Book).md'
const LETTER_1 = '40 Writing/Letters/Garden letter 1 (Newsletter).md'
const LETTER_2 = '40 Writing/Letters/Garden letter 2 (Newsletter).md'
const MULCH = '40 Writing/AI Wiki - Mulch.md'
const WELCOME = 'Welcome.md'
const FILM = '20 Library/20.01 Films/The Lantern Keeper (2019).md'

let stores: TestStores | undefined
let outDir: string | undefined
let exitCode = -1
let map: ResolverMap | undefined
const notes = new Map<string, Root>()

function textOf(node: Element | Root | undefined | null): string {
    return node === undefined || node === null ? '' : toText(node).replace(/\s+/gu, ' ').trim()
}

function noteOf(vaultPath: string): Root {
    const page = notes.get(vaultPath)
    if (page === undefined) {
        throw new Error(`the build made no page for "${vaultPath}"`)
    }
    return page
}

/** The page that the resolver serves for a path of the site. */
async function served(path: string): Promise<Root> {
    if (map === undefined || outDir === undefined) {
        throw new Error('the site was not built')
    }
    const resolution = resolve(path, map)
    if (resolution.kind !== 'page') {
        throw new Error(`"${path}" is no page: ${resolution.kind}`)
    }
    return fromHtml(await readFile(join(outDir, resolution.file), 'utf8'))
}

function titleOf(page: Root): string {
    return textOf(select('title', page))
}

function metaOf(page: Root, name: string): string | undefined {
    const content = select(`meta[name="${name}"]`, page)?.properties['content']
    return typeof content === 'string' ? content : undefined
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
    const queue = await status(device)
    const planned = await plan(device, { include: queue.new })
    await publish(device, planned.id, {
        time: '2031-05-01T00:00:00Z',
        device: 'garden-shed',
        face: 'command-line'
    })
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'note-types-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    exitCode = await child.exited
    if (exitCode !== 0) return
    map = JSON.parse(await readFile(join(outDir, '-', 'resolver-map.json'), 'utf8')) as ResolverMap
    const manifest = join(contentStore, 'manifest')
    for (const name of await readdir(manifest)) {
        const entry = JSON.parse(await readFile(join(manifest, name), 'utf8')) as {
            id: string
            path: string
            state: string
        }
        if (entry.state !== 'published') continue
        const html = await readFile(join(outDir, '-', 'note', `${entry.id}.html`), 'utf8')
        notes.set(entry.path, fromHtml(html))
    }
}, 300_000)

afterAll(async () => {
    // Remove only the folders that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

describe('build of the fixture vault with note types', () => {
    test('completes, so its checks of titles, descriptions and links passed', () => {
        expect(exitCode).toBe(0)
        expect(notes.size).toBeGreaterThan(80)
    })
})

describe('the title of a note page (IDX-01, IDX-03, IDX-07)', () => {
    test('is the display title, the type word and the site name; the H1 is the display title', () => {
        const page = noteOf(PATIENT)
        expect(titleOf(page)).toBe('The Patient Gardener · Book · Sébastien’s Notes')
        expect(textOf(select('h1', page))).toBe('The Patient Gardener')
        expect(selectAll('h1', page)).toHaveLength(1)
    })

    test('takes the first heading over the file name, and drops a prefix of the type', () => {
        expect(textOf(select('h1', noteOf(SEEDS)))).toBe('Seeds of Time')
        expect(textOf(select('h1', noteOf(MULCH)))).toBe('Mulch')
        expect(titleOf(noteOf(MULCH))).toBe('Mulch · AI wiki article · Sébastien’s Notes')
    })

    test('takes the file name without the suffix when two notes share their first heading', () => {
        expect(textOf(select('h1', noteOf(LETTER_1)))).toBe('Garden letter 1')
        expect(titleOf(noteOf(LETTER_2))).toBe('Garden letter 2 · Newsletter · Sébastien’s Notes')
    })

    test('has no type word for a note with no type', () => {
        expect(titleOf(noteOf(WELCOME))).toBe('Welcome · Sébastien’s Notes')
        expect(select('[data-type-badge]', noteOf(WELCOME))).toBeUndefined()
    })
})

describe('the type badge of a note page', () => {
    test('names the type and leads to its hub', () => {
        const badge = select('[data-type-badge]', noteOf(FILM))
        expect(textOf(badge)).toBe('Movie')
        expect(badge?.properties['href']).toBe('/-/types/movies')
    })
})

describe('the description of a note page (IDX-05)', () => {
    test('is the description property', () => {
        expect(metaOf(noteOf(SEEDS), 'description')).toBe(
            'A short history of seed banks, told by the people who keep them.'
        )
    })

    test('is made from the type, the properties and the text without one', () => {
        expect(metaOf(noteOf(PATIENT), 'description')).toBe(
            'Book, rated 4 by Sébastien, read. A slow book about waiting for things to grow, one season at a time.'
        )
    })

    test('is on every note page', () => {
        for (const [path, page] of notes) {
            expect(metaOf(page, 'description')?.length ?? 0, path).toBeGreaterThan(10)
        }
    })
})

describe('the type hubs (NAV-03)', () => {
    test('list the notes of a type from A to Z, with an indexed page and its canonical link', async () => {
        const hub = await served('/-/types/movies')
        expect(titleOf(hub)).toBe('Movies · Sébastien’s Notes')
        expect(textOf(select('[data-list-title]', hub))).toBe('Movies')
        expect(textOf(select('[data-list-count]', hub))).toBe('2 notes, from A to Z.')
        expect(selectAll('[data-listed-note]', hub).map((link) => textOf(link))).toEqual([
            'The Lantern Keeper (2019)',
            'The Quiet Orchard (2021)'
        ])
        expect(metaOf(hub, 'robots')).toBeUndefined()
        expect(metaOf(hub, 'description')).toBe('Movies of Sébastien’s Notes: 2 notes from A to Z.')
        expect(select('link[rel="canonical"]', hub)?.properties['href']).toBe(
            'https://notes.dsebastien.net/-/types/movies'
        )
    })

    test('use the display name of the Starter Kit for a type that the site does not know', async () => {
        expect(textOf(select('[data-list-title]', await served('/-/types/recipes')))).toBe(
            'Recipes'
        )
    })

    test('are listed on the home page, with the library', async () => {
        const home = await served('/')
        const hubs = selectAll('[data-type-hubs] a', home).map((link) => link.properties['href'])
        expect(hubs).toContain('/-/types/movies')
        expect(hubs).toContain('/-/types/permanent-notes')
        expect(select('a[href="/-/library"]', home)).toBeDefined()
        expect(metaOf(home, 'description')?.startsWith('Sébastien’s Notes:')).toBe(true)
    })

    test('of the media types are in the library', async () => {
        const library = await served('/-/library')
        expect(
            selectAll('[data-library] a', library).map((link) => link.properties['href'])
        ).toEqual(['/-/types/movies'])
    })
})

describe('the list of the notes with no type', () => {
    test('holds them, and the home page links to it', async () => {
        const other = await served('/-/other')
        expect(selectAll('[data-listed-note]', other).map((link) => textOf(link))).toEqual([
            'Welcome'
        ])
        expect(titleOf(other)).toBe('Other notes · Sébastien’s Notes')
        const hubs = selectAll('[data-type-hubs] a', await served('/')).map(
            (link) => link.properties['href']
        )
        expect(hubs).toContain('/-/other')
    })
})

describe('the tag pages (NAV-04)', () => {
    test('list the notes of a tag and of its nested tags', async () => {
        const topic = await served('/-/tags/topic')
        const water = await served('/-/tags/topic/water')
        const inWater = selectAll('[data-listed-note]', water).map((link) => textOf(link))
        expect(inWater.length).toBeGreaterThan(0)
        expect(
            selectAll('[data-child-tags] a', topic).map((link) => link.properties['href'])
        ).toContain('/-/tags/topic/water')
        const inTopic = selectAll('[data-listed-note]', topic).map((link) => textOf(link))
        for (const title of inWater) {
            expect(inTopic.some((shown) => shown.startsWith(title))).toBe(true)
        }
    })

    test('are not indexed for a tag of the system or a tag with fewer than 5 notes', async () => {
        expect(metaOf(await served('/-/tags/type/note'), 'robots')).toBe('noindex, follow')
        const water = await served('/-/tags/topic/water')
        const count = selectAll('[data-listed-note]', water).length
        expect(metaOf(water, 'robots')).toBe(count < 5 ? 'noindex, follow' : undefined)
    })

    test('are the target of the tags of the properties panel', () => {
        const tags = selectAll('[data-property="tags"] a', noteOf(FILM)).map(
            (link) => link.properties['href']
        )
        expect(tags).toContain('/-/tags/type/movie')
    })
})
