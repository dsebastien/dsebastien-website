// The script of the properties panel of a note page (issue 48, R59). The
// panel is a `details` element, closed in the HTML (PAGE-02), so it works
// with no script. The panel keeps no state: every page loads with it closed,
// whatever the reader did on another page. The script adds the key `p`, which
// opens and closes the panel when the focus is not in a field, closes a panel
// that the back and forward cache of the browser restores open, and removes
// the choice that an older version of the script stored.

/** The key of the choice that an older version stored. The script removes it. */
export const PROPERTIES_KEY = 'properties'

/** The key that opens and closes the panel. */
export const PROPERTIES_SHORTCUT = 'p'

/** The script of the panel. It is one block, so it declares no global name. */
export const propertiesScript = `{
    const panel = document.querySelector('[data-properties]')
    const key = ${JSON.stringify(PROPERTIES_KEY)}
    try {
        localStorage.removeItem(key)
    } catch {}
    addEventListener('pageshow', (event) => {
        if (event.persisted) panel.open = false
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
