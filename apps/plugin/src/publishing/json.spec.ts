import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { hasNumberThatIsNotWhole, parseJson } from './json.ts'
import { parseManifestEntry } from './manifest.ts'

// The JSON files of the content store are read in the same way by both
// implementations. The Rust tests read the same cases (`cli/src/json.rs`,
// `cli/src/manifest.rs`).
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/cases.json', import.meta.url))

interface Cases {
    json: { name: string; text: string; valid: boolean }[]
    cleaningVersions: { cases: { text: string; valid: boolean }[] }
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const { json, cleaningVersions } = (await Bun.file(CASES).json()) as Cases

/** True when the reader takes the text. */
function accepts(text: string): boolean {
    try {
        parseJson(text)
        return true
    } catch {
        return false
    }
}

/** A manifest entry whose `cleaningVersion` is the number as it is written. */
function entryWith(cleaningVersion: string): string {
    return `{"aliases":[],"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":${cleaningVersion},"firstPublished":"2031-04-01T08:00:00Z","formerPaths":[],"id":"00000000000000aa","lastPublished":"2031-04-01T08:00:00Z","links":[],"path":"A.md","sourceHash":"sha256:00","state":"published"}`
}

describe('reading of a JSON file of the store', () => {
    test.each(json.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(accepts(entry.text)).toBe(entry.valid)
    })

    test('has cases of each kind', () => {
        expect(json.filter((entry) => entry.valid).length).toBeGreaterThan(5)
        expect(json.filter((entry) => !entry.valid).length).toBeGreaterThan(5)
    })
})

describe('the version of the cleaning step in a manifest entry', () => {
    test.each(cleaningVersions.cases.map((entry) => [entry.text, entry] as const))(
        '%s',
        (_text, entry) => {
            const read = (): unknown => parseManifestEntry(entryWith(entry.text), 'manifest/x.json')
            if (entry.valid) {
                expect(read).not.toThrow()
            } else {
                expect(read).toThrow()
            }
        }
    )
})

describe('a number with a fraction or an exponent in a JSON text', () => {
    test.each([
        ['{"a": 1.0}', true],
        ['{"a": 1e3}', true],
        ['{"a": [2, -2.5E-1]}', true],
        ['{"a": 10, "b": -3, "c": [0]}', false],
        ['{"a": "1.0 and 1e3 in a text", "b\\"1.5": 2}', false],
        ['{"denyList": ["Folder 1.5"]}', false]
    ])('%s: %p', (text, expected) => {
        expect(hasNumberThatIsNotWhole(text)).toBe(expected)
    })
})
