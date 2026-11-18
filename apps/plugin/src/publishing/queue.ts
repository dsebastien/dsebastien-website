import { CLEANING_VERSION, sourceOf, STATE_PROPERTY } from './clean.ts'
import type { Configuration } from './configuration.ts'
import { removeProperty, setProperty } from './frontmatter.ts'
import { guardOf } from './guards.ts'
import { contentHash } from './hash.ts'
import { LinkIndex, linkPathsOf, linksOfPaths, sameLinks } from './links.ts'
import type { ManifestEntry } from './manifest.ts'
import { sortByCodePoint } from './order.ts'
import type { Vault } from './ports.ts'

// The publication queue: what waits for a publication (PUB-18 of the spec).
// The rules are in `documentation/Canonical Form.md`, sections "The notes of
// the vault" and "The publication queue". The Rust twin is `cli/src/queue.rs`.
// Change both in the same commit.

/** The four lists of the queue, as vault paths. Each list is sorted by path. */
// A type alias, not an interface: the canonical form takes any object of data.
/** The publication queue that `status` gives: the four lists, and how far the copy is behind. */
export type PublicationQueue = QueueLists & {
    /**
     * The number of commits of the content store, at the last fetch, that the
     * copy does not have. A copy that is behind reads an older manifest.
     */
    readonly behind: number
}

/** The four lists of the queue. */
export type QueueLists = {
    /** The published notes whose content in the vault is not the published content. */
    readonly changed: readonly string[]
    readonly counts: {
        readonly changed: number
        readonly new: number
        readonly toRemove: number
        readonly unchanged: number
    }
    /** The candidates. */
    readonly new: readonly string[]
    /** The notes of `changed` that the author did not edit: the cleaning step gives another result. */
    readonly technicalUpdates: readonly string[]
    /** The published notes that cannot stay published as they are. */
    readonly toRemove: readonly string[]
    readonly unchanged: readonly string[]
}

/** What the scan knows of one note. The text itself is not kept. */
export interface ScannedNote {
    /** The hash of the text as the scan read it. A later read with another hash says that the note changed. */
    readonly textHash: string
    readonly sourceHash: string
    /** True when the note has the state property in the exact form that the tool writes. */
    readonly stateIsSet: boolean
    /** True when the note itself names the state property, in any form. */
    readonly namesState: boolean
}

/** The result of one scan of the vault against the manifest. */
export interface Scan {
    readonly queue: QueueLists
    /** Every note of the scan, by its vault path. */
    readonly notes: ReadonlyMap<string, ScannedNote>
    /** The notes of the scan that the ignore property excludes. */
    readonly ignored: ReadonlySet<string>
    /** The notes of the scan and of the folders of the deny list, by their names: what a link is resolved against. */
    readonly index: LinkIndex
    /** The notes that a guard excludes: a link to one of them gives no item. */
    readonly guarded: ReadonlySet<string>
    /** The names of the notes in the folders of the deny list, in small letters. No file of those folders is read. */
    readonly deniedNames: ReadonlySet<string>
    /** Every entry of the manifest, by the vault path of its note. */
    readonly manifest: ReadonlyMap<string, ManifestEntry>
    readonly configuration: Configuration
}

/** The replacement character: it stands for bytes of a name that are not valid Unicode. */
const REPLACEMENT = String.fromCharCode(0xfffd)

/** The vault paths of the notes of the vault, in the order of the canonical form. */
export async function scanVault(vault: Vault, configuration: Configuration): Promise<string[]> {
    const denied = new Set(configuration.denyList)
    const notes: string[] = []
    const folders = ['']
    for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
        for (const entry of await vault.list(folder)) {
            if (entry.name.startsWith('.') || entry.name.includes(REPLACEMENT)) {
                continue
            }
            const path = folder === '' ? entry.name : `${folder}/${entry.name}`
            if (entry.kind === 'folder') {
                // A folder of the deny list is not scanned for notes: none of its files is read.
                if (!denied.has(path)) {
                    folders.push(path)
                }
            } else if (path.endsWith('.md')) {
                notes.push(path)
            }
        }
    }
    return sortByCodePoint(notes)
}

/**
 * The vault paths of the notes in the folders of the deny list. The tool lists
 * those folders for two reasons: to know that a published note moved into one
 * of them, and to know that a link leads to a note under that guard. It reads
 * none of their files, and it writes none of these paths.
 */
