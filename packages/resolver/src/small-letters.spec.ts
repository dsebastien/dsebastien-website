import { describe, expect, test } from 'bun:test'
import { smallLetters } from './small-letters.ts'

// The small letters of the canonical form (issue 73). The table was made from
// `toLowerCase` of the Bun of this repository, so on that Bun both agree on
// every code point alone and on every text: a difference means that the table
// or the rule of the final sigma is wrong, or that Bun changed (then the table
// stays as it is, on purpose).
describe('small letters', () => {
    test('give the small letters of toLowerCase for every code point alone', () => {
        const different: string[] = []
        for (let code = 0; code <= 0x10ffff; code += 1) {
            if (code >= 0xd800 && code <= 0xdfff) continue
            const letter = String.fromCodePoint(code)
            if (smallLetters(letter) !== letter.toLowerCase()) different.push(code.toString(16))
        }
        expect(different).toEqual([])
    })

    test('follow the rule of the final sigma of toLowerCase, also across signs that it skips', () => {
        for (const text of [
            'ΟΔΟΣ',
            'ΟΔΟΣ.md',
            'ΣΑ',
            'Σ',
            'ΑΣ ΒΣ',
            "ΑΣ'",
            "ΑΣ'Β",
            'ΆΣ',
            'Α.Σ',
            'αΣ1',
            '1Σ',
            'ΟΔΟΣ/ΟΔΟΣ',
            'İstanbul ΣΑΣ'
        ]) {
            expect(smallLetters(text)).toBe(text.toLowerCase())
        }
    })

    test('leave a letter that a newer Unicode makes small as it is (U+A7DD)', () => {
        expect(smallLetters('꟝')).toBe('꟝')
        expect(smallLetters('Élan')).toBe('élan')
    })
})
