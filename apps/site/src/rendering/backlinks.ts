import type { ElementContent, Root } from 'hast'
import { decode, MARK } from './mark.ts'

// The context of a backlink (issue 48, PAGE-03, MOD-06 of the spec): the
// sentence around each link of a note. It is read from the markup that the
// Markdown processor made, where a link is still a mark with its link path, so
// a link in code is no link, and the text is the text that a reader sees.
//
// The sentence is cut in the text of the block of the link: its paragraph, its
// list item without the lists inside it, its heading, its table cell. A line
// break ends a block: a line of a note is a block.

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

/** What the reader of a note holds: every block, and the block that the text goes to now. */
interface Reader {
    blocks: Block[]
    block: Block
}

/** Starts a block, and makes it the block that the text goes to. */
function open(reader: Reader): Block {
    const block: Block = { text: '', links: [] }
    reader.blocks.push(block)
    reader.block = block
    return block
}

/**
 * Reads the nodes of a block. An element that is no part of a text starts a
 * block of its own, and leaves a space in the block around it. A line break
 * ends the block, also inside the markup of a line: a line of a note is a
 * block, so a list of links on lines of their own gives each link its line.
 *
 * @param inline true inside math: every element there is a part of the text
 */
function read(
    nodes: readonly (Root['children'][number] | ElementContent)[],
    reader: Reader,
    inline = false
): void {
    for (const node of nodes) {
        if (node.type === 'text') {
            append(reader.block, node.value)
            continue
        }
        if (node.type !== 'element' || SKIPPED.has(node.tagName)) {
            continue
        }
        // The number of a footnote, and the mark that leads back from it, are
        // no words of the sentence.
        if (
            node.properties['dataFootnoteRef'] !== undefined ||
            node.properties['dataFootnoteBackref'] !== undefined
        ) {
            continue
        }
        if (node.tagName === 'br') {
            open(reader)
        } else if (node.tagName === MARK.link) {
            const linkPath = decode(node.properties['dataLink'])
            const block = reader.block
            const start = block.text.length
            read(node.children, reader, inline)
            if (linkPath !== undefined && linkPath !== '') {
                // A link whose text holds a line break: its last line is the link.
                reader.block.links.push({
                    linkPath,
                    start: reader.block === block ? start : 0,
                    end: reader.block.text.length
                })
            }
        } else if (inline || INLINE.has(node.tagName)) {
            read(node.children, reader, inline || node.tagName === 'math')
        } else {
            const around = reader.block
            open(reader)
            read(node.children, reader)
            reader.block = around
            append(around, ' ')
        }
    }
}

/** The end of a sentence: its mark, the quotes and brackets that close after it, then white space. */
const SENTENCE_END = /[.!?…]+["'”’»)\]]*\s+/gu

/** The contexts of the links of a block. The ends of its sentences are read one time. */
function contextsOf(block: Block): NoteLinkContext[] {
    if (block.links.length === 0) {
        return []
    }
    const { text } = block
    // Where each sentence end starts, where its mark ends, and where the next sentence starts.
    const ends = [...text.matchAll(SENTENCE_END)].map((match) => ({
        start: match.index,
        mark: match.index + match[0].trimEnd().length,
        next: match.index + match[0].length
    }))
    let at = 0
    let from = 0
    return block.links.map((link) => {
        // The links are in the order of the text: go on from the last end.
        for (; at < ends.length; at += 1) {
            const end = ends[at]
            if (end === undefined || end.next > link.start) break
            from = end.next
        }
        // An end inside the text of the link is a part of the link.
        let to = text.length
        for (let next = at; next < ends.length; next += 1) {
            const end = ends[next]
            if (end !== undefined && end.start >= link.end) {
                to = end.mark
                break
            }
        }
        return { linkPath: link.linkPath, ...cut(text, from, link.start, link.end, to) }
    })
}

/** The sentence from `from` to `to` around the link from `start` to `end`, cut to some words on each side. */
function cut(text: string, from: number, start: number, end: number, to: number): LinkContext {
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
    const reader: Reader = { blocks: [root], block: root }
    read(tree.children, reader)
    return reader.blocks.flatMap(contextsOf)
}
