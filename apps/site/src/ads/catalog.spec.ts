import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_STORE_CATALOG } from '@dsebastien-website/testing'
import { readCatalog, readStoreCatalog, storeCatalogFrom, type CatalogSource } from './catalog.ts'

// The store catalog is a contract (CAT-02, business rule 8): the schema of the
// fields that the site reads. The shape test (TEST-04, SEAM-06) runs it on the
// recorded copy, and it blocks a release, as every test does.

async function recorded(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(FIXTURE_STORE_CATALOG, 'utf8')) as Record<string, unknown>
}

/** The recorded catalog with one change to its first product. */
async function withFirstProduct(
    change: (product: Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
    const catalog = await recorded()
    const products = catalog['products'] as Record<string, unknown>[]
    const first = products[0]
    if (first === undefined) {
        throw new Error('the recorded catalog has no product')
    }
    change(first)
    return catalog
}

describe('the shape of the store catalog (TEST-04)', () => {
    test('the recorded catalog matches the schema', async () => {
        const catalog = storeCatalogFrom(await recorded())
        expect(catalog.products.map((product) => product.id)).toEqual([
            'water-wise-garden',
            'barrel-workshop',
            'rain-garden-kit'
        ])
        expect(catalog.products[0]).toEqual({
            id: 'water-wise-garden',
            name: 'Water-Wise Garden Course',
            shortDescription: 'Water less and grow more',
            tags: ['water', 'irrigation', 'drip-irrigation'],
            mainCategory: 'course',
            priceTier: 'paid',
            href: 'https://store.example/product/water-wise-garden',
            badge: 'new',
            featured: false,
            bestseller: false,
            bestValue: false,
            priority: 10
        })
    })

    test('a field that the site does not read may be added or removed', async () => {
        const catalog = await withFirstProduct((product) => {
            product['newField'] = { any: 'thing' }
            delete product['image']
            delete product['pricing']
        })
        expect(storeCatalogFrom(catalog).products).toHaveLength(3)
    })

    test('a product without a badge has none', async () => {
        const catalog = await withFirstProduct((product) => {
            product['badge'] = null
        })
        expect(storeCatalogFrom(catalog).products[0]?.badge).toBeUndefined()
    })

    const breaks: [string, (product: Record<string, unknown>) => void, string][] = [
        ['a missing name', (product) => delete product['name'], 'products[0].name'],
        ['a number as id', (product) => (product['id'] = 3), 'products[0].id'],
        ['tags that are no list', (product) => (product['tags'] = 'water'), 'products[0].tags'],
        [
            'a tag that is no text',
            (product) => (product['tags'] = ['water', 4]),
            'products[0].tags'
        ],
        [
            'an address that is not https',
            (product) => (product['href'] = 'http://store.example/p'),
            'products[0].href'
        ],
        [
            'a flag that is a text',
            (product) => (product['featured'] = 'yes'),
            'products[0].featured'
        ],
        [
            'a priority that is a text',
            (product) => (product['priority'] = 'high'),
            'products[0].priority'
        ],
        ['a badge that is a number', (product) => (product['badge'] = 1), 'products[0].badge']
    ]
    for (const [name, change, where] of breaks) {
        test(`fails on ${name}`, async () => {
            const catalog = await withFirstProduct(change)
            expect(() => storeCatalogFrom(catalog)).toThrow(where)
        })
    }

    test('fails on a catalog without products, on a wrong count and on a repeated id', async () => {
        expect(() => storeCatalogFrom({ count: 0 })).toThrow('products')
        expect(() => storeCatalogFrom([])).toThrow('the store catalog is not an object')
        const counted = await recorded()
        counted['count'] = 2
        expect(() => storeCatalogFrom(counted)).toThrow('count')
        const repeated = await withFirstProduct((product) => (product['id'] = 'barrel-workshop'))
        expect(() => storeCatalogFrom(repeated)).toThrow('products[1].id')
    })
})

describe('the catalog as the build reads it, as the current site does', () => {
    test('leaves out a product with a broken id, name, address or tags, and keeps the others', async () => {
        const catalog = readCatalog(
            await withFirstProduct((product) => (product['href'] = 'javascript:alert(1)'))
        )
        expect(catalog.products.map((product) => product.id)).toEqual([
            'barrel-workshop',
            'rain-garden-kit'
        ])
        expect(catalog.problems).toEqual(['products[0].href is not an https address'])
    })

    test('keeps a product without a short description, a price tier or a category', async () => {
        const catalog = readCatalog(
            await withFirstProduct((product) => {
                delete product['shortDescription']
                delete product['priceTier']
                product['mainCategory'] = 3
            })
        )
        expect(catalog.products[0]?.id).toBe('water-wise-garden')
        expect(catalog.products[0]?.shortDescription).toBeUndefined()
        expect(catalog.products[0]?.priceTier).toBeUndefined()
        expect(catalog.products[0]?.mainCategory).toBeUndefined()
        expect(catalog.problems).toEqual(['products[0].mainCategory is not a text'])
    })
})

describe('the reading of the store catalog by the build (BUILD-06)', () => {
    const LIVE = 'https://store.example/products-light.json'
    // Two days after the recorded catalog was generated.
    const NOW = new Date('2031-03-03T06:00:00Z')
    let folder = ''
    beforeEach(async () => {
        folder = await mkdtemp(join(tmpdir(), 'store-catalog-'))
    })
    afterEach(async () => {
        await rm(folder, { recursive: true, force: true })
    })

    function where(change: Partial<CatalogSource>): CatalogSource {
        return { source: LIVE, copy: join(folder, 'copy.json'), live: LIVE, now: NOW, ...change }
    }

    function serve(body: string): NonNullable<CatalogSource['fetch']> {
        return () => Promise.resolve(new Response(body))
    }

    async function keepCopy(): Promise<void> {
        const body = await readFile(FIXTURE_STORE_CATALOG, 'utf8')
        await readStoreCatalog(where({ fetch: serve(body) }))
    }

    test('reads no catalog when the build names none', async () => {
        expect(await readStoreCatalog(where({ source: undefined }))).toEqual({
            products: [],
            warnings: []
        })
    })

    test('reads a file, and never keeps it as the last valid copy', async () => {
        const read = await readStoreCatalog(where({ source: FIXTURE_STORE_CATALOG }))
        expect(read.products).toHaveLength(3)
        expect(read.warnings).toEqual([])
        expect(await readFile(join(folder, 'copy.json'), 'utf8').catch(() => 'none')).toBe('none')
    })

    test('reads the live address with one request and a time limit, and keeps its copy', async () => {
        const asked: string[] = []
        const body = await readFile(FIXTURE_STORE_CATALOG, 'utf8')
        const read = await readStoreCatalog(
            where({
                fetch: (address, init) => {
                    asked.push(address)
                    expect(init.signal).toBeInstanceOf(AbortSignal)
                    return Promise.resolve(new Response(body))
                }
            })
        )
        expect(asked).toEqual([LIVE])
        expect(read.products).toHaveLength(3)
        expect(await readFile(join(folder, 'copy.json'), 'utf8')).toBe(body)
    })

    test('refuses an address that is not https', async () => {
        const read = await readStoreCatalog(
            where({ source: 'http://store.example/products-light.json' })
        )
        expect(read.products).toEqual([])
        expect(read.warnings[0]).toContain('must have an https address')
    })

    test('uses the products that pass, says why, and keeps no copy of a broken catalog', async () => {
        const broken = JSON.stringify(await withFirstProduct((p) => delete p['href']))
        const read = await readStoreCatalog(where({ fetch: serve(broken) }))
        expect(read.products.map((product) => product.id)).toEqual([
            'barrel-workshop',
            'rain-garden-kit'
        ])
        expect(read.warnings).toEqual([
            'the store catalog breaks its schema: products[0].href is not a text',
            'the build uses the 2 products that pass it'
        ])
        expect(await readFile(join(folder, 'copy.json'), 'utf8').catch(() => 'none')).toBe('none')
    })

    test('uses the last valid copy when the catalog cannot be read, and says so', async () => {
        await keepCopy()
        const read = await readStoreCatalog(where({ fetch: serve('<html>') }))
        expect(read.products).toHaveLength(3)
        expect(read.warnings[1]).toBe(
            'the build uses the last valid copy of the store catalog, of 2031-03-01T06:00:00.000Z'
        )
    })

    test('shows no product ad when the last valid copy is older than 7 days', async () => {
        await keepCopy()
        const read = await readStoreCatalog(
            where({
                now: new Date('2031-03-08T06:00:01Z'),
                fetch: () => Promise.resolve(new Response('down', { status: 503 }))
            })
        )
        expect(read.products).toEqual([])
        expect(read.warnings).toEqual([
            'the store catalog answers 503',
            'the last valid copy of the store catalog is older than 7 days (2031-03-01T06:00:00.000Z): the build shows no product ad'
        ])
    })

    test('shows no product ad when the catalog cannot be read and no valid copy exists', async () => {
        const read = await readStoreCatalog(
            where({ fetch: () => Promise.resolve(new Response('down', { status: 503 })) })
        )
        expect(read.products).toEqual([])
        expect(read.warnings).toEqual([
            'the store catalog answers 503',
            'no valid copy of the store catalog exists: the build shows no product ad'
        ])
    })
})
