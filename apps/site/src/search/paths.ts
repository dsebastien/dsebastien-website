import { SEARCH_PATH } from '@dsebastien-website/resolver'

// The addresses of the files of the search (decision R63), under the path
// of the search page. The build writes them, the page reads them.

/** The title index: its keys at `<folder>.json`, each part at `<folder>/<part file>.json`. */
export const TITLES_FOLDER = `${SEARCH_PATH}/titles`

/** The folder of the full-text index, with a slash at the end. */
export const FULL_TEXT_BASE = `${SEARCH_PATH}/pagefind/`
