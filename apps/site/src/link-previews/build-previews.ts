import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINK_PREVIEW_FOLDER } from '@dsebastien-website/resolver'
import type { AstroIntegration } from 'astro'
import { guardedFetch } from './guarded-fetch.ts'
import {
    previewFileOf,
    previewImageNames,
    previewKey,
    readLinkPreviews,
    type LinkPreview,
    type PreviewTarget
} from './previews.ts'

// The previews of the link cards in a build (CARD-06, CARD-07, CARD-09). The
// variable `LINK_PREVIEWS` says what the build does: `fetch` reads the cache
// and fetches what it lacks (the deploy on the machine that publishes),
// `cache` reads the cache only, and no value (the public CI, the tests) gives
// compact cards and reads nothing. The cache is `.cache/link-previews/` of
// the site, or the folder that `LINK_PREVIEWS_CACHE` names. After the build,
// the images of the previews that the pages name go from the cache into the
// output.

/** The variable that says what the build does with the previews. */
export const LINK_PREVIEWS = 'LINK_PREVIEWS'
/** The variable that names the cache folder. */
export const LINK_PREVIEWS_CACHE = 'LINK_PREVIEWS_CACHE'

/** What a build does with the previews. */
export type PreviewMode = 'off' | 'cache' | 'fetch'

/** The mode and the cache folder of a build, from its environment. */
export function previewSettingsOf(environment: Readonly<Record<string, string | undefined>>): {
    mode: PreviewMode
    cache: string
} {
    const value = environment[LINK_PREVIEWS] ?? ''
    const named = environment[LINK_PREVIEWS_CACHE] ?? ''
    const cache = named === '' ? resolve('.cache', 'link-previews') : resolve(named)
    if (value === '') return { mode: 'off', cache }
    if (value === 'cache' || value === 'fetch') return { mode: value, cache }
    throw new Error(`${LINK_PREVIEWS} is "${value}": it must be empty, "cache" or "fetch"`)
}

/** The previews of the cards of a build, by their targets. */
export async function buildPreviews(
    targets: readonly PreviewTarget[]
): Promise<(target: PreviewTarget) => LinkPreview | undefined> {
    const { mode, cache } = previewSettingsOf(process.env)
    if (mode === 'off' || targets.length === 0) return () => undefined
    const previews = await readLinkPreviews(targets, {
        cache,
        now: new Date(),
        ...(mode === 'fetch' ? { fetch: guardedFetch() } : {})
    })
    return (target) => {
        const key = previewKey(target)
        return key === undefined ? undefined : previews.get(key)
    }
}

const NAMED = new RegExp(`/${LINK_PREVIEW_FOLDER}/[0-9a-f]{64}\\.webp`, 'gu')

/**
 * Puts into an output the images of the previews that its pages name, from
 * the cache. Only an image of the index of the cache counts: a note text that
 * writes such an address names no file.
 */
export async function copyPreviewImages(output: string, cache: string): Promise<number> {
    const known = await previewImageNames(cache)
    if (known.size === 0) return 0
    const entries = await readdir(output, { recursive: true, withFileTypes: true })
    const pages = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => join(entry.parentPath, entry.name))
    const named = new Set<string>()
    for (let start = 0; start < pages.length; start += 64) {
        const texts = await Promise.all(
            pages.slice(start, start + 64).map((page) => readFile(page, 'utf8'))
        )
        for (const text of texts) {
            for (const [path] of text.matchAll(NAMED)) {
                if (known.has(path.slice(path.lastIndexOf('/') + 1))) named.add(path)
            }
        }
    }
    if (named.size === 0) return 0
    const folder = join(output, ...LINK_PREVIEW_FOLDER.split('/'))
    await mkdir(folder, { recursive: true })
    for (const path of named) {
        const file = previewFileOf(cache, path)
        if (file === undefined) continue
        await copyFile(file, join(folder, path.slice(path.lastIndexOf('/') + 1)))
    }
    return named.size
}

/** The Astro integration that puts the images of the cards into the output after each build. */
export function linkPreviewFiles(): AstroIntegration {
    return {
        name: 'link-previews',
        hooks: {
            'astro:build:done': async ({ dir }) => {
                const { mode, cache } = previewSettingsOf(process.env)
                if (mode === 'off') return
                await copyPreviewImages(fileURLToPath(dir), cache)
            }
        }
    }
}
