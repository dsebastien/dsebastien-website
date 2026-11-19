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

/**
 * The version of the markup that this plugin writes. Astro keeps the markup
 * of a note between two builds while the text of the note and the
 * configuration are the same, and it does not see a change of this code.
 * Raise the version with every change of what the plugin writes: the name of
 * the plugin is a part of the configuration, so every note is rendered again.
 * That holds also for a change of the two functions of the publishing tool
 * that read a link here (`wikilinksOf`, `linkPathOfDestination`).
 */
export const MARKUP_VERSION = 4

/** The element that stands for a link to a note until the page is made. */
const MARK = 'note-link'

/** A text as the value of an attribute: plain ASCII, with no quote and no character that HTML escapes. */
function encode(text: string): string {
    return encodeURIComponent(text).replaceAll("'", '%27')
}

/** The start of the mark of one link, with its link path. An embed shows its target in the page. */
function open(linkPath: string, embed = false): NewNode {
    const kind = embed ? ' data-embed=""' : ''
    return { type: 'html', value: `<${MARK} data-link="${encode(linkPath)}"${kind}>` }
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
                // An embed of a note is a link until the rendering slice puts
                // the text of its target in its place. An embed of a file
                // shows the file.
                parts.push(open(link.linkPath, link.embed), shown, CLOSE)
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

/** The part of the data of one document where the plugin keeps the definitions of its reference links. */
const DEFINITIONS = 'noteLinkDefinitions'

/**
 * The plugin of the Markdown renderer: it marks the links to notes. Code and
 * raw HTML are not text for the renderer, so a link in them stays as it is.
 */
export const noteLinks: MarkdownPlugin = {
    name: `note-links-${String(MARKUP_VERSION)}`,
    // The destination of a reference link is on another line of the note,
    // often below the link. So the definitions are read before the visitors run.
    before(root, context) {
        const definitions = new Map<string, string>()
        const read = (node: { type: string; children?: readonly unknown[] }): void => {
            for (const child of node.children ?? []) {
                const item = child as { type: string; identifier?: string; url?: string }
                if (item.type === 'definition' && item.identifier !== undefined) {
                    // The first definition of a name wins, as for the Markdown processor.
                    if (!definitions.has(item.identifier)) {
                        definitions.set(item.identifier, item.url ?? '')
                    }
                } else {
                    read(item)
                }
            }
        }
        read(root)
        ;(context.data as Record<string, unknown>)[DEFINITIONS] = definitions
    },
    text(node, context) {
        // The text of a link is not read again, at any depth: a mark holds no mark.
        let parent: ReturnType<typeof context.parent> = context.parent(node)
        while (parent !== undefined && parent.type !== 'root') {
            if (parent.type === 'link' || parent.type === 'linkReference') {
                return
            }
            parent = context.parent(parent)
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
    },
    // A Markdown image of a file of the vault: an embed whose text is the
    // alternative text of the image.
    image(node, context) {
        const linkPath = linkPathOfDestination(node.url)
        if (linkPath !== undefined && linkPath !== '') {
            context.replaceNode(node, [
                open(linkPath, true),
                { type: 'text', value: node.alt ?? '' },
                CLOSE
            ])
        }
    },
    // A reference link to a file of the vault. The tool does not read this
    // form, so its link path has no target: it shows as plain text, and it is
    // never a link to a file that the site does not have (business rule 5).
    linkReference(node, context) {
        const data = context.data as Record<string, unknown>
        const url = (data[DEFINITIONS] as Map<string, string> | undefined)?.get(node.identifier)
        const linkPath = url === undefined ? undefined : linkPathOfDestination(url)
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

const MARKED = new RegExp(`<${MARK} data-link="([^"]*)"( data-embed="")?>(.*?)</${MARK}>`, 'gs')

/** A link of a note that leads to an attachment, as the page shows it. */
export interface FileLink {
    /** The hashed URL of the file. */
    readonly url: string
    /** The name of the file, which gives its kind. */
    readonly name: string
    readonly width?: number
    readonly height?: number
}

/** The ends of the names of the files that a page shows in its place, by their kind. */
const IMAGES = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const VIDEOS = new Set(['mkv', 'mov', 'mp4', 'ogv', 'webm'])
const SOUNDS = new Set(['3gp', 'flac', 'm4a', 'mp3', 'ogg', 'wav'])

/** The end of a name, in small letters. */
function endOf(name: string): string {
    const dot = name.lastIndexOf('.')
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The text of markup, for an attribute: the tags go, the escapes stay, and a quote is escaped. */
function attributeText(inner: string): string {
    return inner.replace(/<[^>]*>/g, '').replaceAll('"', '&quot;')
}

/** The markup of an embed of a file: an image, a player, or a link. */
function embedOf(file: FileLink, inner: string): string {
    const src = escapeHtml(file.url)
    const kind = endOf(file.name)
    if (IMAGES.has(kind)) {
        // Obsidian writes a width, or a width and a height, after the bar.
        const size = /^(\d+)(?:x(\d+))?$/.exec(inner)
        const alt = size === null ? attributeText(inner) : escapeHtml(file.name)
        let width = file.width
        let height = file.height
        if (size !== null) {
            const asked = Number(size[1])
            height =
                size[2] !== undefined
                    ? Number(size[2])
                    : width !== undefined && height !== undefined
                      ? Math.round((asked * height) / width)
                      : undefined
            width = asked
        }
        const dimensions =
            width !== undefined && height !== undefined
                ? ` width="${String(width)}" height="${String(height)}"`
                : ''
        return `<img src="${src}" alt="${alt}"${dimensions} loading="lazy" decoding="async">`
    }
    if (VIDEOS.has(kind)) {
        return `<video src="${src}" controls preload="metadata"></video>`
    }
    if (SOUNDS.has(kind)) {
        return `<audio src="${src}" controls preload="metadata"></audio>`
    }
    return `<a href="${src}">${inner}</a>`
}

/**
 * The markup of a note with its links in the state of this build.
 *
 * @param html the markup that the renderer made, with the marks
 * @param links the links of the note, from its manifest entry: link path to the vault path of the target
 * @param urlOf the canonical path of a published note, or `undefined` for every other vault path
 * @param files the links of the note that lead to an attachment, from its manifest entry, by their link path
 */
export function withLinkState(
    html: string,
    links: ReadonlyMap<string, string>,
    urlOf: (vaultPath: string) => string | undefined,
    files: ReadonlyMap<string, FileLink> = new Map()
): string {
    return html.replace(
        MARKED,
        (_all, linkPath: string, embed: string | undefined, inner: string) => {
            // A mark that the plugin did not write (raw HTML of a note) can hold a
            // text that cannot be decoded: it has no target.
            let decoded: string | undefined
            try {
                decoded = decodeURIComponent(linkPath)
            } catch {
                decoded = undefined
            }
            const file = decoded === undefined ? undefined : files.get(decoded)
            if (file !== undefined) {
                return embed === undefined
                    ? `<a href="${escapeHtml(file.url)}">${inner}</a>`
                    : embedOf(file, inner)
            }
            const target = decoded === undefined ? undefined : links.get(decoded)
            const url = target === undefined ? undefined : urlOf(target)
            // Business rule 5: a link to a note that is not published leads to no
            // page. The same holds for a link path that has no target: a name that
            // no file has, or a file under a guard.
            return url === undefined
                ? `<span class="not-published">${inner}</span>`
                : `<a href="${escapeHtml(url)}">${inner}</a>`
        }
    )
}
