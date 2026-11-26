import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// The store catalog (`products-light.json`) as the site reads it (CAT-01,
// CAT-02, MOD-12). The store publishes it; this project changes nothing in the
// store (CAT-04, business rule 8). The schema below lists the fields that the
// site reads, and only those: the store may add fields, and may drop a field
// that the site does not read. `storeCatalogFrom()` is the shape test of the
// contract (TEST-04): it fails on any break. Nothing in this project holds a
// copy of a product name or a price as source: the build reads them from the
// catalog.
//
// The build reads the catalog one time (BUILD-06), from the file or the https
// address that `STORE_CATALOG` names, as the current site does: a product with
// a broken `id`, `name`, `href` or `tags` is left out, a broken field that a
// card can do without is dropped, and the other products stay. A catalog that
// cannot be read at all does not stop the build: the build uses the last valid
// copy of the live catalog, for 7 days after it was generated, and else shows
// no product ad. Each reason is a warning. Data that breaks the schema never
// reaches a page.

/** A product of the store catalog: the fields that the site reads. */
export interface Product {
    readonly id: string
    readonly name: string
    readonly shortDescription?: string
    readonly tags: readonly string[]
    readonly mainCategory?: string
    readonly priceTier?: string
    /** The https address of the product in the store. */
    readonly href: string
    readonly badge?: string
    readonly featured: boolean
    readonly bestseller: boolean
    readonly bestValue: boolean
    readonly priority: number
}

/** The store catalog as the build reads it: the products that pass, and every break of the schema. */
export interface ReadStoreCatalog {
    readonly products: readonly Product[]
    /** The time when the store generated the catalog, when it says it. */
    readonly generatedAt?: string
    readonly problems: readonly string[]
}

/** The longest time that the build uses the last valid copy after the store generated it: 7 days. */
export const COPY_MAXIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function productFrom(value: unknown, at: string, problems: string[]): Product | undefined {
    if (!isRecord(value)) {
        problems.push(`${at} is not an object`)
        return undefined
    }
    const before = problems.length
    const required = (key: string): string => {
        const field = value[key]
        if (typeof field !== 'string' || field.trim() === '') {
            problems.push(`${at}.${key} is not a text`)
            return ''
        }
        return field
    }
    const id = required('id')
    const name = required('name')
    const href = required('href')
    if (href !== '' && (!URL.canParse(href) || new URL(href).protocol !== 'https:')) {
        problems.push(`${at}.href is not an https address`)
    }
    const tags = value['tags']
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
        problems.push(`${at}.tags is not a list of texts`)
    }
    const left = problems.length > before
    // The fields that a card can do without: a broken one is dropped.
    const optional = (key: string): Record<string, string> => {
        const field = value[key]
        if (field === undefined || field === null) {
            return {}
        }
        if (typeof field !== 'string') {
            problems.push(`${at}.${key} is not a text`)
            return {}
        }
        return field === '' ? {} : { [key]: field }
    }
    const flag = (key: string): boolean => {
        const field = value[key]
        if (typeof field !== 'boolean') {
            problems.push(`${at}.${key} is not true or false`)
            return false
        }
        return field
    }
    const priority = value['priority']
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
        problems.push(`${at}.priority is not a number`)
    }
    const product: Product = {
        id,
        name,
        ...optional('shortDescription'),
        tags: Array.isArray(tags)
            ? tags.filter((tag): tag is string => typeof tag === 'string')
            : [],
        ...optional('mainCategory'),
        ...optional('priceTier'),
        href,
        ...optional('badge'),
        featured: flag('featured'),
        bestseller: flag('bestseller'),
        bestValue: flag('bestValue'),
        priority: typeof priority === 'number' && Number.isFinite(priority) ? priority : 0
    }
    return left ? undefined : product
}

/**
 * The store catalog of a parsed `products-light.json`, as the build reads it.
 * It throws only when the value has no list of products.
 */
