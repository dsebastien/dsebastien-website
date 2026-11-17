import type { APIRoute } from 'astro'
import type { ResolverMap } from '@dsebastien-website/resolver'
import { readPublishedNotes } from '../../content-store.ts'

// The resolver map: what the build knows about the paths of the site. The
// edge and the plain server read it, and the resolver decides with it.
export const GET: APIRoute = async () => {
    const pages: Record<string, string> = { '/': 'index.html' }
    for (const note of await readPublishedNotes()) {
        pages[note.path] = note.file
    }
    const map: ResolverMap = { pages }
    return new Response(`${JSON.stringify(map, null, 2)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
}
