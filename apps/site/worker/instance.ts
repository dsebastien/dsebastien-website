// The mark of the first answer of an instance (issue 121). The Worker of the
// site and the floor Worker (`floor.ts`) both give it, and the check of the
// first request (`scripts/first-request.ts`) tells by it which requests met a
// new instance. A module of its own, so that the floor Worker holds nothing
// of the Worker of the site.

/** The `Server-Timing` entry of the first answer of an instance. It says nothing of the release. */
export const NEW_INSTANCE_TIMING = 'instance;desc=new'

/** The first answer of an instance, with the entry that says so. */
export function markedNewInstance(response: Response): Response {
    const marked = new Response(response.body, response)
    marked.headers.append('server-timing', NEW_INSTANCE_TIMING)
    return marked
}