export function readCatalog(value: unknown): ReadStoreCatalog {
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
    const generatedAt = value['generatedAt']
    if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
        problems.push('generatedAt is not a time')
    }
    const products: Product[] = []
    const ids = new Set<string>()
    list.forEach((item: unknown, index) => {
        const at = `products[${String(index)}]`
        const product = productFrom(item, at, problems)
        if (product === undefined) {
            return
        }
        if (ids.has(product.id)) {
            problems.push(`${at}.id "${product.id}" is the id of another product`)
            return
        }
        ids.add(product.id)
        products.push(product)
    })
    return {
        products,
        ...(typeof generatedAt === 'string' ? { generatedAt } : {}),
        problems
    }
}

/**
 * The shape test of the store catalog (CAT-02, TEST-04): the products of a
 * parsed `products-light.json`. It throws with every break of the schema,
 * each with where it is (`products[2].href`).
 */
export function storeCatalogFrom(value: unknown): ReadStoreCatalog {
    const catalog = readCatalog(value)
    if (catalog.problems.length > 0) {
        throw new Error(`the store catalog breaks its schema: ${catalog.problems.join('; ')}`)
    }
    return catalog
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
    /** The address of the live catalog: only its catalog becomes the last valid copy. */
    readonly live: string
    /** The time of the build. */
    readonly now: Date
    readonly fetch?: (address: string, init: { signal: AbortSignal }) => Promise<Response>
}

/** The time limit of the read of the catalog by a build. */
export const FETCH_TIME_LIMIT_MS = 10_000

async function readSource(source: string, fetcher: CatalogSource['fetch']): Promise<string> {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(source) && !/^[a-z]:[\\/]/iu.test(source)) {
        if (!source.startsWith('https://')) {
            throw new Error(`the store catalog must have an https address: ${source}`)
        }
        const signal = AbortSignal.timeout(FETCH_TIME_LIMIT_MS)
        const response = await (fetcher ?? fetch)(source, { signal })
        if (!response.ok) {
            throw new Error(`the store catalog answers ${String(response.status)}`)
        }
        return await response.text()
    }
    return await readFile(source, 'utf8')
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * The store catalog of a build (BUILD-06): the products of the source that
 * pass the schema; else the last valid copy while it is 7 days old at most;
 * else no product. A catalog of the live address with no break becomes the
 * last valid copy.
 */
export async function readStoreCatalog(where: CatalogSource): Promise<ReadCatalog> {
    if (where.source === undefined || where.source === '') {
        return { products: [], warnings: [] }
    }
    const warnings: string[] = []
    try {
        const text = await readSource(where.source, where.fetch)
        const catalog = readCatalog(JSON.parse(text))
        if (catalog.problems.length > 0) {
            warnings.push(
                `the store catalog breaks its schema: ${catalog.problems.join('; ')}`,
                `the build uses the ${String(catalog.products.length)} products that pass it`
            )
        } else if (where.source === where.live) {
            await mkdir(dirname(where.copy), { recursive: true })
            await writeFile(where.copy, text)
        }
        return { products: catalog.products, warnings }
    } catch (error) {
        warnings.push(messageOf(error))
    }
    let copy: ReadStoreCatalog
    try {
        copy = storeCatalogFrom(JSON.parse(await readFile(where.copy, 'utf8')))
    } catch {
        warnings.push('no valid copy of the store catalog exists: the build shows no product ad')
        return { products: [], warnings }
    }
    const age = where.now.getTime() - Date.parse(copy.generatedAt ?? '')
    if (!(age <= COPY_MAXIMUM_AGE_MS)) {
        warnings.push(
            `the last valid copy of the store catalog is older than 7 days (${copy.generatedAt ?? 'no time'}): the build shows no product ad`
        )
        return { products: [], warnings }
    }
    warnings.push(
        `the build uses the last valid copy of the store catalog, of ${copy.generatedAt ?? ''}`
    )
    return { products: copy.products, warnings }
}
