import type { APIRoute } from 'astro'
import { readPublishedNotes } from '../../content-store.ts'
import { resolverMapFor } from '../../site-files.ts'

// The resolver map: what the build knows about the paths of the site. The
// edge and the plain server read it, and the resolver decides with it.
export const GET: APIRoute = async () =>
    new Response(`${JSON.stringify(resolverMapFor(await readPublishedNotes()), null, 2)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
