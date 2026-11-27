import { markedNewInstance } from './instance.ts'

// The floor Worker (issue 121, R94): a Worker with no resolver map. The check
// of the first request (`scripts/first-request.ts`) deploys it next to a
// host, with one page of that host as its only static file, and compares
// the first requests of the two: the difference is what the map costs. It
// reads its page from its static files, as the Worker of the site does, and
// marks the first answer of an instance in the same way.

/** The one static file of the floor Worker. */
export const FLOOR_PAGE = 'page.html'

/** The static files of a Worker version. */
interface StaticFiles {
    fetch(request: Request): Promise<Response>
}

/** A floor Worker: one per isolate of the host. */
export function createFloorWorker(): {
    fetch(request: Request, env: { readonly ASSETS: StaticFiles }): Promise<Response>
} {
    let answered = false
    return {
        async fetch(_request, env) {
            const page = await env.ASSETS.fetch(new Request(`https://static.invalid/${FLOOR_PAGE}`))
            const response = new Response(page.body, {
                status: page.status,
                headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
            })
            if (answered) {
                return response
            }
            answered = true
            return markedNewInstance(response)
        }
    }
}

export default createFloorWorker()
