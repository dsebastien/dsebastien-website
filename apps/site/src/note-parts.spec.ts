import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Element, Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { select, selectAll } from 'hast-util-select'
import { toText } from 'hast-util-to-text'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    FIXTURE_NOTE_TYPES,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { fileNoteTypes, nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../../plugin/src/publishing/tool.ts'

// The parts of a note page that come from data (issue 48, PAGE-02 to PAGE-04,
// R59): the properties panel, the backlinks with the sentence around each
// link, and the outline. The tool publishes the fixture vault but one note,
// the site is built, and the tests read the pages of the output.
const SITE = fileURLToPath(new URL('..', import.meta.url))

const FILM = '20 Library/20.01 Films/The Lantern Keeper (2019).md'
const ORCHARD = '20 Library/20.01 Films/The Quiet Orchard (2021).md'
const ADA = '30 People/Ada Quillfeather.md'
const BARREL = '10 Garden/Rain barrel.md'
const SWAP = '10 Garden/Seed swap day.md'
const FROST = '10 Garden/Frost dates explained.md'
/** A note whose type has a suffix: its display title has no suffix. */
const BOOK = '20 Library/20.04 Books/The Patient Gardener (Book).md'
const HEADINGS = '50 Field guide/Text/Headings with the same text.md'
/** The one note that stays in the vault: a link to it is plain text. */
const NOT_PUBLISHED = '10 Garden/Winter plan (draft).md'
/** A note that the test adds to its copy of the vault: dates in the forms of a vault, and links in code. */
const DATED = '10 Garden/Dated note.md'

let stores: TestStores | undefined
let outDir: string | undefined
let exitCode = -1
const pages = new Map<string, Root>()
const sources = new Map<string, string>()

/** The page of a note of the fixture vault. */
function pageOf(vaultPath: string): Root {
    const page = pages.get(vaultPath)
    if (page === undefined) {
        throw new Error(`the build made no page for "${vaultPath}"`)
    }
    return page
}

function textOf(node: Element | undefined): string {
    return node === undefined ? '' : toText(node).replace(/\s+/gu, ' ').trim()
}

/** The row of a property in the panel of a page. */
function rowOf(vaultPath: string, key: string): Element | undefined {
    return select(`[data-properties] [data-property="${key}"]`, pageOf(vaultPath)) ?? undefined
}

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    // The note that stays in the vault links to a published note: it is no backlink.
    await appendFile(join(vault, NOT_PUBLISHED), '\nThe water comes from the [[Rain barrel]].\n')
    await writeFile(
        join(vault, DATED),
        [
            '---',
            'tags:',
            '  - type/note',
            '  - ../../Welcome',
            'seen: 2031-03-09T08:00:00+02:00',
            'never: 2031-02-30',
            'see: "[[Rain barrel#Cleaning]]"',
            'created: 2031-03-09T01:00:00+02:00',
            'updated: 2031-03-10T09:30',
            '---',
            '',
            '# Dated note',
            '',
            'A link in code is no link: `[[Compost basics]]`.',
            '',
            '```text',
            '[[Compost basics]]',
            '```',
            ''
        ].join('\n')
    )
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const queue = await status(device)
    const planned = await plan(device, {
        include: queue.new.filter((path) => path !== NOT_PUBLISHED)
    })
    await publish(device, planned.id, {
        time: '2031-05-01T00:00:00Z',
        device: 'garden-shed',
        face: 'command-line'
    })
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'note-parts-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    exitCode = await child.exited
    if (exitCode !== 0) return
    const manifest = join(contentStore, 'manifest')
    for (const name of await readdir(manifest)) {
        const entry = JSON.parse(await readFile(join(manifest, name), 'utf8')) as {
            id: string
            path: string
            state: string
        }
        if (entry.state !== 'published') continue
        const html = await readFile(join(outDir, '-', 'note', `${entry.id}.html`), 'utf8')
        sources.set(entry.path, html)
        pages.set(entry.path, fromHtml(html))
    }
}, 300_000)

