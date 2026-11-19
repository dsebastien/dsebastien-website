import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import type { Selection } from '../../plugin/src/publishing/plan.ts'
import { plan, publish, type PublicationReport } from '../../plugin/src/publishing/tool.ts'
import { startServer } from '../server/serve.ts'

// The links between notes, from the vault to a served page (issue 34): TEST-13
// and TEST-18 of the spec, through the tool, the build and the plain server.
//
// One content store is built three times:
// 1. a note with links is published, and no target of a link is;
// 2. a target is published, with no change to the note that links to it;
// 3. the target gets the ignore property, and a publication without a
//    selection removes it.
// The three builds use the same cache of Astro, as two builds of the real site do.
const SITE = fileURLToPath(new URL('..', import.meta.url))

const LINKING = '10 Garden/Drip irrigation.md'
const TARGET = '10 Garden/Rain barrel.md'
const TARGET_URL = '/10+Garden/Rain+barrel'
/** A note with a link and an embed to a note in a folder of the deny list. */
const WATERING = '10 Garden/Watering schedule.md'
/** A note with a link in a property, and embeds of a note that is not published. */
const SWAP = '10 Garden/Seed swap day.md'
/** A note that the test writes: a reference link, and a wikilink inside the text of a Markdown link. */
const ODD = 'Odd links.md'
const ODD_TEXT = [
    'By reference: [the barrel][b] and [a site][s].',
    '',
    'A link in a link: [**[[Rain barrel]]**](Rain%20barrel.md).',
    '',
    'Two definitions of one name: [a note first][n] and [a site first][w].',
    '',
    // Another link path than the one of the Markdown link above: the tool reads no definition.
    '[b]: 10%20Garden/Rain%20barrel.md',
    '[s]: https://garden.example/',
    // The first definition of a name wins.
    '[n]: Seed%20library%20rules.md',
    '[n]: https://garden.example/second',
    '[w]: https://garden.example/first',
    '[w]: Rain%20barrel.md',
    ''
].join('\n')

interface Build {
    exitCode: number
    /** The markup of the page of each published note, by its vault path. */
    pages: Map<string, string>
    /** Every file of the pages of notes. */
    files: string[]
    resolverMap: { pages: Record<string, string> }
    /** The status of the answer of the plain server for the canonical URL of the target. */
    targetStatus: number
}

let stores: TestStores | undefined
const builds: Build[] = []
const reports: PublicationReport[] = []
/** The files that the second publication changed in the content store. */
let secondCommit = ''
/** The targets that the entry of the linking note names after the third publication. */
let targetsOfHeldNote: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { cwd, env: gitEnvironment(), stdout: 'pipe' })
    const output = await new Response(child.stdout).text()
    await child.exited
    return output.trimEnd()
}

async function build(contentStore: string): Promise<Build> {
    // The output folder is inside the site, in a folder that git ignores: Astro
    // moves files into it, and a move to another file system fails.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    const outDir = await mkdtemp(join(cache, 'links-page-spec-'))
    try {
        const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
            cwd: SITE,
            env: { ...process.env, CONTENT_STORE: contentStore },
            stdout: 'ignore',
            stderr: 'ignore'
        })
        const exitCode = await child.exited
        if (exitCode !== 0) {
            return {
                exitCode,
                pages: new Map(),
                files: [],
                resolverMap: { pages: {} },
                targetStatus: 0
            }
        }
        const pages = new Map<string, string>()
        for (const file of await readdir(join(contentStore, 'manifest'))) {
            const entry = (await Bun.file(join(contentStore, 'manifest', file)).json()) as {
                id: string
                path: string
                state: string
            }
            if (entry.state === 'published') {
                pages.set(
                    entry.path,
                    await Bun.file(join(outDir, '-', 'note', `${entry.id}.html`)).text()
                )
            }
        }
        const server = await startServer({ dist: outDir, port: 0 })
        try {
            return {
                exitCode,
                pages,
                files: await readdir(join(outDir, '-', 'note')),
                resolverMap: (await Bun.file(join(outDir, '-', 'resolver-map.json')).json()) as {
                    pages: Record<string, string>
                },
                targetStatus: (await fetch(`${server.url}${TARGET_URL}`)).status
            }
        } finally {
            await server.stop()
        }
    } finally {
        // Remove only the folder that this test made.
        await rm(outDir, { recursive: true, force: true })
    }
}

