import style from './palette.css?inline'
import { createPalette as paletteOf } from './palette.ts'
import type { Palette, PaletteOptions } from './palette.ts'

// What the loader imports at the first opening of the palette (issue 122):
// the palette and its style sheet, which no page loads before (R57). The
// style is text of this module, put into the page at the first opening: a
// style sheet that a script imports would be linked by every page.

let styled = false

/** Makes the palette of a page, and gives the page its style one time. */
export function createPalette(document: Document, options?: PaletteOptions): Palette {
    if (!styled) {
        // A constructed style sheet: the Content Security Policy of the page
        // (SEC-01) refuses a `style` element that a script writes.
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(style)
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
        styled = true
    }
    return paletteOf(document, options)
}
