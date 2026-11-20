import type { Element, ElementContent, Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'
import { toText } from 'hast-util-to-text'
import { headingFor, type Heading } from './anchors.ts'
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
// - A block of link cards keeps the cards that can show (CARD-01 to CARD-09).

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
}

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
    heading?: { text: string; id?: string }
    /** The HTML of the body, without that H1. */
    html: string
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

/** The pages of the notes of one build. */
export class SitePages {
    readonly #notes = new Map<string, SiteNote>()
    readonly #read = new Map<string, ReadNote>()
    /** The number of embeds of the page being made: the prefix of the ids of a diagram in one. */
    #embeds = 0

    constructor(notes: Iterable<SiteNote>) {
        for (const note of notes) {
            this.#notes.set(note.vaultPath, note)
        }
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
        const first = tree.children.find((node) => node.type !== 'text' || node.value.trim() !== '')
        let heading: NotePage['heading']
        if (first?.type === 'element' && first.tagName === 'h1') {
            const id = first.properties['id']
            heading = { text: toText(first), ...(typeof id === 'string' ? { id } : {}) }
            tree.children.splice(tree.children.indexOf(first), 1)
        }
        const image = firstImage(tree.children)
        if (image !== undefined) {
            delete image.properties['loading']
            image.properties['fetchPriority'] = 'high'
        }
        const html = toHtml(tree)
        return heading === undefined ? { html } : { heading, html }
    }

    #tree(vaultPath: string): Root {
        const note = this.#readNote(vaultPath)
        if (note === undefined) {
            throw new Error(`the note "${vaultPath}" is not published`)
        }
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
