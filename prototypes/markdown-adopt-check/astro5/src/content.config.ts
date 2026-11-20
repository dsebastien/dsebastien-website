import { ObsidianMdLoader } from 'astro-loader-obsidian'
import { defineCollection, z } from 'astro:content'

// The parent run.ts copies the published notes of the fixture vault and their
// files into vault-copy/: the loader reads a folder itself. Its own schema
// (ObsidianDocumentSchema) is replaced by an open one: it refuses the date form of Obsidian
// (`created: 2031-03-05T10:00`, no seconds) and stops the build on every note.
export const collections = {
    documents: defineCollection({
        loader: ObsidianMdLoader({
            base: 'vault-copy',
            url: 'notes',
            brokenLinksStrategy: 'label'
        }),
        schema: z.object({}).passthrough()
    })
}
