import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    MAP_HEAD_FILE,
    mapHeadFrom,
    mapOfParts,
    mapPartFile,
    mapPartFrom,
    RESOLVER_MAP_FILE,
    resolverMapOf,
    type SiteFiles
} from '@dsebastien-website/resolver'
import { writeMapParts } from './map-parts.ts'

// The build writes the resolver map in parts after each build (issue 121, R94).

const FILES: SiteFiles = {
    home: 'index.html',
    notFound: '404.html',
    gone: '410.html',
    robots: 'robots.txt',
    icon: 'favicon.ico',
    page: (path) => `-/note/${String(path.length)}.html`,
    markdown: (path) => `-/md/${String(path.length)}.md`,
    folder: (path) => `-/folder/${String(path.length)}.html`,
    choice: (paths) => `-/choice/${String(paths.length)}.html`
}

let folder: string | undefined
afterEach(async () => {
    if (folder !== undefined) {
        await rm(folder, { recursive: true, force: true })
        folder = undefined
    }
})

describe('the map in parts of a build', () => {
    test('is written next to the whole map, and gives it back', async () => {
        folder = await mkdtemp(join(tmpdir(), 'map-parts-'))
        const map = resolverMapOf(
            Array.from({ length: 50 }, (_, index) => ({
                path: `Note ${String(index)}.md`,
                aliases: []
            })),
            FILES
        )
        await mkdir(join(folder, '-'), { recursive: true })
        await writeFile(join(folder, RESOLVER_MAP_FILE), JSON.stringify(map, null, 2))
        await writeMapParts(folder, 300)
        const head = mapHeadFrom(await Bun.file(join(folder, MAP_HEAD_FILE)).json())
        expect(head.parts).toBeGreaterThan(1)
        const parts = []
        for (let index = 0; index < head.parts; index += 1) {
            parts.push(
                mapPartFrom(await Bun.file(join(folder, mapPartFile(index))).json(), head, index)
            )
        }
        expect(mapOfParts(head, parts)).toEqual(map)
        // The folder holds the head and the parts, and nothing else.
        expect((await readdir(join(folder, '-', 'resolver-map'))).length).toBe(head.parts + 1)
    })

    test('a part with no key is written too: a host never meets a missing part', async () => {
        folder = await mkdtemp(join(tmpdir(), 'map-parts-'))
        await mkdir(join(folder, '-'), { recursive: true })
        await writeFile(
            join(folder, RESOLVER_MAP_FILE),
            JSON.stringify({ pages: { '/': 'i.html' } })
        )
        await writeMapParts(folder, 1)
        const head = mapHeadFrom(await Bun.file(join(folder, MAP_HEAD_FILE)).json())
        for (let index = 0; index < head.parts; index += 1) {
            expect(await Bun.file(join(folder, mapPartFile(index))).exists()).toBe(true)
        }
    })

    test('a build with no resolver map stops', async () => {
        folder = await mkdtemp(join(tmpdir(), 'map-parts-'))
        expect(writeMapParts(folder)).rejects.toThrow()
    })
})
