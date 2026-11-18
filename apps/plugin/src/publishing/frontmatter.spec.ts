import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { sourceOf, STATE_PROPERTY } from './clean.ts'
import { hasFlowProperties, namesInProperties, removeProperty, setProperty } from './frontmatter.ts'
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
    removed: { name: string; note: string; result: string }[]
    flow: { name: string; note: string; flow: boolean }[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const cases = (await Bun.file(CASES).json()) as Cases

describe('ignore property of a note', () => {
    test.each(cases.ignored.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(namesInProperties(entry.note, IGNORE_PROPERTY)).toBe(entry.excluded)
    })
})

// The tool never writes the state property into properties in the flow form
// of YAML (`{ }`, `[ ]`): a new line below such a line is not valid YAML.
describe('flow form of the properties', () => {
    test.each(cases.flow.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(hasFlowProperties(entry.note)).toBe(entry.flow)
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

    test.each(cases.removed.map((entry) => [entry.name, entry] as const))(
        'removed: %s',
        (_name, entry) => {
            expect(removeProperty(entry.note, STATE_PROPERTY)).toBe(entry.result)
        }
    )

    // A correction of the property must never make a note "changed" (PUB-14).
    test.each(cases.source.map((entry) => [entry.name, entry] as const))(
        'the source is the same after the property is set: %s',
        (_name, entry) => {
            expect(sourceOf(setProperty(entry.note, STATE_PROPERTY, 'true'))).toBe(entry.source)
        }
    )

    test('the shared file has cases of each kind', () => {
        expect(cases.removed.length).toBeGreaterThan(10)
        expect(cases.ignored.length).toBeGreaterThan(20)
        expect(cases.source.length).toBeGreaterThan(10)
        expect(cases.state.length).toBeGreaterThan(10)
        expect(cases.flow.length).toBeGreaterThan(10)
    })
})
