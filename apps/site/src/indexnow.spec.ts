import { describe, expect, test } from 'bun:test'
import {
    changedUrls,
    INDEXNOW_BATCH,
    INDEXNOW_KEY,
    indexNowBatches,
    sitemapDates
} from './indexnow.ts'
import { sitemapXml } from './sitemaps.ts'

const ORIGIN = 'https://notes.example'

describe('the IndexNow key', () => {
    test('is 32 hexadecimal digits', () => {
        expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/u)
    })
})

describe('the URLs that a release sends', () => {
    const before = sitemapDates([
        sitemapXml(
            [
                { path: '/Same', lastmod: '2031-01-01T00:00:00Z' },
                { path: '/Edited', lastmod: '2031-01-01T00:00:00Z' },
                { path: '/Removed', lastmod: '2031-01-01T00:00:00Z' },
                { path: '/' }
            ],
            ORIGIN
        )
    ])
    const after = sitemapDates([
        sitemapXml(
            [
                { path: '/Same', lastmod: '2031-01-01T00:00:00Z' },
                { path: '/Edited', lastmod: '2031-02-01T00:00:00Z' },
                { path: '/New', lastmod: '2031-02-01T00:00:00Z' }
            ],
            ORIGIN
        ),
        sitemapXml([{ path: '/' }], ORIGIN)
    ])

    test('are the new, the changed and the removed URLs, never one that did not change', () => {
        expect(changedUrls(before, after)).toEqual([
            `${ORIGIN}/Edited`,
            `${ORIGIN}/New`,
            `${ORIGIN}/Removed`
        ])
    })

    // IDX-35: the switch, with no sitemap before, sends every URL one time.
    test('are every URL of the sitemaps when the host had no sitemap', () => {
        expect(changedUrls(new Map(), after)).toEqual([
            `${ORIGIN}/`,
            `${ORIGIN}/Edited`,
            `${ORIGIN}/New`,
            `${ORIGIN}/Same`
        ])
    })

    test('are none when nothing changed', () => {
        expect(changedUrls(after, after)).toEqual([])
    })
})

describe('the batches of IndexNow', () => {
    test('name the host, the key and the key file, with 10,000 URLs at most each', () => {
        const urls = Array.from({ length: INDEXNOW_BATCH + 1 }, (_, n) => `${ORIGIN}/${String(n)}`)
        const batches = indexNowBatches(ORIGIN, urls)
        expect(batches).toHaveLength(2)
        expect(batches[0]?.urlList).toHaveLength(INDEXNOW_BATCH)
        expect(batches[1]).toEqual({
            host: 'notes.example',
            key: INDEXNOW_KEY,
            keyLocation: `${ORIGIN}/${INDEXNOW_KEY}.txt`,
            urlList: [`${ORIGIN}/${String(INDEXNOW_BATCH)}`]
        })
        expect(indexNowBatches(ORIGIN, [])).toEqual([])
    })
})
