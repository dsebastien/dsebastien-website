import { createRequire } from 'node:module'
import { tagPath } from '@dsebastien-website/resolver'
import { rehypePrism, unified as astroUnified } from '@astrojs/markdown-remark'
import remarkObsidian from '@quartz-community/remark-obsidian'
import type { Element, ElementContent, Root as HastRoot, RootContent as HastContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toText } from 'hast-util-to-text'
import { render as renderDiagram } from 'pele'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import temml from 'temml'
import { linkPathOfDestination, wikilinksOf } from '../../../plugin/src/publishing/links.ts'
import { allowList } from './allow-list.ts'
import { FRAME_IDS, freeId, noteIds, type IdOfNote } from './anchors.ts'
import { tagOfText } from '../tags.ts'
import { encode, MARK } from './mark.ts'

// The markup of a note (BUILD-04, REN-01 to REN-15 of the spec, R50): what
// the Markdown processor of Astro makes of the text of one note. Astro keeps
// this markup between two builds while the text of the note is the same, so
// nothing in it depends on another note. A link, an embed and a link card
// stay a mark here: the page step (`page.ts`) resolves them at each build.
//
// The parser is `remark-obsidian` with its legacy preset: it reads a note as
// Obsidian does. The steps after it are ours, written against the corpus of
// the Markdown forms (`fixtures/markdown-forms.json`).

/**
 * The version of the markup. Astro keeps the markup of a note between two
 * builds while the text of the note and the configuration are the same, and it
 * does not see a change of this code. Raise the version with every change of
 * what these steps write: it is an option of a step, so a part of the
 * configuration, and every note is rendered again. That holds also for a
 * change of the two functions of the publishing tool that read a link here
 * (`wikilinksOf`, `linkPathOfDestination`) and of the reader of the tags
 * (`tagOfText` in `tags.ts`).
 */
export const MARKUP_VERSION = 11

/**
 * The packages that write the markup, with their versions from the site
 * package. They are an option of a step too, so an upgrade of one of them
 * (a fix of the allow list, of the parser, of Pele) renders every note again.
 */
const RENDERING_PACKAGES: Readonly<Record<string, string>> = (() => {
    const manifest: unknown = createRequire(import.meta.url)('../../package.json')
    const dependencies =
        typeof manifest === 'object' && manifest !== null && 'dependencies' in manifest
            ? (manifest.dependencies as Record<string, unknown>)
            : {}
    const names = [
        '@astrojs/markdown-remark',
        '@quartz-community/remark-obsidian',
        'hast-util-from-html',
        'hast-util-to-text',
        'pele',
        'rehype-raw',
        'rehype-sanitize',
        'temml'
    ]
    return Object.fromEntries(names.map((name) => [name, String(dependencies[name])]))
})()

/** A node of the Markdown tree, as loose as the parser and its plugins make it. */
interface MdNode {
    type: string
    value?: string
    children?: MdNode[]
    data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: unknown[] }
    position?: { start: { offset?: number }; end: { offset?: number } }
    [key: string]: unknown
}

function element(
    name: string,
    properties: Record<string, unknown>,
    children: MdNode[],
    type = 'noteElement'
): MdNode {
    return { type, data: { hName: name, hProperties: properties }, children }
}

function text(value: string): MdNode {
    return { type: 'text', value }
}

/** The mark of a link: its link path, the heading or block after `#`, and the embed flag. */
function linkMark(linkPath: string, fragment: string, embed: boolean, shown: MdNode[]): MdNode {
    const properties: Record<string, unknown> = { dataLink: encode(linkPath) }
    if (fragment !== '') {
        properties['dataFragment'] = encode(fragment)
    }
    if (embed) {
        properties['dataEmbed'] = ''
    }
    return element(MARK.link, properties, shown)
}

/**
 * The mark of a wikilink. The link path is the one of the publishing tool,
 * read from the text of the link, so it is the link path of the manifest.
 */
