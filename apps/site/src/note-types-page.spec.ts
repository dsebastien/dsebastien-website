import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Element, Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { select, selectAll } from 'hast-util-select'
import { toText } from 'hast-util-to-text'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
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
import { SITE_NAME } from './site.ts'

// The generated pages on the built site: the note types (issue 49, decision
// R61) and the home page, the recent pages and the 404 page (issue 50, R62).
// The note types: the title of a page with its type word, the display title without the prefix and the
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
/** Published for the first time by the second run, after the import. */
const LATE = '10 Garden/Wormery.md'
/** Imported, then edited and published again by the second run. */
const EDITED = '10 Garden/Seed swap day.md'

let stores: TestStores | undefined
let outDir: string | undefined
let exitCode = -1
/** What the build wrote: the checks of the built site say there that they ran. */
let buildOutput = ''
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
    // Two runs (R62): the import holds every note but one; the second run
    // publishes that note for the first time and a real edit of another one.
    const queue = await status(device)
    const planned = await plan(device, { include: queue.new.filter((path) => path !== LATE) })
    await publish(device, planned.id, {
        time: '2031-05-01T00:00:00Z',
        device: 'garden-shed',
        face: 'command-line'
    })
    await appendFile(join(vault, EDITED), '\nBring a pencil too.\n')
    const second = await plan(device, { include: [LATE, EDITED] })
    await publish(device, second.id, {
        time: '2031-06-01T00:00:00Z',
        device: 'garden-shed',
        face: 'command-line'
    })
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'note-types-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'pipe',
        stderr: 'inherit'
    })
    buildOutput = await new Response(child.stdout).text()
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
        expect(buildOutput).toMatch(
            /\d+ pages: titles and descriptions unique, every indexable note within 4 links of the home page/u
        )
        expect(notes.size).toBeGreaterThan(80)
    })
})

