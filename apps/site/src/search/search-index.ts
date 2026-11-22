import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolverMap } from '@dsebastien-website/resolver'
import type { AstroIntegration } from 'astro'
import * as pagefind from 'pagefind'
import { FULL_TEXT_BASE } from './paths.ts'

// The full-text index of the search (SRCH-01, decision R63), written after
// each build: Pagefind indexes the built note pages, and only them, so the
// index holds the published notes only. A note page marks what is indexed
// (`data-pagefind-body`: the title, the properties and the text; not the
// outline, the backlinks, the header and the footer) and the label of its
// note type (`data-pagefind-meta="type"`). Each page is indexed under its
// canonical path. One index for all languages (spec v1 9.6.2).

/** The folder of the full-text index in the output of the build. */
const FULL_TEXT_FOLDER = FULL_TEXT_BASE.slice(1, -1)

/** The files of Pagefind that the site does not use: its interfaces and its highlight script. */
const UNUSED = /^pagefind-(?:ui|component-ui|modular-ui|highlight)\./u

/** The folder of the note pages in the output of the build. */
const NOTE_PAGES = '-/note/'

/** The note pages of a resolver map, by canonical path. */
export function notePagesOf(map: ResolverMap): [path: string, file: string][] {
    return Object.entries(map.pages).filter(([, file]) => file.startsWith(NOTE_PAGES))
}

/** Writes the full-text index of the note pages of a built site into its output. */
export async function writeFullTextIndex(output: string): Promise<number> {
    const map = JSON.parse(
        await readFile(join(output, '-', 'resolver-map.json'), 'utf8')
    ) as ResolverMap
    const folder = join(output, ...FULL_TEXT_FOLDER.split('/'))
    await rm(folder, { recursive: true, force: true })
    const { index, errors } = await pagefind.createIndex({ forceLanguage: 'en' })
    try {
        if (index === undefined) {
            throw new Error(`the full-text index cannot start: ${errors.join('; ')}`)
        }
        const pages = notePagesOf(map)
        for (const [path, file] of pages) {
            const added = await index.addHTMLFile({
                url: path,
                content: await readFile(join(output, file), 'utf8')
            })
            if (added.errors.length > 0) {
                throw new Error(
                    `the note page ${file} cannot be indexed: ${added.errors.join('; ')}`
                )
            }
        }
        const written = await index.writeFiles({ outputPath: folder })
        if (written.errors.length > 0) {
            throw new Error(`the full-text index cannot be written: ${written.errors.join('; ')}`)
        }
        for (const file of await readdir(folder)) {
            if (UNUSED.test(file)) await rm(join(folder, file))
        }
        return pages.length
    } finally {
        await pagefind.close()
    }
}

/** The integration that writes the full-text index after a build. */
export function searchIndex(): AstroIntegration {
    return {
        name: 'search-index',
        hooks: {
            'astro:build:done': async ({ dir, logger }) => {
                const pages = await writeFullTextIndex(fileURLToPath(dir))
                logger.info(`full-text index of ${String(pages)} note pages`)
            }
        }
    }
}
