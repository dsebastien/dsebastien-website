import {
    attachmentsOf,
    FileReader,
    sameAttachments,
    sortTooLarge,
    tooLargeOf
} from './attachments.ts'
import type { TooLarge } from './attachments.ts'
import { CLEANING_VERSION, sourceOf, STATE_PROPERTY } from './clean.ts'
import type { Configuration } from './configuration.ts'
import { openProposals } from './edits.ts'
import type { EditEvent, EditsLog } from './edits.ts'
import { removeProperty, setProperty } from './frontmatter.ts'
import { guardOf, guardOfPath } from './guards.ts'
import { contentHash } from './hash.ts'
import { LinkIndex, linkPathsOf, linksOfPaths, sameLinks } from './links.ts'
import type { ManifestEntry } from './manifest.ts'
import {
    firstPart,
    foldedForm,
    isChangedByObsidian,
    isChangedByWindows,
    isRefusedByWindows,
    isReservedRootName,
    obsidianPath,
    obsidianTwins
} from './names.ts'
import { askable, readNoteTypes, sameNoteType } from './note-types.ts'
import type { NoteType } from './note-types.ts'
import { compareCodePoints, sortByCodePoint } from './order.ts'
import { postFrom, postPropertiesOf } from './originals.ts'
import type { PostProperties } from './originals.ts'
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
    /**
     * The notes of `changed` at the new path of a move of `renamed` whose
     * source is not the published source: an edit after the rename, or
     * another note at that path. Their update waits until the selection
     * includes them (decision R67).
     */
    readonly movedEdited: readonly string[]
    /** The candidates. */
    readonly new: readonly string[]
    /**
     * The pairings to confirm: a published note that is missing and a
     * candidate with no manifest entry, with the same source (PUB-62).
     */
    readonly pairings: readonly Move[]
    /**
     * The open proposals of the edits of the guards (`edits.json`), in the
     * order of the log (R69). Apart from the four lists: they are not counted.
     */
    readonly proposals: readonly EditEvent[]
    /** The moves of the new lines of the rename journals that the next publication applies. */
    readonly renamed: readonly Move[]
    /** The notes of `changed` that the author did not edit: the cleaning step gives another result. */
    readonly technicalUpdates: readonly string[]
    /**
     * The published notes of `changed` and `unchanged` that link to a file
     * above the size limit of an attachment, each with the file and its size
     * (issue 72): their update waits, and no plan updates them. Sorted by
     * path, then by file.
     */
    readonly tooLarge: readonly TooLarge[]
    /** The published notes that cannot stay published as they are. */
    readonly toRemove: readonly string[]
    readonly unchanged: readonly string[]
    /**
     * The paths of the unpublished entries of the manifest, as the content
     * store has them: the exact paths that a takedown takes (issue 104). Also
     * an entry whose file this device does not have. Apart from the four
     * lists: they are not counted.
     */
    readonly unpublished: readonly string[]
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
    /**
     * The files of the folders of the deny list that Obsidian shows, by their
     * paths. Obsidian can take a note of the scan for one of them when the
     * two have one Obsidian path (R72): a twin is computed over both.
     */
    readonly denied: readonly string[]
    /** The files that the notes link to, each one read one time per run. */
    readonly files: FileReader
    /**
     * The files above the size limit that the notes at these paths link to
     * (`tooLarge` of a plan): for the candidates of a plan, whose links the
     * scan does not read. Sorted by path, then by file.
     */
    readonly tooLargeOf: (paths: readonly string[]) => Promise<TooLarge[]>
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
    /**
     * The published entries, after the moves, whose `attachments` list a
     * file that is under a guard now (`isGuardedFile`), sorted: the plan
     * names the ones that stay published (`guardedAttachments`).
     */
    readonly guardedEntries: readonly string[]
    /** Every entry of the manifest after the moves of the rename journals, by the vault path of its note. */
    readonly manifest: ReadonlyMap<string, ManifestEntry>
    /** The unpublished entries that leave the manifest because another entry moved into their paths (rule 6 of the moves). */
    readonly displaced: readonly ManifestEntry[]
    /** The entries whose held update ended: their notes have their sources again, and the next publication writes them without `updateHeld`. */
    readonly released: readonly ManifestEntry[]
    /** The journals that the scan read: the plan writes their read marker. */
    readonly journals: JournalState
    /** The warnings of the journals and of the moves, for the report. */
    readonly renameWarnings: readonly RenameWarning[]
    readonly configuration: Configuration
    /** The log of the edits of the guards that the scan read (R69): a plan shows its new events. */
    readonly edits: EditsLog
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
        // The names only: a name that Windows changes is no entry of the
        // vault, but a file moved below it is still under the guard (issue 79).
        for (const entry of await vault.listNames(next.folder)) {
            const hidden =
                next.hidden ||
                entry.name.startsWith('.') ||
                entry.name.includes(REPLACEMENT) ||
                isChangedByWindows(entry.name)
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
 * True when a published note also exists on the main site, and its entry has
 * no verified post or another one than the post URL of the note now: each
 * publication checks it again, with no edit (decision of the author R90).
 */
function checksPostAgain(
    properties: PostProperties | undefined,
    noteType: NoteType | undefined,
    entry: ManifestEntry
): boolean {
    if (properties === undefined) {
        return false
    }
    const post = postFrom(properties, noteType)
    if (!post.inScope) {
        return false
    }
    // With no post URL there is nothing to check: only an old original to clear.
    if (post.url === undefined) {
        return entry.original !== undefined
    }
    return entry.original === undefined || post.url !== entry.original.url
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
    /** The log of the edits of the guards (R69). */
    edits: EditsLog
}): Promise<Scan> {
    const notes = new Map<string, ScannedNote>()
    const ignored = new Set<string>()
    // The paths that a published entry can have after the moves.
    const folded = foldMoves(
        input.manifest.keys(),
        input.journals.lines,
        new Set(
            [...input.manifest]
                .filter(([, entry]) => entry.state === 'unpublished')
                .map(([path]) => path)
        )
    )
    const publishedPaths = new Set<string>()
    for (const [path, entry] of input.manifest) {
        if (entry.state === 'published') {
            publishedPaths.add(path)
            publishedPaths.add(folded.positions.get(path) ?? path)
        }
    }
    // The link paths of the published notes: their links are computed again at each scan.
    const linkPaths = new Map<string, string[]>()
    // What the post on the main site of each published note reads of its properties (issue 55).
    const posts = new Map<string, PostProperties>()
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
            posts.set(path, postPropertiesOf(source))
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
        sourceHashAt: (path) => notes.get(path)?.sourceHash,
        isVaultName: (path) =>
            !path.split('/').some((part) => part.startsWith('.') || part.includes(REPLACEMENT))
    })
    const manifest = moves.manifest
    const index = new LinkIndex([...notes.keys(), ...scanned.others, ...denied])
    const guarded = new Set([...ignored, ...denied])
    const files = new FileReader(input.vault)
    const others = new Set(scanned.others)
    // The type that each published note has now, in one question: never for
    // a note under a guard, and never for a note with a twin, because
    // Obsidian can answer for the twin (R72).
    const twins = obsidianTwins(notes.keys())
    const noteTypes = await noteTypesOf(
        input.noteTypes,
        [...notes.keys()].filter(
            (path) =>
                manifest.get(path)?.state === 'published' && !ignored.has(path) && !twins.has(path)
        )
    )
    const lists = {
        changed: [] as string[],
        new: [] as string[],
        technicalUpdates: [] as string[],
        tooLarge: [] as TooLarge[],
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
            continue
        }
        const targets = linksOfPaths(linkPaths.get(path) ?? [], path, index, guarded)
        // Only the sizes: a file above the limit is never read (issue 72).
        const tooLarge = await tooLargeOf(path, targets.files, files)
        lists.tooLarge.push(...tooLarge)
        if (note.sourceHash !== entry.sourceHash) {
            lists.changed.push(path)
        } else if (
            // The attachments cannot be compared without a read of the file.
            tooLarge.length > 0 ||
            entry.cleaningVersion !== CLEANING_VERSION ||
            // A target was made, moved or removed, or a guard now excludes it.
            !sameLinks(targets.links, entry.links) ||
            // A file was added, changed, moved or removed, or a guard now excludes it.
            !sameAttachments(await attachmentsOf(targets.files, files), entry.attachments) ||
            // The Starter Kit gives the note another type, or the type changed.
            !sameNoteType(noteTypes.get(path), entry.noteType) ||
            // The note also exists on the main site and its post is not
            // verified, or is another one: each publication checks it again
            // (decision of the author R90).
            checksPostAgain(posts.get(path), noteTypes.get(path), entry)
        ) {
            lists.changed.push(path)
            lists.technicalUpdates.push(path)
        } else {
            lists.unchanged.push(path)
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
    // third, the scan did not find its file (decision R64), and no line of a
    // journal moved it elsewhere: the line gives the exact move (issue 105).
    const unpublishedUnderGuard = [...manifest]
        .filter(
            ([path, entry]) =>
                entry.state === 'unpublished' &&
                (guardOfPath(path, input.configuration) !== undefined ||
                    ignored.has(path) ||
                    moves.underGuard.has(path) ||
                    (!notes.has(path) && !moves.movedElsewhere.has(path) && movedUnderGuard(path)))
        )
        .map(([path]) => path)
    const changedPaths = new Set(lists.changed)
    // A moved note whose text is not the published text: the entry gets the
    // mark of a held update, which the publication of the move writes, so
    // the hold lasts until a selection includes the note (R67).
    for (const { to } of moves.moves) {
        const entry = manifest.get(to)
        if (
            entry !== undefined &&
            changedPaths.has(to) &&
            notes.get(to)?.sourceHash !== entry.sourceHash
        ) {
            manifest.set(to, { ...entry, updateHeld: true })
        }
    }
    // A held update whose note has the source of its entry again loses its
    // mark: the next publication writes the entry without it, so a later
    // edit is no held update (decision of the author of 2026-11-26, issue
    // 106). A moved entry is written by its move.
    const movedTo = new Set(moves.moves.map((move) => move.to))
    const released: ManifestEntry[] = []
    for (const [path, entry] of manifest) {
        if (entry.updateHeld === true && notes.get(path)?.sourceHash === entry.sourceHash) {
            const { updateHeld: _held, ...kept } = entry
            manifest.set(path, kept)
            if (!movedTo.has(path)) {
                released.push(kept)
            }
        }
    }
    const isGuardedFile = async (path: string, hash: string): Promise<boolean> => {
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
    }
    // The published entries whose attachments list a file that is under a
    // guard now: a publication would delete that file (rule 8 of "A
    // publication"), and the note would show it as missing.
    const guardedEntries: string[] = []
    for (const [path, entry] of manifest) {
        if (entry.state !== 'published') {
            continue
        }
        for (const attachment of entry.attachments) {
            if (await isGuardedFile(attachment.path, attachment.hash)) {
                guardedEntries.push(path)
                break
            }
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
        missing: sortByCodePoint(missing),
        movedEdited: sortByCodePoint(
            lists.changed.filter((path) => manifest.get(path)?.updateHeld === true)
        ),
        new: sortByCodePoint(lists.new),
        // A note at the new path of a move waits for the publication of the move.
        pairings: pairingsOf(
            missing.filter((path) => !moves.moves.some((move) => move.to === path)),
            lists.new,
            manifest,
            notes
        ),
        proposals: openProposals(input.edits),
        renamed: moves.moves,
        technicalUpdates: sortByCodePoint(lists.technicalUpdates),
        tooLarge: sortTooLarge(lists.tooLarge),
        toRemove: sortByCodePoint(lists.toRemove),
        unchanged: sortByCodePoint(lists.unchanged),
        unpublished: sortByCodePoint(
            [...input.manifest]
                .filter(([, entry]) => entry.state === 'unpublished')
                .map(([path]) => path)
        ),
        unpublishedUnderGuard: sortByCodePoint(unpublishedUnderGuard)
    }
    return {
        queue,
        notes,
        ignored,
        index,
        guarded,
        denied,
        files,
        tooLargeOf: async (paths) => {
            const found: TooLarge[] = []
            for (const path of paths) {
                const text = await input.vault.read(path)
                if (text !== undefined) {
                    const source = sourceOf(text)
                    const targets = linksOfPaths(linkPathsOf(source), path, index, guarded)
                    found.push(...(await tooLargeOf(path, targets.files, files)))
                }
            }
            return sortTooLarge(found)
        },
        isGuardedFile,
        guardedEntries: sortByCodePoint(guardedEntries),
        manifest,
        displaced: moves.displaced,
        released,
        journals: input.journals,
        renameWarnings: [...input.journals.warnings, ...moves.warnings],
        configuration: input.configuration,
        edits: input.edits,
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
 * True when the vault of this device shows the move of the entry from `from`
 * to `to` (rule 2 of the moves): `to` is a path of the vault, and the note at
 * `to` has the source of the entry, or the vault has no note at `from` any
 * more, or a note at both paths with neither of them the source of the entry.
 * In the last two cases the note at `to` can have another source: its update
 * waits for a tick (`movedEdited`, decision R67).
 */
function showsMove(
    vault: {
        inVault: (path: string) => boolean
        isVaultName: (path: string) => boolean
        sourceHashAt: (path: string) => string | undefined
    },
    entry: ManifestEntry,
    from: string,
    to: string
): boolean {
    if (!vault.isVaultName(to)) {
        return false
    }
    if (vault.sourceHashAt(to) === entry.sourceHash || !vault.inVault(from)) {
        return true
    }
    // The old file is still there: it is the note when it has its source, or
    // when the vault has no note at the new path yet.
    return vault.sourceHashAt(from) !== entry.sourceHash && vault.inVault(to)
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
        /** The source hash of the note of the scan at this path. */
        sourceHashAt: (path: string) => string | undefined
        isVaultName: (path: string) => boolean
    }
): {
    readonly manifest: Map<string, ManifestEntry>
    readonly moves: Move[]
    readonly underGuard: Set<string>
    /** The unpublished entries that stay at their paths, moved away by a line or not. */
    readonly leftBehind: ReadonlySet<string>
    /** The unpublished entries that a line moved to a path with no guard where the vault has a file. */
    readonly movedElsewhere: ReadonlySet<string>
    /** The unpublished entries that leave the manifest: another entry moved into the path that their note left (rule 6 of the moves). */
    readonly displaced: ManifestEntry[]
    readonly warnings: RenameWarning[]
} {
    const warnings: RenameWarning[] = [...folded.warnings]
    const underGuard = new Set<string>()
    const final = new Map<string, string>()
    // The unpublished entries that stay at their paths, moved away by a line
    // or not: they do not count at their paths for the collisions when the
    // published note really moved in (rules 5 and 6).
    const leftBehind = new Set<string>()
    // The unpublished entries that a line moved to a path with no guard where
    // the vault has a file: the exact move, so the name rule of the forced
    // removals does not apply to them (issue 105).
    const movedElsewhere = new Set<string>()
    for (const from of sortByCodePoint([...entries.keys()])) {
        const to = folded.positions.get(from) ?? from
        final.set(from, from)
        if (to === from) {
            // An unpublished entry that no line moved gives its path too
            // (decision of the author of 2026-11-26, issue 106).
            if (entries.get(from)?.state === 'unpublished') {
                leftBehind.add(from)
            }
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
        // The line counts as the exact move only when the vault has a file at
        // its new path: a stale line proves nothing, so the name rule of the
        // forced removals still applies (fails closed).
        if (entries.get(from)?.state !== 'published') {
            leftBehind.add(from)
            if (vault.inVault(to)) {
                movedElsewhere.add(from)
            }
            continue
        }
        const entry = entries.get(from)
        if (entry === undefined || !showsMove(vault, entry, from, to)) {
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
        if (isRefusedByWindows(to)) {
            warnings.push({
                path: from,
                message: `the rename journal moves the note to "${to}", a path that Windows cannot hold: it does not move, and it can show as a pairing`
            })
            continue
        }
        if (isChangedByObsidian(to)) {
            warnings.push({
                path: from,
                message: `the rename journal moves the note to "${to}", whose path Obsidian reads as "${obsidianPath(to)}": it does not move, and it can show as a pairing`
            })
            continue
        }
        final.set(from, to)
    }
    // An unpublished entry that stays at its path gives it to a published
    // note that moved into it, only when the note of the scan at that path
    // has the source of that published entry (rules 5 and 6).
    const yields = (from: string): boolean => {
        if (!leftBehind.has(from)) {
            return false
        }
        const holders = [...final].filter(([other, to]) => to === from && other !== from)
        const [holder] = holders
        const entry = holder === undefined ? undefined : entries.get(holder[0])
        return (
            holders.length === 1 &&
            entry?.state === 'published' &&
            vault.sourceHashAt(from) === entry.sourceHash
        )
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
            if (yields(from)) {
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
    const leaving = new Set([...final.keys()].filter((from) => yields(from)))
    const displaced: ManifestEntry[] = []
    const manifest = new Map<string, ManifestEntry>()
    const moves: Move[] = []
    for (const [from, to] of final) {
        const entry = entries.get(from)
        if (entry === undefined) {
            continue
        }
        if (leaving.has(from)) {
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
    return { manifest, moves, underGuard, leftBehind, movedElsewhere, displaced, warnings }
}

/** The entry of a note that moves: its new path, and its former paths (rule 4 of the moves). */
export function movedEntry(entry: ManifestEntry, to: string): ManifestEntry {
    return { ...entry, path: to, formerPaths: formerPathsAfter(entry.formerPaths, entry.path, to) }
}
