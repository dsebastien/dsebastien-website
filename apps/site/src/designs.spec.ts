import { describe, expect, test } from 'bun:test'
import { DEFAULT_DESIGN, DESIGNS, designOf, designScript } from './designs.ts'

describe('designOf', () => {
    test('takes the theme of the query first, then the stored one', () => {
        expect(designOf('signal', 'aurora')).toBe('signal')
        expect(designOf('aurora', 'signal')).toBe('aurora')
        expect(designOf(null, 'signal')).toBe('signal')
    })

    test('ignores an unknown name', () => {
        expect(designOf('nope', 'signal')).toBe('signal')
        expect(designOf('nope', 'other')).toBe(DEFAULT_DESIGN)
        expect(designOf(null, null)).toBe(DEFAULT_DESIGN)
    })

    // R107: the themes of the prototype of issue 116 are gone.
    test('shows Aurora for a stored or asked name of a removed theme', () => {
        expect(DEFAULT_DESIGN).toBe('aurora')
        for (const removed of ['knowii', 'marker']) {
            expect(designOf(removed, null)).toBe('aurora')
            expect(designOf(null, removed)).toBe('aurora')
            expect(designScript).not.toContain(`"${removed}"`)
        }
    })

    test('offers Aurora first, then Signal', () => {
        expect(DESIGNS.map((design) => design.name)).toEqual(['aurora', 'signal'])
    })

    test('the script of the head knows every theme', () => {
        for (const design of DESIGNS) {
            expect(designScript).toContain(`"${design.name}"`)
        }
    })
})
