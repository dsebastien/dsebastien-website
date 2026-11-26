import type { APIRoute } from 'astro'
import { applyRedirectList } from '@dsebastien-website/resolver'
import { readRedirectList } from '../../content-store.ts'
import { publishedSite } from '../../published-site.ts'
import { resolverMapFor } from '../../site-files.ts'

// The resolver map: what the build knows about the paths of the site. The
// edge and the plain server read it, and the resolver decides with it. The
// redirect list of the content store goes into it (issue 44); the warning of
// a dropped row gives counts, never an old path.
export const GET: APIRoute = async () => {
    const site = await publishedSite()
    const base = resolverMapFor(
        site.notes,
        site.notesWithBacklinksPage(),
        [
            ...site.typeHubs,
            ...(site.otherNotes === undefined ? [] : [site.otherNotes]),
            ...site.tagLists,
            ...site.recentLists
        ],
        site.removed
    )
    const { map, dropped } = applyRedirectList(base, await readRedirectList())
    if (dropped.shadowed > 0 || dropped.deadTarget > 0) {
        console.warn(
            `The redirect list: ${String(dropped.shadowed)} rows dropped because a live address has their old path, ${String(dropped.deadTarget)} because their target is not live`
        )
    }
    return new Response(`${JSON.stringify(map, null, 2)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
}
