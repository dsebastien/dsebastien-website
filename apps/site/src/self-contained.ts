import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'

// The server error page is one static file (URL-33, NAV-20, decision R64): a
// 500 also comes when a file of the release is missing, a style sheet or a
// font for example, so the page loads no other file. After each build, its
// style sheets go into the page as `<style>` elements, without the font
// faces (the page shows the fonts of the system), and the build stops when
// the page still names a file of the release or holds a script.

/** The files of the build that must be self-contained. */
const PAGES = ['500.html']

const STYLESHEET = /<link rel="stylesheet" href="([^"]+)"\s*\/?>/gu
const FONT_FACE = /@font-face\{[^}]*\}/gu

function refuse(reason: string): never {
    throw new Error(`The server error page must be one file: ${reason}`)
}

/**
 * The page with its style sheets inside it.
 *
 * @param read gives the text of a style sheet from its address in the page
 */
export async function selfContained(
    html: string,
    read: (href: string) => Promise<string>
): Promise<string> {
    const sheets = new Map<string, string>()
    for (const [, href = ''] of html.matchAll(STYLESHEET)) {
        const css = (await read(href)).replaceAll(FONT_FACE, '')
        if (/url\(/iu.test(css)) {
            refuse(`the style sheet ${href} loads another file`)
        }
        if (/<\/style/iu.test(css)) {
            refuse(`the style sheet ${href} would end its style element`)
        }
        sheets.set(href, css)
    }
    const page = html.replaceAll(
        STYLESHEET,
        (_link, href: string) => `<style>${sheets.get(href) ?? ''}</style>`
    )
    if (/<script/iu.test(page)) {
        refuse('it holds a script')
    }
    if (/<link\b/iu.test(page) || /\/_astro\//u.test(page)) {
        refuse('it names another file of the release')
    }
    return page
}

/** The Astro integration that makes the server error page self-contained after each build. */
export function selfContainedPages(): AstroIntegration {
    return {
        name: 'self-contained-pages',
        hooks: {
            'astro:build:done': async ({ dir }) => {
                const output = fileURLToPath(dir)
                for (const page of PAGES) {
                    const file = join(output, page)
                    const html = await readFile(file, 'utf8')
                    await writeFile(
                        file,
                        await selfContained(html, (href) =>
                            href.startsWith('/_astro/')
                                ? readFile(join(output, ...href.slice(1).split('/')), 'utf8')
                                : Promise.reject(new Error(`${href} is not a file of the build`))
                        )
                    )
                }
            }
        }
    }
}
