// Prototype of issue 26: the time to convert every note of the invented corpus
// (bun run corpus, .cache/corpus/vault) to HTML, with no syntax highlighting,
// for one converter per process. A measure for criterion 4 of issue 12, not a
// tuning (R43). The page, the links and the cache of Astro are not part of it.
//
//     bun prototypes/markdown-adopt-check/measure-speed.ts satteri|remark-obsidian|quartz-ofm

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unified, type Plugin } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeStringify from 'rehype-stringify'
import remarkObsidian from '@quartz-community/remark-obsidian'
import rehypeObsidian from '@quartz-community/rehype-obsidian'
import { ObsidianFlavoredMarkdown } from '@quartz-community/obsidian-flavored-markdown'
import { GitHubFlavoredMarkdown } from '@quartz-community/github-flavored-markdown'
import { createSatteriMarkdownProcessor } from '../../apps/site/node_modules/@astrojs/markdown-satteri/dist/satteri-processor.js'

const CORPUS = fileURLToPath(new URL('../../.cache/corpus/vault', import.meta.url))
const which = Bun.argv[2] ?? 'satteri'

const entries = await readdir(CORPUS, { recursive: true, withFileTypes: true })
const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name))
const texts = await Promise.all(
    files.map(async (file) =>
        (await Bun.file(file).text()).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    )
)

type Convert = (text: string) => Promise<string>
let convert: Convert
if (which === 'satteri') {
    const renderer = await createSatteriMarkdownProcessor({ syntaxHighlight: false })
    convert = async (text) => (await renderer.render(text)).code
} else if (which === 'remark-obsidian') {
    const processor = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkObsidian as Plugin)
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeRaw)
        .use(rehypeObsidian as Plugin, { tweetEmbed: false })
        .use(rehypeStringify)
    convert = async (text) => String(await processor.process(text))
} else {
    interface QuartzPlugin {
        markdownPlugins?: (ctx: unknown) => unknown[]
        htmlPlugins?: (ctx: unknown) => unknown[]
    }
    const plugins = [
        ObsidianFlavoredMarkdown({ enableTweetEmbed: false }),
        GitHubFlavoredMarkdown({})
    ] as unknown as QuartzPlugin[]
    let processor = unified().use(remarkParse)
    const use = (p: unknown): void => {
        processor = (
            Array.isArray(p)
                ? processor.use(p[0] as Plugin, ...(p.slice(1) as []))
                : processor.use(p as Plugin)
        ) as never
    }
    for (const plugin of plugins) for (const p of plugin.markdownPlugins?.(undefined) ?? []) use(p)
    processor = processor.use(remarkRehype, { allowDangerousHtml: true }) as never
    for (const plugin of plugins) for (const p of plugin.htmlPlugins?.(undefined) ?? []) use(p)
    const final = processor.use(rehypeStringify, { allowDangerousHtml: true })
    convert = async (text) => String(await final.process({ value: text, data: { slug: 'note' } }))
}

let bytes = 0
let failed = 0
const start = performance.now()
for (const text of texts) {
    try {
        bytes += (await convert(text)).length
    } catch {
        failed++
    }
}
const seconds = (performance.now() - start) / 1000
const rss = process.memoryUsage().rss / 1024 / 1024
console.log(
    `${which}: ${String(texts.length)} notes in ${seconds.toFixed(1)} s (${(texts.length / seconds).toFixed(0)} notes/s), ` +
        `${String(failed)} failed, ${(bytes / 1024 / 1024).toFixed(1)} MB of HTML, RSS ${rss.toFixed(0)} MB`
)
