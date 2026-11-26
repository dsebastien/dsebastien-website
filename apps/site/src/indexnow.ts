import { entriesOf } from './sitemaps.ts'

// IndexNow (IDX-35, story 125, issue 54; seo items 121 and 123). The key is
// public by design: a search engine reads it in the key file at the root of
// the host, `/<key>.txt`, which the build writes, and which is a reserved
// root name (URL-09: a name that ends with `.txt`). After a deployment that
// is seen live on a host that is not marked noindex, the deploy command sends
// the URLs of the sitemaps that are new, changed (another `lastmod`) or
// removed since the release before, as the live sitemaps gave them before the
// deployment (`release.ts`). A host with no sitemap before (the switch) gets
// every URL of the sitemaps: the one full submission of IDX-35. The sitemaps
// hold only canonical URLs that name themselves (IDX-14), so the batches do
// too.

/** The IndexNow key of the site: 32 hexadecimal digits, public. */
export const INDEXNOW_KEY = 'e004b3f71f5a1950d1aca3dd38cf06d5'

/** The path of the key file. */
export const INDEXNOW_KEY_PATH = `/${INDEXNOW_KEY}.txt`

/** The address that takes the batches, and passes them to every engine that takes part. */
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'

/** The most URLs of one batch (IndexNow documentation). */
export const INDEXNOW_BATCH = 10_000

/** One request of IndexNow, as JSON. */
export interface IndexNowBatch {
    readonly host: string
    readonly key: string
    readonly keyLocation: string
    readonly urlList: readonly string[]
}

/** The entries of a set of sitemap files: the `lastmod` of each URL (`''` with none). */
export function sitemapDates(files: readonly string[]): Map<string, string> {
    const dates = new Map<string, string>()
    for (const xml of files) {
        for (const entry of entriesOf(xml)) {
            dates.set(entry.loc, entry.lastmod ?? '')
        }
    }
    return dates
}

/**
 * The URLs to send after a release: the new and the changed URLs of the
 * sitemaps, then the removed ones, each in the order of the code points.
 *
 * @param before the URLs of the live sitemaps before the release, with their dates
 * @param after the URLs of the sitemaps of the release, with their dates
 */
export function changedUrls(
    before: ReadonlyMap<string, string>,
    after: ReadonlyMap<string, string>
): string[] {
    const order = (one: string, two: string): number => (one < two ? -1 : one > two ? 1 : 0)
    const changed = [...after]
        .filter(([url, date]) => before.get(url) !== date)
        .map(([url]) => url)
        .sort(order)
    const removed = [...before.keys()].filter((url) => !after.has(url)).sort(order)
    return [...changed, ...removed]
}

/** The batches of these URLs for the site at this origin. */
export function indexNowBatches(origin: string, urls: readonly string[]): IndexNowBatch[] {
    const site = new URL(origin)
    const batches: IndexNowBatch[] = []
    for (let start = 0; start < urls.length; start += INDEXNOW_BATCH) {
        batches.push({
            host: site.host,
            key: INDEXNOW_KEY,
            keyLocation: new URL(INDEXNOW_KEY_PATH, site).href,
            urlList: urls.slice(start, start + INDEXNOW_BATCH)
        })
    }
    return batches
}
