import type { APIRoute } from 'astro'
import { SITE_ORIGIN } from '@dsebastien-website/resolver'
import { publishedSite } from '../published-site.ts'
import { sitemapIndexXml } from '../sitemaps.ts'

// The sitemap index (IDX-30): one entry per sitemap file (`src/sitemaps.ts`).
export const GET: APIRoute = async () =>
    new Response(sitemapIndexXml((await publishedSite()).sitemaps, SITE_ORIGIN), {
        headers: { 'content-type': 'application/xml; charset=utf-8' }
    })
