import type { APIRoute } from 'astro'
import { publishedSite } from '../../published-site.ts'
import { resolverMapFor } from '../../site-files.ts'

// The resolver map: what the build knows about the paths of the site. The
// edge and the plain server read it, and the resolver decides with it.
export const GET: APIRoute = async () => {
    const site = await publishedSite()
    const map = resolverMapFor(site.notes, site.notesWithBacklinksPage(), [
        ...site.typeHubs,
        ...(site.otherNotes === undefined ? [] : [site.otherNotes]),
        ...site.tagLists
    ])
    return new Response(`${JSON.stringify(map, null, 2)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
}
