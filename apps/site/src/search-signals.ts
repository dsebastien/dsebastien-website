import { resolve, type ResolverMap } from '@dsebastien-website/resolver'
import { MAIN_SITE_ORIGIN } from '../../plugin/src/publishing/originals.ts'

// The signals of a built site for search engines (IDX-10, IDX-30, story 126,
// issue 54): every indexable page has one absolute canonical link, with the
// Open Graph and Twitter tags of a shared page, and its canonical link and
// its `og:url` are one URL; that URL, and every URL of a sitemap, leads
// through the resolver straight to its page: 200, no redirect (seo item 18).
// A URL of a sitemap is the URL of an indexable page that names itself
// (IDX-14, IDX-30). Each finding stops the build: a takedown or an
// unpublish cannot cause one, because the build writes all these URLs. A note
// page can name its post on the main site as its original (IDX-11, issue 55):
// then no sitemap lists it.

/** What the checks read of the head of a built page. */
export interface PageSignals {
    /** False when the page says `noindex`. */
    readonly indexable: boolean
    /** The targets of its canonical links. */
    readonly canonicals: readonly string[]
    readonly ogUrl: string | undefined
    readonly ogTitle: string | undefined
    readonly twitterCard: string | undefined
}

function attribute(html: string, pattern: RegExp): string | undefined {
    return pattern.exec(html)?.[1]?.replaceAll('&amp;', '&')
}

/** Reads the signals of a built page. */
export function readPageSignals(html: string): PageSignals {
    const robots = attribute(html, /<meta name="robots" content="([^"]*)"/u) ?? ''
    return {
        indexable: !robots.split(',').some((part) => part.trim() === 'noindex'),
        canonicals: [...html.matchAll(/<link rel="canonical" href="([^"]*)"/gu)].map((match) =>
            (match[1] ?? '').replaceAll('&amp;', '&')
        ),
        ogUrl: attribute(html, /<meta property="og:url" content="([^"]*)"/u),
        ogTitle: attribute(html, /<meta property="og:title" content="([^"]*)"/u),
        twitterCard: attribute(html, /<meta name="twitter:card" content="([^"]*)"/u)
    }
}

/**
 * The file of the page that a URL of the site leads to with 200 and no
 * redirect, or why it does not.
 */
function pageOf(url: string, origin: string, map: ResolverMap): string {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return 'is not a URL'
    }
    if (parsed.origin !== origin || parsed.search !== '' || parsed.hash !== '') {
        return `is not a URL of ${origin} without a query and a fragment`
    }
    const resolution = resolve(parsed.pathname, map)
    return resolution.kind === 'page' ? `=${resolution.file}` : `answers ${resolution.kind}`
}

/** True when the file is a note page and the URL is a page of the main site: the original of the note (IDX-11). */
function namesOriginal(file: string, canonical: string | undefined): boolean {
    return (
        file.startsWith('-/note/') &&
        canonical !== undefined &&
        canonical.startsWith(`${MAIN_SITE_ORIGIN}/`)
    )
}

/**
 * The findings of the signals of a built site.
 *
 * @param pages the signals of the built pages, by file
 * @param origin the canonical origin of the site
 * @param sitemaps the URLs of each sitemap file, by its name
 */
export function signalFindings(
    pages: ReadonlyMap<string, PageSignals>,
    origin: string,
    map: ResolverMap,
    sitemaps: ReadonlyMap<string, readonly string[]>
): string[] {
    const stops: string[] = []
    for (const [file, page] of pages) {
        if (!page.indexable) continue
        const [canonical, ...more] = page.canonicals
        if (canonical === undefined || more.length > 0) {
            stops.push(`${file} has ${String(page.canonicals.length)} canonical links, not one`)
            continue
        }
        if (page.ogUrl !== canonical) {
            stops.push(`${file} has the og:url "${page.ogUrl ?? ''}", not its canonical link`)
        }
        if (page.ogTitle === undefined || page.twitterCard === undefined) {
            stops.push(`${file} has no og:title or no twitter:card`)
        }
        if (namesOriginal(file, canonical)) {
            continue
        }
        const target = pageOf(canonical, origin, map)
        if (target !== `=${file}`) {
            stops.push(
                `the canonical link "${canonical}" of ${file} ${target.startsWith('=') ? `leads to ${target.slice(1)}` : target}`
            )
        }
    }
    const listed = new Set<string>()
    for (const [sitemap, urls] of sitemaps) {
        for (const url of urls) {
            if (listed.has(url)) {
                stops.push(`${sitemap} lists "${url}", which another entry lists`)
                continue
            }
            listed.add(url)
            const target = pageOf(url, origin, map)
            if (!target.startsWith('=')) {
                stops.push(`${sitemap} lists "${url}", which ${target}`)
                continue
            }
            const page = pages.get(target.slice(1))
            if (page?.indexable !== true || page.canonicals[0] !== url) {
                stops.push(
                    `${sitemap} lists "${url}", which is not an indexable page that names itself`
                )
            }
        }
    }
    // Every indexable page is in a sitemap (IDX-30).
    for (const [file, page] of pages) {
        const [canonical] = page.canonicals
        if (
            page.indexable &&
            canonical !== undefined &&
            !listed.has(canonical) &&
            !namesOriginal(file, canonical)
        ) {
            stops.push(`${file} is an indexable page that no sitemap lists`)
        }
    }
    return stops
}
