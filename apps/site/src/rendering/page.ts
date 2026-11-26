import { imageVariants, variantPath } from '@dsebastien-website/resolver'
import type { Element, ElementContent, Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'
import { toText } from 'hast-util-to-text'
import type { PropertyLink } from '../properties.ts'
import { headingFor, type Heading } from './anchors.ts'
import { linkContextsOf, type LinkContext } from './backlinks.ts'
import { decode, MARK } from './mark.ts'

// The page step (BUILD-04, BUILD-05, REN-01, REN-04 of the spec): the markup
// of a note, which Astro keeps between two builds, with each mark resolved in
// the state of this build.
//
// - A link to a published note becomes a link to its canonical path, with the
//   id of the heading or of the block that it names. A link to a note that is
//   not published, or whose link path has no target (a missing note, a note
//   under a guard), becomes plain text in the "not published" style and
//   leads to no page (business rule 5).
// - An embed of a published note shows the note, the section of a heading or
//   one block, as that note is rendered. An embed has a depth limit and a
//   cycle check: past them, it is a link.
// - A link or an embed of an attachment leads to its hashed URL: an image, the
//   player of the browser for a video and a sound, a link for every other file.
// - A raw link of a note to an address of the site (`<a href="/wiki/Compost">`)
//   leads where the build says that address leads, else it is plain text in
//   the same style (issue 98).
// - A block of link cards keeps the cards that can show (CARD-01 to CARD-09).
//
// The pages of a build are also its link index (MOD-06, BUILD-05): they say
// which published notes link to a note, with the sentence around each link
// (PAGE-03), and where a link path of a property leads to (PAGE-02).

/** A link of a note that leads to an attachment, as the page shows it. */
export interface FileLink {
    /** The hashed URL of the file. */
    readonly url: string
    /** The name of the file, which gives its kind. */
    readonly name: string
    readonly width?: number
    readonly height?: number
}

/** A published note, as the page step needs it. */
export interface SiteNote {
    readonly vaultPath: string
    /** The canonical path of the page of the note. */
    readonly path: string
    /** The markup that the Markdown processor made, with its marks. */
    readonly markup: string
    /** The links of the note to notes, from its manifest entry: link path to the vault path of the target. */
    readonly links: ReadonlyMap<string, string>
    /** The links of the note to attachments, from its manifest entry, by their link path. */
    readonly files: ReadonlyMap<string, FileLink>
    /** The links of the properties of the note to notes: the markup holds no property. */
    readonly propertyLinks?: readonly PropertyLink[]
}

/** A published note that links to a note. */
export interface Backlink {
    /** The vault path of the note that links. */
    vaultPath: string
    /** The canonical path of its page. */
    path: string
    /** The sentence around each of its links to the note: `BACKLINK_CONTEXTS` at most, each one time. */
    contexts: LinkContext[]
}

/** How many sentences a backlink shows, at most. */
export const BACKLINK_CONTEXTS = 3

/** A heading of the outline of a note page. */
export interface OutlineItem {
    /** How many levels the heading is below the highest level of the outline. */
    depth: number
    text: string
    id: string
}

/** How many headings a note needs for an outline (PAGE-04). */
export const OUTLINE_MINIMUM = 3

/** The lowest level of a heading of the outline. */
const OUTLINE_LEVELS = 3

/** How many notes an embed shows inside each other, at most. Past it, an embed is a link. */
export const EMBED_DEPTH = 4

const IMAGES = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const VIDEOS = new Set(['mkv', 'mov', 'mp4', 'ogv', 'webm'])
const SOUNDS = new Set(['3gp', 'flac', 'm4a', 'mp3', 'ogg', 'wav'])

/** The end of a name, in small letters. */
function endOf(name: string): string {
    const dot = name.lastIndexOf('.')
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function make(
    tagName: string,
    properties: Element['properties'],
    children: ElementContent[] = []
): Element {
    return { type: 'element', tagName, properties, children }
}

function notPublished(children: ElementContent[]): Element {
    return make('span', { className: ['not-published'] }, children)
}

/**
 * The widest that an image shows in the text of a note, in CSS pixels: the
 * column of the text, `max-w-[72ch]` of `.note-text` at its size `text-lg`
 * in Noto Sans, as Chrome lays it out (issue 87).
 */
export const TEXT_COLUMN = 656

/** The width of an image on a small screen: the screen less the padding of the page (`px-4`). */
const SMALL_SCREEN = 'calc(100vw - 2rem)'

/**
 * The variants of an image in `srcset`, with its size on the page in `sizes`
 * (issue 87, PERF-25): on a small screen the width of the screen less its
 * padding, and on a wide one its width, at most the column. Nothing for an
 * image with no variant.
 *
 * @param shown the width that the note gives the image, or its own
 */
function variantsOf(file: FileLink, shown: number | undefined): Element['properties'] {
    if (file.width === undefined || file.height === undefined) {
        return {}
    }
    const variants = imageVariants(file.name, file.width, file.height)
    if (variants.length === 0) {
        return {}
    }
    const wide = Math.min(shown ?? file.width, TEXT_COLUMN)
    return {
        srcSet: variants
            .map((variant) => `${variantPath(file.url, variant.step)} ${String(variant.width)}w`)
            .join(', '),
        // From the screen where the column holds the image whole (2rem of padding).
        sizes: `(min-width: ${String(wide + 32)}px) ${String(wide)}px, ${SMALL_SCREEN}`
    }
}

/** The markup of an embed of a file: an image with its size, a player, or a link. */
function embedOfFile(file: FileLink, shown: string): Element {
    const kind = endOf(file.name)
    if (IMAGES.has(kind)) {
        // Obsidian writes a width, or a width and a height, after the bar:
        // `![[plan.png|300]]`, `![The plan|120](plan.png)`.
        const bar = shown.lastIndexOf('|')
        const sizeText = bar === -1 ? shown : shown.slice(bar + 1)
        const size = /^\s*(\d+)(?:x(\d+))?\s*$/u.exec(sizeText)
        const alt = size === null ? shown : bar === -1 ? file.name : shown.slice(0, bar)
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
        const dimensions = width !== undefined && height !== undefined ? { width, height } : {}
        return make('img', {
            src: file.url,
            ...variantsOf(file, width),
            alt,
            ...dimensions,
            loading: 'lazy',
            decoding: 'async'
        })
    }
    if (VIDEOS.has(kind)) {
        return make('video', { src: file.url, controls: true, preload: 'metadata' })
    }
    if (SOUNDS.has(kind)) {
        return make('audio', { src: file.url, controls: true, preload: 'metadata' })
    }
    return make('a', { href: file.url }, [{ type: 'text', value: shown }])
}

/** The body of the page of a note. */
export interface NotePage {
    /** The H1 at the top of the note, which the title band shows. */
    heading?: NoteHeading
    /** The HTML of the body, without that H1. */
    html: string
    /** The outline of the body, when the note has enough headings (PAGE-04). */
    outline?: OutlineItem[]
}

/** The H1 at the top of a note. */
export interface NoteHeading {
    text: string
    id?: string
}

/** The H1 at the top of these nodes: the first node that is not white space. */
function topHeading(nodes: readonly Root['children'][number][]): Element | undefined {
    const first = nodes.find((node) => node.type !== 'text' || node.value.trim() !== '')
    return first?.type === 'element' && first.tagName === 'h1' ? first : undefined
}

/** The text of a heading as a title shows it: without the number of a footnote. */
function headingText(element: Element): string {
    const withoutMarks = (nodes: ElementContent[]): ElementContent[] =>
        nodes
            .filter(
                (node) =>
                    node.type !== 'element' || node.properties['dataFootnoteRef'] === undefined
            )
            .map((node) =>
                node.type === 'element' ? { ...node, children: withoutMarks(node.children) } : node
            )
    return toText({ ...element, children: withoutMarks(element.children) })
        .replace(/\s+/gu, ' ')
        .trim()
}

function headingOf(element: Element): NoteHeading {
    const id = element.properties['id']
    return { text: headingText(element), ...(typeof id === 'string' ? { id } : {}) }
}

/**
 * The outline of a body: its headings of levels 1 to 3 that have an id. Only
 * a heading of the note itself is an item: a heading of an embed, of a quote
 * or of a callout is inside another element. `undefined` when the note has
 * too few headings.
 */
function outlineOf(nodes: readonly Root['children'][number][]): OutlineItem[] | undefined {
    const headings: { level: number; text: string; id: string }[] = []
    for (const node of nodes) {
        if (node.type !== 'element') continue
        const level = /^h([1-6])$/u.exec(node.tagName)
        const id = node.properties['id']
        if (level !== null && Number(level[1]) <= OUTLINE_LEVELS && typeof id === 'string') {
            headings.push({ level: Number(level[1]), text: headingText(node), id })
        }
    }
    if (headings.length < OUTLINE_MINIMUM) {
        return undefined
    }
    const top = Math.min(...headings.map((heading) => heading.level))
    return headings.map(({ level, text, id }) => ({ depth: level - top, text, id }))
}

/** The first image of these nodes, in the order of the document. */
function firstImage(
    nodes: readonly (Root['children'][number] | ElementContent)[]
): Element | undefined {
    for (const node of nodes) {
        if (node.type !== 'element') continue
        if (node.tagName === 'img') return node
        const inner = firstImage(node.children)
        if (inner !== undefined) return inner
    }
    return undefined
}

/** A note of the site with its tree and its headings, read once per build. */
interface ReadNote extends SiteNote {
    readonly tree: Root
    readonly headings: Heading[]
}

function headingsOf(tree: Root): Heading[] {
    const headings: Heading[] = []
    const visit = (nodes: readonly (Root['children'][number] | ElementContent)[]): void => {
        for (const node of nodes) {
            if (node.type !== 'element') continue
            const level = /^h([1-6])$/u.exec(node.tagName)
            const id = node.properties['id']
            if (level !== null && typeof id === 'string') {
                headings.push({ depth: Number(level[1]), text: toText(node), id })
            }
            visit(node.children)
        }
    }
    visit(tree.children)
    return headings
}

/**
 * An embedded part with no id of its own, so the page keeps one element per
 * id: the ids of headings, blocks and footnotes go. A diagram keeps its ids
 * with the prefix of the embed, and every reference inside it follows, so its
 * title and its gradients stay its own.
 */
function withoutIds(nodes: ElementContent[], prefix: string): ElementContent[] {
    for (const node of nodes) {
        if (node.type !== 'element') continue
        if (node.tagName === 'svg') {
            withPrefix(node, prefix)
        } else {
            delete node.properties['id']
            withoutIds(node.children, prefix)
        }
    }
    return nodes
}

/**
 * The headings of an embedded part, down by the depth of the embed (h6 at
 * most), so an embed holds no H1 and an embed inside an embed sits below its
 * parent: the title band has the H1 of the page (R58).
 */
function levelsDown(nodes: ElementContent[], depth: number): ElementContent[] {
    for (const node of nodes) {
        if (node.type !== 'element' || node.tagName === 'svg') continue
        const level = /^h([1-6])$/u.exec(node.tagName)
        if (level !== null) {
            node.tagName = `h${String(Math.min(6, Number(level[1]) + depth))}`
        }
        levelsDown(node.children, depth)
    }
    return nodes
}

/** Every id of an SVG and every reference to one inside it, with a prefix. */
function withPrefix(svg: Element, prefix: string): void {
    const visit = (node: Element): void => {
        for (const [key, value] of Object.entries(node.properties)) {
            if (key === 'id' && typeof value === 'string') {
                node.properties[key] = `${prefix}${value}`
            } else if (
                (key === 'ariaLabelledBy' || key === 'ariaDescribedBy') &&
                Array.isArray(value)
            ) {
                node.properties[key] = value.map((item) => `${prefix}${String(item)}`)
            } else if (typeof value === 'string' && value.startsWith('url(#')) {
                node.properties[key] = `url(#${prefix}${value.slice('url(#'.length)}`
            } else if (
                (key === 'href' || key === 'xLinkHref') &&
                typeof value === 'string' &&
                value.startsWith('#')
            ) {
                node.properties[key] = `#${prefix}${value.slice(1)}`
            }
        }
        for (const child of node.children) {
            if (child.type === 'element') visit(child)
        }
    }
    visit(svg)
}

function findById(nodes: readonly ElementContent[], id: string): Element | undefined {
    for (const node of nodes) {
        if (node.type !== 'element') continue
        if (node.properties['id'] === id) return node
        const inner = findById(node.children, id)
        if (inner !== undefined) return inner
    }
    return undefined
}

/** True for an address of the web that a card may lead to: `https`, or `http` for a card that is no video. */
function isWebAddress(url: string, video: boolean): boolean {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return false
    }
    return parsed.protocol === 'https:' || (!video && parsed.protocol === 'http:')
}

/** The links of an embedded note to a place of that note (`#…`) lead to its page, not to the page that embeds it. */
function withOwnLinks(nodes: ElementContent[], path: string): ElementContent[] {
    for (const node of nodes) {
        if (node.type !== 'element') continue
        const href = node.properties['href']
        if (node.tagName === 'a' && typeof href === 'string' && href.startsWith('#')) {
            node.properties['href'] = `${path}${href}`
        }
        withOwnLinks(node.children, path)
    }
    return nodes
}

/** True for what a paragraph cannot hold: an embed of a note, or a block of cards. */
function isBlock(node: ElementContent): boolean {
    if (node.type !== 'element' || node.tagName !== 'div') return false
    const classes = node.properties['className']
    return (
        Array.isArray(classes) && (classes.includes('note-embed') || classes.includes('link-cards'))
    )
}

function holdsBlock(node: ElementContent): boolean {
    return (
        node.type === 'element' &&
        node.children.some((child) => isBlock(child) || holdsBlock(child))
    )
}

/** True for white space and a line break: what an edge of a piece of a paragraph drops. */
function isEdge(node: ElementContent): boolean {
    return (
        (node.type === 'text' && node.value.trim() === '') ||
        (node.type === 'element' && node.tagName === 'br')
    )
}

/**
 * An element, cut around the blocks that it holds at any depth (a paragraph,
 * or the bold text inside it): the blocks come out between its pieces. A
 * piece has no line break and no white space alone at its edges, and only the
 * first piece keeps the id of the element (a block id).
 */
function cutAround(element: Element): ElementContent[] {
    if (!holdsBlock(element)) return [element]
    const result: ElementContent[] = []
    let run: ElementContent[] = []
    let first = true
    const flush = (): void => {
        let start = 0
        let end = run.length
        while (start < end && isEdge(run[start] as ElementContent)) start += 1
        while (end > start && isEdge(run[end - 1] as ElementContent)) end -= 1
        const kept = run.slice(start, end)
        // The white space next to a dropped line break goes with it.
        const head = kept[0]
        if (start > 0 && head?.type === 'text') kept[0] = { ...head, value: head.value.trimStart() }
        const tail = kept.at(-1)
        if (end < run.length && tail?.type === 'text')
            kept[kept.length - 1] = { ...tail, value: tail.value.trimEnd() }
        run = []
        if (kept.length === 0) return
        const properties = { ...element.properties }
        if (!first) delete properties['id']
        first = false
        result.push({ ...element, properties, children: kept })
    }
    for (const child of element.children) {
        const pieces = isBlock(child)
            ? [child]
            : child.type === 'element'
              ? cutAround(child)
              : [child]
        for (const piece of pieces) {
            if (isBlock(piece)) {
                flush()
                result.push(piece)
            } else {
                run.push(piece)
            }
        }
    }
    flush()
    return result
}

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./u, '')
    } catch {
        return ''
    }
}

