import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from '../../plugin/src/publishing/node/device.ts'
import { plan, publish } from '../../plugin/src/publishing/tool.ts'
import { startServer, type Server } from '../server/serve.ts'

// The attachments of a note, from the vault to a served page (issue 35,
// SEAM-05 of the spec): the tool publishes notes with an image, an image of a
// deny list folder and a large video, the build makes their pages, and the
// plain server gives the files from the attachment storage, also a part of a
// file for a range request (HOST-05).
const SITE = fileURLToPath(new URL('..', import.meta.url))
const TIME = '2031-04-01T08:00:00Z'

const PLAN = '10 Garden/Garden plan.md'
const PLAN_FILE = '-/note/d3bc99e6071c5b92.html'
const TOUR = '10 Garden/Tool shed tour.md'
const TOUR_FILE = '-/note/527f278c31d27ad7.html'
/** A note that the test writes, with a video that the test makes. */
const POND = '10 Garden/Pond video.md'
const POND_FILE = '-/note/72764ed831b43958.html'
const VIDEO = 'Attachments/pond.mp4'
/** Three MiB of invented bytes: a large media file, never committed. */
const VIDEO_BYTES = Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, index) => index % 251)

const IMAGE = 'Attachments/garden-plan.png'
const IMAGE_KEY = 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'
const IMAGE_URL = `/-/attachments/${IMAGE_KEY}/garden-plan.png`
const VIDEO_KEY = 'a1feacf0d812ba4d0b0e463ed45bbd583cea1de55c54693116754b30b5794745'
const VIDEO_URL = `/-/attachments/${VIDEO_KEY}/pond.mp4`
const DENIED_KEY = '86571f2b883d23bc5c95dc18aa3cef6077451c6f13a52c6f44373b667503c3a1'
/** A file whose kind is the name of a member of every object (issue 80). */
const ODD = 'Attachments/shed.constructor'
const ODD_BYTES = 'Invented bytes of a file with an odd name.\n'
const ODD_KEY = 'fc39dee91a025660efc6ef902ba1695ddfe24e3192e57c95081c3a010d28f5e2'
const ODD_URL = `/-/attachments/${ODD_KEY}/shed.constructor`

let stores: TestStores | undefined
let vault = ''
let outDir: string | undefined
let server: Server | undefined
let exitCode = -1

function outputPath(): string {
    if (outDir === undefined) {
        throw new Error('the output folder does not exist')
    }
    return outDir
}

function serverUrl(): string {
    if (server === undefined) {
        throw new Error('the server does not run')
    }
    return server.url
}

async function readOutput(path: string): Promise<string> {
    return await Bun.file(join(outputPath(), path)).text()
}

beforeAll(async () => {
    stores = await makeTestStores()
    vault = await copyFixtureVault(stores)
    await writeFile(join(vault, VIDEO), VIDEO_BYTES)
    await writeFile(join(vault, ODD), ODD_BYTES)
    await writeFile(
        join(vault, POND),
        '# Pond video\n\n![[pond.mp4]]\n\n![The plan of the plots](../Attachments/garden-plan.png)\n\n[[shed.constructor]]\n'
    )
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const planned = await plan(device, { include: [PLAN, TOUR, POND] })
    await publish(device, planned.id, { time: TIME, device: 'garden-shed', face: 'plugin' })

    // The output folder is inside the site, in a folder that git ignores.
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'attachments-page-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'ignore'
    })
    exitCode = await child.exited
    if (exitCode === 0) {
        server = await startServer({
            dist: outDir,
            port: 0,
            attachments: stores.attachmentStorage
        })
    }
}, 180_000)

afterAll(async () => {
    await server?.stop()
    // Remove only the folders that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
    await stores?.remove()
})

describe('build of notes with attachments', () => {
    test('completes', () => {
        expect(exitCode).toBe(0)
    })

    // The first image of a page loads at once with a high priority (PERF-25, issue 47).
    test('shows an image with its width and its height', async () => {
        expect(await readOutput(PLAN_FILE)).toContain(
            `<img src="${IMAGE_URL}" alt="garden-plan.png" width="16" height="12" decoding="async" fetchpriority="high">`
        )
    })

    // GATE-42: the key of the locked shed is never uploaded, and its embed is plain text.
    test('shows an embed of a file of a deny list folder as plain text, with no address', async () => {
        const html = await readOutput(TOUR_FILE)
        expect(html).toContain(`<img src="${IMAGE_URL}"`)
        expect(html).toContain('<span class="not-published">shed-key.png</span>')
        expect(html).not.toContain(DENIED_KEY)
    })

    test('shows a video with the player of the browser', async () => {
        expect(await readOutput(POND_FILE)).toContain(
            `<video src="${VIDEO_URL}" controls preload="metadata"></video>`
        )
    })

    test('shows a Markdown image with its alternative text and its size', async () => {
        expect(await readOutput(POND_FILE)).toContain(
            `<img src="${IMAGE_URL}" alt="The plan of the plots" width="16" height="12" decoding="async" fetchpriority="high">`
        )
    })

    test('writes the hashed path of each attachment into the resolver map, and no file into the output', async () => {
        const map = JSON.parse(await readOutput('-/resolver-map.json')) as {
            attachments: Record<string, string>
        }
        expect(map.attachments).toEqual({
            [IMAGE_URL]: IMAGE_KEY,
            [ODD_URL]: ODD_KEY,
            [VIDEO_URL]: VIDEO_KEY
        })
        const files = await readdir(outputPath(), { recursive: true })
        expect(
            files.filter((file) =>
                [IMAGE_KEY, ODD_KEY, VIDEO_KEY].some((key) => file.includes(key))
            )
        ).toEqual([])
    })
})

