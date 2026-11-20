// The script of the properties panel of a note page (issue 48, R59). The
// panel is a `details` element, closed in the HTML (PAGE-02), so it works
// with no script. The script adds two things: the choice of the reader (open
// or closed) is kept, as the mode is, and the key `p` opens and closes the
// panel when the focus is not in a field.
//
// The page runs the script right after the panel, before the text of the
// note: a panel that a stored choice opens is open before the text shows, so
// nothing moves.

/** The key of the stored choice of the reader: `open` or `closed`. */
export const PROPERTIES_KEY = 'properties'

/** The key that opens and closes the panel. */
export const PROPERTIES_SHORTCUT = 'p'

/** The script of the panel. It is one block, so it declares no global name. */
export const propertiesScript = `{
    const panel = document.querySelector('[data-properties]')
    const key = ${JSON.stringify(PROPERTIES_KEY)}
    try {
        if (localStorage.getItem(key) === 'open') panel.open = true
    } catch {}
    panel.addEventListener('toggle', () => {
        try {
            localStorage.setItem(key, panel.open ? 'open' : 'closed')
        } catch {}
    })
    addEventListener('keydown', (event) => {
        if (event.key !== ${JSON.stringify(PROPERTIES_SHORTCUT)} || event.ctrlKey || event.metaKey || event.altKey) return
        if (event.repeat || event.defaultPrevented) return
        const field = event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        if (field) return
        panel.open = !panel.open
        if (panel.open) panel.scrollIntoView({ block: 'nearest' })
    })
}`
