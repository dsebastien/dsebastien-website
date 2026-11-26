import type { APIRoute, GetStaticPaths } from 'astro'
import { SITE_ORIGIN } from '@dsebastien-website/resolver'
import { publishedSite } from '../published-site.ts'
import { sitemapXml } from '../sitemaps.ts'

// One sitemap file per group of note types (IDX-30, `src/sitemaps.ts`).
export const getStaticPaths = (async () =>
    [...(await publishedSite()).sitemaps.keys()].map((group) => ({
        params: { group }
    }))) satisfies GetStaticPaths

export const GET: APIRoute = async ({ params }) => {
    const entries = (await publishedSite()).sitemaps.get(params['group'] ?? '') ?? []
    return new Response(sitemapXml(entries, SITE_ORIGIN), {
        headers: { 'content-type': 'application/xml; charset=utf-8' }
    })
}
