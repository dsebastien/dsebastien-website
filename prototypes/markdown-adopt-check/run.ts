// Prototype of issue 26: runs candidate converters on the corpus of the
// Markdown forms (fixtures/markdown-forms.json) and writes the result per form.
//
//     cd prototypes/markdown-adopt-check && bun install && bun run.ts
//
// Candidates:
// - satteri-today: the site of main (Astro 7, Sätteri, the link plugin of
//   issue 34). The fixture vault is published with the tool, the site is
//   built and served, and the text of each note page is read.
// - quartz-v5: the transformer packages of Quartz v5 (Obsidian Flavored
//   Markdown, GitHub Flavored Markdown, LaTeX, syntax highlighting) on unified,
//   in the order of the default Quartz configuration, then the link rule of
//   this project (one resolver, ADR 0005). Quartz resolves links and fills
//   embeds in its core, which is not a library, so this is what a reuse gets.
//   The transformer parses with @quartz-community/remark-obsidian, legacy
//   preset (its default): the parser that decision R50 keeps.
// - astro-loader-obsidian: the Astro 5 project of astro5/. The loader reads a
//   copy of the published notes with their properties and resolves links and
//   files itself: it takes no other resolver.
//
// Every input is invented. Nothing reads the real vault.

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    FIXTURE_VAULT,
    checkHtml,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    readMarkdownForms,
    type MarkdownForm
} from '../../packages/testing/src/index.ts'
import { nodeDevice } from '../../apps/plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../../apps/plugin/src/publishing/tool.ts'
import { LinkIndex } from '../../apps/plugin/src/publishing/links.ts'
import { canonicalPath } from '../../packages/resolver/src/url.ts'
import { startServer } from '../../apps/site/server/serve.ts'
import { unified, type Plugin } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { ObsidianFlavoredMarkdown } from '@quartz-community/obsidian-flavored-markdown'
import { GitHubFlavoredMarkdown } from '@quartz-community/github-flavored-markdown'
import { Latex } from '@quartz-community/latex'
import { SyntaxHighlighting } from '@quartz-community/syntax-highlighting'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SITE = fileURLToPath(new URL('../../apps/site', import.meta.url))
const RESULTS = join(HERE, 'results')

/** The note that the tests never select (catalog entry link-to-unpublished-note). */
const NEVER_SELECTED = '10 Garden/Winter plan (draft).md'

type Outcome = { form: string; result: 'pass' | 'fail' | 'error'; failures: string[]; html: string }

async function vaultFiles(): Promise<string[]> {
    const entries = await readdir(FIXTURE_VAULT, { recursive: true, withFileTypes: true })
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(FIXTURE_VAULT.length + 1))
        .sort()
}

function withoutProperties(text: string): string {
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)
    return match === null ? text : text.slice(match[0].length)
}

async function judge(form: MarkdownForm, html: string): Promise<Outcome> {
    const failures = await checkHtml(html, form.checks)
    return { form: form.id, result: failures.length === 0 ? 'pass' : 'fail', failures, html }
}

// --- The published set and the link rule of this project ----------------------

interface Element {
    type: 'element'
    tagName: string
    properties: Record<string, unknown>
    children: Node[]
}
type Node = Element | { type: string; children?: Node[]; value?: string }

/**
 * The vault path that a relative URL of a converted note names, by the link
 * rule of this project, and the fragment after it.
 */
