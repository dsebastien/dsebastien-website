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

/**
 * The media query of the color of the bar of the browser of each mode
 * (`theme-color`, issue 133), before a script runs: the mode of the system,
 * and dark when the system states none, as `modeOf()`.
 */
export const BAR_MEDIA: Readonly<Record<Mode, string>> = {
    dark: 'not all and (prefers-color-scheme: light)',
    light: '(prefers-color-scheme: light)'
}

/**
 * Shows a mode on a page: its attribute, and the color of the bar of the
 * browser of that mode, also when the reader chose a mode that is not the
 * one of the system. Each `theme-color` element names its mode in
 * `data-mode`; the head holds them before its script. It is the text of a
 * function of the page (`(mode, page) => …`), not a function of this module:
 * the build and the tests would each write a function in another form, and
 * the tests compare the scripts of the built pages with these texts.
 */
export const SHOW_MODE = `(mode, page) => {
        page.documentElement.dataset.theme = mode
        for (const meta of page.querySelectorAll('meta[name="theme-color"]')) {
            meta.media = meta.dataset.mode === mode ? 'all' : 'not all'
        }
    }`

/** The script of the head: the same functions, run with the globals of the page. */
export const modeScript = `{
    let stored = null
    try {
        stored = localStorage.getItem(${JSON.stringify(MODE_KEY)})
    } catch {}
    ;(${SHOW_MODE})(
        (${modeOf.toString()})(stored, matchMedia('(prefers-color-scheme: light)').matches),
        document
    )
}`

/**
 * The script of the switch of the mode, at the end of the body: it shows the
 * switch, a click changes the mode and stores the choice, and without a stored
 * choice the page follows a change of the mode of the system. It is one block,
 * so it declares no global name.
 */
export const modeSwitchScript = `{
    const root = document.documentElement
    const key = ${JSON.stringify(MODE_KEY)}
    const show = (mode) => (${SHOW_MODE})(mode, document)
    const current = () => (root.dataset.theme === 'light' ? 'light' : 'dark')
    const label = (mode) => (mode === 'dark' ? 'Switch to the light mode' : 'Switch to the dark mode')
    show(current())
    const buttons = document.querySelectorAll('[data-mode-switch]')
    for (const button of buttons) {
        button.setAttribute('aria-label', label(current()))
        button.hidden = false
        button.addEventListener('click', () => {
            const next = current() === 'dark' ? 'light' : 'dark'
            show(next)
            try {
                localStorage.setItem(key, next)
            } catch {}
            for (const other of buttons) {
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
            show(event.matches ? 'light' : 'dark')
        }
    })
}`
