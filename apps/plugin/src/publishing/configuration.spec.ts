import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parseConfiguration } from './configuration.ts'

// The configuration of the content store (GATE-04, R103). The Rust
// implementation reads the same cases (`cli/src/configuration.rs`), so both
// accept and refuse the same texts, with the same messages.
const CASES = fileURLToPath(
    new URL('../../../../fixtures/canonical/configuration.json', import.meta.url)
)

interface Cases {
    cases: {
        name: string
        text: string | null
        denyList?: string[]
        noindexFolders?: string[]
        error?: string
    }[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const cases = (await Bun.file(CASES).json()) as Cases

describe('the configuration of the content store', () => {
    test.each(cases.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        const read = () => parseConfiguration(entry.text ?? undefined)
        if (entry.error !== undefined) {
            expect(read).toThrow(entry.error)
            return
        }
        expect(read()).toEqual({
            denyList: entry.denyList ?? [],
            noindexFolders: entry.noindexFolders ?? []
        })
    })

    test('the shared file has valid and refused texts of the noindex folders', () => {
        expect(cases.cases.filter((entry) => (entry.noindexFolders ?? []).length > 0)).not.toEqual(
            []
        )
        expect(
            cases.cases.filter((entry) => entry.error?.includes('noindex folders') === true).length
        ).toBeGreaterThan(3)
    })
})
