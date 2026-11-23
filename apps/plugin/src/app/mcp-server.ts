import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { answer, PROTOCOL_VERSIONS, SERVER_NAME } from '../publishing/mcp.ts'
import type { Operations } from '../publishing/mcp.ts'

// The MCP server of the plugin (issue 41, TOOL-03, decision of the author
// R68): the tools of `publishing/mcp.ts` over HTTP, on this computer only.
// The protocol is the Streamable HTTP transport with one JSON answer per
// POST and no session; a GET for a stream of events gets 405, as the
// protocol allows. The server can publish and take notes down, so it refuses
// a request without the key of this device, a request of a web page (an
// Origin header), and a Host that is not this computer (DNS rebinding).

/** The address that the server listens on: this computer only. */
export const MCP_HOST = '127.0.0.1'

/** The largest body of a request, in bytes. */
const LARGEST_BODY = 1024 * 1024

/** How many times a start tries a port that is in use, and the wait between two tries. */
const TRIES = 5
const WAIT = 200

export interface McpServerOptions {
    /** The port, or 0 for a free port of the system (tests). */
    readonly port: number
    /** The key of this device, read at each request, or `null` when there is none: every request is refused then. */
    readonly key: () => string | null
    /** The version of the plugin, for `initialize`. */
    readonly version: string
    readonly operations: Operations
}

/** True when the header holds the key, compared in a constant time. */
function holdsKey(header: string | undefined, key: string | null): boolean {
    if (key === null || key === '' || header === undefined) {
        return false
    }
    const [scheme, given, ...rest] = header.split(' ')
    if (scheme !== 'Bearer' || given === undefined || rest.length > 0) {
        return false
    }
    // Hashes of the same length, so that the time says nothing about the key.
    const one = createHash('sha256').update(given).digest()
    const two = createHash('sha256').update(key).digest()
    return timingSafeEqual(one, two)
}

function sendText(
    response: ServerResponse,
    status: number,
    text: string,
    headers: Record<string, string> = {}
): void {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
    response.end(text)
}

/**
 * The body of a request as text, `undefined` when it is larger than the
 * limit, or `null` when it is not UTF-8: a bad byte must never become
 * another character of a path (the Rust face refuses such a line too).
 */
function bodyOf(request: IncomingMessage): Promise<string | null | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        let tooLarge = false
        request.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > LARGEST_BODY) {
                tooLarge = true
                chunks.length = 0
            } else if (!tooLarge) {
                chunks.push(chunk)
            }
        })
        request.on('end', () => {
            if (tooLarge) {
                resolve(undefined)
                return
            }
            try {
                resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
            } catch {
                resolve(null)
            }
        })
        request.on('error', reject)
    })
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class LocalMcpServer {
    #server: Server | undefined
    #port: number | undefined

    constructor(private readonly options: McpServerOptions) {}

    /** The port that the server listens on, or `undefined` when it does not run. */
    get port(): number | undefined {
        return this.#port
    }

    /**
     * Starts the server and gives its port. A port in use is tried again for
     * a short time: the server of the plugin before a reload can still hold
     * it. It throws with a message that names the port.
     */
    async start(): Promise<number> {
        await this.stop()
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.#listen()
            } catch (error) {
                const code = (error as { code?: unknown }).code
                if (code !== 'EADDRINUSE' || attempt >= TRIES) {
                    throw new Error(
                        code === 'EADDRINUSE'
                            ? `the port ${String(this.options.port)} of ${MCP_HOST} is in use by another program, or by Vault Publish in another vault: choose another port in the settings of Vault Publish`
                            : `the MCP server cannot listen on ${MCP_HOST}:${String(this.options.port)}: ${error instanceof Error ? error.message : 'it failed'}`,
                        { cause: error }
                    )
                }
                await wait(WAIT)
            }
        }
    }

    #listen(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = createServer((request, response) => {
                this.#handle(request, response).catch(() => {
                    if (!response.headersSent) {
                        sendText(response, 500, 'The MCP server failed')
                    } else {
                        response.end()
                    }
                })
            })
            server.once('error', reject)
            server.listen(this.options.port, MCP_HOST, () => {
                server.off('error', reject)
                const address = server.address()
                const port = typeof address === 'object' && address !== null ? address.port : 0
                this.#server = server
                this.#port = port
                resolve(port)
            })
        })
    }

    /** Stops the server and closes its connections. */
    async stop(): Promise<void> {
        const server = this.#server
        this.#server = undefined
        this.#port = undefined
        if (server === undefined) {
            return
        }
        server.closeAllConnections()
        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve()
            })
        })
    }

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const port = String(this.#port)
        // A browser sends an Origin with every request that a page makes
        // to another site: no page may drive the tool.
        if (request.headers.origin !== undefined) {
            sendText(response, 403, 'A request of a web page is refused')
            return
        }
        // Only 127.0.0.1: a client that asks `localhost` can reach another
        // program that listens on [::1] at the same port, and give it the key.
        if (request.headers.host !== `${MCP_HOST}:${port}`) {
            sendText(response, 403, `The Host must be ${MCP_HOST}:${port}`)
            return
        }
        if (!holdsKey(request.headers.authorization, this.options.key())) {
            sendText(
                response,
                401,
                'Give the key of the MCP server of this device: Authorization: Bearer <key>. It is in the settings of Vault Publish.',
                { 'WWW-Authenticate': 'Bearer' }
            )
            return
        }
        const path = (request.url ?? '/').split('?')[0]
        if (path !== '/mcp') {
            sendText(response, 404, 'The MCP server is at /mcp')
            return
        }
        if (request.method !== 'POST') {
            sendText(response, 405, 'The MCP server takes a POST only', { Allow: 'POST' })
            return
        }
        const type = request.headers['content-type'] ?? ''
        if (type.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
            sendText(response, 415, 'The body must be JSON (Content-Type: application/json)')
            return
        }
        const version = request.headers['mcp-protocol-version']
        if (
            typeof version === 'string' &&
            !(PROTOCOL_VERSIONS as readonly string[]).includes(version)
        ) {
            sendText(
                response,
                400,
                `The MCP server does not know the version ${version} of the protocol`
            )
            return
        }
        const body = await bodyOf(request)
        if (body === undefined) {
            sendText(response, 413, 'The body is larger than 1 MiB')
            return
        }
        const text = await answer(
            // A body that is not UTF-8 is a message that is not JSON.
            body ?? '\u0000',
            { name: SERVER_NAME, version: this.options.version },
            this.options.operations
        )
        if (text === undefined) {
            response.writeHead(202)
            response.end()
            return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(text)
    }
}
