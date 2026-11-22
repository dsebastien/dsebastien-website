import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'
import { notePageBudget } from './src/budgets.ts'
import { markdownProcessor } from './src/rendering/markup.ts'
import { searchIndex } from './src/search/search-index.ts'
import { selfContainedPages } from './src/self-contained.ts'
import { siteChecks } from './src/site-checks.ts'

export default defineConfig({
    // The canonical host of the site: the canonical link of each page names it.
    site: 'https://notes.dsebastien.net',
    // One file per page, with no folder and no slash at the end: the resolver
    // decides which URL leads to which file, not the layout of the output.
    build: { format: 'file' },
    markdown: {
        // The remark processor with the parser of Obsidian and the steps of the
        // site (R50, `src/rendering/markup.ts`). The code is highlighted with
        // classes by those steps, after the allow list (REN-06, REN-15).
        processor: markdownProcessor(),
        syntaxHighlight: false
    },
    // A note page above the HTML budget gives a warning, not a stop (R57).
    // A shared title or description, or a note too far from the home page,
    // stops the build (IDX-04, IDX-05, NAV-07, R61). Then the full-text index
    // of the note pages is written (SRCH-01, R63), and the server error page
    // gets its style inside it (NAV-20, R64).
    integrations: [notePageBudget(), siteChecks(), searchIndex(), selfContainedPages()],
    vite: {
        plugins: [tailwindcss()]
    }
})
