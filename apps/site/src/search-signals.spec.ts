import { describe, expect, test } from 'bun:test'
import { resolverMapOf, type SiteFiles } from '@dsebastien-website/resolver'
import { readPageSignals, signalFindings, type PageSignals } from './search-signals.ts'

const ORIGIN = 'https://notes.example'

const FILES: SiteFiles = {
    home: 'index.html',
    notFound: '404.html',
    gone: '410.html',
    robots: 'robots.txt',
    icon: 'favicon.ico',
    page: (path) => `-/note/${path}.html`,
    markdown: (path) => `-/md/${path}`,
    folder: (path) => `-/folder/${path}.html`,
    choice: (paths) => `-/choice/${paths.join('+')}.html`
}

const map = resolverMapOf([{ path: 'Garden/Rain barrel.md', aliases: ['Barrel'] }], FILES)

const NOTE = '-/note/Garden/Rain barrel.md.html'
const URL_OF_NOTE = `${ORIGIN}/Garden/Rain+barrel`

function signals(canonical: string | undefined, options: Partial<PageSignals> = {}): PageSignals {
    return {
        indexable: true,
        canonicals: canonical === undefined ? [] : [canonical],
        ogUrl: canonical,
        ogTitle: 'A title',
        twitterCard: 'summary',
        ...options
    }
}

const SITEMAPS = new Map([
    ['sitemap-notes.xml', [URL_OF_NOTE]],
    ['sitemap-generated.xml', [`${ORIGIN}/`]]
])

describe('the signals of a built page', () => {
    test('are its canonical links, its og:url, og:title, twitter:card and robots tag', () => {
        const html =
            '<head><meta name="robots" content="noindex, follow"><link rel="canonical" href="https://notes.example/A+%26+B?x=1&amp;y=2"><meta property="og:title" content="A"><meta property="og:url" content="https://notes.example/A"><meta name="twitter:card" content="summary"></head>'
        expect(readPageSignals(html)).toEqual({
            indexable: false,
            canonicals: ['https://notes.example/A+%26+B?x=1&y=2'],
            ogUrl: 'https://notes.example/A',
            ogTitle: 'A',
            twitterCard: 'summary'
        })
    })
})

describe('the checks of the signals', () => {
    const good = new Map([
        ['index.html', signals(`${ORIGIN}/`)],
        [NOTE, signals(URL_OF_NOTE)],
        ['-/search.html', signals(undefined, { indexable: false })]
    ])

    test('find nothing on a site whose URLs lead to their pages', () => {
        expect(signalFindings(good, ORIGIN, map, SITEMAPS)).toEqual([])
    })

    test('stop an indexable page without one canonical link, the og:url or the share tags', () => {
        const pages = new Map([
            ['index.html', signals(undefined)],
            [NOTE, signals(URL_OF_NOTE, { ogUrl: `${ORIGIN}/x`, twitterCard: undefined })]
        ])
        expect(signalFindings(pages, ORIGIN, map, new Map())).toEqual([
            'index.html has 0 canonical links, not one',
            `${NOTE} has the og:url "${ORIGIN}/x", not its canonical link`,
            `${NOTE} has no og:title or no twitter:card`,
            `${NOTE} is an indexable page that no sitemap lists`
        ])
    })

    // AC6: every URL that the build writes answers 200 with no redirect.
    test('stop a canonical link that redirects, leads elsewhere or names another host', () => {
        for (const [canonical, why] of [
            [`${ORIGIN}/Barrel`, 'answers redirect'],
            [`${ORIGIN}/garden/rain+barrel`, 'answers redirect'],
            [`${ORIGIN}/`, 'leads to index.html'],
            ['https://other.example/Garden/Rain+barrel', 'is not a URL of'],
            [`${URL_OF_NOTE}?a=1`, 'is not a URL of']
        ] as const) {
            const found = signalFindings(
                new Map([[NOTE, signals(canonical)]]),
                ORIGIN,
                map,
                new Map()
            )
            expect(found[0]).toContain(why)
        }
    })

    test('stop a sitemap URL that is not an indexable page that names itself', () => {
        const pages = new Map([
            ...good,
            ['-/search.html', signals(`${ORIGIN}/-/nothing`, { indexable: false })]
        ])
        const found = signalFindings(
            pages,
            ORIGIN,
            map,
            new Map([
                ['sitemap-notes.xml', [URL_OF_NOTE, `${ORIGIN}/Barrel`, `${ORIGIN}/Nothing`]],
                ['sitemap-generated.xml', [`${ORIGIN}/`, URL_OF_NOTE]]
            ])
        )
        expect(found).toEqual([
            `sitemap-notes.xml lists "${ORIGIN}/Barrel", which answers redirect`,
            `sitemap-notes.xml lists "${ORIGIN}/Nothing", which answers not-found`,
            `sitemap-generated.xml lists "${URL_OF_NOTE}", which another entry lists`
        ])
    })
})
