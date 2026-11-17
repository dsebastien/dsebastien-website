import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
    // One file per page, with no folder and no slash at the end: the resolver
    // decides which URL leads to which file, not the layout of the output.
    build: { format: 'file' },
    vite: {
        plugins: [tailwindcss()]
    }
})
