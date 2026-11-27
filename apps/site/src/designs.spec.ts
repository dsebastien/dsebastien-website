import { describe, expect, test } from 'bun:test'
import { DEFAULT_DESIGN, DESIGNS, designOf, designScript } from './designs.ts'

describe('designOf', () => {
    test('takes the variant of the query first, then the stored one', () => {
        expect(designOf('marker', 'aurora')).toBe('marker')
        expect(designOf(null, 'aurora')).toBe('aurora')
    })

    test('ignores an unknown name', () => {
        expect(designOf('nope', 'signal')).toBe('signal')
        expect(designOf('nope', 'other')).toBe(DEFAULT_DESIGN)
        expect(designOf(null, null)).toBe(DEFAULT_DESIGN)
    })

    test('starts with the look of today', () => {
        expect<string>(DESIGNS[0].name).toBe(DEFAULT_DESIGN)
    })

    test('the script of the head knows every variant', () => {
        for (const design of DESIGNS) {
            expect(designScript).toContain(`"${design.name}"`)
        }
    })
})