/** What the build gives the page step. */
export interface SitePagesOptions {
    /**
     * Where a raw link of a note to an address of the site leads (issue 98):
     * the address to write, or `undefined` when no page answers it. Without
     * it, only the canonical path of a published note of the build leads.
     */
    readonly addressOf?: (address: string) => string | undefined
}

/** The pages of the notes of one build. */
export class SitePages {
    readonly #notes = new Map<string, SiteNote>()
    readonly #addressOf: (address: string) => string | undefined
    readonly #read = new Map<string, ReadNote>()
    /** The backlinks of each note of the build by its vault path, made at the first question. */
    #backlinks: Map<string, Backlink[]> | undefined
    /** The number of embeds of the page being made: the prefix of the ids of a diagram in one. */
    #embeds = 0

    constructor(notes: Iterable<SiteNote>, options: SitePagesOptions = {}) {
        for (const note of notes) {
            this.#notes.set(note.vaultPath, note)
        }
        const paths = new Set([...this.#notes.values()].map((note) => note.path))
        this.#addressOf =
            options.addressOf ??
            ((address) => (paths.has(address.split(/[?#]/u)[0] ?? '') ? address : undefined))
    }

    /** The HTML of the body of a published note, as the page step gives it. */
    render(vaultPath: string): string {
        return toHtml(this.#tree(vaultPath))
    }

    /**
     * The body of the page of a published note (issue 47). The H1 at the top
     * of the note leaves the body: the title band shows it, with its id (R58).
     * The first image of the page loads at once with a high priority, and the
     * others stay lazy (PERF-25).
     */
    page(vaultPath: string): NotePage {
        const tree = this.#tree(vaultPath)
        const first = topHeading(tree.children)
        if (first !== undefined) {
            tree.children.splice(tree.children.indexOf(first), 1)
        }
        // The text of the H1 comes from the markup, as for the lists: an embed
        // gives its text, not the image or the note that the page shows.
        const heading = first === undefined ? undefined : this.heading(vaultPath)
        const image = firstImage(tree.children)
        if (image !== undefined) {
            delete image.properties['loading']
            image.properties['fetchPriority'] = 'high'
        }
        const outline = outlineOf(tree.children)
        return {
            ...(heading === undefined ? {} : { heading }),
            html: toHtml(tree),
            ...(outline === undefined ? {} : { outline })
        }
    }

    /**
     * The H1 at the top of a published note, which the title band of its page
     * shows: the display title of the note in a list reads it (IDX-03). Its
     * text is read from the marks of the markup, before the page step: an
     * embed gives its text as the note writes it (issue 93), which is also the
     * text of the id of the H1 and of an old hash (URL-14).
     */
    heading(vaultPath: string): NoteHeading | undefined {
        const note = this.#published(vaultPath)
        // The page takes the H1 out of the body that the page step made. The
        // one top node that the page step can remove is a block of link cards
        // of which no card can show: the H1 after it is at the top too.
        const kept = note.tree.children.filter(
            (node) =>
                node.type !== 'element' ||
                node.tagName !== MARK.cards ||
                this.#cards(node, note).length > 0
        )
        const first = topHeading(kept)
        return first === undefined ? undefined : headingOf(first)
    }

    /**
     * Where a link path of a published note leads to, with the heading or the
     * block after `#`: the page of a published note, the hashed URL of an
     * attachment, or a place of the note itself for an empty link path.
     * `undefined` when the target is not published or does not exist
     * (business rule 5). A property of the note reads its links here.
     */
    linkOf(vaultPath: string, linkPath: string, fragment: string): string | undefined {
        const note = this.#published(vaultPath)
        if (linkPath === '') {
            const href = this.#fragmentOf(note, fragment)
            return href === '' ? undefined : href
        }
        const file = note.files.get(linkPath)
        if (file !== undefined) {
            return file.url
        }
        const target = this.#targetOf(note, linkPath)
        return target === undefined
            ? undefined
            : `${target.path}${this.#fragmentOf(target, fragment)}`
    }

    /**
     * The published notes that link to a published note, in the order of the
     * notes of the build, each with the sentence around its links (PAGE-03).
     * A link of the text, an embed and a link of a property count; a note is
     * no backlink of itself.
     */
    backlinks(vaultPath: string): readonly Backlink[] {
        this.#published(vaultPath)
        this.#backlinks ??= this.#readBacklinks()
        return this.#backlinks.get(vaultPath) ?? []
    }

    #readBacklinks(): Map<string, Backlink[]> {
        const all = new Map<string, Backlink[]>()
        for (const vaultPath of this.#notes.keys()) {
            const note = this.#published(vaultPath)
            const found = new Map<string, Backlink>()
            // The sentences of each backlink, whole: a sentence shows one time,
            // also when it holds two links to the note.
            const sentences = new Map<Backlink, Set<string>>()
            const add = (linkPath: string, sentence: string, context: LinkContext): void => {
                if (note.files.has(linkPath)) return
                const target = this.#targetOf(note, linkPath)
                if (target === undefined || target.vaultPath === vaultPath) return
                let backlink = found.get(target.vaultPath)
                if (backlink === undefined) {
                    backlink = { vaultPath, path: note.path, contexts: [] }
                    found.set(target.vaultPath, backlink)
                    sentences.set(backlink, new Set())
                }
                const known = sentences.get(backlink)
                if (
                    known !== undefined &&
                    !known.has(sentence) &&
                    backlink.contexts.length < BACKLINK_CONTEXTS
                ) {
                    known.add(sentence)
                    backlink.contexts.push(context)
                }
            }
            for (const { linkPath, sentence, ...context } of linkContextsOf(note.tree)) {
                add(linkPath, sentence, context)
            }
            for (const link of note.propertyLinks ?? []) {
                const before = `${link.name}: `
                add(link.linkPath, `${before}${link.text}`, {
                    before,
                    link: link.text,
                    after: ''
                })
            }
            for (const [target, backlink] of found) {
                const list = all.get(target)
                if (list === undefined) {
                    all.set(target, [backlink])
                } else {
                    list.push(backlink)
                }
            }
        }
        return all
    }

    /** A published note of the build, read. */
    #published(vaultPath: string): ReadNote {
        const note = this.#readNote(vaultPath)
        if (note === undefined) {
            throw new Error(`the note "${vaultPath}" is not published`)
        }
        return note
    }

    /** The published note that a link path of a note leads to. */
    #targetOf(note: ReadNote, linkPath: string): ReadNote | undefined {
        const vaultPath = note.links.get(linkPath)
        return vaultPath === undefined ? undefined : this.#readNote(vaultPath)
    }

    #tree(vaultPath: string): Root {
        const note = this.#published(vaultPath)
        this.#embeds = 0
        const tree = structuredClone(note.tree)
        tree.children = this.#transform(tree.children as ElementContent[], note, [vaultPath])
        return tree
    }

    #readNote(vaultPath: string): ReadNote | undefined {
        const known = this.#read.get(vaultPath)
        if (known !== undefined) return known
        const note = this.#notes.get(vaultPath)
        if (note === undefined) return undefined
        const tree = fromHtml(note.markup, { fragment: true })
        const read = { ...note, tree, headings: headingsOf(tree) }
        this.#read.set(vaultPath, read)
        return read
    }

    /** The fragment of a URL for a heading path or a block id of a note: `#id`, or nothing. */
    #fragmentOf(note: ReadNote, fragment: string): string {
        if (fragment === '') return ''
        const id = fragment.startsWith('^')
            ? findById(note.tree.children as ElementContent[], fragment) === undefined
                ? undefined
                : fragment
            : headingFor(note.headings, fragment)
        return id === undefined ? '' : `#${encodeURIComponent(id)}`
    }

    #transform(
        nodes: ElementContent[],
        note: ReadNote,
        stack: readonly string[]
    ): ElementContent[] {
        const result: ElementContent[] = []
        for (const node of nodes) {
            if (node.type !== 'element') {
                result.push(node)
            } else if (node.tagName === MARK.link) {
                result.push(...this.#link(node, note, stack))
            } else if (node.tagName === MARK.cards) {
                result.push(...this.#cards(node, note))
            } else {
                node.children = this.#transform(node.children, note, stack)
                result.push(...(node.tagName === 'p' ? cutAround(node) : [node]))
            }
        }
        return result
    }

    /** What a link mark of a note becomes. */
    #link(mark: Element, note: ReadNote, stack: readonly string[]): ElementContent[] {
        const shown = toText(mark)
        const inner = this.#transform(mark.children, note, stack)
        if (mark.properties['dataAddress'] !== undefined) {
            // A raw link of the note to an address of the site (issue 98).
            const address = decode(mark.properties['dataAddress'])
            const href = address === undefined ? undefined : this.#addressOf(address)
            return [href === undefined ? notPublished(inner) : make('a', { href }, inner)]
        }
        const linkPath = decode(mark.properties['dataLink'])
        const fragment = decode(mark.properties['dataFragment']) ?? ''
        const embed = mark.properties['dataEmbed'] !== undefined
        if (linkPath === undefined) {
            return [notPublished(inner)]
        }
        if (linkPath === '') {
            // A link into the note itself: to its heading or its block. Inside an
            // embed, the note is not the page: the link leads to its page.
            const href = this.#fragmentOf(note, fragment)
            if (href === '') return inner
            return [make('a', { href: stack.length > 1 ? `${note.path}${href}` : href }, inner)]
        }
        const file = note.files.get(linkPath)
        if (file !== undefined) {
            return [embed ? embedOfFile(file, shown) : make('a', { href: file.url }, inner)]
        }
        const vaultPath = note.links.get(linkPath)
        const target = vaultPath === undefined ? undefined : this.#readNote(vaultPath)
        if (target === undefined) {
            // Business rule 5: no page for a note that is not published.
            return [notPublished(inner)]
        }
        if (embed) {
            const shownNote = this.#embed(target, fragment, stack)
            if (shownNote !== undefined) return [shownNote]
        }
        return [make('a', { href: `${target.path}${this.#fragmentOf(target, fragment)}` }, inner)]
    }

    /** An embed of a published note, its heading or its block, or `undefined` past the depth limit or in a cycle. */
    #embed(target: ReadNote, fragment: string, stack: readonly string[]): Element | undefined {
        if (stack.includes(target.vaultPath) || stack.length >= EMBED_DEPTH) {
            return undefined
        }
        const all = structuredClone(target.tree).children as ElementContent[]
        let part: ElementContent[] = all
        if (fragment.startsWith('^')) {
            const block = findById(all, fragment)
            if (block === undefined) return undefined
            part = block.tagName === 'li' ? [make('ul', {}, [block])] : [block]
        } else if (fragment !== '') {
            const id = headingFor(target.headings, fragment)
            const start = all.findIndex(
                (node) => node.type === 'element' && node.properties['id'] === id
            )
            const heading = all[start]
            if (id === undefined || heading?.type !== 'element') return undefined
            const depth = Number(heading.tagName.slice(1))
            const end = all.findIndex(
                (node, index) =>
                    index > start &&
                    node.type === 'element' &&
                    /^h[1-6]$/u.test(node.tagName) &&
                    Number(node.tagName.slice(1)) <= depth
            )
            part = all.slice(start, end === -1 ? undefined : end)
        }
        const children = this.#transform(
            withOwnLinks(
                levelsDown(withoutIds(part, `e${String((this.#embeds += 1))}-`), stack.length),
                target.path
            ),
            target,
            [...stack, target.vaultPath]
        )
        return make('div', { className: ['note-embed'], dataEmbedOf: target.path }, children)
    }

