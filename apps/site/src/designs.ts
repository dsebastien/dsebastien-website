// The themes that a reader can choose (DES-10, decision R107): each one is a
// set of token values only (DES-02), with a dark and a light mode
// (`styles/themes/<name>.css`). Aurora is the default theme: the HTML and the
// CSS show it with no script and with no stored choice. A page shows another
// theme with the attribute `data-design` of its root. A name that is not a
// theme (`knowii` and `marker`, the themes of the prototype of issue 116, are
// gone) counts as no choice, so the page shows Aurora.

/** The key of the stored choice of a theme. */
export const DESIGN_KEY = 'design'

/** The query parameter that chooses a theme: `?design=signal` (and stores it). */
export const DESIGN_PARAMETER = 'design'

/** The themes, the default theme first. */
export const DESIGNS = [
    { name: 'aurora', label: 'Aurora' },
    { name: 'signal', label: 'Signal' }
] as const

export type Design = (typeof DESIGNS)[number]['name']

/** The theme of a page with no choice. */
export const DEFAULT_DESIGN: Design = 'aurora'

const NAMES: readonly string[] = DESIGNS.map((design) => design.name)

/**
 * The theme of a page: the query parameter wins, then the stored choice,
 * then the default theme. An unknown name counts as none.
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
 * shows the theme of `designOf()`, and stores a theme that the query asks
 * for.
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
 * The script of the switch of the theme, at the end of the body, a part of
 * the script of the switch of the mode (`modeSwitchScript`): it shows the
 * switch with the current theme, and a change shows the new theme and stores
 * it. The script of the mode is not run again: a theme keeps the mode.
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
