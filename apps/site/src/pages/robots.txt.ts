import type { APIRoute } from 'astro'
import { SITE_ORIGIN } from '@dsebastien-website/resolver'
import { robotsText } from '../robots.ts'

// The rules for robots (`src/robots.ts`): the same file on every host, so the
// check after a deployment compares the live file with this output (AI-06).
export const GET: APIRoute = () =>
    new Response(robotsText(SITE_ORIGIN), {
        headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
