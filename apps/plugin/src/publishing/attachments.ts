import { bytesHash } from './hash.ts'
import { imageSize } from './images.ts'
import type { NoteLink } from './links.ts'
import type { Vault } from './ports.ts'

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
 * one time per run: two notes that link to one image read it one time.
 */
export class FileReader {
    readonly #vault: Vault
    readonly #facts = new Map<string, Promise<FileFacts>>()

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

    async #read(path: string): Promise<FileFacts> {
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
                !path.toLowerCase().endsWith('.md') &&
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
