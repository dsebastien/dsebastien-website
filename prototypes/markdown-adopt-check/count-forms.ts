// Prototype of issue 26: counts, per form of issue 12, the notes of a folder
// that use it. Read only. The numbers of the published notes of the author are
// private: write the output into .private/, never into this repository.
//
//     bun prototypes/markdown-adopt-check/count-forms.ts <folder of notes>
//
// The patterns are approximate: they read lines, not Markdown, and a code block
// is left out by its fence lines only. They answer "is this form used enough
// to matter", not "how does this note render".

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const folder = Bun.argv[2]
if (folder === undefined) {
    console.error('usage: bun count-forms.ts <folder of notes>')
    process.exit(2)
}

const FORMS: Record<string, RegExp> = {
    'wikilink-heading': /(?<!!)\[\[[^\]|#]+#[^\]^|][^\]]*\]\]/,
    'wikilink-block': /(?<!!)\[\[[^\]|#]*#\^[^\]]+\]\]/,
    'wikilink-own-heading': /(?<!!)\[\[#[^\]]+\]\]/,
    'markdown-link-note': /\]\((?!https?:|mailto:|#)[^)\s]+\.md(#[^)]*)?\)/,
    'embed-image-size':
        /!\[\[[^\]]+\.(png|jpe?g|gif|webp|svg|avif)\|\d+(x\d+)?\]\]|!\[[^\]]*\|\d+(x\d+)?\]\(/i,
    'embed-image-in-link': /\[!\[[^\]]*\]\([^)]*\)\]\(/,
    'embed-note':
        /!\[\[(?![^\]]*\.(png|jpe?g|gif|webp|svg|avif|pdf|mp3|wav|ogg|m4a|mp4|webm|mov|base|canvas|excalidraw)(\|[^\]]*)?\]\])[^\]#]+(\|[^\]]*)?\]\]/i,
    'embed-heading': /!\[\[[^\]#]*#[^\]^][^\]]*\]\]/,
    'embed-block': /!\[\[[^\]#]*#\^[^\]]+\]\]/,
    'embed-pdf': /!\[\[[^\]]+\.pdf(#[^\]]*)?(\|[^\]]*)?\]\]/i,
    'embed-audio': /!\[\[[^\]]+\.(mp3|wav|ogg|m4a|flac)(\|[^\]]*)?\]\]/i,
    'embed-video': /!\[\[[^\]]+\.(mp4|webm|mov|mkv)(\|[^\]]*)?\]\]/i,
    'embed-base': /!\[\[[^\]]+\.base(#[^\]]*)?(\|[^\]]*)?\]\]/i,
    'embed-canvas': /!\[\[[^\]]+\.canvas(\|[^\]]*)?\]\]/i,
    'callout-types': /^>\s*\[![^\]]+\]/,
    'callout-folded': /^>\s*\[![^\]]+\][+-]/,
    'callout-nested': /^>\s*>\s*\[!/,
    'frozen-dataview': /<!-- QueryToSerialize:/,
    'link-block': /^LINKS?:?(\s|$)/,
    'video-url-line': /^!\[[^\]]*\]\(https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//,
    'meta-bind-inline': /`(INPUT|VIEW|BUTTON)\[/,
    'meta-bind-block': /^```meta-bind/,
    'live-dataview': /^```dataview(js)?\s*$/,
    'live-dataview-inline': /`=\s/,
    'live-base': /^```base\s*$/,
    'comment-percent': /%%/,
    'comment-html': /<!--(?! (QueryToSerialize|SerializedQuery))/,
    'tags': /(^|\s)#[^\s#\d][^\s#]*/,
    'footnotes': /\[\^[^\]]+\]/,
    'inline-footnotes': /\^\[[^\]]+\]/,
    'highlights': /==[^=\s][^=]*==/,
    'math-block': /^\$\$/,
    'math-inline': /(^|[^$\\])\$[^$\s][^$]*\$(?!\d)/,
    'mermaid': /^```mermaid/,
    'table-pipe-in-link': /^\|.*\[\[[^\]]*\\\|[^\]]*\]\]/,
    'task-list': /^\s*[-*] \[[ xX]\] /,
    'task-custom-char': /^\s*[-*] \[[^ xX\]]\] /,
    'raw-html-details': /<details[\s>]/i,
    'raw-html-script': /<script[\s>]/i,
    'raw-html-iframe': /<iframe[\s>]/i,
    'raw-html-event-attribute': /<[a-z][^>]*\son[a-z]+=/i,
    'code-block': /^```/
}

async function notes(root: string): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => join(entry.parentPath, entry.name))
}

const counts = new Map<string, number>(Object.keys(FORMS).map((form) => [form, 0]))
let sameHeadings = 0
const files = await notes(folder)
for (const file of files) {
    const text = await Bun.file(file).text()
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    const found = new Set<string>()
    let inCode = false
    const headings = new Map<string, number>()
    for (const line of body.split(/\r?\n/)) {
        if (/^```/.test(line)) {
            // An opening fence names the language of the block.
            if (!inCode)
                for (const [form, pattern] of Object.entries(FORMS))
                    if (pattern.source.startsWith('^```') && pattern.test(line)) found.add(form)
            inCode = !inCode
            continue
        }
        if (inCode) continue
        for (const [form, pattern] of Object.entries(FORMS)) if (pattern.test(line)) found.add(form)
        const heading = /^#{1,6}\s+(.*)$/.exec(line)
        if (heading?.[1] !== undefined)
            headings.set(heading[1].trim(), (headings.get(heading[1].trim()) ?? 0) + 1)
    }
    for (const form of found) counts.set(form, (counts.get(form) ?? 0) + 1)
    if ([...headings.values()].some((count) => count > 1)) sameHeadings++
}
console.log(`| Form | Notes |\n| --- | --- |`)
for (const [form, count] of counts) console.log(`| ${form} | ${String(count)} |`)
console.log(`| headings-same-text | ${String(sameHeadings)} |`)
console.log(`| (notes read) | ${String(files.length)} |`)
