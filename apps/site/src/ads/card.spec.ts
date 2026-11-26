import { describe, expect, test } from 'bun:test'
import type { Product } from './catalog.ts'
import { kickerOf, titleCase } from './card.ts'

function product(priceTier?: string, mainCategory?: string): Product {
    return {
        id: 'p',
        name: 'P',
        shortDescription: 'P',
        tags: [],
        ...(mainCategory === undefined ? {} : { mainCategory }),
        ...(priceTier === undefined ? {} : { priceTier }),
        href: 'https://store.example/product/p',
        featured: false,
        bestseller: false,
        bestValue: false,
        priority: 0
    }
}

describe('the text of an ad card, as today', () => {
    test('the badge is in title case', () => {
        expect(titleCase('best-value')).toBe('Best Value')
    })

    test('the kicker gives the label of the tier and the category', () => {
        expect(kickerOf(product('subscription', 'community'))).toBe('Membership · Community')
        expect(kickerOf(product('standard', 'online_course'))).toBe('Online Course')
        expect(kickerOf(product('unknown', 'templates'))).toBe('Templates')
        expect(kickerOf(product())).toBe('')
    })
})
