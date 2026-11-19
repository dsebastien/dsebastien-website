import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { imageSize } from './images.ts'

// The size of an image from the first bytes of its file (documentation/
// Canonical Form.md, section "The attachments of a note", rule 5). The Rust
// implementation reads the same cases (`cli/src/images.rs`).
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/images.json', import.meta.url))

interface Case {
    name: string
    bytes: string
    width?: number
    height?: number
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const { cases } = (await Bun.file(CASES).json()) as { cases: Case[] }

describe('size of an image', () => {
    test.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        const expected =
            entry.width === undefined || entry.height === undefined
                ? undefined
                : { width: entry.width, height: entry.height }
        expect(imageSize(Buffer.from(entry.bytes, 'hex'))).toEqual(expected)
    })

    test('the shared file has cases with and without a size', () => {
        expect(cases.filter((entry) => entry.width !== undefined).length).toBeGreaterThan(15)
        expect(cases.filter((entry) => entry.width === undefined).length).toBeGreaterThan(10)
    })

    test('the image of the fixture vault has its size', async () => {
        const file = fileURLToPath(
            new URL('../../../../fixtures/vault/Attachments/garden-plan.png', import.meta.url)
        )
        expect(imageSize(await Bun.file(file).bytes())).toEqual({ width: 16, height: 12 })
    })
})
