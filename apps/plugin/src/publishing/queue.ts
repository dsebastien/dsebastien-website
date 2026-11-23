import { attachmentsOf, FileReader, sameAttachments } from './attachments.ts'
import { CLEANING_VERSION, sourceOf, STATE_PROPERTY } from './clean.ts'
import type { Configuration } from './configuration.ts'
import { removeProperty, setProperty } from './frontmatter.ts'
import { guardOf, guardOfPath } from './guards.ts'
import { contentHash } from './hash.ts'
import { LinkIndex, linkPathsOf, linksOfPaths, sameLinks } from './links.ts'
import type { ManifestEntry } from './manifest.ts'
import { firstPart, foldedForm, isReservedRootName } from './names.ts'
import { askable, readNoteTypes, sameNoteType } from './note-types.ts'
import type { NoteType } from './note-types.ts'
import { compareCodePoints, sortByCodePoint } from './order.ts'
import type { NoteTypes, Vault } from './ports.ts'
import { foldMoves, formerPathsAfter } from './renames.ts'
import type { JournalState, RenameWarning } from './renames.ts'
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
    /**
     * The pairings to confirm: a published note that is missing and a
     * candidate with no manifest entry, with the same source (PUB-62).
     */
    readonly pairings: readonly Move[]
    /** The moves of the new lines of the rename journals that the next publication applies. */
    readonly renamed: readonly Move[]
    /** The notes of `changed` that the author did not edit: the cleaning step gives another result. */
    readonly technicalUpdates: readonly string[]
    /** The published notes that cannot stay published as they are. */
    readonly toRemove: readonly string[]
    readonly unchanged: readonly string[]
    /**
     * The unpublished notes that a guard excludes: forced removals of the next
     * plan, so that their addresses answer 404 and no more 410 (decision R64).
     * Apart from the four lists: they are not counted.
     */
    readonly unpublishedUnderGuard: readonly string[]
}

/** A move of a manifest entry: from its path to its new path. */
// A type alias, not an interface: the canonical form takes any object of data.
export type Move = { readonly from: string; readonly to: string }

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
    /** Every entry of the manifest after the moves of the rename journals, by the vault path of its note. */
    readonly manifest: ReadonlyMap<string, ManifestEntry>
    /** The unpublished entries that leave the manifest because another entry moved into their paths (rule 6 of the moves). */
    readonly displaced: readonly ManifestEntry[]
    /** The journals that the scan read: the plan writes their read marker. */
    readonly journals: JournalState
    /** The warnings of the journals and of the moves, for the report. */
    readonly renameWarnings: readonly RenameWarning[]
    readonly configuration: Configuration
    /** The note type of each published note that the scan found and that no guard excludes, when it has one. */
    readonly noteTypes: ReadonlyMap<string, NoteType>
}

/**
 * The note type of each of these notes, from the Starter Kit, in one
 * question (decision R61). A note with no type is not in the result. It
 * throws when the Starter Kit is missing, fails or gives an answer that the
 * tool cannot read: every type would else leave the site.
 */
