// The paths of the site that the palette opens and reads (issue 122). The
// resolver owns every path of the site (`packages/resolver`), but its module
// carries the tables of the letters, which the palette does not need: these
// are the same texts, and `site-paths.spec.ts` checks them against the
// resolver and the files of the search.

/** The home page. */
export const HOME = '/'
/** The search page (`SEARCH_PATH`). */
export const SEARCH_PAGE = '/-/search'
/** The title index (`TITLES_FOLDER`). */
export const TITLES = '/-/search/titles'
/** The folder of the full-text index, with a slash at the end (`FULL_TEXT_BASE`). */
export const FULL_TEXT = '/-/search/pagefind/'
/** The first pages of the recent lists (`recentPath()`). */
export const RECENT_ADDED = '/-/recent/added'
export const RECENT_UPDATED = '/-/recent/updated'
/** The library (`LIBRARY_PATH`). */
export const LIBRARY = '/-/library'

/** The path of the Markdown of a note from its canonical path (`markdownPath()`). */
export function markdownOf(notePath: string): string {
    return `/-/md${notePath}.md`
}
