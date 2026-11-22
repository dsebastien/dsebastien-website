import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parseMarkers, readJournals } from './renames.ts'
import type { RenameJournals } from './ports.ts'

// The read marker and the lines of a rename journal (issue 37, R66). The
// cases are the lists `markers` and `journalLines` of
// `fixtures/canonical/cases.json`, which the Rust tests read too
// (`cli/src/renames.rs`). The moves themselves are the shared queue
// scenarios of `fixtures/canonical/queue.json`.
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/cases.json', import.meta.url))

interface Case {
    name: string
    text: string
    valid: boolean
}

// The file is test data of this repository. The cast is the boundary.
const { markers, journalLines } = (await Bun.file(CASES).json()) as {
    markers: Case[]
    journalLines: Case[]
}

/** One journal in memory, with this text. */
function oneJournal(text: string): RenameJournals {
    return {
        list: () => Promise.resolve(['00000000000000aa.jsonl']),
        read: () => Promise.resolve(new TextEncoder().encode(text))
    }
}

describe('read marker of the content store', () => {
    test('the file has cases of each kind', () => {
        expect(markers.some((entry) => entry.valid)).toBe(true)
        expect(markers.filter((entry) => !entry.valid).length).toBeGreaterThan(5)
    })

    test.each(markers.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        if (entry.valid) {
            expect(() => parseMarkers(entry.text)).not.toThrow()
        } else {
            expect(() => parseMarkers(entry.text)).toThrow('renames.json')
        }
    })
})

describe('line of a rename journal', () => {
    test('the file has cases of each kind', () => {
        expect(journalLines.filter((entry) => entry.valid).length).toBeGreaterThan(3)
        expect(journalLines.filter((entry) => !entry.valid).length).toBeGreaterThan(10)
    })

    test.each(journalLines.map((entry) => [entry.name, entry] as const))(
        '%s',
        async (_name, entry) => {
            const state = await readJournals(oneJournal(`${entry.text}\n`), {})
            expect(state.lines.length).toBe(entry.valid ? 1 : 0)
            expect(state.warnings.length).toBe(entry.valid ? 0 : 1)
            // A line is counted, valid or not.
            expect(state.markers['00000000000000aa.jsonl']?.lines).toBe(1)
        }
    )

    test('the bytes after the last line feed are not read and not counted', async () => {
        const state = await readJournals(oneJournal(journalLines[0]?.text ?? ''), {})
        expect(state.lines).toEqual([])
        expect(state.warnings).toEqual([])
        expect(state.read).toBe(false)
    })
})
