import { beforeAll, describe, expect, test } from 'bun:test'
import { FIXTURE_VAULT } from '@dsebastien-website/testing'
import { toCanonicalJson } from '../apps/plugin/src/publishing/canonical.ts'
import { computePlan } from '../apps/plugin/src/publishing/plan.ts'
import { buildRustProgram, runRustProgram } from './harness.ts'

// The parity rule (ADR 0009, TEST-03 of the spec): for the same input, the
// TypeScript and the Rust implementation write the same bytes in the canonical
// form. A failure here blocks a release.

let program: string

beforeAll(async () => {
    program = await buildRustProgram()
}, 600_000)

describe('parity of the publication plan', () => {
    test('both implementations write the same bytes for the fixture vault', async () => {
        const typescript = new TextEncoder().encode(toCanonicalJson(computePlan()))

        const rust = await runRustProgram(program, ['plan', '--vault', FIXTURE_VAULT])

        expect(rust.exitCode).toBe(0)
        // The text first: a difference then shows as text, not as a list of bytes.
        expect(new TextDecoder().decode(rust.stdout)).toBe(new TextDecoder().decode(typescript))
        expect(rust.stdout).toEqual(typescript)
    })

    // The skeleton finds nothing. The same text is in `cli/tests/plan.rs`,
    // which also runs on Windows.
    test('the plan of the skeleton is empty', () => {
        expect(toCanonicalJson(computePlan())).toBe(
            '{\n  "publish": [],\n  "remove": [],\n  "update": []\n}\n'
        )
    })
})
