import { describe, expect, test } from 'bun:test'
import { createFloorWorker, FLOOR_PAGE } from './floor.ts'
import { NEW_INSTANCE_TIMING } from './instance.ts'

// The floor Worker (issue 121, R94): a Worker with no resolver map, which the
// check of the first request deploys next to a host to measure what the map
// adds.

function assets(): { fetch(request: Request): Promise<Response>; asked: string[] } {
    const asked: string[] = []
    return {
        asked,
        fetch(request) {
            const { pathname } = new URL(request.url)
            asked.push(pathname)
            return Promise.resolve(
                pathname === `/${FLOOR_PAGE}`
                    ? new Response('<h1>A page</h1>', { headers: { etag: '"x"' } })
                    : new Response('', { status: 404 })
            )
        }
    }
}

describe('the floor Worker', () => {
    test('answers every path with its one page, read from its static files', async () => {
        const files = assets()
        const worker = createFloorWorker()
        for (const path of ['/Welcome', '/10+Garden/Mint', '/']) {
            const response = await worker.fetch(new Request(`https://floor.example${path}`), {
                ASSETS: files
            })
            expect(response.status).toBe(200)
            expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
            expect(await response.text()).toBe('<h1>A page</h1>')
        }
        expect(files.asked).toEqual([`/${FLOOR_PAGE}`, `/${FLOOR_PAGE}`, `/${FLOOR_PAGE}`])
    })

    test('marks its first answer as the one of a new instance, and no later one', async () => {
        const worker = createFloorWorker()
        const env = { ASSETS: assets() }
        const first = await worker.fetch(new Request('https://floor.example/A'), env)
        const second = await worker.fetch(new Request('https://floor.example/A'), env)
        expect(first.headers.get('server-timing')).toBe(NEW_INSTANCE_TIMING)
        expect(second.headers.get('server-timing')).toBeNull()
    })
})
