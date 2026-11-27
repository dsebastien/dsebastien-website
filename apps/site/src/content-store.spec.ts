import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rejectionOf } from '@dsebastien-website/testing'
import {
    readImportRun,
    readNoindexFolders,
    readPublication,
    readPublishedNotes,
    readRedirectList
} from './content-store.ts'

// How the build reads the content store. A content store that cannot be
// trusted stops the build: a site with a part of the notes must never go out
// as if it were the whole site.
const SITE = fileURLToPath(new URL('..', import.meta.url))

const ENTRY = {
    aliases: [],
    attachments: [],
    cleanedHash: 'sha256:0',
    cleaningVersion: 2,
    firstPublished: '2031-04-01T08:00:00Z',
    formerPaths: [],
    lastPublished: '2031-04-01T08:00:00Z',
    links: [],
    sourceHash: 'sha256:0',
    state: 'published'
}

let folder: string | undefined

/** Makes a content store with these manifest files and names it in the variable that the build reads. */
async function contentStore(manifest: Record<string, unknown>): Promise<void> {
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    folder = await mkdtemp(join(cache, 'content-store-spec-'))
    await mkdir(join(folder, 'manifest'))
    for (const [name, entry] of Object.entries(manifest)) {
        await Bun.write(join(folder, 'manifest', name), JSON.stringify(entry))
    }
    process.env['CONTENT_STORE'] = folder
}

afterEach(async () => {
    delete process.env['CONTENT_STORE']
    // Remove only a folder that this test made.
    if (folder !== undefined) {
        await rm(folder, { recursive: true, force: true })
        folder = undefined
    }
})