function wikilinkMark(node: MdNode, source: string): MdNode {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    const written =
        start === undefined || end === undefined ? [] : wikilinksOf(source.slice(start, end))
    const path = typeof node['path'] === 'string' ? node['path'] : ''
    const linkPath = written.length === 1 && written[0] !== undefined ? written[0].linkPath : path
    const heading = typeof node['heading'] === 'string' ? node['heading'] : ''
    const alias = typeof node['alias'] === 'string' ? node['alias'] : ''
    const embed = node['embedded'] === true
    // What a reader sees when the link is no embed, or when an embed cannot
    // show: the label, or the note and the heading, as Obsidian writes them.
    const shown =
        alias !== ''
            ? alias
            : embed && heading !== ''
              ? `${path === '' ? '' : `${path} > `}${heading.replaceAll('#', ' > ')}`
              : (node.value ?? path)
    return linkMark(linkPath, heading, embed, [text(shown)])
}

/** The link path and the fragment of the destination of a Markdown link to a file of the vault. */
function destinationOf(url: string): { linkPath: string; fragment: string } | undefined {
    const linkPath = linkPathOfDestination(url)
    if (linkPath === undefined || linkPath === '') {
        return undefined
    }
    const hash = url.indexOf('#')
    let fragment = hash === -1 ? '' : url.slice(hash + 1)
    try {
        fragment = decodeURIComponent(fragment)
    } catch {
        // kept as written
    }
    return { linkPath, fragment }
}

/** Code blocks that are live queries or widgets: never shown (REN-03, REN-14). */
function isDroppedBlock(lang: unknown): boolean {
    if (typeof lang !== 'string') {
        return false
    }
    const name = lang.toLowerCase()
    return (
        ['dataview', 'dataviewjs', 'base', 'bases', 'query'].includes(name) ||
        name.startsWith('meta-bind')
    )
}

/** Inline code that is Meta Bind (`INPUT[…]`, `VIEW[…]`, `BUTTON[…]`) or an inline Dataview query (`= …`, `$= …`). */
function isDroppedInline(value: string): boolean {
    return /^(?:INPUT|VIEW|BUTTON)\[/u.test(value) || /^\$?=\s/u.test(value)
}

const FROZEN_START = /^<!--\s*SerializedQuery:/u
const FROZEN_END = /^<!--\s*SerializedQuery END\s*-->/u
const KEYWORD = /^LINKS?:?(?=\s|$)/u
const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])

/** The text of a node and its children. */
function plainText(node: MdNode): string {
    if (typeof node.value === 'string' && node.type !== 'html') {
        return node.value
    }
    return (node.children ?? []).map(plainText).join('')
}

/** The card of one target: a link to another site, or a link mark of a note. `undefined` when it is no target. */
function cardOf(nodes: MdNode[], source: string): MdNode | undefined {
    const filled = nodes.filter(
        (node) => !(node.type === 'text' && (node.value ?? '').trim() === '')
    )
    const [target] = filled
    if (filled.length !== 1 || target === undefined) {
        return undefined
    }
    if (target.type === 'link' && typeof target['url'] === 'string') {
        const url = target['url']
        const destination = destinationOf(url)
        if (destination !== undefined) {
            // A Markdown link to a note or a file of the vault: a card of that target.
            return element(MARK.card, {}, [
                linkMark(destination.linkPath, destination.fragment, false, target.children ?? [])
            ])
        }
        return element(MARK.card, { dataUrl: url }, [text(plainText(target))])
    }
    if (target.type === 'wikilink' && target['embedded'] !== true) {
        return element(MARK.card, {}, [wikilinkMark(target, source)])
    }
    return undefined
}

