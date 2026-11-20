import { getCollection } from 'astro:content'

// The rendered HTML of each note, by its path in the vault copy.
export async function GET(): Promise<Response> {
    const pages: Record<string, string> = {}
    for (const entry of await getCollection('documents')) {
        const path = (entry.filePath ?? '').replace(/^vault-copy\//, '')
        pages[path] = entry.rendered?.html ?? ''
    }
    return new Response(JSON.stringify(pages))
}
