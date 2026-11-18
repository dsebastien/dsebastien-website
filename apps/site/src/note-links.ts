import type { SatteriProcessorOptions } from '@astrojs/markdown-satteri'
import { linkPathOfDestination, wikilinksOf } from '../../plugin/src/publishing/links.ts'

// The links between notes on a page (BUILD-05, REN-04 of the spec).
//
// The work has two steps, because Astro keeps the markup of a note between
// two builds as long as the text of the note is the same:
//
// 1. `noteLinks` runs when a note is rendered. It marks each link to a
//    note with its link path, and it does not know which note is published.
//    So the markup depends on the text of the note only.
// 2. `withLinkState` runs for each page of each build. It makes a link of a
//    mark when the target is published, and plain text in the "not published"
//    style in every other case. So a link appears when its target is
//    published, with no change to the note that holds it.
//
// The build reads a link with the functions of the publishing tool, so that
// the link path of a mark is the link path of the manifest entry.

/** A plugin of the Markdown tree, as the renderer of Astro takes it. */
type MarkdownPlugin = NonNullable<SatteriProcessorOptions['mdastPlugins']>[number]

/** A node that the plugin puts into the tree. */
type NewNode = { type: 'text'; value: string } | { type: 'html'; value: string }

/** The element that stands for a link to a note until the page is made. */
const MARK = 'note-link'

/** A text as the value of an attribute: plain ASCII, with no quote and no character that HTML escapes. */
function encode(text: string): string {
    return encodeURIComponent(text).replaceAll("'", '%27')
}

/** The start of the mark of one link, with its link path. */
function open(linkPath: string): NewNode {
    return { type: 'html', value: `<${MARK} data-link="${encode(linkPath)}">` }
}

const CLOSE: NewNode = { type: 'html', value: `</${MARK}>` }

/** The nodes that a text becomes: its wikilinks and its embeds as marks. `undefined` when it holds none. */
function split(value: string): NewNode[] | undefined {
    const parts: NewNode[] = []
    let done = 0
    let offset = 0
    for (const line of value.split('\n')) {
        for (const link of wikilinksOf(line)) {
            const start = offset + link.start
            const end = offset + link.end
            if (start > done) {
                parts.push({ type: 'text', value: value.slice(done, start) })
            }
            const shown: NewNode = { type: 'text', value: link.text }
            if (link.linkPath === '') {
                // A link into the note itself is plain text until the rendering slice.
                parts.push(shown)
            } else {
                // An embed is a link until the rendering slice puts the text of its target in its place.
                parts.push(open(link.linkPath), shown, CLOSE)
            }
            done = end
        }
        offset += line.length + 1
    }
    if (parts.length === 0) {
        return undefined
    }
    if (done < value.length) {
        parts.push({ type: 'text', value: value.slice(done) })
    }
    return parts
}

/**
 * The plugin of the Markdown renderer: it marks the links to notes. Code and
 * raw HTML are not text for the renderer, so a link in them stays as it is.
 */
export const noteLinks: MarkdownPlugin = {
    name: 'note-links',
    text(node, context) {
        // The text of a Markdown link is not read again: a mark holds no mark.
        if (context.parent(node).type === 'link') {
            return
        }
        const parts = split(node.value)
        if (parts !== undefined) {
            context.replaceNode(node, parts)
        }
    },
    // A Markdown link to a file of the vault. Its text stays as it is.
    link(node, context) {
        const linkPath = linkPathOfDestination(node.url)
        if (linkPath !== undefined && linkPath !== '') {
            context.replaceNode(node, [open(linkPath), ...node.children, CLOSE])
        }
    }
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
}

const MARKED = new RegExp(`<${MARK} data-link="([^"]*)">(.*?)</${MARK}>`, 'gs')

/**
 * The markup of a note with its links in the state of this build.
 *
 * @param html the markup that the renderer made, with the marks
 * @param links the links of the note, from its manifest entry: link path to the vault path of the target
 * @param urlOf the canonical path of a published note, or `undefined` for every other vault path
 */
export function withLinkState(
    html: string,
    links: ReadonlyMap<string, string>,
    urlOf: (vaultPath: string) => string | undefined
): string {
    return html.replace(MARKED, (_all, linkPath: string, inner: string) => {
        const target = links.get(decodeURIComponent(linkPath))
        const url = target === undefined ? undefined : urlOf(target)
        // Business rule 5: a link to a note that is not published leads to no
        // page. The same holds for a link path that has no target: a name that
        // no note has, a note under a guard, or a file that is not a note
        // (until the slice of the attachments).
        return url === undefined
            ? `<span class="not-published">${inner}</span>`
            : `<a href="${escapeHtml(url)}">${inner}</a>`
    })
}
