import { errorFormat } from '@dsebastien-website/resolver'
import {
    createWorker,
    type Environment,
    type ObjectStorage,
    type StaticFiles
} from '../../apps/site/worker/worker.ts'

// PROTOTYPE (issue 21, hosting). Throwaway code: it stays on the branch
// `prototype/hosting` and never goes into main.
//
// The entry of the test Worker: the Worker of the site, with what the checks
// of the hosting research need around it:
//
// 1. Markdown on request (URL-11, check 3): a canonical URL asked with
//    `Accept: text/markdown` gets the Markdown of the note, and both forms
//    say `Vary: Accept`.
// 2. The time of the first request of an isolate, which reads the resolver
//    map (`x-proto-isolate`, `x-proto-first-ms`).
// 3. With the variable `SEARCH_IN_STORAGE`, the files of Pagefind come from
//    the object storage (keys `search/...`), not from the static files.

interface PrototypeEnvironment extends Environment {
    readonly SEARCH_IN_STORAGE?: string
}

const SEARCH = '/-/search/pagefind/'

const worker = createWorker()
// Made at the first request: the host allows no random value outside a request.
let isolate: string | undefined
let first: number | undefined

/** Static files where the files of Pagefind come from the object storage. */
function withSearchInStorage(files: StaticFiles, storage: ObjectStorage): StaticFiles {
    return {
        async fetch(request) {
            const { pathname } = new URL(request.url)
            if (!pathname.startsWith(SEARCH)) {
                return await files.fetch(request)
            }
            const object = await storage.get(`search/${pathname.slice(SEARCH.length)}`)
            return object === null
                ? new Response(null, { status: 404 })
                : new Response(object.body, { headers: { etag: object.httpEtag } })
        }
    }
}

export default {
    async fetch(request: Request, env: PrototypeEnvironment): Promise<Response> {
        const started = Date.now()
        const site: Environment =
            env.SEARCH_IN_STORAGE === '1' && env.ATTACHMENTS !== undefined
                ? { ...env, ASSETS: withSearchInStorage(env.ASSETS, env.ATTACHMENTS) }
                : env
        const url = new URL(request.url)
        let response: Response | undefined
        // Markdown on request: the Markdown path of a canonical path is `/-/md<path>.md`.
        if (
            !url.pathname.startsWith('/-/') &&
            errorFormat(url.pathname, request.headers.get('accept')) === 'markdown'
        ) {
            const markdown = await worker.fetch(
                new Request(`${url.origin}/-/md${url.pathname}.md`, { headers: request.headers }),
                site
            )
            if (markdown.status === 200 || markdown.status === 304) {
                response = markdown
            } else {
                await markdown.body?.cancel()
            }
        }
        response ??= await worker.fetch(request, site)
        const answer = new Response(response.body, response)
        if (!answer.headers.has('vary') && (answer.status === 200 || answer.status === 304)) {
            answer.headers.set('vary', 'Accept')
        }
        isolate ??= crypto.randomUUID().slice(0, 8)
        answer.headers.set('x-proto-isolate', isolate)
        if (first === undefined) {
            first = Date.now() - started
            answer.headers.set('x-proto-first-ms', String(first))
        }
        return answer
    }
}
