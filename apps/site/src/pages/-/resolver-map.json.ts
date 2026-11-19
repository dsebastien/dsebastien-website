import type { APIRoute } from 'astro'
import type { ResolverMap } from '@dsebastien-website/resolver'
import { readPublishedNotes } from '../../content-store.ts'

// The resolver map: what the build knows about the paths of the site. The
// edge and the plain server read it, and the resolver decides with it.
export const GET: APIRoute = async () => {
    const pages: Record<string, string> = { '/': 'index.html' }
    // The hashed path of each attachment that a page uses, with its key in
    // the attachment storage. The files themselves are not in the output.
    const attachments: Record<string, string> = {}
    for (const note of await readPublishedNotes()) {
        pages[note.path] = note.file
        for (const file of note.attachments) {
            attachments[file.url] = file.key
        }
    }
    const map: ResolverMap = { pages, attachments }
    return new Response(`${JSON.stringify(map, null, 2)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
}