/** The lines of a paragraph, cut at its line breaks. */
function linesOf(paragraph: MdNode): MdNode[][] {
    const lines: MdNode[][] = [[]]
    for (const child of paragraph.children ?? []) {
        if (child.type === 'break') {
            lines.push([])
        } else if (child.type === 'text' && (child.value ?? '').includes('\n')) {
            const parts = (child.value ?? '').split('\n')
            parts.forEach((part, index) => {
                if (index > 0) lines.push([])
                if (part !== '') lines.at(-1)?.push(text(part))
            })
        } else {
            lines.at(-1)?.push(child)
        }
    }
    return lines.filter((line) => line.length > 0)
}

/** A line without its `LINK` keyword, or `undefined` when it does not start with it. */
function afterKeyword(line: MdNode[]): MdNode[] | undefined {
    const [first, ...rest] = line
    if (first?.type !== 'text') {
        return undefined
    }
    const match = KEYWORD.exec(first.value ?? '')
    if (match === null) {
        return undefined
    }
    const left = (first.value ?? '').slice(match[0].length)
    return left.trim() === '' ? rest : [text(left), ...rest]
}

/**
 * A block of link cards (CARD-01, CARD-02): a paragraph whose lines each start
 * with `LINK` or `LINKS` and hold one target, or the keyword alone and a list
 * of targets after it. Returns the cards and whether the list is taken too.
 */
function linkBlock(
    paragraph: MdNode,
    next: MdNode | undefined,
    source: string
): { cards: MdNode; takesList: boolean } | undefined {
    const lines = linesOf(paragraph)
    const bodies = lines.map(afterKeyword)
    if (bodies.length === 0 || bodies.some((body) => body === undefined)) {
        return undefined
    }
    const block = (cards: MdNode[]): MdNode => element(MARK.cards, {}, cards)
    if (bodies.length === 1 && bodies[0]?.length === 0 && next?.type === 'list') {
        const cards: MdNode[] = []
        for (const item of next.children ?? []) {
            const [only, ...more] = item.children ?? []
            const card =
                only?.type === 'paragraph' && more.length === 0
                    ? cardOf(only.children ?? [], source)
                    : undefined
            if (card === undefined) {
                return undefined
            }
            cards.push(card)
        }
        return { cards: block(cards), takesList: true }
    }
    const cards: MdNode[] = []
    for (const body of bodies) {
        const card = body === undefined ? undefined : cardOf(body, source)
        if (card === undefined) {
            return undefined
        }
        cards.push(card)
    }
    return { cards: block(cards), takesList: false }
}

/** A line with only a YouTube URL in image syntax: a video card (CARD-09). */
function videoCard(paragraph: MdNode): MdNode | undefined {
    const children = (paragraph.children ?? []).filter(
        (node) => !(node.type === 'text' && (node.value ?? '').trim() === '')
    )
    const [image] = children
    if (children.length !== 1 || image?.type !== 'image' || typeof image['url'] !== 'string') {
        return undefined
    }
    let host: string
    try {
        host = new URL(image['url']).hostname
    } catch {
        return undefined
    }
    if (!VIDEO_HOSTS.has(host)) {
        return undefined
    }
    const alt =
        typeof image['alt'] === 'string' && image['alt'] !== '' ? image['alt'] : image['url']
    return element(MARK.cards, {}, [
        element(MARK.card, { dataUrl: image['url'], dataVideo: '' }, [text(alt)])
    ])
}

/** The id of a block (`^id` at the end of a paragraph), taken out of its text. */
function takeBlockId(paragraph: MdNode): string | undefined {
    const last = paragraph.children?.at(-1)
    if (last?.type !== 'text') {
        return undefined
    }
    const match = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/u.exec(last.value ?? '')
    if (match === null) {
        return undefined
    }
    last.value = (last.value ?? '').slice(0, match.index).trimEnd()
    if (last.value === '') {
        paragraph.children?.pop()
    }
    return `^${match[1] ?? ''}`
}

function setId(node: MdNode, id: string): void {
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } }
}

