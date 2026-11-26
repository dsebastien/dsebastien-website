// The rules of the newsletter bar (NEWS-01, decisions D51 and items 251 and
// 326), without the DOM: the bar shows after the reader passed 30 percent of
// the note, leaves before the footer comes into view, and stays closed after
// a signup or a dismissal. The memory is in the local storage of the browser,
// which is not a cookie; a blocked storage leaves the bar open and breaks
// nothing.

/** The share of the note that the bottom of the screen must pass before the bar shows. */
export const SHOW_AFTER = 0.3

/** The key of the memory of the bar: `signed-up` or `dismissed`. */
export const NEWSLETTER_KEY = 'newsletter'

/** The key of "Don't show this again" of the current site (`ghost-subscribe.js`), on the same host. */
export const LEGACY_DISMISS_KEY = 'newsletter_never_show'

/** Where the page is, in pixels from the top of the document. */
export interface BarView {
    readonly scrollTop: number
    readonly viewportHeight: number
    /** The top and the height of the text of the note. */
    readonly noteTop: number
    readonly noteHeight: number
    /** The top of the footer of the page. */
    readonly footerTop: number
    /** The height of the bar: it leaves this far before the footer. */
    readonly barHeight: number
}

/**
 * The next state of the bar. `reached` stays true once the reader passed the
 * share of the note; the bar then shows while the footer is more than one bar
 * away from the screen, or while the reader works in it.
 */
export function barStep(
    reached: boolean,
    view: BarView,
    state: { readonly closed: boolean; readonly focused: boolean }
): { reached: boolean; shown: boolean } {
    const bottom = view.scrollTop + view.viewportHeight
    const share = view.noteHeight <= 0 ? 1 : (bottom - view.noteTop) / view.noteHeight
    const passed = reached || share >= SHOW_AFTER
    const nearFooter = bottom + view.barHeight >= view.footerTop
    return { reached: passed, shown: passed && !state.closed && (state.focused || !nearFooter) }
}

/** True when the reader signed up or dismissed the bar before, on this browser. */
export function isClosed(storage: Storage): boolean {
    try {
        const value = storage.getItem(NEWSLETTER_KEY)
        return (
            value === 'signed-up' ||
            value === 'dismissed' ||
            storage.getItem(LEGACY_DISMISS_KEY) === 'true'
        )
    } catch {
        return false
    }
}

/** Remembers that the reader signed up or dismissed the bar. It never throws. */
export function remember(storage: Storage, why: 'signed-up' | 'dismissed'): void {
    try {
        storage.setItem(NEWSLETTER_KEY, why)
    } catch {
        // A blocked storage: the bar closes for this page only.
    }
}
