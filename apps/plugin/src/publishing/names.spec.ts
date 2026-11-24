import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
    foldedForm,
    isChangedByObsidian,
    isReservedRootName,
    obsidianPath,
    obsidianTwins
} from './names.ts'

// The root names of the site (documentation/Canonical Form.md). The Rust
// implementation reads the same cases (`cli/src/names.rs`).
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/names.json', import.meta.url))

interface Cases {
    reserved: { name: string; text: string; reserved: boolean }[]
    folded: { name: string; one: string; two: string; equal: boolean }[]
    obsidian: { name: string; text: string; path: string }[]
    twins: { name: string; paths: string[]; twins: Record<string, string> }[]
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
        expect(cases.obsidian.length).toBeGreaterThan(10)
    })
})

describe('the path that Obsidian gives a vault path', () => {
    test.each(cases.obsidian.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(obsidianPath(entry.text)).toBe(entry.path)
        expect(isChangedByObsidian(entry.text)).toBe(entry.path !== entry.text)
    })
})

describe('the paths with one Obsidian path', () => {
    test.each(cases.twins.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(Object.fromEntries(obsidianTwins(entry.paths))).toEqual(entry.twins)
    })
})
