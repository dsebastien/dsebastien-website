import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { PROPERTIES_KEY, propertiesScript } from './properties-panel.ts'

// The script of the properties panel (issue 48, R59): the panel is a `details`
// element that works with no script. It keeps no state: the script removes
// the choice that an older version stored, and the key `p` opens and closes
// the panel.

type Listener = (event: Record<string, unknown>) => void

/**
 * A page with a panel, as the script sees it.
 *
 * @param stored the stored choice of the reader, or `null` when there is none
 * @param refused true when the browser refuses the storage
 */
function page(
    stored: string | null,
    refused = false
): {
    panel: { open: boolean; scrolled: number }
    storage: Map<string, string>
    press: (event: Record<string, unknown>) => void
    toggle: () => void
    restore: (persisted: boolean) => void
} {
    const storage = new Map<string, string>(stored === null ? [] : [[PROPERTIES_KEY, stored]])
    const listeners = new Map<string, Listener>()
    const panelListeners = new Map<string, Listener>()
    const panel = {
        open: false,
        scrolled: 0,
        addEventListener: (name: string, listener: Listener) => panelListeners.set(name, listener),
        scrollIntoView: () => {
            panel.scrolled += 1
        }
    }
    const refuse = (): never => {
        throw new Error('the storage is refused')
    }
    runInNewContext(propertiesScript, {
        document: {
            querySelector: (selector: string) => (selector === '[data-properties]' ? panel : null)
        },
        localStorage: refused
            ? { getItem: refuse, setItem: refuse, removeItem: refuse }
            : {
                  getItem: (key: string) => storage.get(key) ?? null,
                  setItem: (key: string, value: string) => storage.set(key, value),
                  removeItem: (key: string) => storage.delete(key)
              },
        addEventListener: (name: string, listener: Listener) => listeners.set(name, listener)
    })
    return {
        panel,
        storage,
        press: (event) => listeners.get('keydown')?.({ key: 'p', ...event }),
        toggle: () => panelListeners.get('toggle')?.({}),
        restore: (persisted) => listeners.get('pageshow')?.({ persisted })
    }
}

describe('script of the properties panel', () => {
    test('leaves the panel closed, also for a reader who left it open with an older version', () => {
        expect(page(null).panel.open).toBe(false)
        expect(page('closed').panel.open).toBe(false)
        expect(page('open').panel.open).toBe(false)
    })

    test('removes the choice that an older version stored', () => {
        expect(page('open').storage.has(PROPERTIES_KEY)).toBe(false)
        expect(page('closed').storage.has(PROPERTIES_KEY)).toBe(false)
    })

    test('stores nothing when the reader opens or closes the panel', () => {
        const { panel, storage, toggle } = page(null)

        panel.open = true
        toggle()
        panel.open = false
        toggle()
        expect(storage.size).toBe(0)
    })

    test('closes a panel that the back and forward cache restores open', () => {
        const { panel, restore } = page(null)

        panel.open = true
        restore(false)
        expect(panel.open).toBe(true)
        restore(true)
        expect(panel.open).toBe(false)
    })

    test('the key `p` opens the panel and brings it into view, and closes it again', () => {
        const { panel, press } = page(null)

        press({})
        expect(panel.open).toBe(true)
        expect(panel.scrolled).toBe(1)
        press({})
        expect(panel.open).toBe(false)
        expect(panel.scrolled).toBe(1)
    })

    test('the key does nothing in a field, with a modifier key, or when it is held down', () => {
        const { panel, press } = page(null)
        const field = { closest: (selector: string) => (selector.includes('input') ? {} : null) }

        press({ target: field })
        press({ ctrlKey: true })
        press({ metaKey: true })
        press({ altKey: true })
        press({ repeat: true })
        press({ defaultPrevented: true })
        press({ key: 'P', shiftKey: true })
        press({ key: 'q' })

        expect(panel.open).toBe(false)
    })

    test('the key works on an element that is no field', () => {
        const { panel, press } = page(null)

        press({ target: { closest: () => null } })

        expect(panel.open).toBe(true)
    })

    test('works when the browser refuses the storage', () => {
        const { panel, press, toggle } = page(null, true)

        press({})
        toggle()

        expect(panel.open).toBe(true)
    })
})
