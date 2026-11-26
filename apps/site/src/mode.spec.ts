import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { BAR_MEDIA, MODE_KEY, modeOf, modeScript, SHOW_MODE } from './mode.ts'

// The mode of a page (MODE-01 of the spec): a stored choice of the reader
// wins, then the mode of the system, and dark when the system states none.
describe('mode of a page', () => {
    test.each([
        ['a stored dark mode wins over a light system', 'dark', true, 'dark'],
        ['a stored light mode wins over a dark system', 'light', false, 'light'],
        ['a light system without a stored choice', null, true, 'light'],
        ['no stored choice and no light system', null, false, 'dark'],
        ['a stored value that is no mode is ignored', 'sepia', true, 'light'],
        ['an empty stored value is ignored', '', false, 'dark']
    ] as const)('%s', (_name, stored, prefersLight, mode) => {
        expect(modeOf(stored, prefersLight)).toBe(mode)
    })

    // The page runs the same function before its first paint.
    test.each([
        ['a stored choice', 'light', false, 'light'],
        ['the system', null, true, 'light'],
        ['the default', null, false, 'dark']
    ] as const)(
        'the script of the page sets the mode from %s',
        (_name, stored, prefersLight, mode) => {
            const dataset: Record<string, string> = {}
            const bars = barsOfThePage()
            const page = {
                localStorage: { getItem: (key: string) => (key === MODE_KEY ? stored : null) },
                matchMedia: (query: string) => ({
                    matches: query === '(prefers-color-scheme: light)' && prefersLight
                }),
                document: fakeDocument(dataset, bars)
            }
            // The script runs with the globals of a page, as in the head.
            runInNewContext(modeScript, page)
            expect(dataset['theme']).toBe(mode)
            expect(bars.map((bar) => bar.media)).toEqual(
                mode === 'dark' ? ['all', 'not all'] : ['not all', 'all']
            )
        }
    )
})

/**
 * A `theme-color` element of the head. Its media query reads the attribute
 * that the page writes; an assignment to `media` changes nothing.
 */
interface Bar {
    readonly media: string
    dataset: Record<string, string>
    setAttribute: (name: string, value: string) => void
}

/** The two `theme-color` elements of the head, with the media query that the page writes. */
function barsOfThePage(): Bar[] {
    return (['dark', 'light'] as const).map((mode) => {
        const attributes: Record<string, string> = { media: BAR_MEDIA[mode] }
        return {
            get media(): string {
                return attributes['media'] ?? ''
            },
            dataset: { mode },
            setAttribute: (name, value) => {
                attributes[name] = value
            }
        }
    })
}

/** A document with the attributes of its root and its `theme-color` elements. */
function fakeDocument(
    dataset: Record<string, string>,
    bars: readonly { media: string }[]
): { documentElement: { dataset: Record<string, string> }; querySelectorAll: () => unknown } {
    return {
        documentElement: { dataset },
        querySelectorAll: () => bars
    }
}

// Issue 133: the bar of the browser takes the color of the mode that the page
// shows, also when the reader chose a mode that is not the one of the system.
describe('color of the bar of the browser', () => {
    test.each(['dark', 'light'] as const)('follows the %s mode', (mode) => {
        const dataset: Record<string, string> = {}
        const bars = barsOfThePage()
        // The text is a function of the page: it runs as the page runs it.
        runInNewContext(`(${SHOW_MODE})(mode, page)`, {
            mode,
            page: fakeDocument(dataset, bars)
        })
        expect(dataset['theme']).toBe(mode)
        expect(bars.find((bar) => bar.dataset['mode'] === mode)?.media).toBe('all')
        expect(bars.find((bar) => bar.dataset['mode'] !== mode)?.media).toBe('not all')
    })

    // Before a script runs: the mode of the system, dark when it states none.
    test('is the color of the mode of the system before a script runs', () => {
        expect(BAR_MEDIA.light).toBe('(prefers-color-scheme: light)')
        expect(BAR_MEDIA.dark).toBe('not all and (prefers-color-scheme: light)')
    })
})
