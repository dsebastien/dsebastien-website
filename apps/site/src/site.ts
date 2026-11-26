// The facts of the site that every page shows.

/** The name of the site (OPEN-06, decision R49). It leads home from every page. */
export const SITE_NAME = 'Sébastien’s Notes'

/** The license of the text of the author (decision D29). */
export const LICENSE = 'CC BY-NC-SA 4.0'

/** The author of the notes: the `author` element of every page. */
export const AUTHOR = 'Sébastien Dubois'

/** The account of the author on X: the cards of a shared page name it. */
export const X_ACCOUNT = '@dsebastien'

/**
 * The address of the store catalog (`products-light.json`, CAT-01, business
 * rule 8). The `www` host answers it; the bare host redirects without a CORS
 * header (research 1.7). A deployment builds with it unless `STORE_CATALOG`
 * names another source.
 */
export const STORE_CATALOG_URL = 'https://www.store.dsebastien.net/products-light.json'