function targetOfUrl(
    url: string,
    from: string,
    index: LinkIndex
): { target: string | undefined; fragment: string } {
    const hash = url.indexOf('#')
    const raw = hash === -1 ? url : url.slice(0, hash)
    const fragment = hash === -1 ? '' : url.slice(hash)
    let linkPath = raw
    try {
        linkPath = decodeURIComponent(raw)
    } catch {
        // kept as written
    }
    linkPath = linkPath.replace(/^\.\//, '')
    const target =
        index.targetOf(linkPath, from) ?? index.targetOf(linkPath.replace(/\.md$/, ''), from)
    return { target, fragment }
}

/** The URL of an attachment on the site (R45): the key is left out of the prototype. */
function attachmentUrl(path: string): string {
    return `/-/attachments/key/${encodeURIComponent(path.split('/').at(-1) ?? '')}`
}

const SOURCES: Record<string, string> = {
    img: 'src',
    audio: 'src',
    video: 'src',
    source: 'src',
    iframe: 'src',
    embed: 'src',
    object: 'data'
}

/**
 * A rehype step: the link rule of this project on every relative link and
 * every relative file of a converted note (the src of an image, a sound, a
 * video or a frame, the data of an object).
 */
function ourLinks(
    from: string,
    index: LinkIndex,
    published: ReadonlySet<string>
): Plugin<[], Node> {
    return () => (tree: Node) => {
        const visit = (node: Node): void => {
            if (!('children' in node) || node.children === undefined) return
            node.children = node.children.flatMap((child): Node[] => {
                visit(child)
                if (child.type !== 'element') return [child]
                const element = child as Element
                const sourceKey = SOURCES[element.tagName]
                const source = sourceKey === undefined ? undefined : element.properties[sourceKey]
                if (
                    sourceKey !== undefined &&
                    typeof source === 'string' &&
                    !/^[a-z][a-z0-9+.-]*:/i.test(source) &&
                    !source.startsWith('/')
                ) {
                    const { target } = targetOfUrl(source, from, index)
                    if (target !== undefined && !target.endsWith('.md')) {
                        element.properties[sourceKey] = attachmentUrl(target)
                    }
                }
                const href = element.properties['href']
                if (element.tagName !== 'a' || typeof href !== 'string') return [child]
                if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return [child]
                // A tag link of the converter is not a link to a note.
                const classes = element.properties['className']
                if (Array.isArray(classes) && classes.includes('tag-link')) return [child]
                const { target, fragment } = targetOfUrl(href, from, index)
                if (target !== undefined && target.endsWith('.md') && published.has(target)) {
                    element.properties['href'] = canonicalPath(target) + fragment
                    return [child]
                }
                if (target !== undefined && !target.endsWith('.md')) {
                    element.properties['href'] = attachmentUrl(target)
                    return [child]
                }
                // Not published, missing or under a guard: plain text (business rule 5).
                return [
                    {
                        type: 'element',
                        tagName: 'span',
                        properties: { className: ['not-published'] },
                        children: element.children
                    } as Element
                ]
            })
        }
        visit(tree)
    }
}

// --- Candidates -------------------------------------------------------------

interface QuartzPlugin {
    textTransform?: (ctx: unknown, src: string) => string
    markdownPlugins?: (ctx: unknown) => unknown[]
    htmlPlugins?: (ctx: unknown) => unknown[]
}

async function quartzV5(
    forms: MarkdownForm[],
    index: LinkIndex,
    published: ReadonlySet<string>
): Promise<Outcome[]> {
    // The order of quartz.config.default.yaml: syntax highlighting, Obsidian, GitHub, LaTeX.
    const plugins = [
        SyntaxHighlighting({}),
        ObsidianFlavoredMarkdown({ enableYouTubeEmbed: true, enableTweetEmbed: false }),
        GitHubFlavoredMarkdown({}),
        Latex({ renderEngine: 'katex' })
    ] as unknown as QuartzPlugin[]
    const outcomes: Outcome[] = []
    for (const form of forms) {
        try {
            let text = withoutProperties(await Bun.file(join(FIXTURE_VAULT, form.note)).text())
            for (const plugin of plugins) text = plugin.textTransform?.(undefined, text) ?? text
            let processor = unified().use(remarkParse)
            // A plugin is a function or a tuple [plugin, options].
            const use = (p: unknown): void => {
                processor = (
                    Array.isArray(p)
                        ? processor.use(p[0] as Plugin, ...(p.slice(1) as []))
                        : processor.use(p as Plugin)
                ) as never
            }
            for (const plugin of plugins)
                for (const p of plugin.markdownPlugins?.(undefined) ?? []) use(p)
            processor = processor.use(remarkRehype, { allowDangerousHtml: true }) as never
            for (const plugin of plugins)
                for (const p of plugin.htmlPlugins?.(undefined) ?? []) use(p)
            processor = processor
                .use(ourLinks(form.note, index, published) as Plugin)
                .use(rehypeStringify, { allowDangerousHtml: true }) as never
            const slug = form.note.replace(/\.md$/, '').replaceAll(' ', '-')
            const html = String(
                await processor.process({ value: text, data: { slug, filePath: form.note } })
            )
            outcomes.push(await judge(form, html))
        } catch (error) {
            outcomes.push({ form: form.id, result: 'error', failures: [String(error)], html: '' })
        }
    }
    return outcomes
}

/** The site of main: publish, build, serve, and read the text of each note page. */
async function satteriToday(
    forms: MarkdownForm[]
): Promise<{ outcomes: Outcome[]; published: Set<string> }> {
    const stores = await makeTestStores()
    const cache = join(SITE, '.cache')
    await mkdir(cache, { recursive: true })
    const outDir = await mkdtemp(join(cache, 'adopt-check-'))
    try {
        const vault = await copyFixtureVault(stores)
        const contentStore = await makeContentStoreCopy(stores)
        const device = nodeDevice({
            vault,
            contentStore,
            attachmentStorage: stores.attachmentStorage
        })
        const queue = await status(device)
        const include = queue.new.filter((path) => path !== NEVER_SELECTED)
        const planned = await plan(device, { include })
        await publish(device, planned.id, {
            time: '2031-05-01T00:00:00Z',
            device: 'adopt-check',
            face: 'command-line'
        })
        const build = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
            cwd: SITE,
            env: { ...process.env, CONTENT_STORE: contentStore },
            stdout: 'ignore',
            stderr: 'inherit'
        })
        if ((await build.exited) !== 0) throw new Error('the build of the site failed')
        const server = await startServer({
            dist: outDir,
            port: 0,
            attachments: stores.attachmentStorage
        })
        const outcomes: Outcome[] = []
        try {
            for (const form of forms) {
                const answer = await fetch(new URL(canonicalPath(form.note), server.url))
                const page = await answer.text()
                const article = /<article class="note-text[^"]*"[^>]*>([\s\S]*?)<\/article>/.exec(
                    page
                )
                if (answer.status !== 200 || article === null) {
                    outcomes.push({
                        form: form.id,
                        result: 'error',
                        failures: [`HTTP ${String(answer.status)}, no note text`],
                        html: ''
                    })
                    continue
                }
                outcomes.push(await judge(form, article[1] ?? ''))
            }
        } finally {
            await server.stop()
        }
        return { outcomes, published: new Set(include) }
    } finally {
        await rm(outDir, { recursive: true, force: true })
        await stores.remove()
    }
}

