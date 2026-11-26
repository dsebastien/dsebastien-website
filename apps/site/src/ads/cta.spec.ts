import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { ctaAttributes, ctaScript } from './cta.ts'

// The click of an ad sends `cta_clicked` with its five properties (AN-02).

type Listener = (event: Record<string, unknown>) => void

function page(plausible?: (...args: unknown[]) => void): {
    click: (target: unknown) => void
    window: Record<string, unknown>
} {
    const listeners: Listener[] = []
    const window: Record<string, unknown> = {
        addEventListener: (name: string, listener: Listener, capture: boolean) => {
            expect(name).toBe('click')
            expect(capture).toBe(true)
            listeners.push(listener)
        },
        ...(plausible === undefined ? {} : { plausible })
    }
    window['window'] = window
    runInNewContext(ctaScript, window)
    return {
        window,
        click: (target) => {
            for (const listener of listeners) {
                listener({ target })
            }
        }
    }
}

/** A link of an ad, with the data attributes of the build, as the DOM gives them. */
function adLink(): unknown {
    const attributes = ctaAttributes('water-wise-garden', 'end', 1, '10 Garden/Drip irrigation.md')
    const dataset = {
        ctaProduct: attributes['data-cta-product'],
        ctaPosition: attributes['data-cta-position'],
        ctaSlot: attributes['data-cta-slot'],
        ctaPage: attributes['data-cta-page']
    }
    const link = { dataset, href: 'https://store.example/product/water-wise-garden' }
    return {
        closest: (selector: string) => (selector === 'a[data-cta-position]' ? link : null)
    }
}

describe('the click of an ad', () => {
    test('sends cta_clicked with its five properties', () => {
        const sent: unknown[][] = []
        page((...args) => sent.push(args)).click(adLink())
        expect(sent).toEqual([
            [
                'cta_clicked',
                {
                    props: {
                        product: 'water-wise-garden',
                        position: 'end',
                        slot: '1',
                        page: '10 Garden/Drip irrigation.md',
                        href: 'https://store.example/product/water-wise-garden'
                    }
                }
            ]
        ])
    })

    test('sends nothing for another click', () => {
        const sent: unknown[][] = []
        const reader = page((...args) => sent.push(args))
        reader.click({ closest: () => null })
        reader.click(undefined)
        expect(sent).toEqual([])
    })

    // As the current site does (`publish.js`): the analytics script sends the queue when it loads.
    test('queues the event when the analytics script is not loaded yet', () => {
        const reader = page()
        reader.click(adLink())
        const plausible = reader.window['plausible'] as { q?: ArrayLike<unknown>[] }
        expect(plausible.q?.map((args) => Array.from(args))).toEqual([
            [
                'cta_clicked',
                {
                    props: {
                        product: 'water-wise-garden',
                        position: 'end',
                        slot: '1',
                        page: '10 Garden/Drip irrigation.md',
                        href: 'https://store.example/product/water-wise-garden'
                    }
                }
            ]
        ])
    })

    test('never breaks the click: without the analytics call, or when it fails', () => {
        expect(() => {
            page().click(adLink())
        }).not.toThrow()
        expect(() => {
            page(() => {
                throw new Error('blocked')
            }).click(adLink())
        }).not.toThrow()
    })
})
