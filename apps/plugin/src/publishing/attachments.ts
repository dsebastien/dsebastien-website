import { bytesHash } from './hash.ts'
import { imageSize } from './images.ts'
import type { NoteLink } from './links.ts'
import { compareCodePoints, sortByCodePoint } from './order.ts'
import type { Vault } from './ports.ts'
import { smallLetters } from '@dsebastien-website/resolver'

// The attachments of a note (documentation/Canonical Form.md, sections "The
// attachment storage" and "The attachments of a note"). The Rust twin is
// `cli/src/attachments.rs`. Change both in the same commit.

/** One item of the list `attachments` of a manifest entry. */
// A type alias, not an interface: the canonical form takes any object of data.
export type Attachment = {
    /** `sha256:` and the SHA-256 of the bytes of the file. */
    readonly hash: string
    /** The height of an image, when its bytes say it. */
    readonly height?: number
    /** The link path, as the note writes it. */
    readonly link: string
    /** The vault path of the file. */
    readonly path: string
    /** The number of bytes of the file. */
    readonly size: number
    /** The width of an image, when its bytes say it. */
    readonly width?: number
}

/** What the tool knows of one file of the vault: what an attachment item holds, but its link. */
export type FileFacts = Omit<Attachment, 'link'>

/**
 * The size limit of an attachment, in bytes: 100 MiB (decision of the author
 * of 2026-11-26, issue 72). A note that links a larger file is held, and the
 * tool reads no byte of that file: it only asks its size. The Rust twin is
 * `MAX_ATTACHMENT_SIZE` of `cli/src/attachments.rs`.
 */
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

/** A file above the size limit that a note links to: the note is held (issue 72). */
// A type alias, not an interface: the canonical form takes any object of data.
export type TooLarge = {
    /** The vault path of the file. */
    readonly file: string
    /** The vault path of the note. */
    readonly path: string
    /** The number of bytes of the file. */
    readonly size: number
}

/** The form of a hash of an attachment: `sha256:` and 64 small hexadecimal digits. */
export const ATTACHMENT_HASH = /^sha256:[0-9a-f]{64}$/

/** The key of a file in the attachment storage: its hash without `sha256:`. */
export function keyOf(hash: string): string {
    return hash.slice('sha256:'.length)
}

/** The facts of the bytes of a file: its hash, its size and the size of an image. */
export function factsOf(path: string, bytes: Uint8Array): FileFacts {
    const size = imageSize(bytes)
    return {
        hash: bytesHash(bytes),
        ...(size === undefined ? {} : { height: size.height }),
        path,
        size: bytes.length,
        ...(size === undefined ? {} : { width: size.width })
    }
}

/**
 * The files of the vault that the notes of one run link to. Each file is read
 * one time per run: two notes that link to one image read it one time. Its
 * size is asked first, and a file above the size limit is never read.
 */
export class FileReader {
    readonly #vault: Vault
    readonly #facts = new Map<string, Promise<FileFacts>>()
    readonly #sizes = new Map<string, Promise<number>>()

    constructor(vault: Vault) {
        this.#vault = vault
    }

    /** The facts of a file. It throws when the file cannot be read, or went away during the run. */
    facts(path: string): Promise<FileFacts> {
        let facts = this.#facts.get(path)
        if (facts === undefined) {
            facts = this.#read(path)
            this.#facts.set(path, facts)
        }
        return facts
    }

    /** The number of bytes of a file, from the file system: no byte is read. It throws as `facts`. */
    size(path: string): Promise<number> {
        let size = this.#sizes.get(path)
        if (size === undefined) {
            size = this.#size(path)
            this.#sizes.set(path, size)
        }
        return size
    }