beforeAll(async () => {
    stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({ vault, contentStore, attachmentStorage: stores.attachmentStorage })
    const run = async (selection: Selection, time: string): Promise<void> => {
        const planned = await plan(device, selection)
        reports.push(
            await publish(device, planned.id, { time, device: 'garden-shed', face: 'plugin' })
        )
    }

    await Bun.write(join(vault, ODD), ODD_TEXT)
    await run({ include: [LINKING, WATERING, SWAP, ODD] }, '2031-04-01T08:00:00Z')
    builds.push(await build(contentStore))

    await run({ include: [TARGET] }, '2031-04-02T08:00:00Z')
    secondCommit = await git(contentStore, 'diff', '--name-only', 'HEAD~1', 'HEAD')
    builds.push(await build(contentStore))

    const text = await Bun.file(join(vault, TARGET)).text()
    await Bun.write(join(vault, TARGET), text.replace('---\n', '---\npublish_ignore: true\n'))
    // The note that links is held: its entry still names the target, so only
    // the state of the target in the manifest can make the page right.
    await run({ include: [], hold: [LINKING] }, '2031-04-03T08:00:00Z')
    for (const file of await readdir(join(contentStore, 'manifest'))) {
        const entry = (await Bun.file(join(contentStore, 'manifest', file)).json()) as {
            path: string
            links: { path: string }[]
        }
        if (entry.path === LINKING) {
            targetsOfHeldNote = entry.links.map((link) => link.path)
        }
    }
    builds.push(await build(contentStore))
}, 540_000)

afterAll(async () => {
    await stores?.remove()
})

function buildOf(index: number): Build {
    const result = builds[index]
    if (result === undefined) {
        throw new Error(`the build ${String(index + 1)} did not run`)
    }
    return result
}

function page(index: number, note: string): string {
    const html = buildOf(index).pages.get(note)
    if (html === undefined) {
        throw new Error(`the build ${String(index + 1)} has no page for "${note}"`)
    }
    return html
}

/** The text of the note on its page: the frame of the page has links of its own (the header, the skip link). */
function noteOf(html: string): string {
    const text = /<article[^>]*>([\s\S]*)<\/article>/u.exec(html)?.[1]
    if (text === undefined) {
        throw new Error('the page has no article')
    }
    return text
}

describe('page of a note whose link targets are not published', () => {
    test('the build completes', () => {
        expect(buildOf(0).exitCode).toBe(0)
    })

    test('shows a link, a link with a link text, an embed and a Markdown link as plain text in the style', () => {
        const html = page(0, LINKING)
        expect(html).toContain(
            'The hose starts at the <span class="not-published">Rain barrel</span>.'
        )
        expect(html).toContain('<span class="not-published">the barrel</span> or the')
        expect(html).toContain('<span class="not-published">Rain barrel#Cleaning</span>')
        expect(html).toContain(
            'With the full path: <span class="not-published">10 Garden/Rain barrel</span>. As a Markdown link: <span class="not-published">the barrel</span>.'
        )
    })

    test('shows a link to a name that no note has in the same way', () => {
        expect(page(0, LINKING)).toContain('<span class="not-published">Water butt</span>')
    })

    test('has no address of the target, and no link syntax', () => {
        const html = page(0, LINKING)
        expect(noteOf(html)).not.toContain('<a ')
        expect(html).not.toContain('Rain+barrel')
        expect(html).not.toContain('[[')
        expect(html).not.toContain('note-link')
    })

    test('shows a link and an embed to a note in a folder of the deny list as plain text', () => {
        const html = page(0, WATERING)
        expect(html).toContain('code of <span class="not-published">Greenhouse alarm code</span>.')
        expect(noteOf(html)).not.toContain('<a ')
        expect(html).not.toContain('90 Locked Shed')
        expect(html).not.toContain('90+Locked+Shed')
    })

    test('shows a link and an embed to a note that is not published as plain text', () => {
        const html = page(0, SWAP)
        expect(html).toContain(
            '<span class="not-published">Winter plan (draft)</span>. Its first section:'
        )
        expect(html).toContain('<span class="not-published">Winter plan (draft)#Beds</span>')
        expect(html).toContain('<span class="not-published">Seed library rules</span>')
        expect(noteOf(html)).not.toContain('<a ')
    })

    // The tool does not read a reference link, so it never has a target. It
    // must not stay a link to a file that the site does not have.
    test('shows a reference link to a note as plain text, and keeps a reference link to a site', () => {
        const html = page(0, ODD)
        expect(html).toContain(
            'By reference: <span class="not-published">the barrel</span> and <a href="https://garden.example/">a site</a>.'
        )
        expect(html).not.toContain('Rain%20barrel.md')
    })

    test('takes the first definition of a reference link, as the Markdown processor does', () => {
        const html = page(0, ODD)
        expect(html).toContain(
            'Two definitions of one name: <span class="not-published">a note first</span> and <a href="https://garden.example/first">a site first</a>.'
        )
        expect(html).not.toContain('.md"')
        expect(html).not.toContain('garden.example/second')
    })

    test('reads no link inside the text of a link: the markup stays well formed', () => {
        const html = page(0, ODD)
        expect(html).toContain(
            'A link in a link: <span class="not-published"><strong>[[Rain barrel]]</strong></span>.'
        )
        expect(html).not.toContain('note-link')
    })

    test('makes no page for a target, and the plain server answers 404 for its URL', () => {
        expect(buildOf(0).files).toHaveLength(4)
        expect(Object.keys(buildOf(0).resolverMap.pages)).not.toContain(TARGET_URL)
        expect(buildOf(0).targetStatus).toBe(404)
    })
})

