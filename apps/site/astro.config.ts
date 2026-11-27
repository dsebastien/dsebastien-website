import tailwindcss from '@tailwindcss/vite'
import { SITE_ORIGIN } from '@dsebastien-website/resolver'
import { defineConfig } from 'astro/config'
import { notePageBudget } from './src/budgets.ts'
import { resolverMapParts } from './src/map-parts.ts'
import { pagePolicyFile } from './src/page-policy.ts'
import { markdownProcessor } from './src/rendering/markup.ts'
import { searchIndex } from './src/search/search-index.ts'
import { selfContainedPages } from './src/self-contained.ts'
import { siteChecks } from './src/site-checks.ts'

export default defineConfig({
    // The canonical host of the site: the canonical link of each page names it.
    site: SITE_ORIGIN,
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
    // A missing title or description, or a shared title, stops the build
    // (IDX-04, IDX-05, R61); a shared description (R102), a note too far from
    // the home page (NAV-07) and a link to no page (R65) are warnings. Then the full-text index
    // of the note pages is written (SRCH-01, R63), and the server error page
    // gets its style inside it (NAV-20, R64). The resolver map is cut into
    // parts, which the hosts read (issue 121, R94). The Content Security
    // Policy of the pages gets the hashes of their inline scripts and styles
    // (SEC-01, issue 79).
    integrations: [
        notePageBudget(),
        siteChecks(),
        searchIndex(),
        selfContainedPages(),
        pagePolicyFile(),
        resolverMapParts()
    ],
    vite: {
        plugins: [tailwindcss()],
        // A script module of the build is always a file, never put into the
        // page: the browser keeps it between pages, and the markup holds no
        // address that only the script needs (the signup service, NEWS-04).
        // Other assets keep the default limit of Vite.
        build: {
            assetsInlineLimit: (file: string): boolean | undefined =>
                file.endsWith('.js') ? false : undefined
        }
    }
})
