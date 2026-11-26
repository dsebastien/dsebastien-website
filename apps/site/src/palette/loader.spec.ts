import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { opensPalette, startPaletteLoader, type PaletteHandle } from './loader.ts'

// The loader of the palette on every page (SRCH-06, SRCH-08, issue 122): the
// control of the header and the keys open the palette, which loads at the
// first opening only. A DOM test (issue 100, point 10), with a fake palette.

let window: Window
let document: Document

/** The page: the control of the header, a field, a text. */
const PAGE = `
    <header><a href="/-/search" data-palette>Search</a></header>
    <main><input id="field"><p id="text" tabindex="-1">Text</p></main>`

beforeEach(() => {
    window = new Window({ url: 'https://notes.dsebastien.net/10+Garden/Rain+barrel' })
    document = window.document as unknown as Document
    document.body.innerHTML = PAGE
})

afterEach(async () => {
    await window.happyDOM.close()
})

/** A loader with a fake palette that records each opening. */
function started(options: { fail?: boolean } = {}): {
    loads: () => number
    openings: { opener: string; typed: string; focused: string }[]
    settle: () => Promise<void>
    followed: string[]
} {
    const followed: string[] = []
    let loads = 0
    const openings: { opener: string; typed: string; focused: string }[] = []
    let pending: Promise<unknown> = Promise.resolve()
    const palette: PaletteHandle = {
        open(opener, typed) {
            openings.push({
                opener: opener?.id || opener?.tagName.toLowerCase() || 'none',
                typed,
                focused: document.activeElement?.tagName.toLowerCase() ?? 'none'
            })
        }
    }
    startPaletteLoader(
        document,
        () => {
            loads += 1
            const load = options.fail
                ? Promise.reject(new Error('offline'))
                : Promise.resolve(() => palette)
            pending = load.catch(() => undefined)
            return load
        },
        (href) => followed.push(href)
    )
    return {
        followed,
        loads: () => loads,
        openings,
        settle: async () => {
            await pending
            await new Promise((resolve) => setTimeout(resolve, 0))
        }
    }
}

function key(
    target: EventTarget,
    init: {
        key: string
        ctrlKey?: boolean
        metaKey?: boolean
        altKey?: boolean
        shiftKey?: boolean
    }
): boolean {
    const event = new window.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
    target.dispatchEvent(event as unknown as Event)
    return event.defaultPrevented
}

function control(): HTMLAnchorElement {
    const link = document.querySelector<HTMLAnchorElement>('[data-palette]')
    if (link === null) throw new Error('no control')
    return link
}

describe('the keys that open the palette (SRCH-06)', () => {
    const event = (init: Partial<KeyboardEvent>, inField = false) =>
        opensPalette({
            key: '',
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            repeat: false,
            isComposing: false,
            defaultPrevented: false,
            ...init,
            inField
        })

    test('`/` opens it, also with Shift (an AZERTY keyboard), never in a field', () => {
        expect(event({ key: '/' })).toBe(true)
        expect(event({ key: '/', shiftKey: true })).toBe(true)
        expect(event({ key: '/' }, true)).toBe(false)
        expect(event({ key: '/', ctrlKey: true })).toBe(false)
        expect(event({ key: '/', altKey: true })).toBe(false)
        expect(event({ key: '/', metaKey: true })).toBe(false)
    })

    test('Ctrl+K and Cmd+K open it, also in a field, never with Shift or Alt', () => {
        expect(event({ key: 'k', ctrlKey: true })).toBe(true)
        expect(event({ key: 'K', metaKey: true })).toBe(true)
        expect(event({ key: 'k', ctrlKey: true }, true)).toBe(true)
        expect(event({ key: 'k', ctrlKey: true, shiftKey: true })).toBe(false)
        expect(event({ key: 'k', ctrlKey: true, altKey: true })).toBe(false)
        expect(event({ key: 'k' })).toBe(false)
    })

    test('a held key, a key of a composition and a key that a page took open nothing', () => {
        expect(event({ key: '/', repeat: true })).toBe(false)
        expect(event({ key: '/', isComposing: true })).toBe(false)
        expect(event({ key: '/', defaultPrevented: true })).toBe(false)
        expect(event({ key: 'p' })).toBe(false)
    })
})

