import type { APIRoute, GetStaticPaths } from 'astro'
import { INDEXNOW_KEY } from '../indexnow.ts'

// The IndexNow key file at the root of the host (IDX-35, `src/indexnow.ts`):
// `/<key>.txt`, which holds the key.
export const getStaticPaths = (() => [
    { params: { indexnow: INDEXNOW_KEY } }
]) satisfies GetStaticPaths

export const GET: APIRoute = () =>
    new Response(INDEXNOW_KEY, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
