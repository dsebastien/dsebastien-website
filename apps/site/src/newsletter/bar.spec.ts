import { describe, expect, test } from 'bun:test'
import {
    barStep,
    isClosed,
    LEGACY_DISMISS_KEY,
    NEWSLETTER_KEY,
    remember,
    SHOW_AFTER,
    type BarView
} from './bar.ts'

// The rules of the newsletter bar (NEWS-01, decisions D51 and items 251 and
// 326): it shows after 30 percent of the note, leaves before the footer
// comes into view, and stays closed after a signup or a dismissal.

/** A note of 2,000 pixels at 300 pixels from the top, a footer at 3,000, a screen of 600 and a bar of 90. */
function view(scrollTop: number, change: Partial<BarView> = {}): BarView {
    return {
        scrollTop,
        viewportHeight: 600,
        noteTop: 300,
        noteHeight: 2_000,
        footerTop: 3_000,
        barHeight: 90,
        ...change
    }
}

const OPEN = { closed: false, focused: false }

describe('the newsletter bar', () => {
    test('stays hidden until the reader passed 30 percent of the note', () => {
        // The bottom of the screen at 300 + 599: just under 30 percent of 2,000.
        expect(SHOW_AFTER).toBe(0.3)
        expect(barStep(false, view(299), OPEN)).toEqual({ reached: false, shown: false })
        expect(barStep(false, view(300), OPEN)).toEqual({ reached: true, shown: true })
    })

    test('stays once the reader passed 30 percent, also when the reader goes back up', () => {
        expect(barStep(true, view(0), OPEN)).toEqual({ reached: true, shown: true })
    })

    test('shows at once for a note that fits on the screen', () => {
        expect(barStep(false, view(0, { noteHeight: 200 }), OPEN).shown).toBe(true)
    })

    test('leaves before the footer comes into view', () => {
        // The bottom of the screen at 2,910: one bar above the footer.
        expect(barStep(true, view(2_309), OPEN).shown).toBe(true)
        expect(barStep(true, view(2_310), OPEN)).toEqual({ reached: true, shown: false })
        expect(barStep(true, view(2_600), OPEN).shown).toBe(false)
    })

    test('comes back when the reader goes up from the footer', () => {
        expect(barStep(true, view(1_500), OPEN).shown).toBe(true)
    })

    test('stays while the reader types in it, also near the footer', () => {
        expect(barStep(true, view(2_600), { closed: false, focused: true }).shown).toBe(true)
    })

    test('never shows when it is closed', () => {
        expect(barStep(true, view(1_500), { closed: true, focused: false }).shown).toBe(false)
        expect(barStep(true, view(1_500), { closed: true, focused: true }).shown).toBe(false)
    })
})

/** A storage in memory, as `localStorage` gives it. */
function storage(entries: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(entries))
    return {
        get length() {
            return map.size
        },
        clear: () => {
            map.clear()
        },
        key: (index) => [...map.keys()][index] ?? null,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => map.set(key, value),
        removeItem: (key) => map.delete(key)
    }
}

/** A storage that refuses every use, as a browser that blocks it does. */
const BLOCKED = {
    getItem: () => {
        throw new Error('blocked')
    },
    setItem: () => {
        throw new Error('blocked')
    }
} as unknown as Storage

describe('the memory of the newsletter bar', () => {
    test('is open for a new reader', () => {
        expect(isClosed(storage())).toBe(false)
    })

    test.each(['signed-up', 'dismissed'] as const)('stays closed after the reader %s', (why) => {
        const memory = storage()
        remember(memory, why)
        expect(memory.getItem(NEWSLETTER_KEY)).toBe(why)
        expect(isClosed(memory)).toBe(true)
    })

    // The current site keeps "Don't show this again" in this key, on the same host.
    test('stays closed for a reader who dismissed the bar of the current site', () => {
        expect(isClosed(storage({ [LEGACY_DISMISS_KEY]: 'true' }))).toBe(true)
    })

    test('is open, and breaks nothing, when the storage is blocked', () => {
        expect(isClosed(BLOCKED)).toBe(false)
        expect(() => {
            remember(BLOCKED, 'dismissed')
        }).not.toThrow()
    })
})
