// The design variants of the prototype of issue 116: each one is a theme, a
// set of token values only (DES-02), with a dark and a light mode
// (`styles/themes/<name>.css`). The reader switches them in the browser,
// so that the author can compare them on the real pages and pick the new
// default theme. A page shows a variant with the attribute `data-design` of
// its root; `knowii`, the look of today, has no attribute of its own.

/** The key of the stored choice of a variant. */
export const DESIGN_KEY = 'design'

/** The query parameter that chooses a variant: `?design=signal` (and stores it). */
export const DESIGN_PARAMETER = 'design'

/** The variants, the look of today first. */
export const DESIGNS = [
    { name: 'knowii', label: 'Today' },
    { name: 'signal', label: 'Signal' },
    { name: 'marker', label: 'Marker' },
    { name: 'aurora', label: 'Aurora' }
] as const

export type Design = (typeof DESIGNS)[number]['name']

/** The variant of a page with no choice: the look of today. */
export const DEFAULT_DESIGN: Design = 'knowii'

const NAMES: readonly string[] = DESIGNS.map((design) => design.name)

/**
 * The variant of a page: the query parameter wins, then the stored choice,
 * then the look of today. An unknown name counts as none.
 */
export function designOf(asked: string | null, stored: string | null): Design {
    for (const name of [asked, stored]) {
        if (name !== null && NAMES.includes(name)) {
            return name as Design
        }
    }
    return DEFAULT_DESIGN
}

/**
 * The script of the head, before any style: a part of the script of the
 * mode (`modeScript`), so that a page keeps its count of inline scripts. It
 * shows the variant of `designOf()`, and stores a variant that the query
 * asks for.
 */
export const designScript = `{
    const names = ${JSON.stringify(NAMES)}
    const fallback = ${JSON.stringify(DEFAULT_DESIGN)}
    try {
        const asked = new URLSearchParams(location.search).get(${JSON.stringify(DESIGN_PARAMETER)})
        const stored = localStorage.getItem(${JSON.stringify(DESIGN_KEY)})
        if (asked !== null && names.includes(asked)) localStorage.setItem(${JSON.stringify(DESIGN_KEY)}, asked)
        const design = [asked, stored].find((name) => name !== null && names.includes(name)) ?? fallback
        if (design !== fallback) document.documentElement.dataset.design = design
    } catch {}
}`

/**
 * The script of the switch of the variant, at the end of the body, a part of
 * the script of the switch of the mode (`modeSwitchScript`): it shows
 * the switch with the current variant, and a change shows the new variant
 * and stores it. The script of the mode is not run again: a variant keeps
 * the mode.
 */
export const designSwitchScript = `{
    const root = document.documentElement
    const fallback = ${JSON.stringify(DEFAULT_DESIGN)}
    for (const select of document.querySelectorAll('[data-design-switch]')) {
        select.value = root.dataset.design ?? fallback
        select.hidden = false
        select.addEventListener('change', () => {
            const design = select.value
            if (design === fallback) delete root.dataset.design
            else root.dataset.design = design
            try {
                localStorage.setItem(${JSON.stringify(DESIGN_KEY)}, design)
            } catch {}
        })
    }
}`
