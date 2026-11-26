import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { FIXTURE_STORE_CATALOG } from '@dsebastien-website/testing'
import { storeCatalogFrom, type Product } from './catalog.ts'
import { adProductsOf, hasNoAd, scoreOf, tokenOf, tokensOf, type NoteForAds } from './matching.ts'
import { ALIASES, TITLE_PHRASES } from './vocabulary.ts'

// The matching of the ads (AD-01, AD-02, MOD-11): the rule of the current site
// (`publish.js`, "Product CTAs"), with the fix of decision R3: a single word
// of a title of several words no longer matches a product.

const products = storeCatalogFrom(
    JSON.parse(await readFile(FIXTURE_STORE_CATALOG, 'utf8'))
).products

function note(change: Partial<NoteForAds>): NoteForAds {
    return {
        fileName: 'A note',
        noteType: 'permanent-notes',
        tags: [],
        topics: undefined,
        ...change
    }
}

function product(id: string, tags: string[], change: Partial<Product> = {}): Product {
    return {
        id,
        name: id,
        shortDescription: id,
        tags,
        mainCategory: 'course',
        priceTier: 'standard',
        href: `https://store.example/product/${id}`,
        featured: false,
        bestseller: false,
        bestValue: false,
        priority: 0,
        ...change
    }
}

function ids(found: readonly Product[]): string[] {
    return found.map((item) => item.id)
}

describe('the tokens of a note', () => {
    test('a token is in small letters, with - for _, and only a to z, digits and -', () => {
        expect(tokenOf('Knowledge_Management')).toBe('knowledge-management')
        expect(tokenOf('Café!')).toBe('caf')
    })

    test('come from each level of a tag and the whole tag, without the tags of the system', () => {
        const tokens = tokensOf(note({ tags: ['type/note', 'zone/garden', 'ai/llms'] }), {})
        expect([...tokens].sort()).toEqual(['ai', 'ai-llms', 'llms'])
    })

    test('come from each word of a topic and the whole topic, a wikilink by its target and its text', () => {
        const tokens = tokensOf(
            note({ topics: ['[[Second Brain]]', '[[Rain Garden|gardens]]'] }),
            {}
        )
        expect([...tokens].sort()).toEqual(
            ['brain', 'garden', 'gardens', 'rain', 'rain-garden', 'second', 'second-brain'].sort()
        )
    })

    test('take the phrases of the list that a title holds, never one word of a title of several words', () => {
        const tokens = tokensOf(note({ fileName: 'Personal knowledge management at work' }), {})
        expect(tokens.has('personal-knowledge-management')).toBe(true)
        expect(tokens.has('knowledge-management')).toBe(true)
        expect(tokens.has('work')).toBe(false)
        expect(tokens.has('personal')).toBe(false)
    })

    test('take a title of one word whole', () => {
        expect([...tokensOf(note({ fileName: 'Zettelkasten' }), {})]).toEqual(['zettelkasten'])
    })

    test('grow by the alias map, one step', () => {
        const tokens = tokensOf(note({ tags: ['pkm'] }))
        expect(tokens.has('knowledge-management')).toBe(true)
        expect(tokensOf(note({ tags: ['llm'] })).has('llms')).toBe(true)
    })

    test('the alias map and the phrase list are the ones of today', () => {
        expect(Object.keys(ALIASES)).toHaveLength(73)
        expect(ALIASES['time']).toEqual(['time-management'])
        expect(TITLE_PHRASES).toHaveLength(23)
        expect(TITLE_PHRASES).toContain('johnny decimal')
    })
})

describe('the score of a product', () => {
    test('10,000 per matching tag, 2,000 times the share, a fifth of the commercial rank', () => {
        const tokens = new Set(['water'])
        const byId = (id: string): Product => {
            const found = products.find((item) => item.id === id)
            if (found === undefined) {
                throw new Error(`no product ${id}`)
            }
            return found
        }
        expect(scoreOf(byId('water-wise-garden'), tokens)).toBe(10000 + 667 + 2)
        expect(scoreOf(byId('rain-garden-kit'), tokens)).toBe(10000 + 1000 + 0)
        expect(scoreOf(byId('barrel-workshop'), tokens)).toBe(0)
        // Best value 500, bestseller 250, featured 100, priority 90.
        expect(scoreOf(byId('barrel-workshop'), new Set(['barrel']))).toBe(10000 + 1000 + 188)
    })
})

describe('the products of the ad of a note', () => {
    test('a note about a topic of a product gets that product, the best scores first', () => {
        expect(ids(adProductsOf(note({ tags: ['topic/water'] }), products))).toEqual([
            'rain-garden-kit',
            'water-wise-garden'
        ])
    })

    test('two equal scores keep the order of the catalog', () => {
        const pair = [product('second', ['water']), product('first', ['water'])]
        expect(ids(adProductsOf(note({ tags: ['water'] }), pair))).toEqual(['second', 'first'])
    })

    test('one word of a title no longer matches a product (R3)', () => {
        const time = [product('time-course', ['time-management'])]
        expect(ids(adProductsOf(note({ fileName: 'Spare time' }), time))).toEqual([])
        expect(ids(adProductsOf(note({ fileName: 'Rain barrel' }), products))).toEqual([])
    })

    test('a title of one word, and a phrase of the list in a title, still match', () => {
        const time = [product('time-course', ['time-management'])]
        expect(ids(adProductsOf(note({ fileName: 'Time' }), time))).toEqual(['time-course'])
        expect(ids(adProductsOf(note({ fileName: 'On time management' }), time))).toEqual([
            'time-course'
        ])
        expect(ids(adProductsOf(note({ fileName: 'Barrel' }), products))).toEqual([
            'barrel-workshop'
        ])
    })

    test('shows two products at most', () => {
        expect(ids(adProductsOf(note({ tags: ['water', 'barrel'] }), products))).toEqual([
            'barrel-workshop',
            'rain-garden-kit'
        ])
    })

    test('a note that matches no product gets no ad', () => {
        expect(adProductsOf(note({ tags: ['soil'] }), products)).toEqual([])
    })

    test('person and quote notes get no ad, by their type or by a type tag, as today', () => {
        for (const noteType of ['persons', 'quotes']) {
            expect(adProductsOf(note({ noteType, tags: ['water'] }), products)).toEqual([])
        }
        for (const tag of ['type/person', 'type/quote', 'Type/Quotes']) {
            expect(hasNoAd(note({ noteType: 'permanent-notes', tags: [tag, 'water'] }))).toBe(true)
        }
        expect(hasNoAd(note({ tags: ['type/note', 'person'] }))).toBe(false)
    })
})
