import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RESOLVER_MAP_FILE, resolverMapOf } from '@dsebastien-website/resolver'
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
        page: (path) => `${path}.html`,
        markdown: (path) => `-/md/${path}`,
        folder: (path) => `${path}.html`,
        choice: (paths) => `${paths.join('+')}.html`
    })
    await Bun.write(join(dist, RESOLVER_MAP_FILE), JSON.stringify(map))
    await Bun.write(join(dist, '404.html'), '<h1>Not found</h1>')
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
