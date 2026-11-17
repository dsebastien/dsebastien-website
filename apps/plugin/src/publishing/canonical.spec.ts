import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { toCanonicalJson, type CanonicalValue } from './canonical.ts'

// The canonical form (documentation/Canonical Form.md) is what the parity rule
// compares. The Rust implementation reads the same cases
// (`cli/src/canonical.rs`), so both must give the text that the file states.
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/cases.json', import.meta.url))

interface Cases {
    cases: { name: string; value: CanonicalValue; canonical: string }[]
    refused: { name: string; value: CanonicalValue }[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const { cases, refused } = (await Bun.file(CASES).json()) as Cases

describe('canonical form of data', () => {
    test.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(toCanonicalJson(entry.value)).toBe(entry.canonical)
    })

    test('has cases', () => {
        expect(cases.length).toBeGreaterThan(5)
    })
})

describe('values that have no canonical form', () => {
    test.each(refused.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(() => toCanonicalJson(entry.value)).toThrow()
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
