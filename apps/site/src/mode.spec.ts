import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { MODE_KEY, modeOf, modeScript } from './mode.ts'

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
            const page = {
                localStorage: { getItem: (key: string) => (key === MODE_KEY ? stored : null) },
                matchMedia: (query: string) => ({
                    matches: query === '(prefers-color-scheme: light)' && prefersLight
                }),
                document: { documentElement: { dataset } }
            }
            // The script runs with the globals of a page, as in the head.
            runInNewContext(modeScript, page)
            expect(dataset['theme']).toBe(mode)
        }
    )
})