/** The title of a callout: its own, or its type with a capital, as in Obsidian. */
function calloutTitle(node: MdNode, type: string): MdNode[] {
    const title = (node.children ?? []).find((child) => child.type === 'calloutTitle')
    if (title?.children !== undefined && title.children.length > 0) {
        return title.children
    }
    const written = typeof node['title'] === 'string' && node['title'] !== '' ? node['title'] : type
    return [text(written.charAt(0).toUpperCase() + written.slice(1))]
}

/** A callout as the reading view of Obsidian marks it; a folding callout is a `details` element (REN-01). */
function callout(node: MdNode): MdNode {
    const type = (
        typeof node['calloutType'] === 'string' ? node['calloutType'] : 'note'
    ).toLowerCase()
    const body = (node.children ?? []).filter((child) => child.type !== 'calloutTitle')
    const title = calloutTitle(node, type)
    const fold = node['collapsed'] === true ? '-' : node['collapsed'] === false ? '+' : undefined
    const content = element('div', { className: ['callout-content'] }, body)
    if (fold === undefined) {
        return element('div', { className: ['callout'], dataCallout: type }, [
            element('div', { className: ['callout-title'] }, title),
            content
        ])
    }
    return element(
        'details',
        { className: ['callout'], dataCallout: type, dataCalloutFold: fold, open: fold === '+' },
        [element('summary', { className: ['callout-title'] }, title), content]
    )
}

/** What the steps of the Markdown tree know about the note while they rewrite it. */
interface Context {
    /** The text that the parser read: the link path of a wikilink is read from it. */
    readonly source: string
    /** The definitions of the reference links, by their name. The first one of a name wins. */
    readonly definitions: ReadonlyMap<string, string>
    /** The definitions of the inline footnotes, put at the end of the note. */
    readonly notes: MdNode[]
    /** True inside the text of a link: a link there stays text, so a link never holds a link. */
    readonly inLink: boolean
}

/** The text of a node as the note writes it. */
function written(node: MdNode, source: string): string | undefined {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    return start === undefined || end === undefined ? undefined : source.slice(start, end)
}

/** A Markdown link or image to a file of the vault becomes a mark; every other one stays. */
function markOfDestination(node: MdNode, url: string | undefined): MdNode[] {
    const destination = url === undefined ? undefined : destinationOf(url)
    if (destination === undefined) {
        return [node]
    }
    const image = node.type === 'image' || node.type === 'imageReference'
    const shown = image
        ? [text(typeof node['alt'] === 'string' ? node['alt'] : '')]
        : (node.children ?? [])
    return [linkMark(destination.linkPath, destination.fragment, image, shown)]
}

/** What one node of the tree becomes. */
function nodesOf(node: MdNode, context: Context): MdNode[] {
    const { source, notes } = context
    switch (node.type) {
        case 'yaml':
        case 'comment':
            return []
        case 'code':
            return isDroppedBlock(node['lang']) ? [] : [node]
        case 'inlineCode':
            return isDroppedInline(node.value ?? '') ? [] : [node]
        case 'wikilink':
            // Inside the text of a link, a wikilink stays as the note writes it.
            return context.inLink
                ? [text(written(node, source) ?? node.value ?? '')]
                : [wikilinkMark(node, source)]
        case 'link':
        case 'image':
            return markOfDestination(node, typeof node['url'] === 'string' ? node['url'] : '')
        case 'linkReference':
        case 'imageReference': {
            // The tool reads no reference link, so a reference to a file of the
            // vault has no target: it is plain text, never a link to a file that
            // the site does not have (business rule 5).
            const name = typeof node['identifier'] === 'string' ? node['identifier'] : ''
            return markOfDestination(node, context.definitions.get(name))
        }
        case 'tag': {
            // Only a tag that the lists read has a page: any other tag is plain text (NAV-04).
            const tag = node.value ?? ''
            return tagOfText(tag) === undefined
                ? [text(`#${tag}`)]
                : [element('a', { className: ['tag'], href: tagPath(tag) }, [text(`#${tag}`)])]
        }
        case 'highlight':
            return [element('mark', {}, node.children ?? [])]
        case 'callout':
            return [callout(node)]
        case 'footnote': {
            // An inline footnote becomes a footnote with a definition at the end of the note.
            const identifier = `inline-${String(notes.length + 1)}`
            notes.push({
                type: 'footnoteDefinition',
                identifier,
                label: identifier,
                children: [{ type: 'paragraph', children: node.children ?? [] }]
            })
            return [{ type: 'footnoteReference', identifier, label: identifier }]
        }
        default:
            return [node]
    }
}

