import { describe, expect, test } from 'bun:test'
import {
    differenceOf,
    differenceText,
    envValue,
    hmacSha256,
    MISSING_KEY,
    parseTreeListing,
    sameSeal,
    sealKeyOf,
    sealLineOf,
    sealOf,
    stateDigest,
    withSeal
} from './seal.ts'
import type { StoreDifference, TreeFile } from './seal.ts'

// The seal of the content store (R104). The shared cases are
// `fixtures/canonical/seal.json`, which the Rust tests read too. A key is
// built at run time from the byte that a case gives.

const CASES = new URL('../../../../fixtures/canonical/seal.json', import.meta.url)

interface Cases {
    hmac: { name: string; keyByte: string; keyLength: number; text: string; hmac: string }[]
    env: { name: string; text: string; value: string | null }[]
    keys: {
        name: string
        environment: string | null
        envFile: string | null
        keyByte?: string
        result: 'key' | 'missing' | 'invalid'
    }[]
    seals: {
        name: string
        keyByte: string
        parent: string | null
        files: TreeFile[]
        digest: string
        seal: string
    }[]
    sealLines: { message: string; seal: string | null }[]
    listings: { name: string; text: string; files: TreeFile[] }[]
    differences: {
        name: string
        head: string
        sealed: string | null
        sealedFiles: TreeFile[]
        headFiles: TreeFile[]
        texts: Record<string, string>
        difference: StoreDifference
        text: string
    }[]
}

const cases = (await Bun.file(CASES).json()) as Cases

function keyOf(byte: string, length = 32): Uint8Array {
    return Uint8Array.from(Buffer.from(byte.repeat(length), 'hex'))
}

function withKey(text: string | null, byte: string | undefined): string | undefined {
    if (text === null) {
        return undefined
    }
    const hex = (byte ?? '00').repeat(32)
    return text.replaceAll('<key>', hex).replaceAll('<KEY>', hex.toUpperCase())
}

describe('the seal of the content store', () => {
    test('computes the HMAC-SHA256 of RFC 4231', () => {
        for (const { name, keyByte, keyLength, text, hmac } of cases.hmac) {
            expect([name, hmacSha256(keyOf(keyByte, keyLength), text)]).toEqual([name, hmac])
        }
    })

    test('reads the seal key of a .env text', () => {
        for (const { name, text, value } of cases.env) {
            expect([name, envValue(text, 'VAULT_PUBLISH_SEAL_KEY') ?? null]).toEqual([name, value])
        }
    })

    test('takes the key of the environment, else of the .env file, and says why there is none', () => {
        for (const { name, environment, envFile, keyByte, result } of cases.keys) {
            const key = sealKeyOf(withKey(environment, keyByte), withKey(envFile, keyByte))
            if (result === 'key') {
                expect([name, 'key' in key ? Buffer.from(key.key).toString('hex') : key]).toEqual([
                    name,
                    (keyByte ?? '').repeat(32)
                ])
            } else {
                const problem = 'problem' in key ? key.problem : ''
                expect([name, problem === MISSING_KEY ? 'missing' : 'invalid']).toEqual([
                    name,
                    result
                ])
                // The message never holds the value that it refuses.
                expect(problem).not.toContain((keyByte ?? 'abcd').repeat(4))
                expect(problem).toContain('openssl rand -hex 32')
            }
        }
    })

    test('seals a parent and the state of a commit', () => {
        for (const { name, keyByte, parent, files, digest, seal } of cases.seals) {
            expect([
                name,
                stateDigest(files),
                sealOf(keyOf(keyByte), parent ?? undefined, files)
            ]).toEqual([name, digest, seal])
            // Another key gives another seal.
            expect(sealOf(keyOf('01'), parent ?? undefined, files)).not.toBe(seal)
        }
    })

    test('reads the seal of the last line of a commit message only', () => {
        for (const { message, seal } of cases.sealLines) {
            expect([message, sealLineOf(message) ?? null]).toEqual([message, seal])
        }
        const seal = 'ab'.repeat(32)
        expect(sealLineOf(withSeal('Publish\n\nPlan: 0123456789abcdef\n', seal))).toBe(seal)
        expect(withSeal('Publish\n\nPlan: x\n', seal)).toBe(`Publish\n\nPlan: x\nSeal: ${seal}\n`)
    })

    test('compares two seals', () => {
        const seal = 'ab'.repeat(32)
        expect(sameSeal(seal, 'ab'.repeat(32))).toBe(true)
        expect(sameSeal(seal, 'ab'.repeat(31) + 'ac')).toBe(false)
        expect(sameSeal(seal, seal.slice(1))).toBe(false)
    })

    test('reads the files of a listing of git', () => {
        for (const { name, text, files } of cases.listings) {
            expect([name, parseTreeListing(text)]).toEqual([name, files])
        }
    })

    test('says what differs from the sealed state', async () => {
        for (const {
            name,
            head,
            sealed,
            sealedFiles,
            headFiles,
            texts,
            difference,
            text
        } of cases.differences) {
            const found = await differenceOf(
                head,
                sealed ?? undefined,
                sealedFiles,
                headFiles,
                (commit, path) => Promise.resolve(texts[`${commit}:${path}`])
            )
            expect([name, found]).toEqual([name, difference])
            expect([name, differenceText(found)]).toEqual([name, text])
        }
    })
})
