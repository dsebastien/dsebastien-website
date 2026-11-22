import { describe, expect, test } from 'bun:test'
import { lengthWords, sha256Hex } from './sha256.ts'

// The SHA-256 of the resolver: the expected values were computed with sha256sum.
describe('SHA-256 of a text', () => {
    test.each([
        ['the empty text', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['one block', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        [
            'a text whose padding needs a second block',
            'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
            '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
        ],
        [
            'a folded path',
            '10 garden/rain barrel',
            '2417458c9b6c953c1156df6a4cbbc4b763acf7d8801b8d53da1b4dbf5956f4b2'
        ],
        [
            'letters outside ASCII, as UTF-8',
            "Crème brûlée à l'érable",
            'fcb9f2704f0af774bebb813b1f42657bac3bed8d5b58e71034f5b7ab6f8d6feb'
        ],
        [
            'many blocks',
            'a'.repeat(1000),
            '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'
        ]
    ])('%s', (_name, text, hash) => {
        expect(sha256Hex(text)).toBe(hash)
    })
})

// A text of 2^29 bytes or more has a length in bits above 32 bits.
describe('length field of SHA-256', () => {
    test.each([
        [0, 0, 0],
        [3, 0, 24],
        [0x12345678, 0, 0x91a2b3c0],
        [0x20000000, 1, 0],
        [0x20000001, 1, 8],
        [0x60000000, 3, 0]
    ])('%d bytes', (bytes, high, low) => {
        expect(lengthWords(bytes)).toEqual([high, low])
    })
})
