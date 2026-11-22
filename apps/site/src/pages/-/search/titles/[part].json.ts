import type { APIRoute, GetStaticPaths } from 'astro'
import { publishedSite } from '../../../../published-site.ts'
import { partFile } from '../../../../search/titles.ts'

// A part of the title index of the search (SRCH-02, R63): the rows of the
// titles and the aliases with a word that starts with its key. Its file name
// is the key in hexadecimal, so it is plain ASCII on every system.
export const getStaticPaths = (async () => {
    const site = await publishedSite()
    return [...site.titleIndex.parts].map(([key, rows]) => ({
        params: { part: partFile(key) },
        props: { rows }
    }))
}) satisfies GetStaticPaths

export const GET: APIRoute = ({ props }) =>
    new Response(JSON.stringify(props['rows']), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
