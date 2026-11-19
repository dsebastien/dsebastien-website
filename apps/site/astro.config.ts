import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'
import { satteri } from '@astrojs/markdown-satteri'
import { noteLinks } from './src/note-links.ts'

export default defineConfig({
    // The mockups are judged without the toolbar of the dev server.
    devToolbar: { enabled: false },
    // The canonical host of the site: the canonical link of each page names it.
    site: 'https://notes.dsebastien.net',
    // One file per page, with no folder and no slash at the end: the resolver
    // decides which URL leads to which file, not the layout of the output.
    build: { format: 'file' },
    markdown: {
        processor: satteri({
            // A link path is read as the author wrote it: no change of quotes and dashes.
            features: { smartPunctuation: false },
            mdastPlugins: [noteLinks]
        })
    },
    vite: {
        plugins: [tailwindcss()]
    }
})
