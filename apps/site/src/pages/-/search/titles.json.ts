import type { APIRoute } from 'astro'
import { publishedSite } from '../../../published-site.ts'

// The keys of the parts of the title index of the search (SRCH-02, R63):
// `true` for a part that holds every title with a word that starts with its
// key. The search page loads it at the first query, then one part. It also
// names the notes that search engines must not index: the random note of the
// command palette leaves them out (issue 122, R85).
export const GET: APIRoute = async () => {
    const site = await publishedSite()
    return new Response(
        JSON.stringify({ v: 1, keys: site.titleIndex.keys, noindex: site.noindexPaths }),
        {
            headers: { 'content-type': 'application/json; charset=utf-8' }
        }
    )
}
