import { describe, expect, test } from 'bun:test'
import { queryOfPath } from './suggestion.ts'

// The query that the "not found" page puts into its search field (R63):
// the words of the last part of the missing address.
describe('the query of a missing address', () => {
    test('is the last part of the path, with its spaces', () => {
        expect(queryOfPath('/10+Garden/Compost+basics')).toBe('Compost basics')
        expect(queryOfPath('/Compost%20basics.md')).toBe('Compost basics')
        expect(queryOfPath('/Garden/%C3%89vier/')).toBe('Évier')
    })

    test('keeps a plus sign that the address encodes', () => {
        expect(queryOfPath('/C%2B%2B+notes')).toBe('C++ notes')
    })

    test('is empty for the root, a generated page and an address that does not decode', () => {
        expect(queryOfPath('/')).toBe('')
        expect(queryOfPath('/-/tags/x')).toBe('')
        expect(queryOfPath('/%E0%A4%A')).toBe('')
    })

    test('is cut to 80 characters', () => {
        expect(queryOfPath(`/${'a'.repeat(200)}`)).toHaveLength(80)
    })
})