/** Rewrites the children of a node, its children first. */
function rewrite(parent: MdNode, context: Context): void {
    const { source } = context
    const children = parent.children ?? []
    const result: MdNode[] = []
    let frozen = false
    for (let index = 0; index < children.length; index += 1) {
        const node = children[index]
        if (node === undefined) continue
        if (node.type === 'html') {
            const value = (node.value ?? '').trim()
            if (FROZEN_START.test(value)) frozen = true
            if (FROZEN_END.test(value)) frozen = false
        }
        if (node.type === 'paragraph' && !frozen) {
            // A paragraph with only a block id names the block before it.
            const alone = /^\^([A-Za-z0-9-]+)$/u.exec(plainText(node).trim())
            const before = result.at(-1)
            if (alone !== null && before !== undefined && (node.children ?? []).length === 1) {
                setId(before, `^${alone[1] ?? ''}`)
                continue
            }
            const block = linkBlock(node, children[index + 1], source)
            if (block !== undefined) {
                rewrite(block.cards, context)
                result.push(block.cards)
                if (block.takesList) index += 1
                continue
            }
            const video = videoCard(node)
            if (video !== undefined) {
                result.push(video)
                continue
            }
        }
        if (node.type === 'paragraph') {
            const id = takeBlockId(node)
            if (id !== undefined) {
                setId(
                    parent.type === 'listItem' && parent.children?.length === 1 ? parent : node,
                    id
                )
            }
        }
        if (node.children !== undefined && node.type !== 'wikilink') {
            const inLink = context.inLink || node.type === 'link' || node.type === 'linkReference'
            rewrite(node, inLink === context.inLink ? context : { ...context, inLink })
        }
        result.push(...nodesOf(node, context))
    }
    parent.children = result
}

/** The definitions of the reference links of a note. The first definition of a name wins, as for the parser. */
function definitionsOf(root: MdNode): Map<string, string> {
    const definitions = new Map<string, string>()
    const read = (node: MdNode): void => {
        for (const child of node.children ?? []) {
            const name = child['identifier']
            if (
                child.type === 'definition' &&
                typeof name === 'string' &&
                typeof child['url'] === 'string'
            ) {
                if (!definitions.has(name)) definitions.set(name, child['url'])
            } else {
                read(child)
            }
        }
    }
    read(root)
    return definitions
}

/**
 * The step of the Markdown tree: marks for links, embeds and link cards;
 * callouts, tags and highlights as elements; comments, Meta Bind code and live
 * queries out (REN-03, REN-14); block ids as ids. The options are
 * `MARKUP_VERSION` and the versions of the packages that write the markup:
 * the cache of Astro is kept while they stay the same.
 */
export function remarkNote(
    this: unknown,
    _options: { version: number; packages?: Readonly<Record<string, string>> }
) {
    return (tree: unknown, file: { value: unknown }): void => {
        const root = tree as MdNode
        const notes: MdNode[] = []
        rewrite(root, {
            source: String(file.value),
            definitions: definitionsOf(root),
            notes,
            inLink: false
        })
        root.children = [...(root.children ?? []), ...notes]
    }
}

/** True for an element of the given name with the given class. */
function isElement(
    node: HastContent | ElementContent | undefined,
    name: string,
    className?: string
): node is Element {
    if (node?.type !== 'element' || node.tagName !== name) {
        return false
    }
    if (className === undefined) {
        return true
    }
    const classes = node.properties['className']
    return Array.isArray(classes) && classes.includes(className)
}