describe('published notes of a content store', () => {
    test('are the entries of the manifest, with the canonical path and the page file of each', async () => {
        await contentStore({
            'b.json': {
                ...ENTRY,
                id: 'bbbbbbbbbbbbbbbb',
                path: 'Welcome.md',
                links: [{ link: 'Compost basics', path: '10 Garden/Compost basics.md' }],
                attachments: [
                    {
                        hash: 'sha256:a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33',
                        height: 12,
                        link: 'garden-plan.png',
                        path: 'Attachments/garden-plan.png',
                        size: 78,
                        width: 16
                    },
                    {
                        hash: 'sha256:a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33',
                        link: 'map.pdf',
                        path: 'Maps/map.pdf',
                        size: 9
                    }
                ]
            },
            'a.json': {
                ...ENTRY,
                id: 'aaaaaaaaaaaaaaaa',
                path: '10 Garden/Compost basics.md',
                aliases: ['Composting'],
                formerPaths: ['Shed/Compost.md', 'Compost basics.md'],
                firstPublished: '2031-03-01T07:30:00Z',
                lastPublished: '2031-03-20T18:05:00Z'
            }
        })

        expect(await readPublishedNotes()).toEqual([
            {
                id: 'aaaaaaaaaaaaaaaa',
                vaultPath: '10 Garden/Compost basics.md',
                path: '/10+Garden/Compost+basics',
                file: '-/note/aaaaaaaaaaaaaaaa.html',
                markdownFile: '-/md/aaaaaaaaaaaaaaaa.md',
                aliases: ['Composting'],
                formerPaths: ['Shed/Compost.md', 'Compost basics.md'],
                title: 'Compost basics',
                firstPublished: '2031-03-01T07:30:00Z',
                lastPublished: '2031-03-20T18:05:00Z',
                links: [],
                attachments: []
            },
            {
                id: 'bbbbbbbbbbbbbbbb',
                vaultPath: 'Welcome.md',
                path: '/Welcome',
                file: '-/note/bbbbbbbbbbbbbbbb.html',
                markdownFile: '-/md/bbbbbbbbbbbbbbbb.md',
                aliases: [],
                formerPaths: [],
                title: 'Welcome',
                firstPublished: '2031-04-01T08:00:00Z',
                lastPublished: '2031-04-01T08:00:00Z',
                links: [{ link: 'Compost basics', path: '10 Garden/Compost basics.md' }],
                attachments: [
                    {
                        link: 'garden-plan.png',
                        key: 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33',
                        url: '/-/attachments/a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33/garden-plan.png',
                        name: 'garden-plan.png',
                        width: 16,
                        height: 12
                    },
                    {
                        link: 'map.pdf',
                        key: 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33',
                        url: '/-/attachments/a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33/map.pdf',
                        name: 'map.pdf'
                    }
                ]
            }
        ])
    })

    test('read an entry whose update is held (updateHeld) as any other entry, published or not (issue 106)', async () => {
        await contentStore({
            'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'Held.md', updateHeld: true },
            'b.json': {
                ...ENTRY,
                id: 'bbbbbbbbbbbbbbbb',
                path: 'Gone.md',
                state: 'unpublished',
                updateHeld: true
            }
        })

        const notes = await readPublishedNotes()

        expect(notes.map((note) => [note.vaultPath, note.id])).toEqual([
            ['Held.md', 'aaaaaaaaaaaaaaaa']
        ])
        expect(Object.keys(notes[0] ?? {})).not.toContain('updateHeld')
        expect((await readPublication()).removed.map((note) => note.vaultPath)).toEqual(['Gone.md'])
    })

    test('read the post that the tool verified as the original of a note (issue 55)', async () => {
        const original = {
            checked: '2031-04-01T08:00:00Z',
            url: 'https://www.dsebastien.net/a-post/'
        }
        await contentStore({
            'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'Article.md', original },
            'b.json': { ...ENTRY, id: 'bbbbbbbbbbbbbbbb', path: 'Other.md' }
        })

        const notes = await readPublishedNotes()

        expect(notes.map((note) => note.original)).toEqual([original.url, undefined])
    })

    // The canonical link of the page names the original: it must be a post
    // of the main site, as the tool records it.
    const wrongOriginals: [string, unknown][] = [
        ['an original that is a text', 'https://www.dsebastien.net/a-post/'],
        ['an original without a time', { url: 'https://www.dsebastien.net/a-post/' }],
        [
            'an original on another host',
            { checked: ENTRY.firstPublished, url: 'https://example.net/a/' }
        ],
        [
            'an original not in its comparison form',
            { checked: ENTRY.firstPublished, url: 'https://www.dsebastien.net/A-Post' }
        ]
    ]
    test.each(wrongOriginals)('stop the build when an entry has %s', async (_name, original) => {
        await contentStore({
            'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'Article.md', original }
        })

        expect(await rejectionOf(readPublishedNotes())).toContain('manifest entry')
    })

    test('are none when the build has no content store', async () => {
        expect(await readPublishedNotes()).toEqual([])
    })

    test('stop the build when the content store is not a folder', async () => {
        process.env['CONTENT_STORE'] = join(SITE, '.cache', 'no-such-content-store')

        expect(await rejectionOf(readPublishedNotes())).toContain('not a folder')
    })

    test('stop the build when two entries have the same path', async () => {
        await contentStore({
            'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'Welcome.md' },
            'b.json': { ...ENTRY, id: 'bbbbbbbbbbbbbbbb', path: 'Welcome.md' }
        })

        expect(await rejectionOf(readPublishedNotes())).toContain('Welcome.md')
    })

    test('stop the build when an entry is not a manifest entry', async () => {
        await contentStore({ 'a.json': ['not', 'an', 'entry'] })

        expect(await rejectionOf(readPublishedNotes())).toContain('manifest entry')
    })

    // The id becomes the name of a file of the site.
    test('stop the build when an id is not 16 hexadecimal digits', async () => {
        await contentStore({ 'a.json': { ...ENTRY, id: '../../outside', path: 'Welcome.md' } })

        expect(await rejectionOf(readPublishedNotes())).toContain('manifest entry')
    })

    // A former path becomes an address of the site (URL-21, R66).
    for (const former of [['../Outside.md'], ['Old'], ['a//b.md'], [3], 'Old.md']) {
        test(`stop the build when the former paths are ${JSON.stringify(former)}`, async () => {
            await contentStore({
                'a.json': {
                    ...ENTRY,
                    id: 'aaaaaaaaaaaaaaaa',
                    path: 'Welcome.md',
                    formerPaths: former
                }
            })

            expect(await rejectionOf(readPublishedNotes())).toContain('manifest entry')
        })
    }

    // The page of a note shows a date of publication when the note has no date
    // property (PAGE-05).
    const wrongDates: [string, Record<string, unknown>][] = [
        ['no first publication', { firstPublished: undefined }],
        ['a last publication that is not a time', { lastPublished: 'yesterday' }]
    ]
    for (const [name, change] of wrongDates) {
        test(`stop the build when an entry has ${name}`, async () => {
            await contentStore({
                'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'Welcome.md', ...change }
            })

            expect(await rejectionOf(readPublishedNotes())).toContain('manifest entry')
        })
    }

    // The page of a note reads its links from the entry.
    const wrongLinks: [string, unknown][] = [
        ['no links', undefined],
        ['links that are not a list', 'Welcome'],
        ['a link without the path of its target', [{ link: 'Welcome' }]]
    ]
    test.each(wrongLinks)('stop the build when an entry has %s', async (_name, links) => {
        await contentStore({
            'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'Welcome.md', links }
        })

        expect(await rejectionOf(readPublishedNotes())).toContain('manifest entry')
    })
})

// The import (decision R62): the run of the first publication of the content
// store, read from every entry, so that an unpublished note still counts.
describe('the import run of a content store', () => {
    test('is the earliest first publication of any entry, also of an unpublished one', async () => {
        await contentStore({
            'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'A.md', state: 'unpublished' },
            'b.json': {
                ...ENTRY,
                id: 'bbbbbbbbbbbbbbbb',
                path: 'B.md',
                firstPublished: '2031-05-01T00:00:00Z',
                lastPublished: '2031-05-01T00:00:00Z'
            }
        })
        expect(await readImportRun()).toBe('2031-04-01T08:00:00Z')
    })

    test('is none without a content store or without a publication', async () => {
        expect(await readImportRun()).toBeUndefined()
        await contentStore({})
        expect(await readImportRun()).toBeUndefined()
    })
})

