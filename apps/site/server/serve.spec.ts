import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    RESOLVER_MAP_FILE,
    resolverMapOf,
    variantKey,
    variantPath
} from '@dsebastien-website/resolver'
import { writeMapParts } from '../src/map-parts.ts'
import { startServer, type Server } from './serve.ts'

// The plain server and the header `Host` (issue 102): the Markdown texts of
// the errors name the listening address of the server, never the host that
// a client sends, and a `Host` that gives no URL is the fault of the client.

let dist: string
let server: Server

beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'serve-spec-'))
    const map = resolverMapOf([{ path: 'Welcome.md', aliases: [] }], {
        home: 'index.html',
        notFound: '404.html',
        gone: '410.html',
        robots: 'robots.txt',
        icon: 'favicon.ico',
        page: (path) => `${path}.html`,
        markdown: (path) => `-/md/${path}`,
        folder: (path) => `${path}.html`,
        choice: (paths) => `${paths.join('+')}.html`
    })
    await Bun.write(join(dist, RESOLVER_MAP_FILE), JSON.stringify(map))
    // The server reads the map in parts, as the Worker does (issue 121): the
    // whole map is not in the folder.
    await writeMapParts(dist, 64)
    await unlink(join(dist, RESOLVER_MAP_FILE))
    await Bun.write(join(dist, '404.html'), '<h1>Not found</h1>')
    await Bun.write(join(dist, 'Welcome.md.html'), '<h1>Welcome</h1>')
    server = await startServer({ dist, port: 0 })
})

afterAll(async () => {
    await server.stop()
    await rm(dist, { recursive: true, force: true })
})

/** The status line and the body of a request with a `Host` header of its own, sent as raw HTTP. */
async function withHost(host: string, path: string): Promise<{ status: string; body: string }> {
    const { port } = new URL(server.url)
    const answer = await new Promise<string>((resolve, reject) => {
        let text = ''
        Bun.connect({
            hostname: '127.0.0.1',
            port: Number(port),
            socket: {
                open(socket) {
                    socket.write(
                        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
                    )
                },
                data(_socket, data) {
                    text += data.toString()
                },
                close() {
                    resolve(text)
                },
                error(_socket, error) {
                    reject(error)
                }
            }
        }).catch(reject)
    })
    const end = answer.indexOf('\r\n\r\n')
    return {
        status: answer.slice(0, answer.indexOf('\r\n')),
        body: answer.slice(end + 4)
    }
}

describe('the plain server and the Host header', () => {
    test('names its listening address in a Markdown text, never the Host of the client', async () => {
        const { status, body } = await withHost('evil.example', '/-/md/Nothing.md')
        expect(status).toBe('HTTP/1.1 404 Not Found')
        expect(body).toContain(`[${server.url}/](<${server.url}/>)`)
        expect(body).not.toContain('evil.example')
    })

    test('answers 400 to a Host that gives no URL', async () => {
        const { status, body } = await withHost('[bad', '/Welcome')
        expect(status).toBe('HTTP/1.1 400 Bad Request')
        expect(body).toBe('Bad request\n')
    })
})

// Issue 87: the variants of an image come from a folder of their own.
describe('the plain server and the variants of an image', () => {
    test('gives a variant from the folder of the variants, and the image from the storage', async () => {
        const key = 'a'.repeat(64)
        const root = await mkdtemp(join(tmpdir(), 'serve-spec-variants-'))
        const image = `/-/attachments/${key}/cover.png`
        await Bun.write(
            join(root, 'dist', RESOLVER_MAP_FILE),
            JSON.stringify({ pages: {}, attachments: { [image]: key } })
        )
        // The server reads the map in parts (issue 121).
        await writeMapParts(join(root, 'dist'))
        await Bun.write(join(root, 'storage', key), 'png')
        await Bun.write(join(root, 'variants', variantKey(key, 480)), 'webp')
        const site = await startServer({
            dist: join(root, 'dist'),
            port: 0,
            attachments: join(root, 'storage'),
            variants: join(root, 'variants')
        })
        try {
            const variant = await fetch(`${site.url}${variantPath(image, 480)}`)
            expect(variant.headers.get('content-type')).toBe('image/webp')
            expect(await variant.text()).toBe('webp')
            expect(await (await fetch(`${site.url}${image}`)).text()).toBe('png')
            // A variant that the folder lacks gives the image (R92).
            const missing = await fetch(`${site.url}${variantPath(image, 800)}`)
            expect(missing.headers.get('content-type')).toBe('image/png')
            expect(await missing.text()).toBe('png')
        } finally {
            await site.stop()
            await rm(root, { recursive: true, force: true })
        }
    })
})

describe('the plain server and the map in parts (issue 121)', () => {
    // A build that writes the folder again while the server runs must not
    // give it a head of one build and parts of another.
    test('reads the head and every part at its start: a later build changes no answer', async () => {
        const folder = join(dist, '-', 'resolver-map')
        const saved = new Map<string, string>()
        for (const name of await readdir(folder)) {
            saved.set(name, await readFile(join(folder, name), 'utf8'))
            if (name !== 'head.json') {
                await writeFile(join(folder, name), '{}')
            }
        }
        try {
            const page = await fetch(`${server.url}/Welcome`)
            expect(page.status).toBe(200)
            expect(await page.text()).toBe('<h1>Welcome</h1>')
        } finally {
            for (const [name, text] of saved) {
                await writeFile(join(folder, name), text)
            }
        }
    })

    test('answers a page and a variant from the parts of the map', async () => {
        const page = await fetch(`${server.url}/Welcome`)
        expect(page.status).toBe(200)
        expect(await page.text()).toBe('<h1>Welcome</h1>')
        const variant = await fetch(`${server.url}/welcome`, { redirect: 'manual' })
        expect(variant.status).toBe(301)
        expect(variant.headers.get('location')).toBe('/Welcome')
    })
})