describe('the title of every page (IDX-01)', () => {
    test('ends with the site name, also on a page that is not indexed', async () => {
        const built = outDir ?? ''
        const files = (await readdir(built, { recursive: true })).filter((file) =>
            file.endsWith('.html')
        )
        for (const folder of ['-/folder/', '-/choice/', '-/tags/', '-/note/']) {
            expect(
                files.some((file) => file.startsWith(folder)),
                folder
            ).toBe(true)
        }
        expect(files).toContain('404.html')
        const without: string[] = []
        for (const file of files) {
            const title = titleOf(fromHtml(await readFile(join(built, file), 'utf8')))
            if (title !== SITE_NAME && !title.endsWith(` · ${SITE_NAME}`)) {
                without.push(`${file}: ${title}`)
            }
        }
        expect(without).toEqual([])
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

    // Issue 94: the H1 keeps the display title, only the title of the page changes.
    test('takes the file name without the suffix when two notes share their first heading', () => {
        expect(titleOf(noteOf(LETTER_1))).toBe('Garden letter 1 · Newsletter · Sébastien’s Notes')
        expect(titleOf(noteOf(LETTER_2))).toBe('Garden letter 2 · Newsletter · Sébastien’s Notes')
        expect(textOf(select('h1', noteOf(LETTER_1)))).toBe('The garden letter')
        expect(textOf(select('h1', noteOf(LETTER_2)))).toBe('The garden letter')
        expect(select('meta[property="og:title"]', noteOf(LETTER_1))?.properties['content']).toBe(
            'Garden letter 1 · Newsletter'
        )
    })

    test('has no type word for a note with no type', () => {
        expect(titleOf(noteOf(WELCOME))).toBe('Welcome · Sébastien’s Notes')
        expect(select('[data-type-badge]', noteOf(WELCOME))).toBeUndefined()
    })
})

describe('the type badge of a note page', () => {
    test('names the type and leads to its hub, with a name that says where it leads', () => {
        const badge = select('[data-type-badge]', noteOf(FILM))
        expect(textOf(badge)).toBe('Movie')
        expect(badge?.properties['href']).toBe('/-/types/movies')
        expect(badge?.properties['ariaLabel']).toBe('Movie, all notes of this type')
        expect(badge?.properties['className']).toEqual(['badge-link'])
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
    test('are indexed with 5 notes or more (IDX-22)', async () => {
        expect(metaOf(await served('/-/types/permanent-notes'), 'robots')).toBeUndefined()
        expect(metaOf(await served('/-/types/movies'), 'robots')).toBe('noindex, follow')
    })

    test('list the notes of a type from A to Z, with its canonical link', async () => {
        const hub = await served('/-/types/movies')
        expect(titleOf(hub)).toBe('Movies · Sébastien’s Notes')
        expect(textOf(select('[data-list-title]', hub))).toBe('Movies')
        expect(textOf(select('[data-list-count]', hub))).toBe('2 notes, from A to Z.')
        expect(selectAll('[data-listed-note]', hub).map((link) => textOf(link))).toEqual([
            'The Lantern Keeper (2019)',
            'The Quiet Orchard (2021)'
        ])
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

    // The movies hub of the fixture vault has fewer than 5 notes: no hub of
    // the library is indexed, so the library is not either (IDX-22, issue 98).
    test('of the media types are in the library, not indexed with no indexed hub, with its title as its H1', async () => {
        const library = await served('/-/library')
        expect(
            selectAll('[data-library] a', library).map((link) => link.properties['href'])
        ).toEqual(['/-/types/movies'])
        expect(metaOf(library, 'robots')).toBe('noindex, follow')
        expect(titleOf(library)).toBe('Library · Sébastien’s Notes')
        expect(textOf(select('h1', library))).toBe('Library')
    })
})

describe('the list of the notes with no type', () => {
    test('holds them, and the home page links to it', async () => {
        const other = await served('/-/other')
        expect(selectAll('[data-listed-note]', other).map((link) => textOf(link))).toEqual([
            'Welcome'
        ])
        expect(titleOf(other)).toBe('Other notes · Sébastien’s Notes')
        expect(metaOf(other, 'robots')).toBe('noindex, follow')
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
        expect(
            selectAll('[data-listed-note] > span:first-child', water).map((link) => textOf(link))
        ).toEqual(['Drip irrigation', 'Rain barrel'])
        expect(
            selectAll('[data-child-tags] a', topic).map((link) => link.properties['href'])
        ).toEqual(['/-/tags/topic/water'])
        expect(
            selectAll('[data-listed-note] > span:first-child', topic).map((link) => textOf(link))
        ).toEqual(['Drip irrigation', 'Rain barrel'])
    })

    test('list a note whose tag is only in its text', async () => {
        for (const path of ['/-/tags/compost', '/-/tags/garden/soil', '/-/tags/garden']) {
            const titles = selectAll(
                '[data-listed-note] > span:first-child',
                await served(path)
            ).map((link) => textOf(link))
            expect(titles, path).toContain('Tags')
        }
    })

    test('are not indexed for a tag of the system or a tag with fewer than 5 notes', async () => {
        expect(metaOf(await served('/-/tags/type/note'), 'robots')).toBe('noindex, follow')
        // Two notes only.
        expect(metaOf(await served('/-/tags/topic/water'), 'robots')).toBe('noindex, follow')
    })

    test('are the target of the tags of the properties panel', () => {
        const tags = selectAll('[data-property="tags"] a', noteOf(FILM)).map(
            (link) => link.properties['href']
        )
        expect(tags).toContain('/-/tags/type/movie')
    })
})

/** The created or the updated date of the title band of a note page, by the path of the note. */
async function bandDate(path: string, which: 'created' | 'updated'): Promise<string> {
    const times = selectAll('[data-note-title] ~ p time', await served(path))
    const time = times[which === 'created' ? 0 : 1]?.properties['dateTime']
    return typeof time === 'string' ? time : ''
}

/** The paths and the dates of the notes of a list page. */
function listedDates(page: Root): { path: string; date: string }[] {
    return selectAll('[data-listed-note]', page).map((link) => {
        const time = select('[data-listed-date]', link)?.properties['dateTime']
        return {
            path: String(link.properties['href']),
            date: typeof time === 'string' ? time : ''
        }
    })
}

function newestFirst(dates: readonly string[]): boolean {
    return dates.every((date, index) => index === 0 || (dates[index - 1] ?? '') >= date)
}

describe('the home page (NAV-02, R62)', () => {
    test('has its blocks in order: topics, note types, recent notes, the stats line', async () => {
        const html = await readFile(join(outDir ?? '', 'index.html'), 'utf8')
        const at = [
            'data-topics',
            'data-type-hubs',
            'data-recent="added"',
            'data-recent="updated"',
            'data-stats'
        ].map((mark) => html.indexOf(mark))
        expect(at.every((position) => position > 0)).toBe(true)
        expect([...at].sort((one, two) => one - two)).toEqual(at)
    })

    test('leads to the maps of content as topics', async () => {
        const topics = selectAll('[data-topics] a', await served('/')).map(
            (link) => link.properties['href']
        )
        expect(topics).toEqual(['/10+Garden/Compost+basics'])
    })

    test('shows the 10 notes most recently added and updated, newest first, with a link to each list', async () => {
        const home = await served('/')
        for (const kind of ['added', 'updated']) {
            const items = selectAll(`[data-recent="${kind}"] li`, home)
            expect(items, kind).toHaveLength(10)
            const dates = items.map((item) => String(select('time', item)?.properties['dateTime']))
            expect(newestFirst(dates), kind).toBe(true)
            expect(
                select(`[data-recent="${kind}"] a[href="/-/recent/${kind}"]`, home),
                kind
            ).toBeDefined()
        }
    })

    test('ends with the stats line, whose last update is the newest day of the two lists', async () => {
        const stats = textOf(select('[data-stats]', await served('/')))
        expect(stats).toMatch(
            new RegExp(`^${String(notes.size)} notes, \\d+ note types and \\d+ tags\\. `, 'u')
        )
        // The second run only added Wormery and edited one note: both on 2031-06-01.
        expect(stats.endsWith('Last update: 2031-06-01.')).toBe(true)
    })
})

describe('the recent pages (NAV-05, PUB-70, PUB-71, R62)', () => {
    test('list the notes added, newest first; a note of the import keeps its created date', async () => {
        const page = await served('/-/recent/added')
        expect(titleOf(page)).toBe('Recently added notes · Sébastien’s Notes')
        expect(metaOf(page, 'robots')).toBeUndefined()
        const listed = listedDates(page)
        expect(listed).toHaveLength(Math.min(notes.size, 100))
        expect(newestFirst(listed.map((item) => item.date))).toBe(true)
        // The note of the second run comes first, with the date of that run
        // (its created property says 2031-03-06).
        expect(listed[0]).toEqual({ path: '/10+Garden/Wormery', date: '2031-06-01' })
        // The edited note keeps its created date: it was imported.
        expect(listed.find((item) => item.path === '/10+Garden/Seed+swap+day')?.date).toBe(
            '2031-03-03'
        )
        for (const { path, date } of listed.slice(1, 15)) {
            expect(date, path).toBe(await bandDate(path, 'created'))
        }
    })

    test('list the notes updated, newest first; a note unchanged since the import keeps its updated date', async () => {
        const listed = listedDates(await served('/-/recent/updated'))
        expect(newestFirst(listed.map((item) => item.date))).toBe(true)
        // The edit of the second run moved one note up (its updated property
        // still says 2031-03-03). The note that the second run published for
        // the first time is not here: it never changed.
        expect(listed[0]).toEqual({ path: '/10+Garden/Seed+swap+day', date: '2031-06-01' })
        expect(listed.map((item) => item.path)).not.toContain('/10+Garden/Wormery')
        for (const { path, date } of listed.slice(1, 15)) {
            expect(date, path).toBe(await bandDate(path, 'updated'))
        }
    })

    test('say what each date is, in an ordered list, with a canonical link', async () => {
        const added = await served('/-/recent/added')
        expect(textOf(select('[data-listed-when]', added))).toBe('Added 2031-06-01')
        expect(select('ol[data-list]', added)).toBeDefined()
        expect(select('link[rel="canonical"]', added)?.properties['href']).toBe(
            'https://notes.dsebastien.net/-/recent/added'
        )
        const updated = await served('/-/recent/updated')
        expect(textOf(select('[data-listed-when]', updated))).toBe('Changed 2031-06-01')
        const home = await served('/')
        expect(textOf(select('[data-recent="added"] [data-listed-when]', home))).toBe(
            'Added 2031-06-01'
        )
        expect(textOf(select('[data-recent="updated"] [data-listed-when]', home))).toBe(
            'Changed 2031-06-01'
        )
    })

    test('have a filter by note type: folded on a list, open on a filter page', async () => {
        expect(
            select('details[data-filters]', await served('/-/recent/added'))?.properties['open']
        ).toBeUndefined()
        expect(
            select('details[data-filters]', await served('/-/recent/added/movies'))?.properties[
                'open'
            ]
        ).toBe(true)
    })

    test('have a filter by note type: one page per type, not indexed', async () => {
        const movies = await served('/-/recent/added/movies')
        expect(titleOf(movies)).toBe('Recently added: Movies · Sébastien’s Notes')
        expect(metaOf(movies, 'robots')).toBe('noindex, follow')
        expect(
            listedDates(movies)
                .map((item) => item.path)
                .sort()
        ).toEqual([
            '/20+Library/20.01+Films/The+Lantern+Keeper+(2019)',
            '/20+Library/20.01+Films/The+Quiet+Orchard+(2021)'
        ])
        expect(select('link[rel="canonical"]', movies)?.properties['href']).toBe(
            'https://notes.dsebastien.net/-/recent/added/movies'
        )
        const filters = selectAll('[data-filters] a', movies).map((link) => link.properties['href'])
        expect(filters).toContain('/-/recent/added')
        expect(filters).toContain('/-/recent/added/permanent-notes')
        expect(textOf(select('[data-filters] [aria-current="page"]', movies))).toBe('Movies')
    })
})

describe('the 404 page (NAV-06, URL-26, R62)', () => {
    test('answers an unknown path, also under /-/, and leads home, to the recent lists and to the hubs', async () => {
        for (const path of ['/No+such+note', '/-/no-such-page']) {
            expect(resolve(path, map ?? { pages: {} }).kind, path).toBe('not-found')
        }
        const page = fromHtml(await readFile(join(outDir ?? '', '404.html'), 'utf8'))
        const links = selectAll('a', page).map((link) => link.properties['href'])
        for (const href of ['/', '/-/recent/added', '/-/recent/updated', '/-/types/movies']) {
            expect(links, href).toContain(href)
        }
        expect(metaOf(page, 'robots')).toBe('noindex, follow')
    })
})