export async function scanDenied(vault: Vault, configuration: Configuration): Promise<string[]> {
    const notes: string[] = []
    const folders = [...configuration.denyList]
    for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
        for (const entry of await vault.list(folder)) {
            if (entry.name.startsWith('.') || entry.name.includes(REPLACEMENT)) {
                continue
            }
            const path = `${folder}/${entry.name}`
            if (entry.kind === 'folder') {
                folders.push(path)
            } else if (path.endsWith('.md')) {
                notes.push(path)
            }
        }
    }
    return notes
}

/**
 * Scans the vault and fills the four lists of the queue. The state property
 * of a note is never an input (PUB-12): it is read only to know which notes
 * the correction after a publication must write.
 */
export async function computeQueue(input: {
    vault: Vault
    manifest: ReadonlyMap<string, ManifestEntry>
    configuration: Configuration
}): Promise<Scan> {
    const notes = new Map<string, ScannedNote>()
    const ignored = new Set<string>()
    // The link paths of the published notes: their links are computed again at each scan.
    const linkPaths = new Map<string, string[]>()
    for (const path of await scanVault(input.vault, input.configuration)) {
        let text: string | undefined
        try {
            text = await input.vault.read(path)
        } catch (error) {
            // A note that cannot be read is never taken for a note without the ignore property.
            throw new Error(
                `"${path}" cannot be read: it ${error instanceof Error ? error.message : 'failed'}`,
                { cause: error }
            )
        }
        if (text === undefined) {
            // The file went away during the scan.
            continue
        }
        // The scan left the folders of the deny list out, so only the ignore property is left.
        if (guardOf(path, text, input.configuration) !== undefined) {
            ignored.add(path)
        }
        const source = sourceOf(text)
        if (input.manifest.get(path)?.state === 'published') {
            linkPaths.set(path, linkPathsOf(source))
        }
        notes.set(path, {
            textHash: contentHash(text),
            sourceHash: contentHash(source),
            stateIsSet: setProperty(text, STATE_PROPERTY, 'true') === text,
            namesState: removeProperty(text, STATE_PROPERTY) !== text
        })
    }

    // A link that Obsidian leads to a note under a guard must not lead to
    // another note of the same name. So the notes of the deny list folders
    // are candidates too, by their paths alone, and such a target gives no item.
    const denied = await scanDenied(input.vault, input.configuration)
    const index = new LinkIndex([...notes.keys(), ...denied])
    const guarded = new Set([...ignored, ...denied])
    const lists = {
        changed: [] as string[],
        new: [] as string[],
        technicalUpdates: [] as string[],
        toRemove: [] as string[],
        unchanged: [] as string[]
    }
    for (const [path, entry] of input.manifest) {
        if (entry.state !== 'published') {
            continue
        }
        const note = notes.get(path)
        if (note === undefined || ignored.has(path)) {
            // Missing from this vault, in a folder of the deny list, or with the ignore property.
            lists.toRemove.push(path)
        } else if (note.sourceHash !== entry.sourceHash) {
            lists.changed.push(path)
        } else if (
            entry.cleaningVersion !== CLEANING_VERSION ||
            // A target was made, moved or removed, or a guard now excludes it.
            !sameLinks(linksOfPaths(linkPaths.get(path) ?? [], path, index, guarded), entry.links)
        ) {
            lists.changed.push(path)
            lists.technicalUpdates.push(path)
        } else {
            lists.unchanged.push(path)
        }
    }
    for (const path of notes.keys()) {
        if (input.manifest.get(path)?.state !== 'published' && !ignored.has(path)) {
            lists.new.push(path)
        }
    }
    const queue: QueueLists = {
        changed: sortByCodePoint(lists.changed),
        counts: {
            changed: lists.changed.length,
            new: lists.new.length,
            toRemove: lists.toRemove.length,
            unchanged: lists.unchanged.length
        },
        new: sortByCodePoint(lists.new),
        technicalUpdates: sortByCodePoint(lists.technicalUpdates),
        toRemove: sortByCodePoint(lists.toRemove),
        unchanged: sortByCodePoint(lists.unchanged)
    }
    return {
        queue,
        notes,
        ignored,
        index,
        guarded,
        deniedNames: new Set(
            denied.map((path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase())
        ),
        manifest: input.manifest,
        configuration: input.configuration
    }
}
