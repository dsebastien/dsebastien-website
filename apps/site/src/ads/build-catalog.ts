import { resolve } from 'node:path'
import type { Product } from './catalog.ts'
import { readStoreCatalog } from './catalog.ts'

// The store catalog of a build (BUILD-06): the source that the variable
// `STORE_CATALOG` names (a file or an https address), and the last valid
// copy in `.cache/store-catalog.json` of the site, or the file that
// `STORE_CATALOG_COPY` names. Without `STORE_CATALOG` the build has no
// catalog and shows no product ad, which is the state of the public CI. A
// warning goes to the output of the build.

/** The variable that names the source of the store catalog. */
export const STORE_CATALOG = 'STORE_CATALOG'

/** The products of the store catalog of this build. */
export async function storeCatalog(): Promise<readonly Product[]> {
    const copy = process.env['STORE_CATALOG_COPY']
    const read = await readStoreCatalog({
        source: process.env[STORE_CATALOG],
        copy: copy === undefined || copy === '' ? resolve('.cache', 'store-catalog.json') : copy
    })
    for (const warning of read.warnings) {
        console.warn(`[store-catalog] ${warning}`)
    }
    return read.products
}