describe('plain local server of attachments', () => {
    test('answers 200 with the bytes of an image, kept for a long time', async () => {
        const response = await fetch(`${serverUrl()}${IMAGE_URL}`)

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        expect(response.headers.get('accept-ranges')).toBe('bytes')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            await Bun.file(join(vault, IMAGE)).bytes()
        )
    })

    test('answers a range request for a large video with that part only', async () => {
        const response = await fetch(`${serverUrl()}${VIDEO_URL}`, {
            headers: { range: 'bytes=1000000-1000999' }
        })

        expect(response.status).toBe(206)
        expect(response.headers.get('content-type')).toBe('video/mp4')
        expect(response.headers.get('content-range')).toBe(
            `bytes 1000000-1000999/${String(VIDEO_BYTES.length)}`
        )
        const part = new Uint8Array(await response.arrayBuffer())
        expect(part.length).toBe(1000)
        expect(part).toEqual(VIDEO_BYTES.slice(1000000, 1001000))
    })

    test('answers a range request for the end of a file, and for a part that runs past the end', async () => {
        const end = await fetch(`${serverUrl()}${VIDEO_URL}`, { headers: { range: 'bytes=-10' } })
        expect(end.status).toBe(206)
        expect(new Uint8Array(await end.arrayBuffer())).toEqual(VIDEO_BYTES.slice(-10))

        const past = await fetch(`${serverUrl()}${VIDEO_URL}`, {
            headers: { range: `bytes=${String(VIDEO_BYTES.length - 5)}-99999999` }
        })
        expect(past.status).toBe(206)
        expect((await past.arrayBuffer()).byteLength).toBe(5)
    })

    test('answers 416 for a range outside the file', async () => {
        const response = await fetch(`${serverUrl()}${VIDEO_URL}`, {
            headers: { range: `bytes=${String(VIDEO_BYTES.length)}-` }
        })

        expect(response.status).toBe(416)
        expect(response.headers.get('content-range')).toBe(`bytes */${String(VIDEO_BYTES.length)}`)
    })

    test('answers an SVG or any attachment with no right to run a script', async () => {
        const response = await fetch(`${serverUrl()}${IMAGE_URL}`)

        expect(response.headers.get('content-security-policy')).toContain('sandbox')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    })

    // The kind comes from the end of the name, which can be the name of a
    // member of every object.
    test('answers a file of an unknown kind as plain bytes, also a kind named constructor', async () => {
        const response = await fetch(`${serverUrl()}${ODD_URL}`)

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/octet-stream')
        expect(await response.text()).toBe(ODD_BYTES)
    })

    test('answers 404 for a file that no page uses, and for a path that names a file itself', async () => {
        for (const path of [
            `/-/attachments/${DENIED_KEY}/shed-key.png`,
            `/-/attachments/${IMAGE_KEY}/other-name.png`,
            `/-/attachments/${IMAGE_KEY}`,
            `/-/attachments/..%2F..%2Fpackage.json`
        ]) {
            const response = await fetch(`${serverUrl()}${path}`)
            expect(response.status, path).toBe(404)
        }
    })
})

// URL-33: an attachment that the resolver map names and that the attachment
// storage lacks is a failure of the release, never "not found" (R46: a cleanup
// of another device can delete an upload). It runs last: it removes a file of
// the storage.
describe('plain local server of attachments with a broken storage', () => {
    test('answers 500 with no detail when the storage lacks a file of the map', async () => {
        if (stores === undefined) {
            throw new Error('the stores do not exist')
        }
        await rm(join(stores.attachmentStorage, VIDEO_KEY))
        const response = await fetch(`${serverUrl()}${VIDEO_URL}`)

        expect(response.status).toBe(500)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.text()).toBe('Server error\n')
    })
})
