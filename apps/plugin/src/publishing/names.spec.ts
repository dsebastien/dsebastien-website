import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { foldedForm, isReservedRootName } from './names.ts'

// The root names of the site (documentation/Canonical Form.md). The Rust
// implementation reads the same cases (`cli/src/names.rs`).
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/names.json', import.meta.url))

interface Cases {
    reserved: { name: string; text: string; reserved: boolean }[]
    folded: { name: string; one: string; two: string; equal: boolean }[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const cases = (await Bun.file(CASES).json()) as Cases

describe('reserved root names', () => {
    test.each(cases.reserved.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(isReservedRootName(entry.text)).toBe(entry.reserved)
    })
})

describe('folded form', () => {
    test.each(cases.folded.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(foldedForm(entry.one) === foldedForm(entry.two)).toBe(entry.equal)
    })

    test('the shared file has cases of each kind', () => {
        expect(cases.reserved.length).toBeGreaterThan(10)
        expect(cases.folded.length).toBeGreaterThan(5)
    })
})
