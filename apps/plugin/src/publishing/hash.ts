import { createHash } from 'node:crypto'

/** The SHA-256 of a text as UTF-8, in small hexadecimal digits. */
export function sha256Hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The hash of a text in the form of the manifest: `sha256:` and the digits. */
export function contentHash(text: string): string {
    return `sha256:${sha256Hex(text)}`
}
