import { join, resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'
import { resolve, type ResolverMap } from '@dsebastien-website/resolver'

// The plain server (MOD-09 and HOST-02 of the spec): it serves the output of
// the build through the resolver, as the edge does on the real host. It is
// for local work and for the tests of the URL contract. It is not a server
// for production.
//
//   bun run serve [--dist <folder>] [--port <number>]

/** The place of the resolver map in the output of the build. */
const RESOLVER_MAP = '-/resolver-map.json'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readResolverMap(dist: string): Promise<ResolverMap> {
    const map: unknown = await Bun.file(join(dist, RESOLVER_MAP)).json()
    const pages = isRecord(map) ? map['pages'] : undefined
    if (!isRecord(pages) || !Object.values(pages).every((file) => typeof file === 'string')) {
        throw new Error(`${RESOLVER_MAP} is not a resolver map`)
    }
    return { pages: pages as Record<string, string> }
}

/** A running server. */
export interface Server {
    /** The address of the server, without a slash at the end. */
    url: string
    stop(): Promise<void>
}

/**
 * Starts the server on this machine only.
 *
 * @param options.dist the output of the build
 * @param options.port the port. 0 takes a free port
 */
export async function startServer(options: { dist: string; port: number }): Promise<Server> {
    const dist = resolvePath(options.dist)
    const map = await readResolverMap(dist)
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: options.port,
        fetch(request) {
            // The path is read as it is requested, with its percent-encoding.
            const resolution = resolve(new URL(request.url).pathname, map)
            if (resolution.kind === 'not-found') {
                return new Response('Not found\n', {
                    status: 404,
                    headers: { 'content-type': 'text/plain; charset=utf-8' }
                })
            }
            // The file comes from the resolver map, never from the request.
            return new Response(Bun.file(join(dist, resolution.file)), {
                headers: { 'content-type': 'text/html; charset=utf-8' }
            })
        }
    })
    return {
        url: `http://127.0.0.1:${String(server.port)}`,
        stop: () => server.stop(true)
    }
}

if (import.meta.main) {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            dist: { type: 'string', default: 'dist' },
            port: { type: 'string', default: '4322' }
        },
        strict: true
    })
    const server = await startServer({ dist: values.dist, port: Number(values.port) })
    console.error(`The built site is on ${server.url}`)
}
