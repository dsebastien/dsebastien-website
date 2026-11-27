import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { copyPreviewImages } from './build-previews.ts'
import { previewKey, readLinkPreviews } from './previews.ts'

const SITE = fileURLToPath(new URL('../..', import.meta.url))
const NOW = new Date('2031-05-01T08:00:00Z')
const SOIL = { url: 'https://garden.example/soil', video: false }

let work = ''

beforeEach(async () => {
    const parent = join(SITE, '.cache')
    await mkdir(parent, { recursive: true })
    work = await mkdtemp(join(parent, 'build-previews-spec-'))
})

afterEach(async () => {
    await rm(work, { recursive: true, force: true })
})

describe('the images of the cards in the output (CARD-07)', () => {
    test('only the images of the previews go to the output; a name in a note text is no file', async () => {
        const cache = join(work, 'cache')
        const output = join(work, 'dist')
        const photo = await sharp({
            create: { width: 640, height: 336, channels: 3, background: '#5a8f3c' }
        })
            .png()
            .toBuffer()
        const previews = await readLinkPreviews([SOIL], {
            cache,
            now: NOW,
            fetch: async (url) =>
                Promise.resolve(
                    url.endsWith('.png')
                        ? new Response(new Uint8Array(photo), {
                              headers: { 'content-type': 'image/png' }
                          })
                        : new Response('<meta property="og:image" content="/soil.png">', {
                              headers: { 'content-type': 'text/html' }
                          })
                )
        })
        const path = previews.get(previewKey(SOIL) ?? '')?.image?.path ?? ''
        expect(path).not.toBe('')
        const written = `/-/link-previews/${'ab'.repeat(32)}.webp`
        await mkdir(join(output, 'notes'), { recursive: true })
        await writeFile(
            join(output, 'notes', 'index.html'),
            `<img src="${path}"><p>A note names ${written} in its text.</p>`
        )
        expect(await copyPreviewImages(output, cache)).toBe(1)
        expect(await readdir(join(output, '-', 'link-previews'))).toEqual([
            path.slice(path.lastIndexOf('/') + 1)
        ])
    })

    test('a build whose pages name no image of the previews copies nothing', async () => {
        const output = join(work, 'dist')
        await mkdir(output, { recursive: true })
        await writeFile(
            join(output, 'index.html'),
            `<p>/-/link-previews/${'cd'.repeat(32)}.webp</p>`
        )
        expect(await copyPreviewImages(output, join(work, 'cache'))).toBe(0)
    })
})
