// The mode of a page (MODE-01 of the spec): dark or light. A stored choice of
// the reader wins, then the mode of the system, and dark when the system
// states none. The page runs `modeScript` in its head, before any style, so
// it never shows the wrong mode first.

/** The key of the stored choice of the reader. */
export const MODE_KEY = 'mode'

export type Mode = 'dark' | 'light'

/**
 * The mode of a page.
 *
 * @param stored the stored choice, or `null` when there is none
 * @param prefersLight true when the system asks for a light mode
 */
export function modeOf(stored: string | null, prefersLight: boolean): Mode {
    if (stored === 'dark' || stored === 'light') {
        return stored
    }
    return prefersLight ? 'light' : 'dark'
}

/** The script of the head: the same function, run with the globals of the page. */
export const modeScript = `
let stored = null
try {
    stored = localStorage.getItem(${JSON.stringify(MODE_KEY)})
} catch {}
document.documentElement.dataset.theme = (${modeOf.toString()})(
    stored,
    matchMedia('(prefers-color-scheme: light)').matches
)
`

/**
 * The script of the switch of the mode, at the end of the body: a click
 * changes the mode and stores the choice. Without a stored choice, the page
 * follows a change of the mode of the system.
 */
export const modeSwitchScript = `
const root = document.documentElement
const key = ${JSON.stringify(MODE_KEY)}
const label = (mode) => (mode === 'dark' ? 'Switch to the light mode' : 'Switch to the dark mode')
for (const button of document.querySelectorAll('[data-mode-switch]')) {
    button.setAttribute('aria-label', label(root.dataset.theme))
    button.addEventListener('click', () => {
        const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
        root.dataset.theme = next
        try {
            localStorage.setItem(key, next)
        } catch {}
        for (const other of document.querySelectorAll('[data-mode-switch]')) {
            other.setAttribute('aria-label', label(next))
        }
    })
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
    let stored = null
    try {
        stored = localStorage.getItem(key)
    } catch {}
    if (stored === null) {
        root.dataset.theme = event.matches ? 'light' : 'dark'
    }
})
`
