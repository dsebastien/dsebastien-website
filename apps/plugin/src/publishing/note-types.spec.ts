import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { isNoteType, readNoteTypes, sameNoteType } from './note-types.ts'
import type { NoteType } from './note-types.ts'

// The note type of a note (documentation/Canonical Form.md, "The note type of
// a note"). The Rust implementation reads the same cases (`cli/src/note_types.rs`).
const CASES = fileURLToPath(
    new URL('../../../../fixtures/canonical/note-types.json', import.meta.url)
)

interface Cases {
    read: { name: string; question: string[]; answer: unknown; types: Record<string, NoteType> }[]
    refused: { name: string; question: string[]; answer: unknown }[]
    manifest: { name: string; noteType: unknown; valid: boolean }[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const cases = (await Bun.file(CASES).json()) as Cases

describe('the answer of the Starter Kit', () => {
    test.each(cases.read.map((entry) => [entry.name, entry] as const))(
        'reads: %s',
        (_name, entry) => {
            const types = readNoteTypes(entry.question, entry.answer)
            expect(Object.fromEntries(types)).toEqual(entry.types)
        }
    )

    test.each(cases.refused.map((entry) => [entry.name, entry] as const))(
        'refuses: %s',
        (_name, entry) => {
            expect(() => readNoteTypes(entry.question, entry.answer)).toThrow(
                'the Obsidian Starter Kit gave an answer that the tool cannot read'
            )
        }
    )

    test('the shared file has cases of each kind', () => {
        expect(cases.read.length).toBeGreaterThanOrEqual(5)
        expect(cases.refused.length).toBeGreaterThanOrEqual(15)
        expect(cases.manifest.length).toBeGreaterThanOrEqual(8)
    })
})

describe('the note type of a manifest entry', () => {
    test.each(cases.manifest.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(isNoteType(entry.noteType)).toBe(entry.valid)
    })
})

describe('two note types', () => {
    const quote = { displayName: 'Quotes', name: 'quotes' }

    test('are the same with the same keys and values', () => {
        expect(sameNoteType(quote, { name: 'quotes', displayName: 'Quotes' })).toBe(true)
        expect(sameNoteType(undefined, undefined)).toBe(true)
    })

    test('differ by any key, and with no type on one side', () => {
        expect(sameNoteType(quote, { ...quote, displayName: 'Citations' })).toBe(false)
        expect(sameNoteType(quote, { ...quote, suffix: ' (Quote)' })).toBe(false)
        expect(sameNoteType(quote, { ...quote, prefix: 'Q - ' })).toBe(false)
        expect(sameNoteType(quote, { ...quote, name: 'own-quotes' })).toBe(false)
        expect(sameNoteType(quote, undefined)).toBe(false)
        expect(sameNoteType(undefined, quote)).toBe(false)
    })
})
