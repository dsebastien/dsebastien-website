import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { sourceOf, STATE_PROPERTY } from './clean.ts'
import { namesInProperties, setProperty } from './frontmatter.ts'
import { IGNORE_PROPERTY } from './guards.ts'

// The rules for the properties of a note (documentation/Canonical Form.md).
// The Rust implementation reads the same cases (`cli/src/frontmatter.rs`), so
// both must give the result that the file states.
const CASES = fileURLToPath(
    new URL('../../../../fixtures/canonical/properties.json', import.meta.url)
)

interface Cases {
    ignored: { name: string; note: string; excluded: boolean }[]
    source: { name: string; note: string; source: string }[]
    state: { name: string; note: string; result: string }[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const cases = (await Bun.file(CASES).json()) as Cases

describe('ignore property of a note', () => {
    test.each(cases.ignored.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(namesInProperties(entry.note, IGNORE_PROPERTY)).toBe(entry.excluded)
    })
})

describe('source of a note', () => {
    test.each(cases.source.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(sourceOf(entry.note)).toBe(entry.source)
    })
})

describe('state property of a note', () => {
    test.each(cases.state.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(setProperty(entry.note, STATE_PROPERTY, 'true')).toBe(entry.result)
    })

    test('the shared file has cases of each kind', () => {
        expect(cases.ignored.length).toBeGreaterThan(20)
        expect(cases.source.length).toBeGreaterThan(10)
        expect(cases.state.length).toBeGreaterThan(10)
    })
})
