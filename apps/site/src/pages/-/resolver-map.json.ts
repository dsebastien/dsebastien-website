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
    const { map, dropped, kept } = applyRedirectList(base, await readRedirectList())
    const counts = [
        [dropped.shadowed, 'rows dropped because a live address has their old path (shadowed)'],
        [dropped.deadTarget, 'rows dropped because their target leads to no page'],
        [dropped.loop, 'rows dropped because their target leads round in the list (loop)'],
        [kept.goneTarget, 'rows gone because their target is gone'],
        [kept.prefixOnLiveFolder, 'prefix rules kept on a live folder'],
        [kept.hidesNameOrAlias, 'rows kept that hide a file name or an alias of a live note']
    ] as const
    const shown = counts.filter(([count]) => count > 0)
    if (shown.length > 0) {
        console.warn(
            `The redirect list: ${shown.map(([count, what]) => `${String(count)} ${what}`).join(', ')}`
        )
    }
    return new Response(`${JSON.stringify(map, null, 2)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
}