/**
 * astro-loader-obsidian in the Astro 5 project of astro5/: the published notes
 * and every other file of the fixture vault outside the deny list are copied
 * into astro5/vault-copy/, because the loader reads a folder itself.
 */
async function astroLoader(
    forms: MarkdownForm[],
    published: ReadonlySet<string>
): Promise<Outcome[] | undefined> {
    const project = join(HERE, 'astro5')
    if (!(await Bun.file(join(project, 'node_modules', 'astro', 'package.json')).exists()))
        return undefined
    const copy = join(project, 'vault-copy')
    await rm(copy, { recursive: true, force: true })
    const denyList = (
        (await Bun.file(join(FIXTURE_VAULT, '..', 'configuration.json')).json()) as {
            denyList: string[]
        }
    ).denyList
    for (const path of await vaultFiles()) {
        if (denyList.some((folder) => path.startsWith(`${folder}/`))) continue
        if (path.endsWith('.md') && !published.has(path)) continue
        await Bun.write(join(copy, path), Bun.file(join(FIXTURE_VAULT, path)))
    }
    // A clean build: no cache of an earlier build. Measured: the first clean
    // build fails (a Markdown image named by its file name alone is not found),
    // and a second build passes on the cache of the first one. Both results
    // are written down; the forms are measured on the second build.
    await rm(join(project, 'dist'), { recursive: true, force: true })
    await rm(join(project, '.astro'), { recursive: true, force: true })
    await rm(join(project, 'node_modules', '.astro'), { recursive: true, force: true })
    const builds: string[] = []
    let code = 1
    for (let attempt = 1; attempt <= 2 && code !== 0; attempt++) {
        const build = Bun.spawn(['bunx', '--bun', 'astro', 'build'], {
            cwd: project,
            stdout: 'ignore',
            stderr: 'pipe'
        })
        code = await build.exited
        const errors = (await new Response(build.stderr).text())
            .split('\n')
            .filter((line) => /error|warn/i.test(line) && !line.includes('Shiki'))
        builds.push(`Build ${String(attempt)}: exit ${String(code)}\n${errors.join('\n')}`)
    }
    await Bun.write(
        join(RESULTS, 'astro-loader-obsidian-builds.txt'),
        builds.join('\n\n').replaceAll(HERE, '') + '\n'
    )
    if (code !== 0) {
        return forms.map((form) => ({
            form: form.id,
            result: 'error' as const,
            failures: ['the Astro 5 build failed two times'],
            html: ''
        }))
    }
    const dump = Bun.file(join(project, 'dist', 'forms.json'))
    if (!(await dump.exists())) return undefined
    const pages = (await dump.json()) as Record<string, string>
    const outcomes: Outcome[] = []
    for (const form of forms) {
        const html = pages[form.note]
        if (html === undefined) {
            outcomes.push({
                form: form.id,
                result: 'error',
                failures: ['the loader gave no entry for the note'],
                html: ''
            })
            continue
        }
        outcomes.push(await judge(form, html))
    }
    return outcomes
}

