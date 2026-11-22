import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve, type ResolverMap } from '@dsebastien-website/resolver'
import type { AstroIntegration } from 'astro'

// The checks of a built site (IDX-04, IDX-05, NAV-07, decision R61): every
// indexable page has a title and a description, no two indexable pages share
// a title or a description, every indexable note is reachable from the home
// page in at most four plain links, and no internal link of a page leads to
// the "not found" page. A finding stops the build.

/** The most links from the home page to an indexable note (NAV-07). */
export const MOST_LINKS_TO_A_NOTE = 4

/** What the checks read of a built page. */
export interface BuiltPage {
    readonly title: string | undefined
    readonly description: string | undefined
    /** False when the page says `noindex`. */
    readonly indexable: boolean
    /** The targets of its plain links, as the page writes them. */
    readonly links: readonly string[]
}

/** The characters that HTML writes as entities in an attribute or a text. */
function decoded(text: string): string {
    return text
        .replace(/&#x([0-9a-f]+);/giu, (_all, hex: string) =>
            String.fromCodePoint(Number.parseInt(hex, 16))
        )
        .replace(/&#([0-9]+);/gu, (_all, digits: string) =>
            String.fromCodePoint(Number.parseInt(digits, 10))
        )
        .replaceAll('&quot;', '"')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&')
}

/** Where a link of a built page leads: a page of the site, the "not found" page, or something else (a file, an attachment, another site). */
export type LinkTarget =
    | { readonly kind: 'page'; readonly file: string }
    | { readonly kind: 'missing' }
    | { readonly kind: 'other' }

/** Reads the parts of a built page that the checks need. */
export function readBuiltPage(html: string): BuiltPage {
    const title = /<title>([^<]*)<\/title>/u.exec(html)?.[1]
    const description = /<meta name="description" content="([^"]*)"/u.exec(html)?.[1]
    const robots = /<meta name="robots" content="([^"]*)"/u.exec(html)?.[1] ?? ''
    const links = [...html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/gu)].map((match) =>
        decoded(match[1] ?? '')
    )
    return {
        title: title === undefined ? undefined : decoded(title),
        description: description === undefined ? undefined : decoded(description),
        indexable: !robots.split(',').some((part) => part.trim() === 'noindex'),
        links
    }
}

/**
 * The findings of the checks on the pages of a site, by their files.
 *
 * @param pages the built pages, by file
 * @param home the file of the home page
 * @param notes the files of the note pages
 * @param targetOf where a link leads
 */
export function siteFindings(
    pages: ReadonlyMap<string, BuiltPage>,
    home: string,
    notes: ReadonlySet<string>,
    targetOf: (link: string) => LinkTarget
): string[] {
    const findings: string[] = []
    const targets = new Map<string, LinkTarget>()
    const target = (link: string): LinkTarget => {
        const known = targets.get(link) ?? targetOf(link)
        targets.set(link, known)
        return known
    }
    const titles = new Map<string, string>()
    const descriptions = new Map<string, string>()
    for (const [file, page] of pages) {
        if (!page.indexable) continue
        if (page.title === undefined || page.title.trim() === '') {
            findings.push(`${file} has no title`)
        } else if (titles.has(page.title)) {
            findings.push(
                `${file} and ${titles.get(page.title) ?? ''} share the title "${page.title}"`
            )
        } else {
            titles.set(page.title, file)
        }
        if (page.description === undefined || page.description.trim() === '') {
            findings.push(`${file} has no description`)
        } else if (descriptions.has(page.description)) {
            findings.push(
                `${file} and ${descriptions.get(page.description) ?? ''} share the description "${page.description}"`
            )
        } else {
            descriptions.set(page.description, file)
        }
    }
    // A link to the "not found" page, from any page: a reader would follow it.
    for (const [file, page] of pages) {
        for (const link of new Set(page.links)) {
            if (target(link).kind === 'missing') {
                findings.push(`${file} links to "${link}", which leads to no page`)
            }
        }
    }
    // The plain links from the home page, one step at a time (NAV-07).
    const depth = new Map([[home, 0]])
    let step = [home]
    for (let links = 1; links <= MOST_LINKS_TO_A_NOTE && step.length > 0; links++) {
        const next: string[] = []
        for (const file of step) {
            for (const link of pages.get(file)?.links ?? []) {
                const to = target(link)
                if (to.kind === 'page' && pages.has(to.file) && !depth.has(to.file)) {
                    depth.set(to.file, links)
                    next.push(to.file)
                }
            }
        }
        step = next
    }
    for (const file of notes) {
        if (pages.get(file)?.indexable === true && !depth.has(file)) {
            findings.push(
                `${file} is an indexable note that the home page does not reach in ${String(MOST_LINKS_TO_A_NOTE)} links`
            )
        }
    }
    return findings
}

/** Where a link of a page leads, through the resolver, after one redirect at most. */
export function fileOfLink(link: string, map: ResolverMap): LinkTarget {
    if (!link.startsWith('/') || link.startsWith('//')) {
        return { kind: 'other' }
    }
    const path = link.split('#')[0]?.split('?')[0] ?? ''
    const first = resolve(path, map)
    const resolution = first.kind === 'redirect' ? resolve(first.location, map) : first
    switch (resolution.kind) {
        case 'page':
            return { kind: 'page', file: resolution.file }
        // The gone page of an unpublished note is no page to link to (R64).
        case 'not-found':
        case 'gone':
            return { kind: 'missing' }
        default:
            return { kind: 'other' }
    }
}

/** The checks of the built site, after a build. A finding stops the build. */
export function siteChecks(): AstroIntegration {
    return {
        name: 'site-checks',
        hooks: {
            'astro:build:done': async ({ dir, logger }) => {
                const output = fileURLToPath(dir)
                const map = JSON.parse(
                    await readFile(join(output, '-', 'resolver-map.json'), 'utf8')
                ) as ResolverMap
                const pages = new Map<string, BuiltPage>()
                for (const file of new Set(Object.values(map.pages))) {
                    pages.set(file, readBuiltPage(await readFile(join(output, file), 'utf8')))
                }
                // The "not found" page is no path of the map, but a reader follows its links.
                if (map.notFound !== undefined) {
                    pages.set(
                        map.notFound,
                        readBuiltPage(await readFile(join(output, map.notFound), 'utf8'))
                    )
                }
                const notes = new Set(
                    [...pages.keys()].filter((file) => file.startsWith('-/note/'))
                )
                const findings = siteFindings(
                    pages,
                    map.pages['/'] ?? 'index.html',
                    notes,
                    (link) => fileOfLink(link, map)
                )
                if (findings.length > 0) {
                    throw new Error(
                        `the built site breaks ${String(findings.length)} rule(s) of IDX-04, IDX-05, NAV-07 and its links:\n${findings.slice(0, 20).join('\n')}`
                    )
                }
                logger.info(
                    `${String(pages.size)} pages: titles and descriptions unique, every indexable note within ${String(MOST_LINKS_TO_A_NOTE)} links of the home page, no link to a missing page`
                )
            }
        }
    }
}