afterAll(async () => {
    // Remove only the folders that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

describe('build of the fixture vault', () => {
    test('completes, with a page per published note', () => {
        expect(exitCode).toBe(0)
        expect(pages.size).toBeGreaterThan(50)
        expect(pages.has(NOT_PUBLISHED)).toBe(false)
    })
})

describe('properties panel of a note page (PAGE-02)', () => {
    test('is in the HTML of the page, closed, before the text of the note', () => {
        const panel = select('details[data-properties]', pageOf(FILM))
        const html = sources.get(FILM) ?? ''

        expect(panel).toBeDefined()
        expect(panel?.properties['open']).toBeUndefined()
        expect(textOf(select('summary span', panel ?? undefined) ?? undefined)).toBe('Properties')
        expect(html.indexOf('data-properties')).toBeGreaterThan(0)
        expect(html.indexOf('data-properties')).toBeLessThan(html.indexOf('data-note-body'))
    })

    test('shows the properties of the note in their order, without the empty ones', () => {
        const rows = selectAll('[data-properties] [data-property]', pageOf(FILM))

        // `rating` is empty in this note.
        expect(rows.map((row) => row.properties['dataProperty'])).toEqual([
            'tags',
            'status',
            'release_date',
            'directors',
            'created',
            'updated'
        ])
        expect(rows.map((row) => textOf(select('dt', row) ?? undefined))).toEqual([
            'Tags',
            'Status',
            'Release Date',
            'Directors',
            'Created',
            'Updated'
        ])
    })

    test('shows a text, a number, a truth value and a date by the rules of today', () => {
        expect(textOf(select('dd', rowOf(FILM, 'status')) ?? undefined)).toBe('To watch')
        expect(textOf(select('dd', rowOf(ORCHARD, 'rating')) ?? undefined)).toBe('4')
        expect(textOf(select('dd', rowOf(FROST, 'ai_generated')) ?? undefined)).toBe('✓ true')
        const release = select('dd time', rowOf(FILM, 'release_date'))
        expect(release?.properties['dateTime']).toBe('2019-10-04')
        expect(textOf(release ?? undefined)).toBe('2019-10-04')
        const created = select('dd time', rowOf(FILM, 'created'))
        expect(created?.properties['dateTime']).toBe('2031-03-09T08:00')
        expect(textOf(created ?? undefined)).toBe('2031-03-09, 08:00')
    })

    test('a link in a property is a link when its target is published', () => {
        const link = select('dd a', rowOf(FILM, 'directors'))

        expect(link?.properties['href']).toBe('/30+People/Ada+Quillfeather')
        expect(textOf(link ?? undefined)).toBe('Ada Quillfeather')
        // The link holds its text alone: a space inside it would be underlined.
        expect(sources.get(FILM)).toContain(
            '<a class="link-control" href="/30+People/Ada+Quillfeather">Ada Quillfeather</a>'
        )
    })

    test('a link in a property to a note that is not published is plain text, with no address', () => {
        const row = rowOf(SWAP, 'related')

        expect(textOf(select('dd .not-published', row) ?? undefined)).toBe('Winter plan (draft)')
        expect(selectAll('a', row)).toEqual([])
        expect(sources.get(SWAP)).not.toContain('Winter+plan')
    })

    test('the tags are links to their tag pages', () => {
        const tags = selectAll('dd a', rowOf(BARREL, 'tags'))

        expect(tags.map((tag) => [textOf(tag), tag.properties['href']])).toEqual([
            ['#type/note', '/-/tags/type/note'],
            ['#topic/water', '/-/tags/topic/water']
        ])
    })

    test('a web address is a link that opens another site in a new tab, and a list shows its items', () => {
        const site = select('dd a', rowOf(ADA, 'website'))

        expect(site?.properties['href']).toBe('https://quillfeather.example')
        expect(site?.properties['target']).toBe('_blank')
        expect(site?.properties['rel']).toEqual(['noopener', 'noreferrer'])
        expect(selectAll('dd li', rowOf(ADA, 'aliases')).map((item) => textOf(item))).toEqual([
            'A. Quillfeather'
        ])
        expect(textOf(select('dd', rowOf(ADA, 'date_of_birth')) ?? undefined)).toBe('1961-04-12')
    })

    test('runs the script of the panel right after the panel', () => {
        const html = sources.get(FILM) ?? ''
        const end = html.indexOf('</details>', html.indexOf('data-properties'))

        expect(html.slice(end, end + 200)).toMatch(/^<\/details>\s*<script>/u)
    })
})

describe('properties of a note with the dates and the tags of a real vault', () => {
    test('a time with a time zone shows as the vault writes it, and a day that does not exist is hidden', () => {
        const seen = select('dd time', rowOf(DATED, 'seen'))

        expect(seen?.properties['dateTime']).toBe('2031-03-09T08:00')
        expect(textOf(seen ?? undefined)).toBe('2031-03-09, 08:00')
        expect(rowOf(DATED, 'never')).toBeUndefined()
        // The title band keeps the day of the vault: it is the day before in UTC.
        expect(sources.get(DATED)).toContain(
            'Created <time datetime="2031-03-09">2031-03-09</time>'
        )
    })

    test('a text of the tags that is no tag is plain text, and writes no path of the site', () => {
        const row = rowOf(DATED, 'tags')

        expect(selectAll('a', row).map((tag) => tag.properties['href'])).toEqual([
            '/-/tags/type/note'
        ])
        expect(selectAll('li', row).map((item) => textOf(item))).toEqual([
            '#type/note',
            '../../Welcome'
        ])
    })

    test('a link to a heading shows the note and the heading, in the panel and as a backlink', () => {
        const link = select('dd a', rowOf(DATED, 'see'))

        expect(textOf(link ?? undefined)).toBe('Rain barrel > Cleaning')
        expect(link?.properties['href']).toBe('/10+Garden/Rain+barrel#cleaning')
    })
})

describe('backlinks of a note page (PAGE-03)', () => {
    const backlinksOf = (vaultPath: string): Element[] =>
        selectAll('[data-backlinks] [data-backlink]', pageOf(vaultPath))

    test('lists the notes that link to the note, the newest update first, then by title', () => {
        expect(
            backlinksOf(BARREL).map((backlink) => {
                const link = select('a', backlink)
                return [textOf(link ?? undefined), link?.properties['href']]
            })
        ).toEqual([
            ['Frozen table', '/50+Field+guide/Queries/Frozen+table'],
            ['Markdown links to notes', '/50+Field+guide/Links/Markdown+links+to+notes'],
            ['Reading list', '/40+Writing/Reading+list'],
            ['Dated note', '/10+Garden/Dated+note'],
            ['Drip irrigation', '/10+Garden/Drip+irrigation'],
            ['Garden index', '/10+Garden/Garden+index'],
            ['Compost basics', '/10+Garden/Compost+basics']
        ])
    })

    test('shows the sentence around each link, with the text of the link marked', () => {
        const [, markdown, , dated, drip, , compost] = backlinksOf(BARREL)

        expect(selectAll('[data-backlink-context]', compost).map((item) => textOf(item))).toEqual([
            'Water it from the Rain barrel when the summer is dry.'
        ])
        expect(textOf(select('[data-backlink-context] mark', compost) ?? undefined)).toBe(
            'Rain barrel'
        )
        // The mark holds the text of the link alone: no space goes into it or after it.
        expect(sources.get(BARREL)).toContain(
            'Water it from the <mark>Rain barrel</mark> when the summer is dry.</p>'
        )
        expect(sources.get(BARREL)).toContain(
            'The hose starts at the <mark>Rain barrel</mark>.</p>'
        )
        // A link of a property has the name of the property as its context.
        expect(textOf(select('[data-backlink-context]', dated) ?? undefined)).toBe(
            'See: Rain barrel > Cleaning'
        )
        // A Markdown link to a note is a link like any other.
        expect(textOf(select('[data-backlink-context]', markdown) ?? undefined)).toBe(
            'Fill the rain barrel first, then check the drip lines.'
        )
        // A note with many links shows three sentences at most. `Water butt` is
        // an alias, which is no link path, and a link to a heading shows the
        // note and the heading as Obsidian does.
        expect(selectAll('[data-backlink-context]', drip).map((item) => textOf(item))).toEqual([
            'The hose starts at the Rain barrel.',
            'People also call it the barrel or the Water butt.',
            'How to clean it: Rain barrel > Cleaning.'
        ])
        expect(selectAll('[data-backlink-context] mark', drip).map((item) => textOf(item))).toEqual(
            ['Rain barrel', 'the barrel', 'Rain barrel > Cleaning']
        )
    })

    test('names the number of the notes in the title of the section', () => {
        expect(textOf(select('[data-backlinks] h2', pageOf(BARREL)) ?? undefined)).toBe(
            'Notes that link here 7'
        )
    })

    test('a link in a property is a backlink, with the name of the property', () => {
        expect(
            backlinksOf(ADA).map((backlink) => [
                textOf(select('a', backlink) ?? undefined),
                textOf(select('[data-backlink-context]', backlink) ?? undefined)
            ])
        ).toEqual([
            ['The Quiet Orchard (2021)', 'Directors: Ada Quillfeather'],
            ['The Lantern Keeper (2019)', 'Directors: Ada Quillfeather']
        ])
    })

    // The note with links in code links to `Compost basics` nowhere else.
    test('a link inside code is no backlink', () => {
        const titles = backlinksOf('10 Garden/Compost basics.md').map((backlink) =>
            textOf(select('a', backlink) ?? undefined)
        )

        expect(titles).toContain('Reading list')
        expect(titles).not.toContain('Dated note')
    })

    test('a note that is not published is no backlink, and no file of the site names its address', async () => {
        const dist = outDir ?? ''
        const files = (await readdir(dist, { recursive: true })).filter((file) =>
            /\.(?:html|json|md|txt|xml)$/u.test(file)
        )
        const naming: string[] = []
        for (const file of files) {
            const text = await readFile(join(dist, file), 'utf8')
            // Its canonical path, its vault path, and the text that only it holds.
            if (
                /Winter\+plan|Winter%20plan|Winter plan \(draft\)\.md|The water comes from/u.test(
                    text
                )
            ) {
                naming.push(file)
            }
        }

        expect(files.length).toBeGreaterThan(100)
        expect(naming).toEqual([])
        const map = await readFile(join(dist, '-', 'resolver-map.json'), 'utf8')
        expect(map).not.toContain('winter plan')
    })

    test('a note that no note links to has no backlinks section', () => {
        expect(select('[data-backlinks]', pageOf(FILM))).toBeUndefined()
    })

    test('a note with few backlinks has them all on its page, and no page of backlinks', async () => {
        expect(select('[data-backlinks] a[href^="/-/backlinks/"]', pageOf(BARREL))).toBeUndefined()
        const map = JSON.parse(
            await readFile(join(outDir ?? '', '-', 'resolver-map.json'), 'utf8')
        ) as { pages: Record<string, string> }
        expect(Object.keys(map.pages).filter((path) => path.startsWith('/-/backlinks/'))).toEqual(
            []
        )
    })
})

describe('outline of a note page (PAGE-04)', () => {
    const itemsOf = (outline: Element | undefined): [string, unknown][] =>
        selectAll('a', outline).map((link) => [textOf(link), link.properties['href']])

    test('lists the headings of a note with enough headings, as links to them', () => {
        const rail = select('[data-outline="rail"]', pageOf(HEADINGS)) ?? undefined

        expect(itemsOf(rail)).toEqual([
            ['Spring', '#spring'],
            ['Tasks', '#tasks'],
            ['Autumn', '#autumn'],
            ['Tasks', '#autumn-tasks']
        ])
        expect(rail?.properties['ariaLabel']).toBe('On this page')
    })

    test('is also a closed folding block above the text, for a small screen', () => {
        const page = pageOf(HEADINGS)
        const fold = select('details[data-outline="fold"]', page) ?? undefined
        const html = sources.get(HEADINGS) ?? ''

        expect(fold?.properties['open']).toBeUndefined()
        expect(textOf(select('summary span', fold) ?? undefined)).toBe('On this page')
        expect(itemsOf(fold)).toEqual(itemsOf(select('[data-outline="rail"]', page) ?? undefined))
        expect(html.indexOf('data-outline="fold"')).toBeLessThan(html.indexOf('data-note-body'))
    })

    test('a note with few headings has no outline', () => {
        expect(selectAll('[data-outline]', pageOf(FROST))).toEqual([])
    })
})

// Issue 137: a plain link in the title band saves the Markdown form of the
// note, named after its title, with no script.
describe('download of the Markdown of a note page', () => {
    test('is a link of the title band to the download form, with the file name of the title', () => {
        const link = select('.title-band a[data-markdown-download]', pageOf(BARREL))
        expect(link?.properties['href']).toBe(
            '/-/md/10+Garden/Rain+barrel.md?download=Rain%20barrel.md'
        )
        expect(link?.properties['download']).toBe('Rain barrel.md')
        // One text for the name of the link and for its tooltip.
        expect(link?.properties['ariaLabel']).toBe('Download as Markdown')
        expect(link?.properties['title']).toBe('Download as Markdown')
        expect(textOf(select('[data-note-title]', pageOf(BARREL)) ?? undefined)).toBe('Rain barrel')
    })

    test('names the file after the display title, not the file name', () => {
        const link = select('.title-band a[data-markdown-download]', pageOf(BOOK))
        expect(link?.properties['download']).toBe('The Patient Gardener.md')
    })

    test('is on every note page', () => {
        for (const [path, page] of pages) {
            expect(selectAll('a[data-markdown-download]', page), path).toHaveLength(1)
        }
    })
})
