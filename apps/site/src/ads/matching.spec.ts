import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { FIXTURE_STORE_CATALOG } from '@dsebastien-website/testing'
import { storeCatalogFrom, type Product } from './catalog.ts'
import { adProductsOf, tokensOf, type NoteForAds } from './matching.ts'

// The matching of the ads (AD-01, AD-02, MOD-11): the products of the store
// catalog whose tags meet the topic of a note. The rule of today (research
// 1.7) with the fix of decision R3: a single word of a longer title no longer
// matches a product.

const products = storeCatalogFrom(
    JSON.parse(await readFile(FIXTURE_STORE_CATALOG, 'utf8'))
).products

function note(change: Partial<NoteForAds>): NoteForAds {
    return { title: 'A note', noteType: 'permanent-notes', tags: [], topics: undefined, ...change }
}

function ids(found: readonly Product[]): string[] {
    return found.map((product) => product.id)
}

describe('the tokens of a note', () => {
    test('come from the tags, without the tags of the system, and from the topics', () => {
        const tokens = tokensOf(
            note({
                tags: ['type', 'type/note', 'zone', 'zone/garden', 'topic', 'topic/water'],
                topics: ['[[Rain Garden|rain gardens]]', 'Soil life']
            }),
            {}
        )
        expect([...tokens].sort()).toEqual(
            ['a-note', 'rain-garden', 'rain-gardens', 'soil-life', 'topic', 'water'].sort()
        )
    })

    test('take the whole title and its phrases of two words or more, never one word of it', () => {
        const tokens = tokensOf(note({ title: 'Drip irrigation for a rain barrel' }), {})
        expect(tokens.has('drip-irrigation-for-a-rain-barrel')).toBe(true)
        expect(tokens.has('drip-irrigation')).toBe(true)
        expect(tokens.has('rain-barrel')).toBe(true)
        expect(tokens.has('irrigation')).toBe(false)
        expect(tokens.has('barrel')).toBe(false)
    })

    test('take a title of one word whole', () => {
        expect([...tokensOf(note({ title: 'Zettelkasten' }), {})]).toEqual(['zettelkasten'])
    })

    test('are folded: small letters, no accents, a hyphen between words', () => {
        expect([...tokensOf(note({ title: 'Café  Société!' }), {})]).toEqual(['cafe-societe'])
    })

    test('grow by the alias map', () => {
        const tokens = tokensOf(note({ tags: ['pkm'] }), { pkm: ['knowledge-management'] })
        expect(tokens.has('knowledge-management')).toBe(true)
    })
})

describe('the products of the ad of a note', () => {
    test('a note about a topic of a product gets that product', () => {
        expect(ids(adProductsOf(note({ tags: ['topic', 'topic/water'] }), products))).toEqual([
            // Both match one tag; the density of the match orders them.
            'rain-garden-kit',
            'water-wise-garden'
        ])
    })

    test('more matching tags come first, then the density of the match, then the commercial rank', () => {
        const found = adProductsOf(
            note({ title: 'Drip irrigation', tags: ['topic/water'] }),
            products
        )
        expect(ids(found)).toEqual(['water-wise-garden', 'rain-garden-kit'])
    })

    test('one word of a title no longer matches a product (R3)', () => {
        expect(ids(adProductsOf(note({ title: 'Rain barrel' }), products))).toEqual([])
        expect(ids(adProductsOf(note({ title: 'Drip irrigation' }), products))).toEqual([
            'water-wise-garden'
        ])
    })

    test('a title that is the topic of a product matches it', () => {
        expect(ids(adProductsOf(note({ title: 'Barrel' }), products))).toEqual(['barrel-workshop'])
    })

    test('shows two products at most', () => {
        const found = adProductsOf(note({ tags: ['water', 'barrel'] }), products)
        expect(found).toHaveLength(2)
    })

    test('a note that matches no product gets no ad', () => {
        expect(adProductsOf(note({ tags: ['soil'] }), products)).toEqual([])
    })

    test('person and quote notes get no ad, as today', () => {
        for (const noteType of ['persons', 'quotes', 'own-quotes']) {
            expect(adProductsOf(note({ noteType, tags: ['water'] }), products)).toEqual([])
        }
    })
})
