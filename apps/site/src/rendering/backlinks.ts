import type { ElementContent, Root } from 'hast'
import { decode, MARK } from './mark.ts'

// The context of a backlink (issue 48, PAGE-03, MOD-06 of the spec): the
// sentence around each link of a note. It is read from the markup that the
// Markdown processor made, where a link is still a mark with its link path, so
// a link in code is no link, and the text is the text that a reader sees.
//
// The sentence is cut in the text of the block of the link: its paragraph, its
// list item without the lists inside it, its heading, its table cell.

/** The sentence around a link, in three parts. */
export interface LinkContext {
    /** The text of the sentence before the link. */
    before: string
    /** The text of the link, as a reader sees it. */
    link: string
    /** The text of the sentence after the link. */
    after: string
}

/** The sentence around a link of a note to a file of the vault. */
export interface NoteLinkContext extends LinkContext {
    /** The link path as the note writes it. */
    linkPath: string
}

/** The elements that are a part of the text of their block. Every other element is a block of its own. */
const INLINE = new Set([
    'a',
    'abbr',
    'b',
    'bdi',
    'bdo',
    'cite',
    'code',
    'data',
    'del',
    'dfn',
    'em',
    'i',
    'img',
    'ins',
    'kbd',
    'mark',
    'math',
    'q',
    's',
    'samp',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'time',
    'u',
    'var',
    'wbr'
])

/** The elements whose text a reader does not read as a part of a sentence. */
const SKIPPED = new Set(['annotation', 'script', 'style', 'svg', 'template'])

/** How many characters of a sentence a context keeps on each side of its link. */
const SIDE = 160

/** The text of a block, with the place of each link in it. */
interface Block {
    text: string
    links: { linkPath: string; start: number; end: number }[]
}

/** Adds a text to a block, with one space for each run of white space. */
function append(block: Block, value: string): void {
    const text = value.replace(/\s+/gu, ' ')
    block.text += block.text === '' || block.text.endsWith(' ') ? text.trimStart() : text
}

/**
 * Reads the nodes of a block. An element that is no part of a text starts a
 * block of its own, and leaves a space in the block around it.
 *
 * @param inline true inside math: every element there is a part of the text
 */
function read(
    nodes: readonly (Root['children'][number] | ElementContent)[],
    block: Block,
    blocks: Block[],
    inline = false
): void {
    for (const node of nodes) {
        if (node.type === 'text') {
            append(block, node.value)
            continue
        }
        if (node.type !== 'element' || SKIPPED.has(node.tagName)) {
            continue
        }
        // The number of a footnote is no word of the sentence.
        if (node.properties['dataFootnoteRef'] !== undefined) {
            continue
        }
        if (node.tagName === 'br') {
            append(block, ' ')
        } else if (node.tagName === MARK.link) {
            const linkPath = decode(node.properties['dataLink'])
            const start = block.text.length
            read(node.children, block, blocks, inline)
            if (linkPath !== undefined && linkPath !== '') {
                block.links.push({ linkPath, start, end: block.text.length })
            }
        } else if (inline || INLINE.has(node.tagName)) {
            read(node.children, block, blocks, inline || node.tagName === 'math')
        } else {
            const inner: Block = { text: '', links: [] }
            blocks.push(inner)
            read(node.children, inner, blocks)
            append(block, ' ')
        }
    }
}

/** The end of a sentence: its mark, the quotes and brackets that close after it, then white space. */
const SENTENCE_END = /[.!?…]+["'”’»)\]]*\s+/gu

/** The sentence of a text around the part from `start` to `end`. */
function sentenceAround(text: string, start: number, end: number): LinkContext {
    let from = 0
    let to = text.length
    for (const match of text.matchAll(SENTENCE_END)) {
        const after = match.index + match[0].length
        if (after <= start) {
            from = after
        } else if (match.index >= end) {
            to = match.index + match[0].trimEnd().length
            break
        }
        // An end inside the text of the link is a part of the link.
    }
    let before = text.slice(from, start).trimStart()
    let after = text.slice(end, to).trimEnd()
    if (before.length > SIDE) {
        before = `… ${before.slice(-SIDE).replace(/^\S*\s+/u, '')}`
    }
    if (after.length > SIDE) {
        after = `${after.slice(0, SIDE).replace(/\s+\S*$/u, '')} …`
    }
    return { before, link: text.slice(start, end), after }
}

/**
 * The sentence around each link of a note to a file of the vault: block by
 * block in the order in which the blocks start, and in the order of the text
 * inside a block. A link into the note itself is not read.
 *
 * @param tree the markup of the note, with its marks
 */
export function linkContextsOf(tree: Root): NoteLinkContext[] {
    const root: Block = { text: '', links: [] }
    const blocks = [root]
    read(tree.children, root, blocks)
    return blocks.flatMap((block) =>
        block.links.map((link) => ({
            linkPath: link.linkPath,
            ...sentenceAround(block.text, link.start, link.end)
        }))
    )
}