/** Every element of a tree, with its parent and its place, in the order of the tree. */
function elementsOf(
    parent: HastRoot | Element
): { node: Element; parent: HastRoot | Element; index: number }[] {
    const found: { node: Element; parent: HastRoot | Element; index: number }[] = []
    parent.children.forEach((child, index) => {
        if (child.type === 'element') {
            found.push({ node: child, parent, index })
            found.push(...elementsOf(child))
        }
    })
    return found
}

/** The text of a node as written: the white space of code stays. */
function rawText(node: Element): string {
    return node.children
        .map((child) =>
            child.type === 'text' ? child.value : child.type === 'element' ? rawText(child) : ''
        )
        .join('')
}

function make(tagName: string, className: string[], children: ElementContent[]): Element {
    return { type: 'element', tagName, properties: { className }, children }
}

/** The elements of a fragment of HTML, with no inline style (REN-06). */
function htmlElements(html: string, space: 'html' | 'svg' = 'html'): ElementContent[] {
    const tree = fromHtml(html, { fragment: true, space })
    for (const { node } of elementsOf(tree)) {
        delete node.properties['style']
    }
    return tree.children.filter((child): child is ElementContent => child.type !== 'doctype')
}

/** Math as MathML, which needs no style and no script (REN-01, REN-06). */
function mathOf(tex: string, display: boolean): ElementContent[] | undefined {
    try {
        return htmlElements(temml.renderToString(tex, { displayMode: display, throwOnError: true }))
    } catch {
        return undefined
    }
}

/** A Mermaid diagram as SVG, made at build time by Pele (REN-08). Its theme comes from the classes of the site. */
function diagramOf(source: string, prefix: string): ElementContent[] | undefined {
    try {
        // Pele writes every id of a diagram with this prefix.
        return htmlElements(renderDiagram(source, { idPrefix: prefix }).svg, 'svg')
    } catch {
        // A diagram that Pele cannot read stays as its code.
        return undefined
    }
}

/** Every element of some nodes, the nodes included. */
function allElements(nodes: readonly ElementContent[]): Element[] {
    return nodes.flatMap((node) =>
        node.type === 'element' ? [node, ...elementsOf(node).map(({ node: inner }) => inner)] : []
    )
}

/**
 * True for a root-relative address: an address of the site. `//host` and
 * `/\host` lead to another host in a browser, so they are not.
 */
function isSiteAddress(href: string): boolean {
    return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')
}

/** The property that marks the footnotes and the links that the build writes (issue 124). */
const BUILT_MARK = 'dataBuiltMark'

/**
 * The step of the HTML tree before the raw HTML is read: every element is
 * ours, so it marks the footnotes (their section and the references to them)
 * and the links (the tag links) with a random value of this render.
 * `rehypeNote` gives their ids priority and drops the mark; raw HTML cannot
 * know the value.
 */
export function rehypeBuiltMark() {
    return (tree: HastRoot, file: { data: Record<string, unknown> }): void => {
        const mark = crypto.randomUUID()
        file.data[BUILT_MARK] = mark
        for (const { node } of elementsOf(tree)) {
            if (
                (isElement(node, 'section') && node.properties['dataFootnotes'] !== undefined) ||
                isElement(node, 'a')
            ) {
                for (const element of allElements([node])) element.properties[BUILT_MARK] = mark
            }
        }
    }
}

/**
 * The step of the HTML tree after the allow list: math, Mermaid diagrams,
 * then the ids (URL-14, issue 124): the ids that the build writes (the
 * footnotes, the diagrams, the math) are taken first, then the ids of the
 * note and the slugs of its headings go through `noteIds`. It runs after the
 * allow list, because what it writes is ours.
 */
