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
        const element = document.createElement('style')
        element.textContent = style
        document.head.append(element)
        styled = true
    }
    return paletteOf(document, options)
}
