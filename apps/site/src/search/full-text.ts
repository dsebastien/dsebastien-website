import { excerptParts, type FullTextEngine, type FullTextHit } from './engine.ts'

// The full text of the search with Pagefind (SRCH-04, decision R63). Only
// this module knows the library: the build writes its index of the note
// pages into `/-/search/pagefind/` (`search-index.ts`), and the page loads
// `pagefind.js` from there at the first full-text search (R57).

/** What the search reads of the module of Pagefind. */
interface PagefindModule {
    options(options: { basePath: string; baseUrl: string }): Promise<void>
    search(query: string): Promise<{ results: readonly { data(): Promise<unknown> }[] }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function isPagefind(value: unknown): value is PagefindModule {
    return (
        isRecord(value) &&
        typeof value['options'] === 'function' &&
        typeof value['search'] === 'function'
    )
}

/** A result of Pagefind as a hit of the search; `undefined` when it lacks a part. */
function hitOf(data: unknown): FullTextHit | undefined {
    if (!isRecord(data) || typeof data['url'] !== 'string' || typeof data['excerpt'] !== 'string') {
        return undefined
    }
    const meta = isRecord(data['meta']) ? data['meta'] : {}
    const title = typeof meta['title'] === 'string' ? meta['title'] : data['url']
    const type = typeof meta['type'] === 'string' && meta['type'] !== '' ? meta['type'] : undefined
    return {
        path: data['url'],
        title,
        ...(type === undefined ? {} : { type }),
        excerpt: excerptParts(data['excerpt'])
    }
}

/**
 * The loader of the full text: it loads Pagefind from `base` (the folder of
 * its files, with a slash at the end) at its first call.
 */
export function pagefindEngine(base: string): () => Promise<FullTextEngine> {
    return async () => {
        const loaded: unknown = await import(/* @vite-ignore */ `${base}pagefind.js`)
        if (!isPagefind(loaded)) {
            throw new Error('the full-text index did not load')
        }
        // The build gives each page its canonical path: no folder goes in front of it.
        await loaded.options({ basePath: base, baseUrl: '/' })
        return {
            async search(query) {
                const { results } = await loaded.search(query)
                return {
                    total: results.length,
                    async hits(from, count) {
                        const data = await Promise.all(
                            results.slice(from, from + count).map((result) => result.data())
                        )
                        return data.map(hitOf).filter((hit) => hit !== undefined)
                    }
                }
            }
        }
    }
}