export function rehypeNote() {
    return (tree: HastRoot, file: { data: Record<string, unknown> }): void => {
        let diagrams = 0
        /** The elements that the build writes, whose ids win over an id of the note. */
        const built = new Set<Element>()
        const keep = (nodes: ElementContent[]): ElementContent[] => {
            for (const element of allElements(nodes)) built.add(element)
            return nodes
        }
        // From the end, so a change of a node does not move the place of one still to come.
        for (const { node, parent, index } of elementsOf(tree).toReversed()) {
            const [code] = node.children
            const inPre = parent.type === 'element' && parent.tagName === 'pre'
            if (isElement(node, 'code', 'language-math') && !inPre) {
                const math = mathOf(rawText(node), false)
                if (math !== undefined) parent.children.splice(index, 1, ...keep(math))
            } else if (isElement(node, 'pre') && isElement(code, 'code', 'language-math')) {
                const math = mathOf(rawText(code), true)
                if (math !== undefined)
                    parent.children[index] = make('div', ['math-block'], keep(math))
            } else if (isElement(node, 'pre') && isElement(code, 'code', 'language-mermaid')) {
                diagrams += 1
                const svg = diagramOf(rawText(code), `diagram-${String(diagrams)}`)
                if (svg !== undefined)
                    parent.children[index] = make('figure', ['diagram'], keep(svg))
            }
        }
        const all = elementsOf(tree).map(({ node }) => node)
        // The footnotes of the build: the elements that `rehypeBuiltMark` marked
        // before the raw HTML was read. Raw HTML may write the same `data-footnote*`
        // marks (the allow list keeps `data*`), never the mark of this render.
        const mark = file.data[BUILT_MARK]
        for (const node of all) {
            if (mark !== undefined && node.properties[BUILT_MARK] === mark) built.add(node)
            delete node.properties['dataBuiltMark']
        }
        // A raw link of the note to an address of the site (`<a href="/wiki/Compost">`)
        // is a mark: the page step resolves it at each build, so it never leads to
        // no page (issue 98). A link of the build, a link to another site and a
        // link into the note stay.
        for (const node of all) {
            const href = node.properties['href']
            if (
                !built.has(node) &&
                node.tagName === 'a' &&
                typeof href === 'string' &&
                isSiteAddress(href)
            ) {
                node.tagName = MARK.link
                node.properties = { dataAddress: encode(href) }
            }
        }
        // The ids that the build writes keep clear of the frame and of each other.
        const taken = new Set<string>()
        const ofNote: { node: Element; item: IdOfNote }[] = []
        for (const node of all) {
            const id = node.properties['id']
            if (built.has(node)) {
                if (typeof id !== 'string') continue
                const free = freeId(id, new Set([...FRAME_IDS, ...taken]))
                node.properties['id'] = free
                taken.add(free)
            } else if (typeof id === 'string') {
                ofNote.push({ node, item: { id } })
            } else if (/^h[1-6]$/u.test(node.tagName)) {
                ofNote.push({
                    node,
                    item: { depth: Number(node.tagName.slice(1)), text: toText(node) }
                })
            }
        }
        const ids = noteIds(
            ofNote.map(({ item }) => item),
            taken
        )
        ofNote.forEach(({ node }, index) => {
            const id = ids[index]
            if (id !== undefined) node.properties['id'] = id
        })
    }
}

/**
 * The Markdown processor of the site: remark with the parser of Obsidian and
 * our steps. The raw HTML of a note is read first and goes through the allow
 * list (REN-15); then come our steps and the highlight of code with classes
 * (REN-06). No smart punctuation: a link path is read as the author wrote it.
 */
export function markdownProcessor(): ReturnType<typeof astroUnified> {
    return astroUnified({
        smartypants: false,
        gfm: false,
        remarkPlugins: [
            remarkObsidian,
            [remarkNote, { version: MARKUP_VERSION, packages: RENDERING_PACKAGES }]
        ],
        rehypePlugins: [
            rehypeBuiltMark,
            rehypeRaw,
            [rehypeSanitize, allowList],
            rehypeNote,
            [rehypePrism, []]
        ]
    })
}
