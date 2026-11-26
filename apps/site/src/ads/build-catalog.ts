import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { STORE_CATALOG_URL } from '../site.ts'
import type { Product } from './catalog.ts'
import { readStoreCatalog } from './catalog.ts'

// The store catalog of a build (BUILD-06): the source that the variable
// `STORE_CATALOG` names (a file or an https address), and the last valid
// copy of the live catalog in `.cache/store-catalog.json` of the site, or the
// file that `STORE_CATALOG_COPY` names. Without `STORE_CATALOG` the build has
// no catalog and shows no product ad, which is the state of the public CI.
// Each warning goes to the output of the build, and to the file that
// `STORE_CATALOG_REPORT` names, which a deployment puts in its result line.

/** The variable that names the source of the store catalog. */
export const STORE_CATALOG = 'STORE_CATALOG'

/** The products of the store catalog of this build. */
export async function storeCatalog(): Promise<readonly Product[]> {
    const copy = process.env['STORE_CATALOG_COPY']
    const read = await readStoreCatalog({
        source: process.env[STORE_CATALOG],
        copy: copy === undefined || copy === '' ? resolve('.cache', 'store-catalog.json') : copy,
        live: STORE_CATALOG_URL,
        now: new Date()
    })
    const report = process.env['STORE_CATALOG_REPORT']
    for (const warning of read.warnings) {
        console.warn(`[store-catalog] ${warning}`)
        if (report !== undefined && report !== '') {
            await appendFile(report, `[store-catalog] ${warning}\n`)
        }
    }
    return read.products
}
