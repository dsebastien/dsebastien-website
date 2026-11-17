import { sha256Hex } from './hash.ts'
import type { ContentStore } from './ports.ts'

// The manifest: the record of each published note, one file per note
// (STORE-03 to STORE-05 of the spec). The Rust twin is `cli/src/manifest.rs`.

/** The folder of the manifest in the content store. */
export const MANIFEST_FOLDER = 'manifest'

/** The folder of the cleaned notes in the content store. */
export const NOTES_FOLDER = 'notes'

// A type alias, not an interface: the canonical form takes any object of data.
export type ManifestEntry = {
    /** The attachments of the note. A later slice fills it. */
    readonly attachments: readonly string[]
    readonly cleanedHash: string
    readonly cleaningVersion: number
    /** The time of the run of the first publication. */
    readonly firstPublished: string
    /** The paths that the note had before, in the order in which they were added. */
    readonly formerPaths: readonly string[]
    /** The identity of the note. Nothing writes it into the note. */
    readonly id: string
    /** The time of the run of the last publication. */
    readonly lastPublished: string
    /** The vault path of the note. */
    readonly path: string
    readonly sourceHash: string
    readonly state: 'published'
}

/**
 * The identity of a note that is published for the first time: 16 digits of
 * the hash of its path and of the time of the run. Both are inputs, so both
 * implementations give the same identity.
 */
export function noteId(path: string, firstPublished: string): string {
    return sha256Hex(`${path}\n${firstPublished}`).slice(0, 16)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTextList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Reads one entry from the text of its file. It throws when the text is not an entry. */
export function parseManifestEntry(text: string, file: string): ManifestEntry {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) {
        throw new Error(`${file} is not a manifest entry`)
    }
    const { attachments, cleanedHash, cleaningVersion, firstPublished, formerPaths } = value
    const { id, lastPublished, path, sourceHash, state } = value
    if (
        !isTextList(attachments) ||
        typeof cleanedHash !== 'string' ||
        typeof cleaningVersion !== 'number' ||
        !Number.isSafeInteger(cleaningVersion) ||
        cleaningVersion < 0 ||
        typeof firstPublished !== 'string' ||
        !isTextList(formerPaths) ||
        typeof id !== 'string' ||
        typeof lastPublished !== 'string' ||
        typeof path !== 'string' ||
        typeof sourceHash !== 'string' ||
        state !== 'published'
    ) {
        throw new Error(`${file} is not a manifest entry`)
    }
    return {
        attachments,
        cleanedHash,
        cleaningVersion,
        firstPublished,
        formerPaths,
        id,
        lastPublished,
        path,
        sourceHash,
        state
    }
}

/** Reads every entry of the manifest of a content store. */
export async function readManifest(store: ContentStore): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = []
    for (const file of await store.list(MANIFEST_FOLDER)) {
        const text = await store.read(file)
        if (text !== undefined) {
            entries.push(parseManifestEntry(text, file))
        }
    }
    return entries
}
