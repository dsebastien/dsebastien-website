import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rejectionOf } from '@dsebastien-website/testing'
import { readImportRun, readPublishedNotes } from './content-store.ts'

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
