// The loader of the command palette, on every page with scripts (SRCH-06,
// SRCH-08, issue 122). The control of the header is a link to the search
// page, so a page with no script still leads to the search. This script
// makes it open the palette on the same page, and so do `/` (not in a field)
// and `Ctrl+K` or `Cmd+K` (also in a field). The palette loads at its first
// opening, with one dynamic import: before it, a page holds this loader only
// (R57, PERF-21). It names nothing of the search, so a test can check that a
// page loads nothing of the search.
//
// A phone shows its keyboard only for a focus in the tap itself, and the
// import comes after the tap: while the palette loads, a field of the page
// holds the focus and what the reader types, and the palette takes both.

/** The attribute of the control of the header. */
export const PALETTE_CONTROL = 'data-palette'

/** What the loader needs of the palette. */
export interface PaletteHandle {
    /** Opens the palette with the focus in its field; `opener` gets the focus back at the end. */
    open(opener: HTMLElement | null, typed: string): void
}

/** What the loader reads of a key. */
export interface KeyFacts {
    readonly key: string
    readonly ctrlKey: boolean
    readonly metaKey: boolean
    readonly altKey: boolean
    readonly shiftKey: boolean
    readonly repeat: boolean
    readonly isComposing: boolean
    readonly defaultPrevented: boolean
    /** True when the focus is in a field. */
    readonly inField: boolean
}

/**
 * True when a key opens the palette: `/` outside a field, with no Ctrl, Alt
 * or Cmd (Shift is fine: an AZERTY keyboard needs it for `/`); `Ctrl+K` or
 * `Cmd+K` anywhere, with no Shift or Alt.
 */
export function opensPalette(event: KeyFacts): boolean {
    if (event.repeat || event.isComposing || event.defaultPrevented) return false
    if (event.key === '/') {
        return !event.inField && !event.ctrlKey && !event.metaKey && !event.altKey
    }
    return (
        event.key.toLowerCase() === 'k' &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey
    )
}

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/** The palette module, loaded at the first opening. */
async function loadPalette(): Promise<(document: Document) => PaletteHandle> {
    const module = await import('./palette-bundle.ts')
    return module.createPalette
}

/**
 * Starts the loader on a page.
 *
 * @param load gives the function that makes the palette; the tests give a fake
 * @param follow opens an address when the palette cannot load
 */
export function startPaletteLoader(
    document: Document,
    load: () => Promise<(document: Document) => PaletteHandle> = loadPalette,
    follow: (href: string) => void = (href) => {
        document.location.assign(href)
    }
): void {
    const control = document.querySelector<HTMLAnchorElement>(`a[${PALETTE_CONTROL}]`)
    control?.setAttribute('aria-haspopup', 'dialog')
    control?.setAttribute('aria-keyshortcuts', '/ Control+K Meta+K')
    let palette: PaletteHandle | undefined
    let loading: Promise<PaletteHandle> | undefined

    const open = (opener: HTMLElement | null): void => {
        if (palette !== undefined) {
            palette.open(opener, '')
            return
        }
        if (loading !== undefined) return
        const wait = document.createElement('input')
        wait.type = 'text'
        wait.className = 'sr-only'
        wait.setAttribute('data-palette-wait', '')
        wait.setAttribute('aria-label', 'Search the notes or run a command')
        wait.autocomplete = 'off'
        // A smaller text makes a phone zoom into the field.
        wait.style.fontSize = '16px'
        document.body.append(wait)
        wait.focus()
        loading = load().then((create) => create(document))
        loading.then(
            (made) => {
                palette = made
                const typed = wait.value
                wait.remove()
                made.open(opener, typed)
            },
            () => {
                loading = undefined
                wait.remove()
                opener?.focus()
                if (control !== null) follow(control.href)
            }
        )
    }

    control?.addEventListener('click', (event) => {
        if (
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
        ) {
            return
        }
        event.preventDefault()
        open(control)
    })
    document.addEventListener('keydown', (event) => {
        const inField = elementOf(event.target)?.closest(FIELD) != null
        if (!opensPalette({ ...pick(event), inField })) return
        event.preventDefault()
        const focused = document.activeElement
        open(focused === document.body ? null : (focused as HTMLElement | null))
    })
}

/** The target of an event when it is an element: a key can also come from the document. */
export function elementOf(target: EventTarget | null): Element | null {
    return target !== null && 'closest' in target ? (target as Element) : null
}

function pick(event: KeyboardEvent): Omit<KeyFacts, 'inField'> {
    return {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        defaultPrevented: event.defaultPrevented
    }
}