describe('the loader of the palette (SRCH-08)', () => {
    test('loads nothing before the first opening', async () => {
        const loader = started()
        key(document.body, { key: 'p' })
        await loader.settle()
        expect(loader.loads()).toBe(0)
    })

    test('marks the control as the opener of a dialog, with its keys', () => {
        started()
        expect(control().getAttribute('aria-haspopup')).toBe('dialog')
        expect(control().getAttribute('aria-keyshortcuts')).toBe('/ Control+K Meta+K')
    })

    test('a click on the control opens the palette on the same page, and loads it one time', async () => {
        const loader = started()
        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
        control().dispatchEvent(click as unknown as Event)
        expect(click.defaultPrevented).toBe(true)
        await loader.settle()
        control().click()
        await loader.settle()
        expect(loader.loads()).toBe(1)
        expect(loader.openings.map((opening) => opening.opener)).toEqual(['a', 'a'])
    })

    test('a click with a key of the keyboard is left to the browser: a new tab of the search page', async () => {
        const loader = started()
        for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey'] as const) {
            const click = new window.MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                button: 0,
                [modifier]: true
            })
            control().dispatchEvent(click as unknown as Event)
            expect(click.defaultPrevented).toBe(false)
        }
        await loader.settle()
        expect(loader.loads()).toBe(0)
    })

    test('`/` opens it outside a field and names the element that had the focus', async () => {
        const loader = started()
        const text = document.getElementById('text')
        text?.focus()
        expect(key(text ?? document.body, { key: '/' })).toBe(true)
        await loader.settle()
        expect(loader.openings.map((opening) => opening.opener)).toEqual(['text'])
    })

    test('`/` in a field types a slash; Ctrl+K in a field opens the palette', async () => {
        const loader = started()
        const field = document.getElementById('field') ?? document.body
        field.focus()
        expect(key(field, { key: '/' })).toBe(false)
        expect(key(field, { key: 'k', ctrlKey: true })).toBe(true)
        await loader.settle()
        expect(loader.openings.map((opening) => opening.opener)).toEqual(['field'])
    })

    test('while the palette loads, a field holds the focus, so a phone shows its keyboard, and keeps what the reader types', async () => {
        let finish: (() => void) | undefined
        const openings: { typed: string; field: boolean; focused: boolean }[] = []
        // The focus of the field must not scroll the page to it.
        const focusOptions: unknown[] = []
        const prototype = window.HTMLElement.prototype as unknown as HTMLElement
        const focus = Object.getOwnPropertyDescriptor(prototype, 'focus')?.value as (
            this: HTMLElement,
            options?: FocusOptions
        ) => void
        prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
            focusOptions.push(options)
            focus.call(this, options)
        }
        startPaletteLoader(
            document,
            () =>
                new Promise((resolve) => {
                    finish = () => {
                        resolve(() => ({
                            open(_opener, typed) {
                                // The palette takes the focus while the field still has it:
                                // a focus that moves from a field to a field keeps the keyboard.
                                const wait = document.querySelector('[data-palette-wait]')
                                openings.push({
                                    typed,
                                    field: wait !== null,
                                    focused: wait !== null && document.activeElement === wait
                                })
                            }
                        }))
                    }
                })
        )
        control().click()
        const waiting = document.activeElement as HTMLInputElement | null
        expect(waiting?.tagName).toBe('INPUT')
        expect(waiting?.hasAttribute('data-palette-wait')).toBe(true)
        expect(waiting?.getAttribute('aria-label')).toBe('Search the notes or run a command')
        // Fixed at the top, so the page does not jump.
        expect(waiting?.style.position).toBe('fixed')
        expect(waiting?.style.top).toBe('0px')
        expect(focusOptions).toContainEqual({ preventScroll: true })
        prototype.focus = focus
        if (waiting !== null) waiting.value = 'comp'
        finish?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(openings).toEqual([{ typed: 'comp', field: true, focused: true }])
        expect(document.querySelector('[data-palette-wait]')).toBeNull()
    })

    test('a second click while the palette loads gives the focus back to the waiting field', async () => {
        let finish: (() => void) | undefined
        startPaletteLoader(
            document,
            () =>
                new Promise((resolve) => {
                    finish = () => {
                        resolve(() => ({ open: () => undefined }))
                    }
                })
        )
        control().click()
        control().focus()
        control().click()
        expect(document.activeElement?.hasAttribute('data-palette-wait')).toBe(true)
        finish?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
    })

    test('Escape in the waiting field cancels the opening, and the next click opens the palette', async () => {
        let finish: (() => void) | undefined
        const openings: string[] = []
        startPaletteLoader(
            document,
            () =>
                new Promise((resolve) => {
                    finish = () => {
                        resolve(() => ({
                            open(_opener, typed) {
                                openings.push(typed)
                            }
                        }))
                    }
                })
        )
        const text = document.getElementById('text')
        text?.focus()
        key(text ?? document.body, { key: '/' })
        const waiting = document.activeElement as HTMLInputElement | null
        if (waiting !== null) waiting.value = 'co'
        expect(key(waiting ?? document.body, { key: 'Escape' })).toBe(true)
        expect(document.querySelector('[data-palette-wait]')).toBeNull()
        expect(document.activeElement).toBe(text)
        finish?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(openings).toEqual([])
        control().click()
        expect(openings).toEqual([''])
    })

    test('when the palette cannot load, the control leads to the search page', async () => {
        const loader = started({ fail: true })
        control().click()
        await loader.settle()
        expect(loader.followed).toEqual(['https://notes.dsebastien.net/-/search'])
        expect(document.querySelector('[data-palette-wait]')).toBeNull()
    })
})
