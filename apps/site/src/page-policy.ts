import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'
import type { Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { PAGE_POLICY_FILE, SERVER_ERROR_FILE, pagePolicyFrom } from '@dsebastien-website/resolver'
import { analyticsOfEnvironment, type AnalyticsSettings } from './analytics/analytics.ts'
import { VIDEO_FRAME_ORIGIN } from './link-previews/video.ts'
import { tabStylesOf } from './music/tab-style.ts'
import { MEMBERS_SITE } from './newsletter/signup.ts'

// The Content Security Policy of the pages (SEC-01, issue 79): as strict as
// the features allow. After each build, the hashes of the inline scripts and
// styles of every page go into the policy, which the build writes to
// `PAGE_POLICY_FILE`; the hosts give it to every page. The inline scripts stay
// inline: they are small and run before the first paint (the mode of the
// page), so a file of their own would cost a request on each first visit.
// The server error page is left out: it has no script, and it gets a policy
// of its own (`SCRIPTLESS_PAGE_POLICY` of the resolver).

export { VIDEO_FRAME_ORIGIN }

/**
 * The most distinct inline scripts or styles of a build: an inline script
 * whose text changes on each page makes one hash per page, and belongs in a
 * file of its own.
 */
export const MAX_INLINE_HASHES = 32

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu
/** The `type` attribute of a script element, in its three forms. */
const TYPE = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu
/** The types of a script that runs; any other type is a data block, which runs nothing. */
const RUNNING_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript'])
/** A text that may be a `style` attribute: only then is the page parsed. */
const MAYBE_STYLE_ATTRIBUTE = /\sstyle\s*=/iu

/** True when a script element with these attributes runs: no type, a module or JavaScript. */
function runs(attributes: string): boolean {
    const [, double, single, bare] = TYPE.exec(attributes) ?? []
    return RUNNING_TYPES.has((double ?? single ?? bare ?? '').trim().toLowerCase())
}

/** True when an element of the page has a `style` attribute, read by the rules of HTML. */
function hasStyleAttribute(html: string): boolean {
    const visit = (node: Root | RootContent): boolean =>
        (node.type === 'element' && node.properties['style'] !== undefined) ||
        ('children' in node && node.children.some(visit)) ||
        (node.type === 'element' && node.content !== undefined && visit(node.content))
    return visit(fromHtml(html))
}

/** The inline scripts and styles of the pages of a build. */
export interface InlineCode {
    readonly scripts: ReadonlySet<string>
    readonly styles: ReadonlySet<string>
}

/** The source of a hash of a policy for an inline text, as the browser hashes it. */
export function hashSource(text: string): string {
    return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`
}

/**
 * The inline scripts and styles of a page. A script with a `src` is a file,
 * and a script of another type (`application/ld+json`) is data.
 *
 * @throws when an element of the page has a `style` attribute
 */
export function inlineCodeOf(html: string, page = 'the page'): InlineCode {
    const scripts = new Set<string>()
    const styles = new Set<string>()
    for (const [, attributes = '', text = ''] of html.matchAll(SCRIPT)) {
        if (!/\ssrc\s*=/iu.test(attributes) && runs(attributes)) {
            scripts.add(text)
        }
    }
    for (const [, text = ''] of html.matchAll(STYLE)) {
        styles.add(text)
    }
    // The text of a note can name the attribute (a description, an alt
    // text): only the parsed page tells an attribute from a text.
    if (MAYBE_STYLE_ATTRIBUTE.test(html) && hasStyleAttribute(html)) {
        throw new Error(`${page} has a style attribute, which the Content Security Policy blocks`)
    }
    return { scripts, styles }
}

/** The Content Security Policy of the pages, with the inline code of the build. */
export function pagePolicy(code: InlineCode, analytics?: AnalyticsSettings): string {
    for (const [kind, texts] of [
        ['scripts', code.scripts],
        ['styles', code.styles]
    ] as const) {
        if (texts.size > MAX_INLINE_HASHES) {
            throw new Error(
                `the pages have ${String(texts.size)} distinct inline ${kind}, more than ${String(MAX_INLINE_HASHES)}: an inline text that changes with the page belongs in a file`
            )
        }
    }
    const hashes = (texts: ReadonlySet<string>): string[] => [...texts].sort().map(hashSource)
    const proxy = analytics === undefined ? [] : [new URL(analytics.script).origin]
    const directives: [string, ...string[]][] = [
        ['default-src', "'self'"],
        // Pagefind, the full-text search, runs its WebAssembly in a worker of
        // its own file, so the pages need no 'wasm-unsafe-eval'.
        ['script-src', "'self'", ...proxy, ...hashes(code.scripts)],
        ['style-src', "'self'", ...hashes(code.styles)],
        // The images of other hosts that a note shows still load (issue 79).
        ['img-src', "'self'", 'data:', 'https:'],
        ['font-src', "'self'"],
        ['connect-src', "'self'", ...proxy, MEMBERS_SITE],
        ['frame-src', VIDEO_FRAME_ORIGIN],
        ['object-src', "'none'"],
        ['base-uri', "'none'"],
        ['form-action', "'self'"],
        ['frame-ancestors', "'none'"]
    ]
    return pagePolicyFrom(directives.map((parts) => parts.join(' ')).join('; '))
}

/** The HTML files of an output, as paths in it, but the server error page. */
async function pagesOf(output: string): Promise<string[]> {
    const entries = await readdir(output, { recursive: true, withFileTypes: true })
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => join(entry.parentPath, entry.name))
        .filter((file) => file !== join(output, SERVER_ERROR_FILE))
}

/** Writes the page policy of an output from its pages. */
export async function writePagePolicy(
    output: string,
    analytics: AnalyticsSettings | undefined
): Promise<string> {
    const scripts = new Set<string>()
    const styles = new Set<string>()
    const files = await pagesOf(output)
    // A few files at a time: a build has more than 20,000 pages.
    for (let start = 0; start < files.length; start += 64) {
        const batch = files.slice(start, start + 64)
        const codes = await Promise.all(
            batch.map(async (file) => inlineCodeOf(await readFile(file, 'utf8'), file))
        )
        for (const code of codes) {
            code.scripts.forEach((text) => scripts.add(text))
            code.styles.forEach((text) => styles.add(text))
        }
    }
    // The style that alphaTab adds in the browser, on a page with a tab or a score.
    for (const text of await tabStylesOf(output)) styles.add(text)
    const policy = pagePolicy({ scripts, styles }, analytics)
    await writeFile(join(output, ...PAGE_POLICY_FILE.split('/')), `${policy}\n`)
    return policy
}

/** The Astro integration that writes the page policy after each build. */
export function pagePolicyFile(): AstroIntegration {
    return {
        name: 'page-policy',
        hooks: {
            'astro:build:done': async ({ dir }) => {
                await writePagePolicy(fileURLToPath(dir), analyticsOfEnvironment(process.env))
            }
        }
    }
}
