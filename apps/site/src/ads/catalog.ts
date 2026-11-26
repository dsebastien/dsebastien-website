import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// The store catalog (`products-light.json`) as the site reads it (CAT-01,
// CAT-02, MOD-12). The store publishes it; this project changes nothing in the
// store (CAT-04, business rule 8). The schema below lists the fields that the
// site reads, and only those: the store may add fields, and may drop a field
// that the site does not read. `storeCatalogFrom()` is the shape test of the
// contract (TEST-04). Nothing in this project holds a copy of a product name
// or a price as source: the build reads them from the catalog.
//
// The build reads the catalog one time (BUILD-06), from the file or the
// address that `STORE_CATALOG` names. A catalog that cannot be read or that
// breaks the schema does not stop the build: the build uses the last valid
// copy, and with no valid copy it shows no product ad. Data that breaks the
// schema never reaches a page.

/** A product of the store catalog: the fields that the site reads. */
export interface Product {
    readonly id: string
    readonly name: string
    readonly shortDescription: string
    readonly tags: readonly string[]
    readonly mainCategory: string
    readonly priceTier: string
    /** The address of the product in the store. */
    readonly href: string
    readonly badge?: string
    readonly featured: boolean
    readonly bestseller: boolean
    readonly bestValue: boolean
    readonly priority: number
}

/** The store catalog, validated. */
export interface StoreCatalog {
    readonly products: readonly Product[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function productFrom(value: unknown, at: string, problems: string[]): Product | undefined {
    if (!isRecord(value)) {
        problems.push(`${at} is not an object`)
        return undefined
    }
    const text = (key: string): string => {
        const field = value[key]
        if (typeof field !== 'string' || field.trim() === '') {
            problems.push(`${at}.${key} is not a text`)
            return ''
        }
        return field
    }
    const flag = (key: string): boolean => {
        const field = value[key]
        if (typeof field !== 'boolean') {
            problems.push(`${at}.${key} is not true or false`)
            return false
        }
        return field
    }
    const tags = value['tags']
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
        problems.push(`${at}.tags is not a list of texts`)
    }
    const href = text('href')
    if (href !== '' && !URL.canParse(href)) {
        problems.push(`${at}.href is not an address`)
    } else if (href !== '' && new URL(href).protocol !== 'https:') {
        problems.push(`${at}.href is not an https address`)
    }
    const badge = value['badge']
    if (badge !== undefined && badge !== null && typeof badge !== 'string') {
        problems.push(`${at}.badge is not a text`)
    }
    const priority = value['priority']
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
        problems.push(`${at}.priority is not a number`)
    }
    const product: Product = {
        id: text('id'),
        name: text('name'),
        shortDescription: text('shortDescription'),
        tags: Array.isArray(tags)
            ? tags.filter((tag): tag is string => typeof tag === 'string')
            : [],
        mainCategory: text('mainCategory'),
        priceTier: text('priceTier'),
        href,
        ...(typeof badge === 'string' && badge !== '' ? { badge } : {}),
        featured: flag('featured'),
        bestseller: flag('bestseller'),
        bestValue: flag('bestValue'),
        priority: typeof priority === 'number' ? priority : 0
    }
    return product
}

/**
 * The store catalog of a parsed `products-light.json`. It throws with every
 * break of the schema, each with where it is (`products[2].href`).
 */
export function storeCatalogFrom(value: unknown): StoreCatalog {
    if (!isRecord(value)) {
        throw new Error('the store catalog is not an object')
    }
    const list = value['products']
    if (!Array.isArray(list)) {
        throw new Error('the store catalog has no list of products')
    }
    const problems: string[] = []
    const count = value['count']
    if (count !== undefined && count !== list.length) {
        problems.push(
            `count is ${JSON.stringify(count)}, and the catalog has ${String(list.length)} products`
        )
    }
    const products: Product[] = []
    const ids = new Set<string>()
    list.forEach((item: unknown, index) => {
        const at = `products[${String(index)}]`
        const product = productFrom(item, at, problems)
        if (product !== undefined) {
            if (ids.has(product.id)) {
                problems.push(`${at}.id "${product.id}" is the id of another product`)
            }
            ids.add(product.id)
            products.push(product)
        }
    })
    if (problems.length > 0) {
        throw new Error(`the store catalog breaks its schema: ${problems.join('; ')}`)
    }
    return { products }
}

/** What the build reads: the products, and what it must report. */
export interface ReadCatalog {
    readonly products: readonly Product[]
    readonly warnings: readonly string[]
}

/** Where the build reads the catalog. */
export interface CatalogSource {
    /** A file or an https address, or `undefined` when the build names no catalog. */
    readonly source: string | undefined
    /** The file of the last valid copy. */
    readonly copy: string
    readonly fetch?: (address: string) => Promise<Response>
}

async function readSource(source: string, fetcher: CatalogSource['fetch']): Promise<string> {
    if (/^https?:\/\//u.test(source)) {
        const response = await (fetcher ?? fetch)(source)
        if (!response.ok) {
            throw new Error(`the store catalog answers ${String(response.status)}`)
        }
        return await response.text()
    }
    return await readFile(source, 'utf8')
}

/**
 * The store catalog of a build (BUILD-06): the catalog of the source, kept as
 * the last valid copy; else the last valid copy, with a warning; else no
 * product, with a warning.
 */
export async function readStoreCatalog(where: CatalogSource): Promise<ReadCatalog> {
    if (where.source === undefined || where.source === '') {
        return { products: [], warnings: [] }
    }
    const warnings: string[] = []
    try {
        const text = await readSource(where.source, where.fetch)
        const catalog = storeCatalogFrom(JSON.parse(text))
        await mkdir(dirname(where.copy), { recursive: true })
        await writeFile(where.copy, text)
        return { products: catalog.products, warnings }
    } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error))
    }
    try {
        const catalog = storeCatalogFrom(JSON.parse(await readFile(where.copy, 'utf8')))
        warnings.push('the build uses the last valid copy of the store catalog')
        return { products: catalog.products, warnings }
    } catch {
        warnings.push('no valid copy of the store catalog exists: the build shows no product ad')
        return { products: [], warnings }
    }
}
