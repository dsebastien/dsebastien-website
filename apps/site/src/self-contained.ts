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
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/giu
/** What loads a file in CSS: an address, an import, a set of images, a source. */
const CSS_LOAD = /url\(|@import|image-set\(|(?<![\w-])src\(/iu
/** The start of a meta element, in any letter case. */
const META = /<meta(?=[\s/>])/giu
/** An attribute of an element (its name, and its value in double, single or no quotes), or a slash. */
const ATTRIBUTE = /\s*(?:([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?|\/)/uy
const LOADING_ELEMENT =
    /<(?:img|picture|source|video|audio|track|iframe|frame|object|embed|image)\b/iu
const SOURCE = /\s(?:src|srcset|data|poster|background)\s*=/iu
const ADDRESS = /<([a-z][\w:-]*)\b[^>]*\s(?:xlink:)?href\s*=/giu

/**
 * True when a meta element of the markup has an `http-equiv` other than
 * `content-type`: a refresh loads another address after a time, and no other
 * value has a use on this page. The attributes are read with their quotes,
 * so a `>` of a quoted value does not end the element, and a value is
 * compared as it is written, so a value with a character reference is
 * refused too.
 */
function hasHttpEquiv(markup: string): boolean {
    for (const meta of markup.matchAll(META)) {
        ATTRIBUTE.lastIndex = meta.index + meta[0].length
        for (
            let attribute = ATTRIBUTE.exec(markup);
            attribute !== null && attribute[0] !== '';
            attribute = ATTRIBUTE.exec(markup)
        ) {
            const [, name = '', double, single, bare] = attribute
            const value = (double ?? single ?? bare ?? '').trim().toLowerCase()
            if (name.toLowerCase() === 'http-equiv' && value !== 'content-type') {
                return true
            }
        }
    }
    return false
}

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
        sheets.set(href, (await read(href)).replaceAll(FONT_FACE, ''))
    }
    const page = html.replaceAll(
        STYLESHEET,
        (_link, href: string) => `<style>${sheets.get(href) ?? ''}</style>`
    )
    // The style is checked as CSS, and the rest of the page as HTML: a text
    // of the CSS, such as the syntax "<image>" of a property, is no element.
    const styles = [...page.matchAll(STYLE)].map(([, css = '']) => css)
    for (const css of styles) {
        if (CSS_LOAD.test(css)) {
            refuse('its style loads another file')
        }
        if (/<\/style/iu.test(css)) {
            refuse('its style would end its style element')
        }
    }
    const markup = page.replaceAll(STYLE, '<style></style>')
    if (/<script/iu.test(markup)) {
        refuse('it holds a script')
    }
    if (/<link\b/iu.test(markup) || /\/_astro\//u.test(markup)) {
        refuse('it names another file of the release')
    }
    // Every other way to load a file: an element that loads one, a source,
    // a CSS address in an attribute, and an address of an element that is no link.
    if (
        LOADING_ELEMENT.test(markup) ||
        SOURCE.test(markup) ||
        CSS_LOAD.test(markup) ||
        hasHttpEquiv(markup)
    ) {
        refuse('it loads another file')
    }
    for (const [, element = ''] of markup.matchAll(ADDRESS)) {
        if (element.toLowerCase() !== 'a') {
            refuse(`its element ${element} names another file`)
        }
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
