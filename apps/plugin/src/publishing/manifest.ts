import { isAttachmentList } from './attachments.ts'
import type { Attachment } from './attachments.ts'
import { isVaultPath } from './configuration.ts'
import { sha256Hex } from './hash.ts'
import { parseJson } from './json.ts'
import type { NoteLink } from './links.ts'
import { isNoteType } from './note-types.ts'
import type { NoteType } from './note-types.ts'
import { compareCodePoints } from './order.ts'
import type { Original } from './originals.ts'
import type { ContentStore } from './ports.ts'

// The manifest: the record of each published note, one file per note
// (STORE-03 to STORE-05 of the spec). The Rust twin is `cli/src/manifest.rs`.

/** The folder of the manifest in the content store. */
export const MANIFEST_FOLDER = 'manifest'

/** The folder of the cleaned notes in the content store. */
export const NOTES_FOLDER = 'notes'

// A type alias, not an interface: the canonical form takes any object of data.
export type ManifestEntry = {
    /** The aliases of the note that get a URL, each one time, in the order of the code points. */
    readonly aliases: readonly string[]
    /** The links of the note that lead to a file that is not a note, with the facts of the file, sorted by their link path. */
    readonly attachments: readonly Attachment[]
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
    /** The links of the note that lead to a note, sorted by their link path. */
    readonly links: readonly NoteLink[]
    /** The note type of the note, when it has one (decision R61). */
    readonly noteType?: NoteType
    /**
     * The post on the main site that the last publication of the note
     * verified as its original (PUB-100, IDX-12). An entry without a
     * verified post has no such key.
     */
    readonly original?: Original
    /** The vault path of the note. */
    readonly path: string
    readonly sourceHash: string
    /** `unpublished` after a publication removed the note. The entry stays: it keeps the identity of the note. */
    readonly state: 'published' | 'unpublished'
    /**
     * `true` when a move of a rename journal put the note at a path whose
     * note had another source: its update waits until a selection includes
     * it (decision R67). An entry with no held update has no such key.
     */
    readonly updateHeld?: true
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

/** True when the value is the list `aliases` of an entry: texts, each one time, in the order of the code points. */
function isAliasList(value: unknown): value is string[] {
    return (
        isTextList(value) &&
        value.every(
            (alias, index) => index === 0 || compareCodePoints(value[index - 1] ?? '', alias) < 0
        )
    )
}

/** True when the value is the list `links` of an entry: each item has exactly a link path and the vault path of a note. */
function isLinkList(value: unknown): value is NoteLink[] {
    return (
        Array.isArray(value) &&
        value.every(
            (item) =>
                isRecord(item) &&
                Object.keys(item).length === 2 &&
                typeof item['link'] === 'string' &&
                typeof item['path'] === 'string' &&
                isNotePath(item['path'])
        )
    )
}

/** True when the value is the `original` of an entry: exactly a text `checked` and a text `url`. */
function isOriginal(value: unknown): value is Original {
    return (
        isRecord(value) &&
        Object.keys(value).length === 2 &&
        typeof value['checked'] === 'string' &&
        typeof value['url'] === 'string'
    )
}

/** The form of the identity of a note: 16 hexadecimal digits. It names the file of the entry. */
const NOTE_ID = /^[0-9a-f]{16}$/

/** True when the path is the vault path of a note: its name ends in `.md`, in small letters. */
export function isNotePath(path: string): boolean {
    return isVaultPath(path) && path.endsWith('.md')
}

/**
 * Reads one entry from the text of its file. It throws when the text is not an
 * entry. The path and the id are checked, because the tool makes paths of the
 * content store from them.
 */
export function parseManifestEntry(text: string, file: string): ManifestEntry {
    let value: unknown
    try {
        value = parseJson(text)
    } catch {
        value = undefined
    }
    if (!isRecord(value)) {
        throw new Error(`${file} is not a manifest entry`)
    }
    const { aliases, attachments, cleanedHash, cleaningVersion, firstPublished, formerPaths } =
        value
    const { id, lastPublished, links, noteType, original, path, sourceHash, state, updateHeld } =
        value
    if (
        !isAliasList(aliases) ||
        !isAttachmentList(attachments, isVaultPath) ||
        typeof cleanedHash !== 'string' ||
        typeof cleaningVersion !== 'number' ||
        !Number.isSafeInteger(cleaningVersion) ||
        cleaningVersion < 0 ||
        typeof firstPublished !== 'string' ||
        !isTextList(formerPaths) ||
        typeof id !== 'string' ||
        !NOTE_ID.test(id) ||
        typeof lastPublished !== 'string' ||
        !isLinkList(links) ||
        (noteType !== undefined && !isNoteType(noteType)) ||
        (original !== undefined && !isOriginal(original)) ||
        typeof path !== 'string' ||
        !isNotePath(path) ||
        typeof sourceHash !== 'string' ||
        (state !== 'published' && state !== 'unpublished') ||
        (updateHeld !== undefined && updateHeld !== true)
    ) {
        throw new Error(`${file} is not a manifest entry`)
    }
    return {
        aliases,
        attachments: attachments.map((item) => ({
            hash: item.hash,
            ...(item.height === undefined ? {} : { height: item.height }),
            link: item.link,
            path: item.path,
            size: item.size,
            ...(item.width === undefined ? {} : { width: item.width })
        })),
        cleanedHash,
        cleaningVersion,
        firstPublished,
        formerPaths,
        id,
        lastPublished,
        links: links.map((item) => ({ link: item.link, path: item.path })),
        ...(noteType === undefined
            ? {}
            : {
                  noteType: {
                      displayName: noteType.displayName,
                      name: noteType.name,
                      ...(noteType.prefix === undefined ? {} : { prefix: noteType.prefix }),
                      ...(noteType.suffix === undefined ? {} : { suffix: noteType.suffix })
                  }
              }),
        ...(original === undefined
            ? {}
            : { original: { checked: original.checked, url: original.url } }),
        path,
        sourceHash,
        state,
        ...(updateHeld === true ? { updateHeld } : {})
    }
}

/** The path of the entry of a note in the content store. */
export function manifestFile(id: string): string {
    return `${MANIFEST_FOLDER}/${id}.json`
}

/**
 * Reads every entry of the manifest of a content store, by the vault path of
 * its note. It throws when a file is not an entry, when a file does not have
 * the name of its entry, and when two entries have the same path.
 */
export async function readManifest(store: ContentStore): Promise<Map<string, ManifestEntry>> {
    const entries = new Map<string, ManifestEntry>()
    for (const file of await store.list(MANIFEST_FOLDER)) {
        const text = await store.read(file)
        if (text === undefined) {
            continue
        }
        const entry = parseManifestEntry(text, file)
        if (file !== manifestFile(entry.id)) {
            throw new Error(`${file} does not have the name of its manifest entry`)
        }
        if (entries.has(entry.path)) {
            throw new Error(`two manifest entries have the path "${entry.path}"`)
        }
        entries.set(entry.path, entry)
    }
    return entries
}