describe('page of the same note after its target is published', () => {
    test('the publication changed no file of the note that links: only the files of the target', () => {
        const files = secondCommit.split('\n')
        expect(files).toHaveLength(2)
        expect(files).toContain(`notes/${TARGET}`)
        expect(files.filter((file) => file.startsWith('manifest/'))).toHaveLength(1)
    })

    test('the build completes', () => {
        expect(buildOf(1).exitCode).toBe(0)
    })

    test('shows each form of the link as a link to the canonical URL of the target', () => {
        const html = page(1, LINKING)
        expect(html).toContain(`The hose starts at the <a href="${TARGET_URL}">Rain barrel</a>.`)
        expect(html).toContain(`<a href="${TARGET_URL}">the barrel</a> or the`)
        expect(html).toContain(`<a href="${TARGET_URL}">Rain barrel#Cleaning</a>`)
        expect(html).toContain(
            `With the full path: <a href="${TARGET_URL}">10 Garden/Rain barrel</a>. As a Markdown link: <a href="${TARGET_URL}">the barrel</a>.`
        )
    })

    test('still shows the name that no note has as plain text', () => {
        expect(page(1, LINKING)).toContain('<span class="not-published">Water butt</span>')
    })

    test('shows the link around a link as one link, and the reference link still as plain text', () => {
        const html = page(1, ODD)
        expect(html).toContain(
            `A link in a link: <a href="${TARGET_URL}"><strong>[[Rain barrel]]</strong></a>.`
        )
        expect(html).toContain('By reference: <span class="not-published">the barrel</span>')
        expect(html).not.toContain('note-link')
    })

    test('the plain server answers 200 for the URL of the target', () => {
        expect(buildOf(1).resolverMap.pages[TARGET_URL]).toBeDefined()
        expect(buildOf(1).targetStatus).toBe(200)
    })
})

describe('site after the target got the ignore property', () => {
    // TEST-13: removed by the next publication, whatever is selected.
    test('the publication without a selection removed the target', () => {
        expect(reports[2]?.forcedRemoved).toEqual([TARGET])
        expect(reports[2]?.removed).toEqual([])
        expect(reports[2]?.skipped).toEqual([LINKING])
    })

    // The page must follow the manifest, not the entry of the note that links.
    test('the entry of the held note still names the target', () => {
        expect(targetsOfHeldNote).toContain(TARGET)
    })

    test('the build completes', () => {
        expect(buildOf(2).exitCode).toBe(0)
    })

    test('the URL of the target answers 404, and the site has no page of it', () => {
        expect(buildOf(2).targetStatus).toBe(404)
        expect(Object.keys(buildOf(2).resolverMap.pages)).not.toContain(TARGET_URL)
        expect(buildOf(2).files).toHaveLength(4)
        expect(buildOf(2).pages.has(TARGET)).toBe(false)
    })

    test('the note that links shows plain text again, with no address of the target', () => {
        const html = page(2, LINKING)
        expect(html).toContain(
            'The hose starts at the <span class="not-published">Rain barrel</span>.'
        )
        expect(noteOf(html)).not.toContain('<a ')
        expect(html).not.toContain('Rain+barrel')
    })
})
