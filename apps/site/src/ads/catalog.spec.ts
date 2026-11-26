import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_STORE_CATALOG } from '@dsebastien-website/testing'
import { readStoreCatalog, storeCatalogFrom } from './catalog.ts'

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

describe('the reading of the store catalog by the build (BUILD-06)', () => {
    let folder = ''
    beforeEach(async () => {
        folder = await mkdtemp(join(tmpdir(), 'store-catalog-'))
    })
    afterEach(async () => {
        await rm(folder, { recursive: true, force: true })
    })

    test('reads no catalog when the build names none', async () => {
        const read = await readStoreCatalog({ source: undefined, copy: join(folder, 'copy.json') })
        expect(read).toEqual({ products: [], warnings: [] })
    })

    test('reads a file, and keeps it as the last valid copy', async () => {
        const copy = join(folder, 'copy.json')
        const read = await readStoreCatalog({ source: FIXTURE_STORE_CATALOG, copy })
        expect(read.products).toHaveLength(3)
        expect(read.warnings).toEqual([])
        expect(storeCatalogFrom(JSON.parse(await readFile(copy, 'utf8'))).products).toHaveLength(3)
    })

    test('reads an address with one request', async () => {
        const asked: string[] = []
        const body = await readFile(FIXTURE_STORE_CATALOG, 'utf8')
        const read = await readStoreCatalog({
            source: 'https://store.example/products-light.json',
            copy: join(folder, 'copy.json'),
            fetch: (address) => {
                asked.push(address)
                return Promise.resolve(new Response(body))
            }
        })
        expect(asked).toEqual(['https://store.example/products-light.json'])
        expect(read.products).toHaveLength(3)
    })

    test('uses the last valid copy when the catalog breaks the schema, and says so', async () => {
        const copy = join(folder, 'copy.json')
        await readStoreCatalog({ source: FIXTURE_STORE_CATALOG, copy })
        const broken = join(folder, 'broken.json')
        await writeFile(broken, JSON.stringify(await withFirstProduct((p) => delete p['href'])))
        const read = await readStoreCatalog({ source: broken, copy })
        expect(read.products).toHaveLength(3)
        expect(read.warnings).toEqual([
            expect.stringContaining('products[0].href') as unknown as string,
            'the build uses the last valid copy of the store catalog'
        ])
        // The broken catalog never replaces the valid copy.
        expect(storeCatalogFrom(JSON.parse(await readFile(copy, 'utf8'))).products).toHaveLength(3)
    })

    test('shows no product ad when the catalog cannot be read and no valid copy exists', async () => {
        const read = await readStoreCatalog({
            source: 'https://store.example/products-light.json',
            copy: join(folder, 'copy.json'),
            fetch: () => Promise.resolve(new Response('down', { status: 503 }))
        })
        expect(read.products).toEqual([])
        expect(read.warnings).toEqual([
            expect.stringContaining('503') as unknown as string,
            'no valid copy of the store catalog exists: the build shows no product ad'
        ])
    })
})
