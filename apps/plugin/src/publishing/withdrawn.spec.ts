import { describe, expect, test } from 'bun:test'
import { parseWithdrawn, WITHDRAWN_FILE, withdrawnKeys, withdrawnText } from './withdrawn.ts'

// The keys that the guards withdrew (issue 120, decision of the author R78, after R45):
// `withdrawn.json` of the content store. The shared cases are the list
// `withdrawn` of `fixtures/canonical/cases.json`, which the Rust tests read
// too.

interface Case {
    readonly name: string
    readonly text: string
    readonly valid: boolean
}

const CASES = new URL('../../../../fixtures/canonical/cases.json', import.meta.url)
const { withdrawn } = (await Bun.file(CASES).json()) as { withdrawn: Case[] }

const ONE = '1'.repeat(64)
const TWO = '2'.repeat(64)

describe('the file of the withdrawn keys', () => {
    test('is read as the shared cases state', () => {
        expect(withdrawn.filter((entry) => entry.valid).length).toBeGreaterThan(1)
        expect(withdrawn.filter((entry) => !entry.valid).length).toBeGreaterThan(5)
        for (const { name, text, valid } of withdrawn) {
            if (valid) {
                expect(() => parseWithdrawn(text), name).not.toThrow()
            } else {
                expect(() => parseWithdrawn(text), name).toThrow(WITHDRAWN_FILE)
            }
        }
    })

    test('is empty when the content store has none', () => {
        expect(parseWithdrawn(undefined)).toEqual([])
    })

    test('holds the keys sorted, each one time, and is no file without a key', () => {
        expect(withdrawnText([TWO, ONE, TWO])).toBe(
            `{\n  "keys": [\n    "${ONE}",\n    "${TWO}"\n  ]\n}\n`
        )
        expect(withdrawnText([])).toBeUndefined()
        expect(parseWithdrawn(withdrawnText([TWO, ONE]))).toEqual([ONE, TWO])
    })
})

describe('the withdrawn keys of a publication', () => {
    test('are the guarded keys of before and after, and the earlier ones, that no unguarded file uses after', () => {
        expect(
            withdrawnKeys({
                earlier: [ONE, 'a'.repeat(64)],
                guardedBefore: [TWO],
                guardedAfter: ['b'.repeat(64)],
                usedAfter: ['a'.repeat(64)]
            })
        ).toEqual([ONE, TWO, 'b'.repeat(64)])
    })
})