// The notes that the author unpublished keep their entries: their addresses
// answer 410 (URL-27, decision R64). The build reads their paths and aliases
// only, never their cleaned notes.
describe('unpublished notes of a content store', () => {
    test('are the entries in the state unpublished, by path, with their aliases', async () => {
        await contentStore({
            'a.json': {
                ...ENTRY,
                id: 'aaaaaaaaaaaaaaaa',
                path: 'Z/Old.md',
                aliases: ['Gone'],
                formerPaths: ['Y/Older name.md'],
                state: 'unpublished'
            },
            'b.json': { ...ENTRY, id: 'bbbbbbbbbbbbbbbb', path: 'Live.md' },
            'c.json': { ...ENTRY, id: 'cccccccccccccccc', path: 'A/Older.md', state: 'unpublished' }
        })
        expect((await readPublication()).removed).toEqual([
            { vaultPath: 'A/Older.md', aliases: [], formerPaths: [] },
            { vaultPath: 'Z/Old.md', aliases: ['Gone'], formerPaths: ['Y/Older name.md'] }
        ])
        expect((await readPublishedNotes()).map((note) => note.vaultPath)).toEqual(['Live.md'])
    })

    test('are none without a content store', async () => {
        expect((await readPublication()).removed).toEqual([])
    })

    test('stop the build when an unpublished entry has the path of another entry', async () => {
        await contentStore({
            'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'Same.md', state: 'unpublished' },
            'b.json': { ...ENTRY, id: 'bbbbbbbbbbbbbbbb', path: 'Same.md' }
        })
        expect(await rejectionOf(readPublication())).toContain('"Same.md"')
    })

    test('stop the build when an entry has a state that is neither published nor unpublished', async () => {
        await contentStore({
            'a.json': { ...ENTRY, id: 'aaaaaaaaaaaaaaaa', path: 'Odd.md', state: 'hidden' }
        })
        expect(await rejectionOf(readPublication())).toContain('manifest/a.json')
    })
})

// The redirect list (issue 44): a private file of the content store that only
// the build reads. A list that cannot be read stops the build, with the name
// of the file and no old path of it.
describe('the redirect list of a content store', () => {
    test('is the list of redirects.json', async () => {
        await contentStore({})
        await Bun.write(
            join(folder ?? '', 'redirects.json'),
            JSON.stringify({ version: 1, gone: ['Old/Stats'] })
        )
        expect(await readRedirectList()).toEqual({
            redirects: [],
            gone: ['Old/Stats'],
            prefixes: []
        })
    })

    test('is empty without the file, and without a content store', async () => {
        expect(await readRedirectList()).toEqual({ redirects: [], gone: [], prefixes: [] })
        await contentStore({})
        expect(await readRedirectList()).toEqual({ redirects: [], gone: [], prefixes: [] })
    })

    test('stops the build when the file is not JSON or not a redirect list', async () => {
        await contentStore({})
        await Bun.write(join(folder ?? '', 'redirects.json'), '{ not json')
        expect(await rejectionOf(readRedirectList())).toContain('redirects.json')
        await Bun.write(join(folder ?? '', 'redirects.json'), JSON.stringify({ version: 2 }))
        expect(await rejectionOf(readRedirectList())).toContain('redirects.json')
    })
})

// The noindex folders (R103): the optional list of configuration.json of the
// content store, which the build applies. A wrong list stops the build, as it
// stops the publishing tool.
describe('the noindex folders of a content store', () => {
    test('are the list noindexFolders of configuration.json', async () => {
        await contentStore({})
        await Bun.write(
            join(folder ?? '', 'configuration.json'),
            JSON.stringify({
                denyList: ['Locked Shed'],
                noindexFolders: ['Seed Bank', 'Pond/Frogs']
            })
        )
        expect(await readNoindexFolders()).toEqual(['Seed Bank', 'Pond/Frogs'])
    })

    test('are empty without the list, without the file, and without a content store', async () => {
        expect(await readNoindexFolders()).toEqual([])
        await contentStore({})
        expect(await readNoindexFolders()).toEqual([])
        await Bun.write(join(folder ?? '', 'configuration.json'), JSON.stringify({ denyList: [] }))
        expect(await readNoindexFolders()).toEqual([])
    })

    test('stop the build when the list is wrong', async () => {
        await contentStore({})
        await Bun.write(
            join(folder ?? '', 'configuration.json'),
            JSON.stringify({ denyList: [], noindexFolders: ['Seed Bank/'] })
        )
        expect(await rejectionOf(readNoindexFolders())).toContain(
            'the noindex folders entry "Seed Bank/" is not a vault path'
        )
        await Bun.write(join(folder ?? '', 'configuration.json'), '{ not json')
        expect(await rejectionOf(readNoindexFolders())).toContain('configuration.json')
    })
})
