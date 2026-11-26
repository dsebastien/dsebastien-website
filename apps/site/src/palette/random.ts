import type { SearchSources } from '../search/engine.ts'

// The random note of the palette (SRCH-05, item 134, issue 122), from the
// title index that the search loads: a complete part picked by chance, then
// a title of it, never an alias, never a note that search engines must not
// index (`publish_noindex`, R85: the title index names them). A note with more
// words is in more parts, so the chance is not the same for every note.

/** The tries before no note is found: a part can hold aliases only. */
const TRIES = 3

/** The canonical path of a published note picked by chance; `undefined` when none could be. */
export async function randomNote(
    sources: Pick<SearchSources, 'keys' | 'part'> & {
        /** The notes that search engines must not index. */
        noindex(): Promise<readonly string[]>
    },
    chance: () => number = Math.random
): Promise<string | undefined> {
    const keys = Object.entries(await sources.keys())
        .filter(([, complete]) => complete)
        .map(([key]) => key)
    const hidden = new Set(await sources.noindex())
    for (let tried = 0; tried < TRIES; tried += 1) {
        const key = keys[Math.floor(chance() * keys.length)]
        if (key === undefined) return undefined
        const titles = (await sources.part(key)).filter(
            (row) => row.length === 3 && !hidden.has(row[1])
        )
        const row = titles[Math.floor(chance() * titles.length)]
        if (row !== undefined) return row[1]
    }
    return undefined
}