export async function noteTypesOf(
    port: NoteTypes,
    paths: readonly string[]
): Promise<Map<string, NoteType>> {
    const question = askable(paths)
    let answer: unknown
    try {
        answer = await port.recognize(question)
    } catch (error) {
        throw new Error(
            `the Obsidian Starter Kit cannot give the note types: ${error instanceof Error ? error.message : 'it failed'}. Nothing can be planned or published without it`,
            { cause: error }
        )
    }
    return readNoteTypes(question, answer)
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
    journals: JournalState
    configuration: Configuration
    noteTypes: NoteTypes
}): Promise<Scan> {
    const notes = new Map<string, ScannedNote>()
    const ignored = new Set<string>()
    // The paths that a published entry can have after the moves.
    const folded = foldMoves(input.manifest.keys(), input.journals.lines)
    const publishedPaths = new Set<string>()
    for (const [path, entry] of input.manifest) {
        if (entry.state === 'published') {
            publishedPaths.add(path)
            publishedPaths.add(folded.positions.get(path) ?? path)
        }
    }
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
        if (publishedPaths.has(path)) {
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
    const moves = applyMoves(input.manifest, folded, {
        underGuard: (path) =>
            guardOfPath(path, input.configuration) !== undefined || ignored.has(path),
        inVault: (path) => notes.has(path),
        isVaultName: (path) =>
            !path.split('/').some((part) => part.startsWith('.') || part.includes(REPLACEMENT))
    })
    const manifest = moves.manifest
    const index = new LinkIndex([...notes.keys(), ...scanned.others, ...denied])
    const guarded = new Set([...ignored, ...denied])
    const files = new FileReader(input.vault)
    const others = new Set(scanned.others)
    // The type that each published note has now, in one question: never for a note under a guard.
    const noteTypes = await noteTypesOf(
        input.noteTypes,
        [...notes.keys()].filter(
            (path) => manifest.get(path)?.state === 'published' && !ignored.has(path)
        )
    )
    const lists = {
        changed: [] as string[],
        new: [] as string[],
        technicalUpdates: [] as string[],
        toRemove: [] as string[],
        unchanged: [] as string[]
    }
    for (const [path, entry] of manifest) {
        if (entry.state !== 'published') {
            continue
        }
        const note = notes.get(path)
        if (note === undefined || ignored.has(path) || moves.underGuard.has(path)) {
            // Missing from this vault, in a folder of the deny list, with the
            // ignore property, or moved under a guard by a line of a journal,
            // also when this device still has the file (the guards win).
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
                !sameAttachments(await attachmentsOf(targets.files, files), entry.attachments) ||
                // The Starter Kit gives the note another type, or the type changed.
                !sameNoteType(noteTypes.get(path), entry.noteType)
            ) {
                lists.changed.push(path)
                lists.technicalUpdates.push(path)
            } else {
                lists.unchanged.push(path)
            }
        }
    }
    for (const path of notes.keys()) {
        if (manifest.get(path)?.state !== 'published' && !ignored.has(path)) {
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
    const movedUnderGuard = (path: string): boolean =>
        deniedNames.has(guardName(path.slice(path.lastIndexOf('/') + 1)))
    const missing = lists.toRemove.filter(
        (path) =>
            guardOfPath(path, input.configuration) === undefined &&
            !ignored.has(path) &&
            !moves.underGuard.has(path) &&
            !movedUnderGuard(path)
    )
    // An unpublished note under a guard, in the same three cases; for the
    // third, the scan did not find its file (decision R64).
    const unpublishedUnderGuard = [...manifest]
        .filter(
            ([path, entry]) =>
                entry.state === 'unpublished' &&
                (guardOfPath(path, input.configuration) !== undefined ||
                    ignored.has(path) ||
                    moves.underGuard.has(path) ||
                    (!notes.has(path) && movedUnderGuard(path)))
        )
        .map(([path]) => path)
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
        // A note at the new path of a move waits for the publication of the move.
        pairings: pairingsOf(
            missing.filter((path) => !moves.moves.some((move) => move.to === path)),
            lists.new,
            manifest,
            notes
        ),
        renamed: moves.moves,
        technicalUpdates: sortByCodePoint(lists.technicalUpdates),
        toRemove: sortByCodePoint(lists.toRemove),
        unchanged: sortByCodePoint(lists.unchanged),
        unpublishedUnderGuard: sortByCodePoint(unpublishedUnderGuard)
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
        manifest,
        displaced: moves.displaced,
        journals: input.journals,
        renameWarnings: [...input.journals.warnings, ...moves.warnings],
        configuration: input.configuration,
        noteTypes
    }
}

/**
 * The pairings of the queue (PUB-62): a source hash of exactly one published
 * note of `missing` and of exactly one candidate that has no manifest entry.
 */
function pairingsOf(
    missing: readonly string[],
    candidates: readonly string[],
    manifest: ReadonlyMap<string, ManifestEntry>,
    notes: ReadonlyMap<string, ScannedNote>
): Move[] {
    const group = (paths: Iterable<[string, string]>): Map<string, string[]> => {
        const groups = new Map<string, string[]>()
        for (const [hash, path] of paths) {
            groups.set(hash, [...(groups.get(hash) ?? []), path])
        }
        return groups
    }
    const gone = group(
        missing.flatMap((path): [string, string][] => {
            const hash = manifest.get(path)?.sourceHash
            return hash === undefined ? [] : [[hash, path]]
        })
    )
    const found = group(
        candidates.flatMap((path): [string, string][] => {
            const hash = notes.get(path)?.sourceHash
            return hash === undefined || manifest.has(path) ? [] : [[hash, path]]
        })
    )
    const pairings: Move[] = []
    for (const [hash, [from, ...others]] of gone) {
        const [to, ...more] = found.get(hash) ?? []
        if (from !== undefined && to !== undefined && others.length === 0 && more.length === 0) {
            pairings.push({ from, to })
        }
    }
    return pairings.sort((one, two) => compareCodePoints(one.from, two.from))
}

/** The vault path of a note without `.md`: the text of its URL. */
function withoutSuffix(path: string): string {
    return path.slice(0, -'.md'.length)
}

/**
 * The moves of the rename journals (`documentation/Canonical Form.md`, "The
 * rename journal"): the entries at their last paths, the moves, the entries
 * that moved under a guard (they stay, and are forced removals), and the
 * warnings of the moves that do not happen.
 */
export function applyMoves(
    entries: ReadonlyMap<string, ManifestEntry>,
    folded: ReturnType<typeof foldMoves>,
    vault: {
        underGuard: (path: string) => boolean
        inVault: (path: string) => boolean
        isVaultName: (path: string) => boolean
    }
): {
    readonly manifest: Map<string, ManifestEntry>
    readonly moves: Move[]
    readonly underGuard: Set<string>
    /** The unpublished entries that leave the manifest: another entry moved into the path that their note left (rule 6 of the moves). */
    readonly displaced: ManifestEntry[]
    readonly warnings: RenameWarning[]
} {
    const warnings: RenameWarning[] = [...folded.warnings]
    const underGuard = new Set<string>()
    const final = new Map<string, string>()
    // The unpublished entries that a line moved away and that stay at their
    // paths: they do not count at their paths for the collisions.
    const leftBehind = new Set<string>()
    for (const from of sortByCodePoint([...entries.keys()])) {
        const to = folded.positions.get(from) ?? from
        final.set(from, from)
        if (to === from) {
            continue
        }
        if (vault.underGuard(to)) {
            // The exact move under a guard: a forced removal (R40, R66), also
            // when this device still has the file (the guards win). But a line
            // that is older than the first publication of a note that this
            // device still has cannot be about that note: a folder line moves
            // every path below the folder, also of a note published later.
            const time = folded.times.get(from) ?? ''
            const entry = entries.get(from)
            if (
                vault.inVault(from) &&
                entry !== undefined &&
                compareCodePoints(time, entry.firstPublished) < 0
            ) {
                warnings.push({
                    path: from,
                    message: `the rename journal moves the note to "${to}", but its line is older than the first publication of the note, and this device still has the note: it does not move`
                })
                continue
            }
            underGuard.add(from)
            continue
        }
        // An unpublished entry does not move: its old address stays gone
        // (R64), and a path that it had only while it was unpublished never
        // becomes a public former path. The guard rule above still applies.
        if (entries.get(from)?.state !== 'published') {
            leftBehind.add(from)
            continue
        }
        if ((vault.inVault(from) && !vault.inVault(to)) || !vault.isVaultName(to)) {
            warnings.push({
                path: from,
                message: `the rename journal moves the note to "${to}", but the vault of this device does not show that move: it does not move, and it can show as a pairing`
            })
            continue
        }
        const name = withoutSuffix(to.slice(to.lastIndexOf('/') + 1))
        if (isReservedRootName(name) || (to.includes('/') && isReservedRootName(firstPart(to)))) {
            warnings.push({
                path: from,
                message: `the rename journal moves the note to "${to}", whose name is a reserved root name of the site: it does not move`
            })
            continue
        }
        final.set(from, to)
    }
    // Two entries at one path, or two published entries with one folded form:
    // the entries of the group that moved do not move, until no such group is left.
    for (let changed = true; changed;) {
        changed = false
        const groups = new Map<string, string[]>()
        const add = (key: string, from: string): void => {
            groups.set(key, [...(groups.get(key) ?? []), from])
        }
        for (const [from, to] of final) {
            if (leftBehind.has(from)) {
                continue
            }
            add(`path\n${to}`, from)
            if (entries.get(from)?.state === 'published') {
                add(`folded\n${foldedForm(withoutSuffix(to))}`, from)
            }
        }
        for (const group of groups.values()) {
            if (group.length < 2) {
                continue
            }
            for (const from of group) {
                const to = final.get(from)
                if (to !== undefined && to !== from) {
                    final.set(from, from)
                    changed = true
                    warnings.push({
                        path: from,
                        message: `the rename journal moves the note to "${to}", where another note of the manifest is, or one that the site gives the same URL: it does not move`
                    })
                }
            }
        }
    }
    // An unpublished entry whose path another entry took leaves the manifest
    // (rule 6 of the moves, issue 105): the published note took the path
    // that the unpublished note left.
    const taken = new Set([...final].filter(([from]) => !leftBehind.has(from)).map(([, to]) => to))
    const displaced: ManifestEntry[] = []
    const manifest = new Map<string, ManifestEntry>()
    const moves: Move[] = []
    for (const [from, to] of final) {
        const entry = entries.get(from)
        if (entry === undefined) {
            continue
        }
        if (leftBehind.has(from) && taken.has(from)) {
            displaced.push(entry)
            warnings.push({
                path: from,
                message: `the rename journal moves this unpublished note away, and another note moved into its path: its entry leaves the manifest, so its other old addresses answer 404 instead of 410`
            })
            continue
        }
        if (to === from) {
            manifest.set(from, entry)
        } else {
            manifest.set(to, movedEntry(entry, to))
            moves.push({ from, to })
        }
    }
    return { manifest, moves, underGuard, displaced, warnings }
}

/** The entry of a note that moves: its new path, and its former paths (rule 4 of the moves). */
export function movedEntry(entry: ManifestEntry, to: string): ManifestEntry {
    return { ...entry, path: to, formerPaths: formerPathsAfter(entry.formerPaths, entry.path, to) }
}
