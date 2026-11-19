import type { APIRoute } from 'astro'

// The rules for robots (URL-31 of the spec): a first version that allows all.
// The slice of search engines (issue 54) writes the real one, with the
// sitemaps and the AI use policy.
export const GET: APIRoute = () =>
    new Response('User-agent: *\nAllow: /\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