    /** A block of link cards: the cards that can show, or nothing (CARD-05). */
    #cards(block: Element, note: ReadNote): ElementContent[] {
        const cards: ElementContent[] = []
        for (const card of block.children) {
            if (card.type !== 'element' || card.tagName !== MARK.card) continue
            const url = card.properties['dataUrl']
            if (typeof url === 'string') {
                // The address of a card comes from the text of the note, after
                // the allow list: only a web address may become a link.
                const video = card.properties['dataVideo'] !== undefined
                if (!isWebAddress(url, video)) continue
                cards.push(this.#card(url, toText(card), video ? 'YouTube' : hostOf(url), video))
                continue
            }
            const mark = card.children.find(
                (child): child is Element => child.type === 'element' && child.tagName === MARK.link
            )
            const linkPath = mark === undefined ? undefined : decode(mark.properties['dataLink'])
            if (mark === undefined || linkPath === undefined || linkPath === '') continue
            const title = toText(mark)
            const fragment = decode(mark.properties['dataFragment']) ?? ''
            const file = note.files.get(linkPath)
            const vaultPath = note.links.get(linkPath)
            const target = vaultPath === undefined ? undefined : this.#readNote(vaultPath)
            if (file !== undefined) {
                cards.push(this.#card(file.url, title, '', false))
            } else if (target !== undefined) {
                cards.push(
                    this.#card(
                        `${target.path}${this.#fragmentOf(target, fragment)}`,
                        title,
                        '',
                        false
                    )
                )
            } else if (vaultPath !== undefined) {
                // CARD-04: a note that is not published shows its link text, and
                // becomes a card when it goes live.
                cards.push(
                    make('div', { className: ['link-card'] }, [
                        notPublished([{ type: 'text', value: title }])
                    ])
                )
            }
        }
        return cards.length === 0 ? [] : [make('div', { className: ['link-cards'] }, cards)]
    }

    /** A compact link card: its title and the name of its source, with no image and no request to the other site. */
    #card(href: string, title: string, source: string, video: boolean): Element {
        const parts: ElementContent[] = [
            make('span', { className: ['link-card-title'] }, [{ type: 'text', value: title }])
        ]
        if (source !== '') {
            parts.push(
                make('span', { className: ['link-card-source'] }, [{ type: 'text', value: source }])
            )
        }
        return make(
            'div',
            { className: video ? ['link-card', 'link-card-video'] : ['link-card'] },
            [make('a', { className: ['link-card-link'], href }, parts)]
        )
    }
}
