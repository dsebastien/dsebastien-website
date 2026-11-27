import type { SearchSources } from './engine.ts'
import { pagefindEngine } from './full-text.ts'
import { partFile, type TitleRow } from './titles.ts'

// The sources of the search over the files of the site (decision R63): the
// keys and the parts of the title index, and the full text of Pagefind. The
// search page and the command palette (issue 122) read them.

async function fetchJson(url: string): Promise<unknown> {
    const answer = await fetch(url)
    if (!answer.ok) {
        throw new Error(`${url}: ${String(answer.status)}`)
    }
    return answer.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The sources of the site: the search, and the notes that search engines must not index. */
export interface SiteSources extends SearchSources {
    /** The canonical paths of the notes that say noindex (R85, R103), from the keys file of the title index. */
    noindex(): Promise<readonly string[]>
}

/**
 * The sources of the search over the files of the site.
 *
 * @param titles the folder of the title index (`TITLES_FOLDER`)
 * @param fullText the folder of the full-text index, with a slash at the end (`FULL_TEXT_BASE`)
 */
export function siteSources(titles: string, fullText: string): SiteSources {
    // The keys file is read one time; a failed read is tried again at the next use.
    let read: Promise<unknown> | undefined
    const keysFile = (): Promise<unknown> => {
        read ??= fetchJson(`${titles}.json`).catch((error: unknown) => {
            read = undefined
            throw error
        })
        return read
    }
    return {
        async noindex() {
            const index = await keysFile()
            const paths = isRecord(index) ? index['noindex'] : undefined
            return Array.isArray(paths)
                ? paths.filter((path): path is string => typeof path === 'string')
                : []
        },
        async keys() {
            const index = await keysFile()
            if (!isRecord(index) || !isRecord(index['keys'])) {
                throw new Error('the title index has no keys')
            }
            const keys: Record<string, boolean> = {}
            for (const [key, complete] of Object.entries(index['keys'])) {
                keys[key] = complete === true
            }
            return keys
        },
        async part(key) {
            const rows = await fetchJson(`${titles}/${partFile(key)}.json`)
            if (!Array.isArray(rows)) {
                throw new Error(`the part "${key}" of the title index is not a list`)
            }
            return rows.filter(
                (row): row is TitleRow =>
                    Array.isArray(row) &&
                    (row.length === 3 || row.length === 4) &&
                    row.every((cell) => typeof cell === 'string')
            )
        },
        fullText: pagefindEngine(fullText)
    }
}
