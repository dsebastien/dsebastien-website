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
//
// The search form of the home page (R101) carries `data-palette-form`: a
// submit, a click or a tap into its field and a key typed in it open the
// palette with the text of the field, and its own field holds the focus while
// the palette loads. With no script it stays a plain form to the search page;
// when the palette cannot load, it becomes one again.

/** The attribute of the control of the header. */
export const PALETTE_CONTROL = 'data-palette'

/** The attribute of a search form that opens the palette (R101). */
export const PALETTE_FORM = 'data-palette-form'

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
    const form = document.querySelector<HTMLFormElement>(`form[${PALETTE_FORM}]`)
    const formField = form?.querySelector<HTMLInputElement>('input[name="q"]') ?? null
    const formButton = form?.querySelector('button[type="submit"]') ?? null
    // A searchbox has no popup in ARIA 1.2: its button says it, and a hint names it for the field.
    let formHint: HTMLElement | undefined
    if (formField !== null) {
        formButton?.setAttribute('aria-haspopup', 'dialog')
        formHint = document.createElement('span')
        formHint.id = `${formField.id || 'palette-form'}-hint`
        formHint.className = 'sr-only'
        formHint.setAttribute('data-palette-hint', '')
        formHint.textContent = 'Opens the search and commands panel'
        formField.after(formHint)
        formField.setAttribute('aria-describedby', formHint.id)
    }
    /** False once the palette failed to load from the form: the form is plain again. */
    let formOpens = formField !== null
    let palette: PaletteHandle | undefined
    let loading: Promise<PaletteHandle> | undefined
    /** The field that holds the focus while an opening waits for the palette. */
    let wait: HTMLInputElement | undefined
    let waitOpener: HTMLElement | null = null
    /** The address to follow when the palette cannot load, or none. */
    let waitFallback: string | null = null

    /** Ends the wait and gives back the waiting field: the caller removes it or keeps it. */
    const stopWaiting = (): HTMLInputElement | undefined => {
        const field = wait
        wait = undefined
        return field
    }

    /**
     * Opens the palette.
     *
     * @param own the field of the form, which holds the focus and the text itself
     * @param fallback the address to follow when the palette cannot load
     */
    const open = (
        opener: HTMLElement | null,
        own?: HTMLInputElement,
        fallback: string | null = control?.href ?? null
    ): void => {
        if (palette !== undefined) {
            palette.open(opener, own?.value ?? '')
            if (own !== undefined) own.value = ''
            return
        }
        if (wait !== undefined) {
            // A second click or key while the palette loads.
            wait.focus({ preventScroll: true })
            return
        }
        waitOpener = opener
        waitFallback = fallback
        if (own !== undefined) {
            wait = own
            loadAndOpen()
            return
        }
        const field = document.createElement('input')
        field.type = 'text'
        field.className = 'sr-only'
        field.setAttribute('data-palette-wait', '')
        field.setAttribute('aria-label', 'Search the notes or run a command')
        field.autocomplete = 'off'
        // A smaller text makes a phone zoom into the field; fixed at the top, the page does not move.
        field.style.fontSize = '16px'
        field.style.position = 'fixed'
        field.style.top = '0px'
        field.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || wait !== field) return
            // Escape cancels the opening; the palette still loads for the next one.
            event.preventDefault()
            stopWaiting()?.remove()
            waitOpener?.focus()
        })
        wait = field
        document.body.append(field)
        field.focus({ preventScroll: true })
        loadAndOpen()
    }

    const loadAndOpen = (): void => {
        loading ??= load().then((create) => create(document))
        loading.then(
            (made) => {
                palette = made
                const waited = stopWaiting()
                if (waited === undefined) return
                // The palette takes the focus from the field: a phone keeps its keyboard.
                made.open(waitOpener, waited.value)
                if (waited === formField) waited.value = ''
                else waited.remove()
            },
            () => {
                loading = undefined
                const waited = stopWaiting()
                if (waited === undefined) return
                if (waited === formField) {
                    // The field keeps the focus and the text, and the form is plain again.
                    formOpens = false
                    formButton?.removeAttribute('aria-haspopup')
                    formField.removeAttribute('aria-describedby')
                    formHint?.remove()
                } else {
                    waited.remove()
                    waitOpener?.focus()
                }
                if (waitFallback === null) return
                // The search page, with what the reader typed while the palette loaded.
                const address = new URL(waitFallback)
                if (waited.value.trim() !== '') address.searchParams.set('q', waited.value)
                follow(address.href)
            }
        )
    }

    if (form !== null && formField !== null) {
        form.addEventListener('submit', (event) => {
            // Enter while the palette loads: the plain form goes to the search page.
            if (!formOpens || wait === formField) return
            event.preventDefault()
            open(formField, formField, form.action)
        })
        // A click or a tap into the field; a tap also shows the keyboard of a phone.
        formField.addEventListener('click', () => {
            if (formOpens) open(formField, formField, null)
        })
        // A key typed in the field that the reader reached with Tab. A key of an
        // input method (Japanese, Chinese, a phone keyboard) waits for the end of
        // the composition; the input event that may follow the end has no text left.
        const typed = (): void => {
            if (formOpens && wait === undefined && formField.value !== '') {
                open(formField, formField, null)
            }
        }
        formField.addEventListener('input', (event) => {
            if (!(event as InputEvent).isComposing) typed()
        })
        formField.addEventListener('compositionend', typed)
        formField.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || wait !== formField) return
            // Escape cancels the opening; the field keeps the focus and the text.
            event.preventDefault()
            stopWaiting()
        })
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