// --- Main -------------------------------------------------------------------

const forms = await readMarkdownForms()
const index = new LinkIndex(await vaultFiles())
const { outcomes: satteri, published } = await satteriToday(forms)
const candidates: Record<string, Outcome[]> = {
    'satteri-today': satteri,
    'quartz-v5': await quartzV5(forms, index, published)
}
await mkdir(RESULTS, { recursive: true })
const loader = await astroLoader(forms, published)
if (loader !== undefined) candidates['astro-loader-obsidian'] = loader

await mkdir(RESULTS, { recursive: true })
const names = Object.keys(candidates)
const rows = forms.map((form) => {
    const cells = names.map((name) => {
        const outcome = candidates[name]?.find((item) => item.form === form.id)
        if (outcome === undefined) return '?'
        return outcome.result === 'pass'
            ? 'pass'
            : `${outcome.result} (${String(outcome.failures.length)}/${String(form.checks.length)})`
    })
    return `| ${form.id} | ${cells.join(' | ')} |`
})
const totals = names.map((name) =>
    String(candidates[name]?.filter((item) => item.result === 'pass').length ?? 0)
)
const table = [
    `| Form | ${names.join(' | ')} |`,
    `| --- | ${names.map(() => '---').join(' | ')} |`,
    ...rows,
    `| **passed** (of ${String(forms.length)}) | ${totals.join(' | ')} |`
].join('\n')
await Bun.write(
    join(RESULTS, 'summary.md'),
    `# Result per form\n\nWritten by run.ts. Cell: pass, or fail/error with failed checks of all checks.\n\n${table}\n`
)
for (const name of names) {
    await Bun.write(join(RESULTS, `${name}.json`), JSON.stringify(candidates[name], null, 2) + '\n')
}
console.log(table)
