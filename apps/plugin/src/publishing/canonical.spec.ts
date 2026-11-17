import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { toCanonicalJson, type CanonicalValue } from './canonical.ts'
import { compareCodePoints } from './order.ts'
import { makePlan } from './plan.ts'

// The canonical form (documentation/Canonical Form.md) is what the parity rule
// compares. The Rust implementation reads the same cases
// (`cli/src/canonical.rs`), so both must give the text that the file states.
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/cases.json', import.meta.url))

interface Cases {
    cases: { name: string; value: CanonicalValue; canonical: string }[]
    refused: { name: string; value: CanonicalValue }[]
    order: { paths: string[]; sorted: string[] }
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const { cases, refused, order } = (await Bun.file(CASES).json()) as Cases

describe('canonical form of data', () => {
    test.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(toCanonicalJson(entry.value)).toBe(entry.canonical)
    })

    test('has cases', () => {
        expect(cases.length).toBeGreaterThan(5)
    })
})

describe('canonical form of data, for values that only TypeScript can hold', () => {
    // Rust has no negative zero in a whole number.
    test('negative zero is written as zero', () => {
        expect(toCanonicalJson(-0)).toBe('0\n')
    })

    test('a key that is a symbol, and a member that is not listed, are not data', () => {
        const value = Object.defineProperty({ a: 1, [Symbol('b')]: 2 }, 'c', {
            value: 3,
            enumerable: false
        })
        expect(toCanonicalJson(value)).toBe('{\n  "a": 1\n}\n')
    })
})

describe('order of paths', () => {
    // The default sort of TypeScript compares UTF-16 units, and it puts a
    // character above U+FFFF before the characters U+E000 to U+FFFF.
    test('follows the code points of the whole path', () => {
        expect([...order.paths].sort(compareCodePoints)).toEqual(order.sorted)
    })

    test('differs from the default sort for the shared case', () => {
        expect([...order.paths].sort()).not.toEqual(order.sorted)
    })

    test('says when two paths are the same, and which one is a start of the other', () => {
        expect(compareCodePoints('a.md', 'a.md')).toBe(0)
        expect(compareCodePoints('a', 'a.md')).toBeLessThan(0)
        expect(compareCodePoints('a.md', 'a')).toBeGreaterThan(0)
    })
})

describe('the document of the canonical form', () => {
    // A formatter can change the example without a word.
    test('shows the empty plan exactly as it is written', async () => {
        const document = fileURLToPath(
            new URL('../../../../documentation/Canonical Form.md', import.meta.url)
        )
        const text = await Bun.file(document).text()
        expect(text).toContain(
            `\n\`\`\`json\n${toCanonicalJson(makePlan({ publish: [], update: [], remove: [] }))}\`\`\`\n`
        )
    })
})

describe('values that have no canonical form', () => {
    test.each(refused.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(() => toCanonicalJson(entry.value)).toThrow()
    })

    test('the shared file has such values', () => {
        expect(refused.length).toBeGreaterThanOrEqual(10)
    })

    // `map` skips a hole, and the list would be written with nothing between two commas.
    test('a list with a hole', () => {
        // eslint-disable-next-line no-sparse-arrays -- the hole is the case
        const holes: unknown = [1, , 3]
        expect(() => toCanonicalJson(holes as CanonicalValue)).toThrow()
        expect(() => toCanonicalJson(new Array(3) as CanonicalValue)).toThrow()
    })

    test('a value that holds itself', () => {
        const value: Record<string, unknown> = {}
        value['self'] = value
        expect(() => toCanonicalJson(value as CanonicalValue)).toThrow('levels')
    })

    // Rust text cannot hold half of a surrogate pair, so the other
    // implementation could never write the same bytes.
    test('a text with half of a surrogate pair', () => {
        expect(() => toCanonicalJson({ name: 'a\uD83C' })).toThrow()
    })

    test('a value that is not data', () => {
        const date: unknown = new Date(0)
        expect(() => toCanonicalJson(date as CanonicalValue)).toThrow()
        expect(() => toCanonicalJson(undefined as unknown as CanonicalValue)).toThrow()
    })

    test('a number that is too large to be exact', () => {
        expect(() => toCanonicalJson(2 ** 53)).toThrow()
    })
})
