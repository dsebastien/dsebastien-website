import type { APIRoute, GetStaticPaths } from 'astro'
import { readCleanedNote, readPublishedNotes } from '../../../content-store.ts'

// The Markdown of a published note (URL-10 of the spec): its cleaned note, as
// the content store holds it. The resolver leads `/-/md/<path>.md` to it.
export const getStaticPaths = (async () =>
    (await readPublishedNotes()).map((note) => ({
        params: { id: note.id },
        props: { vaultPath: note.vaultPath }
    }))) satisfies GetStaticPaths

export const GET: APIRoute<{ vaultPath: string }> = async ({ props }) =>
    new Response(await readCleanedNote(props.vaultPath), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' }
    })
