import { attachmentsOf, FileReader, sameAttachments } from './attachments.ts'
import { CLEANING_VERSION, sourceOf, STATE_PROPERTY } from './clean.ts'
import type { Configuration } from './configuration.ts'
import { removeProperty, setProperty } from './frontmatter.ts'
import { guardOf, guardOfPath } from './guards.ts'
import { contentHash } from './hash.ts'
import { LinkIndex, linkPathsOf, linksOfPaths, sameLinks } from './links.ts'
import type { ManifestEntry } from './manifest.ts'
import { sortByCodePoint } from './order.ts'
import type { Vault } from './ports.ts'
import { guardName } from '@dsebastien-website/resolver'

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
    /**
     * The notes of `toRemove` whose file this device does not have and that no
     * guard excludes: missing from this vault. Never selected by default (PUB-95).
     */
    readonly missing: readonly string[]
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
    /** The files of the scan and of the folders of the deny list, by their names: what a link is resolved against. */
    readonly index: LinkIndex
    /** The files that a guard excludes: a link to one of them gives no item. */
    readonly guarded: ReadonlySet<string>
    /** The files that the notes link to, each one read one time per run. */
    readonly files: FileReader
    /**
     * True when the file of an attachment of a manifest entry is under a
     * guard now: its path is in a folder of the deny list, or a file of its
     * name is in such a folder, hidden names included, and the scan has no
     * file at its path with the hash of the entry (the file may have moved
     * there, and another file may have its old path: names only, so it fails
     * closed). Such an attachment leaves the attachment storage, whatever the
     * plan holds.
     */
    readonly isGuardedFile: (path: string, hash: string) => Promise<boolean>
    /** Every entry of the manifest, by the vault path of its note. */
    readonly manifest: ReadonlyMap<string, ManifestEntry>
    readonly configuration: Configuration
}

/** The replacement character: it stands for bytes of a name that are not valid Unicode. */
const REPLACEMENT = String.fromCharCode(0xfffd)

/** The files of the scan of the vault: its notes and its other files. */
export interface ScannedFiles {
    /** The vault paths of the notes, in the order of the canonical form. */
    readonly notes: string[]
    /** The vault paths of the other files, which a note can link to. */
    readonly others: string[]
}

/** The vault paths of the files of the vault, outside the folders of the deny list. */
export async function scanVault(vault: Vault, configuration: Configuration): Promise<ScannedFiles> {
    const denied = new Set(configuration.denyList)
    const notes: string[] = []
    const others: string[] = []
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
            } else {
                others.push(path)
            }
        }
    }
    return { notes: sortByCodePoint(notes), others: sortByCodePoint(others) }
}

/**
 * The vault paths of the files in the folders of the deny list, notes and
 * other files. The tool lists those folders for two reasons: to know that a
 * published note moved into one of them, and to know that a link leads to a
 * file under that guard. It reads none of their files, and it writes none of
 * these paths.
 */
export async function scanDenied(
    vault: Vault,
    configuration: Configuration
): Promise<{ readonly files: string[]; readonly names: Set<string> }> {
    const files: string[] = []
    // Every name, also below a name that starts with a dot or that is not
    // valid Unicode: a file moved there is still under the guard. Obsidian
    // does not show them, so they are no candidates of a link.
    const names = new Set<string>()
    const folders = configuration.denyList.map((folder) => ({ folder, hidden: false }))
    for (let next = folders.pop(); next !== undefined; next = folders.pop()) {
        for (const entry of await vault.list(next.folder)) {
            const hidden =
                next.hidden || entry.name.startsWith('.') || entry.name.includes(REPLACEMENT)
            const path = `${next.folder}/${entry.name}`
            if (entry.kind === 'folder') {
                folders.push({ folder: path, hidden })
            } else {
                names.add(guardName(entry.name))
                if (!hidden) {
                    files.push(path)
                }
            }
        }
    }
    return { files, names }
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
    const scanned = await scanVault(input.vault, input.configuration)
    for (const path of scanned.notes) {
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

    // A link that Obsidian leads to a file under a guard must not lead to
    // another file of the same name. So the files of the deny list folders
    // are candidates too, by their paths alone, and such a target gives no item.
    const { files: denied, names: deniedFileNames } = await scanDenied(
        input.vault,
        input.configuration
    )
    const index = new LinkIndex([...notes.keys(), ...scanned.others, ...denied])
    const guarded = new Set([...ignored, ...denied])
    const files = new FileReader(input.vault)
    const others = new Set(scanned.others)
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
        } else {
            const targets = linksOfPaths(linkPaths.get(path) ?? [], path, index, guarded)
            if (
                entry.cleaningVersion !== CLEANING_VERSION ||
                // A target was made, moved or removed, or a guard now excludes it.
                !sameLinks(targets.links, entry.links) ||
                // A file was added, changed, moved or removed, or a guard now excludes it.
                !sameAttachments(await attachmentsOf(targets.files, files), entry.attachments)
            ) {
                lists.changed.push(path)
                lists.technicalUpdates.push(path)
            } else {
                lists.unchanged.push(path)
            }
        }
    }
    for (const path of notes.keys()) {
        if (input.manifest.get(path)?.state !== 'published' && !ignored.has(path)) {
            lists.new.push(path)
        }
    }
    // The notes of the folders of the deny list, by their names: a published
    // note that is missing may have moved there.
    const deniedNames = new Set([...deniedFileNames].filter((name) => name.endsWith('.md')))
    // A published note waits for its removal under a guard when its path is in
    // a folder of the deny list, it has the ignore property, or its file is
    // missing and a note of its name is in a folder of the deny list (it moved
    // there). Every other one is only missing from this vault.
    const missing = lists.toRemove.filter(
        (path) =>
            guardOfPath(path, input.configuration) === undefined &&
            !ignored.has(path) &&
            !deniedNames.has(guardName(path.slice(path.lastIndexOf('/') + 1)))
    )
    const queue: QueueLists = {
        changed: sortByCodePoint(lists.changed),
        counts: {
            changed: lists.changed.length,
            new: lists.new.length,
            toRemove: lists.toRemove.length,
            unchanged: lists.unchanged.length
        },
        missing: sortByCodePoint(missing),
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
        files,
        isGuardedFile: async (path, hash) => {
            if (input.configuration.denyList.some((folder) => path.startsWith(`${folder}/`))) {
                return true
            }
            if (!deniedFileNames.has(guardName(path.slice(path.lastIndexOf('/') + 1)))) {
                return false
            }
            if (!others.has(path)) {
                return true
            }
            // A file that cannot be read now is taken for a moved one.
            try {
                return (await files.facts(path)).hash !== hash
            } catch {
                return true
            }
        },
        manifest: input.manifest,
        configuration: input.configuration
    }
}