    async #size(path: string): Promise<number> {
        let size: number | undefined
        try {
            size = await this.#vault.size(path)
        } catch (error) {
            throw new Error(
                `"${path}" cannot be read: it ${error instanceof Error ? error.message : 'failed'}`,
                { cause: error }
            )
        }
        if (size === undefined) {
            throw new Error(`"${path}" cannot be read: it went away during the run`)
        }
        return size
    }

    async #read(path: string): Promise<FileFacts> {
        const size = await this.size(path)
        if (size > MAX_ATTACHMENT_SIZE) {
            throw new Error(
                `"${path}" is not read: its ${String(size)} bytes are above the size limit`
            )
        }
        let bytes: Uint8Array | undefined
        try {
            bytes = await this.#vault.readBytes(path)
        } catch (error) {
            throw new Error(
                `"${path}" cannot be read: it ${error instanceof Error ? error.message : 'failed'}`,
                { cause: error }
            )
        }
        if (bytes === undefined) {
            throw new Error(`"${path}" cannot be read: it went away during the run`)
        }
        return factsOf(path, bytes)
    }
}

/**
 * The list `attachments` of a note, from the links that lead to a file that
 * is not a note. The links are sorted by their link paths, so the list is too.
 */
export async function attachmentsOf(
    files: readonly NoteLink[],
    reader: FileReader
): Promise<Attachment[]> {
    const attachments: Attachment[] = []
    for (const file of files) {
        const facts = await reader.facts(file.path)
        attachments.push({ ...facts, link: file.link })
    }
    return attachments
}

/**
 * The files above the size limit that these links of the note at `path` lead
 * to, each one time, sorted by the vault path of the file. Only their sizes
 * are read.
 */
export async function tooLargeOf(
    path: string,
    files: readonly NoteLink[],
    reader: FileReader
): Promise<TooLarge[]> {
    const found = new Map<string, number>()
    for (const file of files) {
        const size = await reader.size(file.path)
        if (size > MAX_ATTACHMENT_SIZE) {
            found.set(file.path, size)
        }
    }
    return sortByCodePoint([...found.keys()]).map((file) => ({
        file,
        path,
        size: found.get(file) ?? 0
    }))
}

/** The items of `tooLarge`, each one time, sorted by path, then by file. */
export function sortTooLarge(items: readonly TooLarge[]): TooLarge[] {
    const seen = new Set<string>()
    return [...items]
        .sort(
            (one, two) =>
                compareCodePoints(one.path, two.path) || compareCodePoints(one.file, two.file)
        )
        .filter((item) => {
            const key = `${item.path}
${item.file}`
            if (seen.has(key)) {
                return false
            }
            seen.add(key)
            return true
        })
}

/** True when two lists of attachments say the same: the same items in the same order. */
export function sameAttachments(one: readonly Attachment[], two: readonly Attachment[]): boolean {
    return (
        one.length === two.length &&
        one.every((item, index) => {
            const other = two[index]
            return (
                other !== undefined &&
                item.hash === other.hash &&
                item.height === other.height &&
                item.link === other.link &&
                item.path === other.path &&
                item.size === other.size &&
                item.width === other.width
            )
        })
    )
}

/** True when the value is the list `attachments` of a manifest entry. */
export function isAttachmentList(
    value: unknown,
    isPath: (path: string) => boolean
): value is Attachment[] {
    return (
        Array.isArray(value) &&
        value.every((item: unknown) => {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) {
                return false
            }
            const record = item as Record<string, unknown>
            const keys = Object.keys(record)
            const { hash, height, link, path, size, width } = record
            const whole = (number: unknown): boolean =>
                typeof number === 'number' && Number.isSafeInteger(number)
            const sized = height !== undefined || width !== undefined
            return (
                keys.every((key) =>
                    ['hash', 'height', 'link', 'path', 'size', 'width'].includes(key)
                ) &&
                typeof hash === 'string' &&
                ATTACHMENT_HASH.test(hash) &&
                typeof link === 'string' &&
                typeof path === 'string' &&
                isPath(path) &&
                !smallLetters(path).endsWith('.md') &&
                whole(size) &&
                (size as number) >= 0 &&
                (!sized ||
                    (whole(width) &&
                        whole(height) &&
                        (width as number) > 0 &&
                        (height as number) > 0))
            )
        })
    )
}
