import { attachmentsOf, keyOf, MAX_ATTACHMENT_SIZE } from './attachments.ts'
import type { Attachment, TooLarge } from './attachments.ts'
import { toCanonicalJson } from './canonical.ts'
import { CLEANING_VERSION, cleanNote, sourceOf, STATE_PROPERTY } from './clean.ts'
import { linksOf } from './links.ts'
import type { CanonicalValue } from './canonical.ts'
import { CONFIGURATION_FILE, isVaultPath, parseConfiguration } from './configuration.ts'
import type { Configuration } from './configuration.ts'
import {
    EDIT_ACTIONS,
    EDITS_FILE,
    editsText,
    eventsSince,
    isLooser,
    makeEvent,
    openProposals,
    parseEdits,
    withEvent
} from './edits.ts'
import type { EditAction, EditEvent, EditsLog } from './edits.ts'
import {
    aliasesOf,
    hasFlowProperties,
    namesInProperties,
    removeProperty,
    setProperty
} from './frontmatter.ts'
import type { Aliases } from './frontmatter.ts'
import { guardOfPath, IGNORE_PROPERTY } from './guards.ts'
import { bytesHash, contentHash, sha256Hex } from './hash.ts'
import { inexactNumberOf, parseJson } from './json.ts'
import type { NoteLink } from './links.ts'
import { MANIFEST_FOLDER, manifestFile, NOTES_FOLDER, noteId, readManifest } from './manifest.ts'
import type { ManifestEntry } from './manifest.ts'
import { isNoteType, sameNoteType } from './note-types.ts'
import type { NoteType } from './note-types.ts'
import { foldedForm, obsidianTwins } from './names.ts'
import { compareCodePoints, sortByCodePoint } from './order.ts'
import { normalSelection, planWithSizes } from './plan.ts'
import type { NormalSelection, PublicationPlan, Selection } from './plan.ts'
import { hasListToRefresh, listsNotRefreshed, liveQueries } from './frozen.ts'
import type { Device, Fetch, LockHolder, NoteTypes, RefreshResult } from './ports.ts'
import { computeQueue, movedEntry, noteTypesOf } from './queue.ts'
import type { Move, PublicationQueue, Scan } from './queue.ts'
import { foldMoves, movedFolder, parseMarkers, readJournals, RENAMES_FILE } from './renames.ts'
import { parseWithdrawn, WITHDRAWN_FILE, withdrawnKeys, withdrawnText } from './withdrawn.ts'
import type { JournalState } from './renames.ts'
import { FACES, isCanonicalTime, isOneLine } from './run.ts'
import type { Face } from './run.ts'

// The operations of the publishing tool. Every face calls these: the plugin,
// and the tests in the place of the command line program, whose Rust twin is
// `cli/src/tool.rs`. No rule of the publishing logic lives in a face.

/** A plan and the id under which it is stored on the device. */
export interface StoredPlan {
    readonly id: string
    readonly plan: PublicationPlan
    /** True when the content store could not be reached and the plan uses the last fetch (PERF-16). */
    readonly offline: boolean
    /** The notes of the plan with a list to refresh that this run did not refresh (PUB-101, R71). */
    readonly listsNotRefreshed: readonly string[]
    /** The notes of the plan with a live query block, which the page drops (REN-14). */
    readonly liveQueries: readonly string[]
    /** The notes that the plan holds: they link to a file above the size limit (issue 72). */
    readonly tooLarge: readonly TooLarge[]
    /** The notes whose text the refresh changed, for the author. Outside the parity rule. */
    readonly listsRefreshed: readonly string[]
    /** Why the refresh did not refresh a note, for the author. Outside the parity rule. */
    readonly refreshProblems: readonly { readonly path: string; readonly message: string }[]
}

export { FACES } from './run.ts'
export type { Face } from './run.ts'

/** What a face gives to a publication. The logic reads no clock and no name of the system. */
export interface Run {
    /** The time of the run, in the canonical form. */
    readonly time: string
    /** The name of the device, for the message of the commit. One line of text. */
    readonly device: string
    /** The face that started the publication. */
    readonly face: Face
}

/** What a publication did. Every list of paths is sorted by path. */
// A type alias, not an interface: the canonical form takes any object of data.
export type PublicationReport = {
    /** The keys of the files that the cleanup deleted from the attachment storage. */
    readonly attachmentsDeleted: readonly string[]
    /** The keys of the files that the publication uploaded to the attachment storage. */
    readonly attachmentsUploaded: readonly string[]
    /** The notes of the plan that were left out, with the reason. */
    readonly failed: readonly { readonly path: string; readonly reason: string }[]
    /** The notes that were removed because a guard excludes them. They left the manifest. */
    readonly forcedRemoved: readonly string[]
    /** The moves of the publication: their old paths are former paths now (R66). */
    readonly moved: readonly Move[]
    /** The notes whose state property was removed. */
    readonly propertyRemoved: readonly string[]
    /** The notes whose state property was set. */
    readonly propertySet: readonly string[]
    /** The notes that were published for the first time, or again after an unpublish. */
    readonly published: readonly string[]
    /** The notes that were unpublished. */
    readonly removed: readonly string[]
    /** The changed notes that the plan did not update. Their live version stays. */
    readonly skipped: readonly string[]
    readonly updated: readonly string[]
    /** What the author must know and what stopped nothing. */
    readonly warnings: readonly { readonly path: string; readonly message: string }[]
}

/** What a takedown did (`documentation/Canonical Form.md`, "A takedown"). Every list of paths is sorted by path. */
// A type alias, not an interface: the canonical form takes any object of data.
export type TakedownReport = {
    /** The keys of the files that the takedown deleted from the attachment storage. */
    readonly attachmentsDeleted: readonly string[]
    /** The notes whose state property was removed. */
    readonly propertyRemoved: readonly string[]
    /**
     * What the attachment storage gave: a file that can still be public. A
     * face ends with an error after the report when this list is not empty.
     */
    readonly storageWarnings: readonly { readonly path: string; readonly message: string }[]
    /** The notes that left the content store with their manifest entries. */
    readonly takenDown: readonly string[]
    /** What the author must know about the state property. */
    readonly warnings: readonly { readonly path: string; readonly message: string }[]
}

/** The form of the id of a plan: 16 hexadecimal digits. An id is never used as a path in another form. */
const PLAN_ID = /^[0-9a-f]{16}$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTextList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'it failed'
}

/** The text of the configuration. It throws when the copy has none. */
async function configurationText(device: Device): Promise<string> {
    const text = await device.store.read(CONFIGURATION_FILE)
    if (text === undefined) {
        // A wrong folder must never read as a content store with an empty
        // deny list: every private folder would be a candidate (R67).
        throw new Error(
            `the copy of the content store has no ${CONFIGURATION_FILE} in its last commit: the folder is not the copy of the content store, or the content store has no configuration yet. Add ${CONFIGURATION_FILE} with the deny list ("denyList"), commit it and push it`
        )
    }
    return text
}

/** Reads the configuration and checks it against the vault. */
async function readConfiguration(
    device: Device,
    journals: JournalState
): Promise<{ configuration: Configuration; hash: string }> {
    const text = await configurationText(device)
    const configuration = parseConfiguration(text)
    // A deny list entry that names no folder would exclude nothing: a renamed
    // folder, or another letter case, would make its notes candidates (GATE-38).
    for (const folder of configuration.denyList) {
        if (!(await device.vault.hasFolder(folder))) {
            // The rename journals can say where the folder went (PUB-91).
            const moved = movedFolder(folder, journals.all)
            const proposal =
                moved !== undefined && (await device.vault.hasFolder(moved))
                    ? `. The rename journal says that it was renamed to "${moved}": put "${moved}" in the deny list`
                    : ''
            throw new Error(
                `the deny list names "${folder}", which is not a folder of the vault. No publication is possible until the deny list is corrected${proposal}`
            )
        }
    }
    return { configuration, hash: contentHash(text) }
}

/** The hash of the manifest: each file with the hash of its text. */
async function manifestHash(device: Device): Promise<string> {
    let lines = ''
    for (const file of await device.store.list(MANIFEST_FOLDER)) {
        lines += `${file}\n${contentHash((await device.store.read(file)) ?? '')}\n`
    }
    return contentHash(lines)
}

/** The state of the device that the queue is computed from. */
interface State {
    readonly scan: Scan
    readonly configurationHash: string
    /** The hash of `renames.json`, or `none`. */
    readonly renamesHash: string
    /** The number of commits of the content store, at the last fetch, that the copy does not have. */
    readonly behind: number
    /** False when the run tried to fetch and the content store could not be reached. */
    readonly reached: boolean
}

/**
 * Checks the content store, reads the configuration and the manifest, and
 * scans the vault. With a fetch (for `plan` and `publish`), it fetches the
 * content store first and stops when the copy is behind it: a copy that did
 * not pull reads an older manifest, and a note that came under a guard since
 * would stay live (issue 70). A copy that was behind at the last fetch stops
 * a plan also without a network.
 */
async function readState(device: Device, fetch: Fetch): Promise<State> {
    const { behind, reached } = await device.store.verify(fetch)
    if (fetch !== 'none') {
        refuseWhenBehind(behind)
    }
    const renames = await device.store.read(RENAMES_FILE)
    const journals = await readJournals(device.renames, parseMarkers(renames))
    const { configuration, hash } = await readConfiguration(device, journals)
    // A log that is not valid stops every run (R69).
    const edits = parseEdits(await device.store.read(EDITS_FILE))
    // So does a list of withdrawn keys that is not valid (issue 120).
    parseWithdrawn(await device.store.read(WITHDRAWN_FILE))
    const manifest = await readManifest(device.store)
    return {
        scan: await computeQueue({
            vault: device.vault,
            manifest,
            journals,
            configuration,
            noteTypes: device.noteTypes,
            edits
        }),
        configurationHash: hash,
        renamesHash: renames === undefined ? 'none' : contentHash(renames),
        behind,
        reached
    }
}

/**
 * Stops when the copy is behind the content store: a copy that did not pull
 * reads an older manifest, and its push would be refused. The tool never
 * pulls by itself (R46, R65).
 */
function refuseWhenBehind(behind: number): void {
    if (behind > 0) {
        throw new Error(
            `the copy of the content store is ${String(behind)} commit(s) behind the content store: another device changed the content store since the last pull. Nothing can be planned, published or taken down until the copy is up to date: pull first (git pull --ff-only origin main)`
        )
    }
}

/** The device with the vault of one run: each folder of the vault is listed one time. */
function forRun(device: Device): Device {
    return { ...device, vault: device.vault.forRun() }
}

/** What the lock of the device holds, for a message: one line. */
function lockMessage(text: string): string {
    return `a publication runs on this device, or one stopped halfway (the lock holds ${text.replace(/\s+/gu, ' ').trim()}). When no publication runs, remove the lock with the unlock command: the next plan, publish or takedown then puts the copy back`
}

/** Stops when the lock of the device is taken: the files of the copy can be half written. */
async function refuseWhenLocked(device: Device): Promise<void> {
    const text = await device.local.readLock()
    if (text !== undefined) {
        throw new Error(lockMessage(text))
    }
}

/** The lock of a run was removed while the run ran, and another run can have taken the copy. */
class LockLost extends Error {}

/**
 * Runs the work with the lock of the device (TOOL-09, PUB-27), and removes the
 * lock at its end when it is still the lock of this run. The work gets a
 * check that throws `LockLost` when the lock is not its own any more: the
 * author ran unlock while it ran.
 */
async function withLock<T>(
    device: Device,
    holder: LockHolder,
    work: (ownLock: () => Promise<void>) => Promise<T>
): Promise<T> {
    const lock = await device.local.lock(holder)
    if (!lock.taken) {
        throw new Error(lockMessage(lock.text))
    }
    const ownLock = async (): Promise<void> => {
        if ((await device.local.readLock()) !== lock.text) {
            throw new LockLost(
                'the lock of this publication was removed while it ran (unlock while a publication runs), and another run can have taken the copy. This run stops here and corrects no property: make a new plan when no other run runs'
            )
        }
    }
    try {
        return await work(ownLock)
    } finally {
        await device.local.release(lock.text)
    }
}

/**
 * Removes the lock of the device that a run left when it stopped halfway. The
 * next plan, publish or takedown puts the copy back. True when a lock was there.
 */
export async function unlock(device: Device): Promise<boolean> {
    return await device.local.unlock()
}

/** The run journal of a publication (`documentation/Canonical Form.md`, "Failure cases"). */
type RunJournal =
    | {
          readonly step: 'write'
          /** True when an earlier publication stopped after its push, and its correction is owed. */
          readonly correctionOwed: boolean
          /** The commit of the copy before the run, or `undefined` when the copy had no commit. */
          readonly head: string | undefined
          /** The paths of the content store that the run can write or remove. */
          readonly paths: readonly string[]
          readonly plan: string
      }
    | { readonly step: 'correct' }

function journalText(journal: RunJournal): string {
    if (journal.step === 'correct') {
        return toCanonicalJson({ step: 'correct' })
    }
    const { head, ...rest } = journal
    return toCanonicalJson(head === undefined ? rest : { ...rest, head })
}

/** True when the path is a path of the content store that a run can write: a note, a manifest entry, or a file of the store. */
function isStorePath(path: string): boolean {
    return (
        isVaultPath(path) &&
        (path === RENAMES_FILE ||
            path === CONFIGURATION_FILE ||
            path === EDITS_FILE ||
            path === WITHDRAWN_FILE ||
            path.startsWith(`${NOTES_FOLDER}/`) ||
            (path.startsWith(`${MANIFEST_FOLDER}/`) && path.split('/').length === 2))
    )
}

/** Reads the run journal of the device. It throws when the journal is not one. */
async function readJournal(device: Device): Promise<RunJournal | undefined> {
    const text = await device.local.loadJournal()
    if (text === undefined) {
        return undefined
    }
    let value: unknown
    try {
        value = parseJson(text)
    } catch {
        value = undefined
    }
    if (isRecord(value)) {
        const { correctionOwed, head, paths, plan, step } = value
        if (step === 'correct' && Object.keys(value).length === 1) {
            return { step }
        }
        if (
            step === 'write' &&
            typeof correctionOwed === 'boolean' &&
            (head === undefined || (typeof head === 'string' && /^[0-9a-f]{40,64}$/u.test(head))) &&
            isTextList(paths) &&
            paths.every(isStorePath) &&
            typeof plan === 'string'
        ) {
            return { step, correctionOwed, head, paths, plan }
        }
    }
    throw new Error(
        'the run journal of this device cannot be read (.git/vault-publish/journal.json of the copy): correct the copy by hand, then remove the journal'
    )
}

/**
 * Puts back what a publication that stopped halfway left (R46). The result is
 * the journal after it: none, or `correct` when the correction of the
 * property is owed.
 */
async function recover(
    device: Device,
    ownLock: () => Promise<void>
): Promise<RunJournal | undefined> {
    const journal = await readJournal(device)
    if (journal?.step !== 'write') {
        return journal
    }
    const result = await device.store.recover(journal.head, journal.paths, journal.plan, ownLock)
    // The journal is the one of the run only while the lock is its own (issue 75).
    await ownLock()
    if (result === 'pushed' || journal.correctionOwed) {
        const after: RunJournal = { step: 'correct' }
        await device.local.saveJournal(journalText(after))
        return after
    }
    await device.local.removeJournal()
    return undefined
}

/**
 * The publication queue: the four lists of what waits for a publication. It
 * writes nothing into the vault and nothing into the content store.
 */
export async function status(given: Device): Promise<PublicationQueue> {
    return (await statusWithEdits(given)).queue
}

/**
 * The publication queue, and the events of the edits of the guards that the
 * next plan shows (R69), from one read of the copy: the publication center
 * states the plan of the choices with both.
 */
export async function statusWithEdits(given: Device): Promise<{
    readonly queue: PublicationQueue
    readonly edits: readonly EditEvent[]
    /** The published entries whose attachments list a file under a guard now (`guardedAttachments` of a plan). */
    readonly guardedEntries: readonly string[]
}> {
    const device = forRun(given)
    await refuseWhenLocked(device)
    if ((await readJournal(device))?.step === 'write') {
        throw new Error(
            'a publication stopped halfway on this device. status writes nothing, so it does not put the copy back: the next plan, publish, takedown or edit puts it back'
        )
    }
    const state = await readState(device, 'none')
    return {
        queue: { ...state.scan.queue, behind: state.behind },
        edits: eventsSince(state.scan.edits),
        guardedEntries: state.scan.guardedEntries
    }
}

/** The source, the cleaned note, the aliases, the links, the attachments and the note type of one note of a plan. */
interface NoteTexts {
    readonly source: string
    readonly aliases: Aliases
    readonly cleaned: string
    readonly links: readonly NoteLink[]
    readonly attachments: readonly Attachment[]
    readonly noteType: NoteType | undefined
}

/** A plan with everything that its publication needs. */
interface Computed {
    readonly plan: PublicationPlan
    /** The selection that gave the plan, as the record holds it. */
    readonly selection: NormalSelection
    /** False when the content store could not be reached and the plan uses the last fetch. */
    readonly reached: boolean
    /** The record of the plan, in the canonical form. */
    readonly record: string
    readonly scan: Scan
    /** The texts of the notes to publish and to update, as the record names them by their hashes. */
    readonly texts: ReadonlyMap<string, NoteTexts>
    /** The notes that the plan holds for the size limit of an attachment (issue 72). */
    readonly tooLarge: readonly TooLarge[]
}

/**
 * Computes the plan of a selection and its record: the plan, the selection,
 * and the state that the plan was computed from, in the canonical form.
 */
async function recordFor(
    device: Device,
    selectionFor: (scan: Scan) => NormalSelection,
    fetch: Fetch
): Promise<Computed> {
    const { scan, configurationHash, renamesHash, reached } = await readState(device, fetch)
    // An unpublish holds every changed note that it does not name: its
    // selection comes from the queue of the same scan.
    const selection = selectionFor(scan)
    const { plan, tooLarge } = await planWithSizes(scan, selection)
    // The published notes got their type in the scan. The new ones of the plan
    // get theirs in one more question.
    // The candidates of the pairings get theirs in the same question (R66).
    const newTypes = await noteTypesOf(
        device.noteTypes,
        sortByCodePoint([...plan.publish, ...selection.pair.map((pairing) => pairing.to)])
    )
    const texts = new Map<string, NoteTexts>()
    const notes: {
        aliases: readonly string[]
        attachments: readonly Attachment[]
        cleanedHash: string
        links: readonly NoteLink[]
        noteType?: NoteType
        path: string
        sourceHash: string
    }[] = []
    // The two lists have no path in common, and each one is sorted.
    for (const path of [...plan.publish, ...plan.update]) {
        const text = await device.vault.read(path)
        if (text === undefined) {
            throw new Error(`"${path}" does not exist in the vault any more`)
        }
        const source = sourceOf(text)
        const cleaned = cleanNote(source)
        const { links, files } = linksOf(source, path, scan.index, scan.guarded)
        const attachments = await attachmentsOf(files, scan.files)
        const aliases = aliasesOf(source)
        const noteType = newTypes.get(path) ?? scan.noteTypes.get(path)
        texts.set(path, { source, aliases, cleaned, links, attachments, noteType })
        notes.push({
            aliases: aliases.aliases,
            attachments,
            cleanedHash: contentHash(cleaned),
            links,
            ...(noteType === undefined ? {} : { noteType }),
            path,
            sourceHash: contentHash(source)
        })
    }
    // In the order of the canonical form: never the default order of texts.
    notes.sort((one, two) => compareCodePoints(one.path, two.path))
    const record = toCanonicalJson({
        plan,
        selection,
        state: {
            configuration: configurationHash,
            journals: scan.journals.hash,
            manifest: await manifestHash(device),
            notes,
            renames: renamesHash
        }
    })
    return { plan, reached, record, scan, selection, texts, tooLarge }
}

/**
 * Computes a publication plan and stores it on the device. It writes nothing
 * into the content of the store, and nothing into the vault but the frozen
 * lists that the refresh of the device updates first (PUB-35, R71).
 */
export async function plan(given: Device, selection: Selection): Promise<StoredPlan> {
    const device = forRun(given)
    await refuseWhenLocked(device)
    // A publication that stopped halfway left files in the copy: they are put
    // back first, with the lock, so that no publication starts in the middle.
    if ((await readJournal(device))?.step === 'write') {
        await withLock(device, { command: 'plan' }, (ownLock) => recover(device, ownLock))
    }
    const normal = normalSelection(selection)
    let computed = await recordFor(device, () => normal, 'try')
    const { reached } = computed
    // The lists of the notes of the plan are refreshed before the plan is
    // final (PUB-35, R71): when the refresh wrote a note, the plan is
    // computed again, so the record holds the refreshed text (PUB-92).
    // Only the notes with a list to refresh (rule 4) are asked: a first
    // publication of every note asks far fewer.
    // A note with a twin is not asked: Obsidian can refresh the twin (R72),
    // also a file of the deny list, which the scan does not read.
    const twins = obsidianTwins([...computed.scan.notes.keys(), ...computed.scan.denied])
    const paths = sortByCodePoint(
        [...computed.plan.publish, ...computed.plan.update].filter((path) => {
            const source = computed.texts.get(path)?.source
            return source !== undefined && hasListToRefresh(source) && !twins.has(path)
        })
    )
    let refresh: RefreshResult = {
        refreshed: new Set(),
        written: new Map(),
        wrote: false,
        problems: []
    }
    if (device.lists !== undefined && paths.length > 0) {
        refresh = await device.lists.refresh(paths)
        if (refresh.wrote) {
            // The copy was just fetched: the second scan reads it as it is.
            computed = await recordFor(device, () => normal, 'none')
        }
    }
    return {
        id: await store(device, computed),
        plan: computed.plan,
        offline: !reached,
        ...listsOfPlan(computed, refresh.refreshed),
        tooLarge: computed.tooLarge,
        listsRefreshed: sortByCodePoint([...refresh.written.keys()]),
        refreshProblems: refresh.problems
    }
}

/** The two lists of the frozen lists of a plan (rules 5 and 6 of "The frozen lists of a note"). */
function listsOfPlan(
    computed: Computed,
    refreshed: ReadonlySet<string>
): Pick<StoredPlan, 'listsNotRefreshed' | 'liveQueries'> {
    const paths = [...computed.plan.publish, ...computed.plan.update]
    const sources = new Map([...computed.texts].map(([path, texts]) => [path, texts.source]))
    return {
        listsNotRefreshed: listsNotRefreshed(paths, sources, refreshed),
        liveQueries: liveQueries(paths, sources)
    }
}

/** Stores the record of a plan on the device. The result is its id, which names the record (outside the parity rule, TOOL-30). */
async function store(device: Device, computed: Computed): Promise<string> {
    const id = sha256Hex(computed.record).slice(0, 16)
    await device.local.save(id, computed.record)
    return id
}

/** Reads the selection of a stored record. It throws when the record is not one. */
function selectionOf(record: string, id: string): NormalSelection {
    let value: unknown
    try {
        value = parseJson(record)
    } catch {
        value = undefined
    }
    const selection = isRecord(value) ? value['selection'] : undefined
    if (isRecord(selection)) {
        const { accept, hold, include, pair, remove } = selection
        if (
            isTextList(accept) &&
            isTextList(hold) &&
            isTextList(include) &&
            isTextList(remove) &&
            Array.isArray(pair) &&
            pair.every(
                (item) =>
                    isRecord(item) &&
                    Object.keys(item).length === 2 &&
                    typeof item['from'] === 'string' &&
                    typeof item['to'] === 'string'
            )
        ) {
            const pairs = (pair as Record<string, string>[]).map((item) => ({
                from: item['from'] ?? '',
                to: item['to'] ?? ''
            }))
            return normalSelection({ accept, hold, include, pair: pairs, remove })
        }
    }
    throw new Error(`the stored plan ${id} cannot be read`)
}

/** One file of the content store to write, or to remove when it has no text. */
interface StoreFile {
    readonly path: string
    readonly text: string | undefined
}

/**
 * The files of the copy as they were before a publication touched them. A
 * failure puts them back from here, not from a commit of the copy: a copy can
 * have no commit, and a file of it can be in no commit.
 */
/** The mark of a file whose text could not be read before its removal. */
const UNKNOWN = Symbol('unknown')

/**
 * Puts back the files of the copy after a run that failed before its push
 * arrived, and then settles the journal of the run, but only when every file
 * is back and git took the commit back: else the journal stays, so the next
 * run puts the copy back. The result is the end of the message of the
 * failure. A run that lost the lock never calls it: it would put its files
 * back over the work of the other run.
 */
async function putCopyBack(
    device: Device,
    backup: Backup,
    head: string | undefined,
    settle: () => Promise<void>,
    nextRuns = 'plan, publish or takedown'
): Promise<string> {
    const stayed = await backup.putAllBack()
    if (stayed.length === 0 && (await device.store.head()) === head) {
        await settle()
    }
    return stayed.length === 0
        ? 'and the files of the copy are as they were before'
        : `and these files of the copy could not be put back: ${stayed.join(', ')}. The next ${nextRuns} puts them back`
}

class Backup {
    readonly #store: Device['store']
    /** The text of each file before the run, `undefined` for no file, `UNKNOWN` for a file that cannot be read as text. */
    readonly #before = new Map<string, string | undefined | typeof UNKNOWN>()

    constructor(store: Device['store']) {
        this.#store = store
    }

    /** Writes a file, or removes it when there is no text. True when the file changed. */
    async apply(file: StoreFile): Promise<boolean> {
        if (!this.#before.has(file.path)) {
            let before: string | undefined | typeof UNKNOWN
            try {
                before = await this.#store.read(file.path)
            } catch (error) {
                // A removal needs no text: a cleaned note under a guard that
                // is not valid UTF-8, or a link, must still leave the store.
                // An undo leaves such a file to the run journal, and the next
                // run puts it back from git.
                if (file.text !== undefined) {
                    throw error
                }
                before = UNKNOWN
            }
            this.#before.set(file.path, before)
        }
        if (file.text === undefined) {
            return await this.#store.remove(file.path)
        }
        // A file that already has the text is no change: the commit must hold
        // exactly the paths that changed. A copy that converts line ends
        // writes the files of its commit with Windows line ends.
        const before = this.#before.get(file.path)
        if (typeof before === 'string' && before.replaceAll('\r\n', '\n') === file.text) {
            return false
        }
        await this.#store.write(file.path, file.text)
        return true
    }

    /**
     * Puts these files back as they were. Every file is tried, also when one
     * fails. The result is the paths that could not be put back.
     */
    async putBack(paths: Iterable<string>): Promise<string[]> {
        const failed: string[] = []
        for (const path of paths) {
            if (!this.#before.has(path)) {
                continue
            }
            const text = this.#before.get(path)
            if (text === UNKNOWN) {
                failed.push(path)
                continue
            }
            try {
                if (text === undefined) {
                    await this.#store.remove(path)
                } else {
                    await this.#store.write(path, text)
                }
                this.#before.delete(path)
            } catch {
                failed.push(path)
            }
        }
        return failed
    }

    /** Puts every file back that the publication touched. */
    async putAllBack(): Promise<string[]> {
        return await this.putBack([...this.#before.keys()])
    }
}

/** A failure that stops the whole publication. */
class Stop extends Error {}

/**
 * Writes the files of one note. They are one unit: when a write fails, the
 * files are put back as they were, and the error goes to the caller. When they
 * cannot be put back, the whole publication stops: a file that stayed would
 * be read as published at the next run.
 *
 * @returns the paths that changed
 */
async function applyUnit(journal: Backup, files: readonly StoreFile[]): Promise<string[]> {
    const changed: string[] = []
    try {
        for (const file of files) {
            if (await journal.apply(file)) {
                changed.push(file.path)
            }
        }
    } catch (error) {
        const stayed = await journal.putBack(files.map((file) => file.path))
        if (stayed.length > 0) {
            throw new Stop(
                `the files of a note could not be written, and ${stayed.join(', ')} could not be put back: ${messageOf(error)}`,
                { cause: error }
            )
        }
        throw error
    }
    return changed
}

/** The manifest entry of a note after its publication or its update. */
function entryOf(
    path: string,
    texts: NoteTexts,
    before: ManifestEntry | undefined,
    time: string
): ManifestEntry {
    const hashes = {
        aliases: texts.aliases.aliases,
        attachments: texts.attachments,
        cleanedHash: contentHash(texts.cleaned),
        cleaningVersion: CLEANING_VERSION,
        links: texts.links,
        ...(texts.noteType === undefined ? {} : { noteType: texts.noteType }),
        sourceHash: contentHash(texts.source)
    }
    if (before === undefined) {
        return {
            ...hashes,
            firstPublished: time,
            formerPaths: [],
            id: noteId(path, time),
            lastPublished: time,
            path,
            state: 'published'
        }
    }
    // The identity and the first date stay. A technical update does not move
    // the last date, nor a publication again of a text that did not change:
    // the author did not edit the note (PUB-24, PUB-71).
    const edited = before.sourceHash !== hashes.sourceHash
    // A note that has no type now loses the type of its entry, and an update
    // ends a held update (R67).
    const { noteType: _before, updateHeld: _held, ...kept } = before
    return {
        ...kept,
        ...hashes,
        lastPublished: edited ? time : before.lastPublished,
        state: 'published'
    }
}

/**
 * A warning for each reserved alias of each note that the publication
 * published or updated: the alias gets no URL, because the file of the site
 * wins (decision R47).
 */
function reservedAliasWarnings(
    texts: ReadonlyMap<string, NoteTexts>,
    paths: readonly string[]
): { path: string; message: string }[] {
    return paths.flatMap((path) =>
        (texts.get(path)?.aliases.reserved ?? []).map((alias) => ({
            path,
            message: `the alias "${alias}" is a reserved root name of the site: it gets no URL`
        }))
    )
}

/** One warning for each published or updated note with a live query (rule 8 of "The frozen lists of a note"). */
function liveQueryWarnings(
    texts: ReadonlyMap<string, NoteTexts>,
    paths: readonly string[]
): { path: string; message: string }[] {
    return liveQueries(paths, new Map([...texts].map(([path, note]) => [path, note.source]))).map(
        (path) => ({
            path,
            message:
                'the note has a live Dataview or Bases block with no frozen form: the page does not show it (REN-14)'
        })
    )
}

/** The warning of a note that changed between the read of the tool and its write. */
const CHANGED_DURING_RUN = `the note changed during the publication: its ${STATE_PROPERTY} property is corrected at the next publication`

/**
 * Corrects the state property of the notes of the scan, after a push that
 * succeeded (PUB-13): a published note has it with the value true, and every
 * other note of the scan does not have it. A note is written only when its
 * text changes, and never when it changed since the scan.
 */
async function correctState(
    device: Device,
    scan: Scan,
    published: ReadonlySet<string>
): Promise<Pick<PublicationReport, 'propertyRemoved' | 'propertySet' | 'warnings'>> {
    const propertyRemoved: string[] = []
    const propertySet: string[] = []
    const warnings: { path: string; message: string }[] = []
    for (const [path, note] of scan.notes) {
        const isPublished = published.has(path)
        if (isPublished ? note.stateIsSet : !note.namesState) {
            continue
        }
        try {
            const text = await device.vault.read(path)
            if (text === undefined || contentHash(text) !== note.textHash) {
                warnings.push({ path, message: CHANGED_DURING_RUN })
                continue
            }
            const write = await writeState(device, path, text, isPublished)
            if (write.written) {
                ;(isPublished ? propertySet : propertyRemoved).push(path)
            } else {
                warnings.push({ path, message: write.warning })
            }
        } catch (error) {
            warnings.push({
                path,
                message: `the ${STATE_PROPERTY} property could not be corrected: ${messageOf(error)}`
            })
        }
    }
    return { propertyRemoved, propertySet, warnings }
}

/** What `writeState` did with a note: written, or left with the warning that says why. */
type StateWrite = { readonly written: true } | { readonly written: false; readonly warning: string }

/** Sets the state property of a note to true, or removes it. It throws when the write fails. */
async function writeState(
    device: Device,
    path: string,
    text: string,
    isPublished: boolean
): Promise<StateWrite> {
    // A new line below a line in the flow form of YAML (`{ }`, `[ ]`) is not
    // valid YAML. The note stays as the author wrote it.
    if (hasFlowProperties(text)) {
        return {
            written: false,
            warning: `the properties of the note are in the flow form of YAML ({ } or [ ]), and the tool does not write into that form: correct the ${STATE_PROPERTY} property by hand`
        }
    }
    const wanted = isPublished
        ? setProperty(text, STATE_PROPERTY, 'true')
        : removeProperty(text, STATE_PROPERTY)
    // The write must not change what the guard reads. In an odd form of the
    // properties, a line of the ignore property can belong to the state
    // property, or the new lines can close properties that were open. Such a
    // note is never written.
    if (namesInProperties(wanted, IGNORE_PROPERTY) !== namesInProperties(text, IGNORE_PROPERTY)) {
        return {
            written: false,
            warning: `the ${STATE_PROPERTY} property cannot be corrected with no change to what the ignore property says: correct it by hand`
        }
    }
    if (!(await device.vault.write(path, wanted, text))) {
        return { written: false, warning: CHANGED_DURING_RUN }
    }
    return { written: true }
}

/**
 * The keys of the files of the attachment storage that the published notes of
 * a manifest use. An attachment whose file is under a guard now is used by no
 * note, also when an entry that the plan held still lists it.
 */
async function usedKeys(
    manifest: ReadonlyMap<string, ManifestEntry>,
    isGuarded: Scan['isGuardedFile'],
    keepsGuarded: KeepsGuarded = NEVER_KEEPS
): Promise<Set<string>> {
    const keys = new Set<string>()
    for (const [path, entry] of manifest) {
        if (entry.state === 'published') {
            for (const attachment of entry.attachments) {
                if (keepsGuarded(path) || !(await isGuarded(attachment.path, attachment.hash))) {
                    keys.add(keyOf(attachment.hash))
                }
            }
        }
    }
    return keys
}

/**
 * The two files of a note in the content store: its cleaned note and its
 * manifest entry. A forced removal and a takedown remove both (PUB-84).
 */
function filesOfNote(path: string, id: string): readonly [string, string] {
    return [`${NOTES_FOLDER}/${path}`, manifestFile(id)]
}

/**
 * The keys of the attachments of the published entries of a manifest, with
 * no guard check: a takedown reads no file of the vault.
 */
function publishedKeys(manifest: ReadonlyMap<string, ManifestEntry>): Set<string> {
    const keys = new Set<string>()
    for (const entry of manifest.values()) {
        if (entry.state === 'published') {
            for (const attachment of entry.attachments) {
                keys.add(keyOf(attachment.hash))
            }
        }
    }
    return keys
}

/** The form of the name of a file of the attachment storage: a key, or a key that is being written. */
const STORAGE_NAME = /^(?:[0-9a-f]{64}|\.[0-9a-f]{64}\.part)$/

/**
 * The files that macOS and Windows put into a folder by themselves: a cleanup
 * leaves them with no warning (decision of the author R79). Only these exact
 * names: any other name that is not a key still gives a warning.
 */
const SYSTEM_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** The uploads of one publication to the attachment storage (PUB-39). */
class Uploads {
    readonly #device: Device
    #present: Set<string> | undefined
    /** The keys that this run uploaded, in the order of the uploads. */
    readonly uploaded: string[] = []

    constructor(device: Device) {
        this.#device = device
    }

    /**
     * Uploads each attachment whose key the storage does not have yet. The
     * bytes are read from the vault again, and must have the hash of the
     * record: a file that changed since the plan is not uploaded.
     */
    async upload(attachments: readonly Attachment[]): Promise<void> {
        for (const attachment of attachments) {
            const key = keyOf(attachment.hash)
            // The storage is listed one time, before the first upload: a
            // publication with no upload, a takedown for example, never
            // needs the storage.
            this.#present ??= new Set(await this.#device.attachments.list())
            const present = this.#present
            if (present.has(key)) {
                continue
            }
            // A file of another size, or above the size limit, is not read (issue 72).
            const sized =
                attachment.size <= MAX_ATTACHMENT_SIZE &&
                (await this.#device.vault.size(attachment.path)) === attachment.size
            const bytes = sized ? await this.#device.vault.readBytes(attachment.path) : undefined
            if (bytes === undefined || bytesHash(bytes) !== attachment.hash) {
                throw new Error(
                    `the file "${attachment.path}" changed since the plan, and it is not uploaded`
                )
            }
            await this.#device.attachments.put(key, bytes)
            present.add(key)
            this.uploaded.push(key)
        }
    }

    /**
     * Deletes the uploads of this run that no published entry of the manifest
     * lists (PUB-93). Every upload is tried. The result is the keys that
     * could not be deleted.
     */
    async takeBack(
        manifest: ReadonlyMap<string, ManifestEntry>,
        isGuarded: Scan['isGuardedFile']
    ): Promise<string[]> {
        const used = await usedKeys(manifest, isGuarded)
        const stayed: string[] = []
        for (const key of this.uploaded) {
            if (used.has(key)) {
                continue
            }
            try {
                await this.#device.attachments.remove(key)
            } catch {
                stayed.push(key)
            }
        }
        return stayed
    }
}

/**
 * True when a cleanup counts as used the files under a guard that the
 * published entry at this path lists (rule 10 of "The edits of the
 * guards"): a run of an agent face never deletes such a file unless its
 * `accept` names the entry.
 */
type KeepsGuarded = (path: string) => boolean

/** The cleanup of a run of the face plugin: a file under a guard counts for no note. */
const NEVER_KEEPS: KeepsGuarded = () => false

/**
 * The text of `withdrawn.json` after a publication whose manifest is
 * `after`, or `undefined` for no file (issue 120, rule 8 of a publication):
 * the earlier withdrawn keys and the keys that the guards withdraw from the
 * manifest before and after the run, less the keys that a published entry
 * after the run lists from a file under no guard. The guard alone decides
 * (decision of the author of 2026-11-26): a run of an agent face keeps such
 * a file in the folder of its device (rule 10), but its key is withdrawn
 * all the same, so it leaves the object storage of the host.
 */
async function withdrawnAfter(
    device: Device,
    scan: Scan,
    after: ReadonlyMap<string, ManifestEntry>
): Promise<string | undefined> {
    const guarded = async (manifest: ReadonlyMap<string, ManifestEntry>): Promise<string[]> => {
        const used = await usedKeys(manifest, scan.isGuardedFile)
        return [...publishedKeys(manifest)].filter((key) => !used.has(key))
    }
    return withdrawnText(
        withdrawnKeys({
            earlier: parseWithdrawn(await device.store.read(WITHDRAWN_FILE)),
            guardedBefore: await guarded(scan.manifest),
            guardedAfter: await guarded(after),
            usedAfter: await usedKeys(after, scan.isGuardedFile)
        })
    )
}

/** What the cleanups of a run keep (rule 10): for an agent face, the guarded files of every entry that `accept` does not name. */
function keepsGuardedFor(face: Face, selection: NormalSelection): KeepsGuarded {
    if (face === 'plugin') {
        return NEVER_KEEPS
    }
    const accepted = new Set(selection.accept)
    return (path) => !accepted.has(path)
}

/**
 * Cleans the attachment storage: every file whose name is not the key of an
 * attachment of a published entry goes (PUB-82, PUB-84, PUB-93). It reads no
 * file of the storage. A name that is not in the form of a key is not a file
 * of the storage: it stays, with a warning, so a folder given by mistake
 * loses no file. A deletion that fails gives a warning, and the next
 * publication tries again.
 */
async function cleanStorage(
    device: Device,
    manifest: ReadonlyMap<string, ManifestEntry>,
    isGuarded: Scan['isGuardedFile'],
    keepsGuarded: KeepsGuarded = NEVER_KEEPS
): Promise<{
    readonly deleted: string[]
    readonly uploaded: string[]
    readonly warnings: { path: string; message: string }[]
}> {
    const unused = await deleteUnused(device, await usedKeys(manifest, isGuarded, keepsGuarded))
    if (unused.names === undefined) {
        return { deleted: unused.deleted, uploaded: [], warnings: unused.warnings }
    }
    const repaired = await repairStorage(device, manifest, isGuarded, new Set(unused.names))
    return {
        deleted: unused.deleted,
        uploaded: repaired.uploaded,
        warnings: [...unused.warnings, ...repaired.warnings]
    }
}

/**
 * Deletes every file of the attachment storage whose name is a key, or a key
 * that is being written, and is not one of the used keys. A name that is not
 * in the form of a key stays, with a warning. The result has the names of the
 * storage, or `undefined` when it could not be listed.
 */
async function deleteUnused(
    device: Device,
    used: ReadonlySet<string>
): Promise<{
    readonly deleted: string[]
    readonly names: readonly string[] | undefined
    readonly warnings: { path: string; message: string }[]
}> {
    const deleted: string[] = []
    const warnings: { path: string; message: string }[] = []
    let names: string[]
    try {
        names = await device.attachments.list()
    } catch (error) {
        warnings.push({
            path: '',
            message: `the attachment storage could not be listed, and it is cleaned at the next publication: ${messageOf(error)}`
        })
        return { deleted, names: undefined, warnings }
    }
    for (const name of sortByCodePoint(names)) {
        if (used.has(name) || SYSTEM_FILES.has(name)) {
            continue
        }
        if (!STORAGE_NAME.test(name)) {
            warnings.push({
                path: name,
                message:
                    'the attachment storage holds a file whose name is not a key, and the tool leaves it: is the folder of the storage the right one?'
            })
            continue
        }
        try {
            if (await device.attachments.remove(name)) {
                deleted.push(name)
            }
        } catch (error) {
            warnings.push({
                path: name,
                message: `the file could not be deleted from the attachment storage, and the next publication tries again: ${messageOf(error)}`
            })
        }
    }
    return { deleted, names, warnings }
}

/**
 * Uploads again every file that a published entry uses and that the storage
 * does not have (R46): the cleanup of another device can delete an upload
 * that this device made before its push. The bytes come from the vault path
 * of an attachment with that key, and must have its hash. The attachments are
 * tried in the order of the paths of the notes, then in the order of each
 * list. A file under a guard now is never uploaded again.
 */
async function repairStorage(
    device: Device,
    manifest: ReadonlyMap<string, ManifestEntry>,
    isGuarded: Scan['isGuardedFile'],
    present: ReadonlySet<string>
): Promise<{
    readonly uploaded: string[]
    readonly warnings: { path: string; message: string }[]
}> {
    const wanted = new Map<string, Attachment[]>()
    const entries = [...manifest].sort(([one], [two]) => compareCodePoints(one, two))
    for (const [, entry] of entries) {
        if (entry.state !== 'published') {
            continue
        }
        for (const attachment of entry.attachments) {
            const key = keyOf(attachment.hash)
            if (present.has(key) || (await isGuarded(attachment.path, attachment.hash))) {
                continue
            }
            wanted.set(key, [...(wanted.get(key) ?? []), attachment])
        }
    }
    const uploaded: string[] = []
    const warnings: { path: string; message: string }[] = []
    for (const key of sortByCodePoint([...wanted.keys()])) {
        const attachments = wanted.get(key) ?? []
        let found: { path: string; bytes: Uint8Array } | undefined
        for (const attachment of attachments) {
            let bytes: Uint8Array | undefined
            try {
                // A file of another size, or above the size limit, is not read (issue 72).
                if (
                    attachment.size <= MAX_ATTACHMENT_SIZE &&
                    (await device.vault.size(attachment.path)) === attachment.size
                ) {
                    bytes = await device.vault.readBytes(attachment.path)
                }
            } catch {
                bytes = undefined
            }
            if (bytes !== undefined && bytesHash(bytes) === attachment.hash) {
                found = { path: attachment.path, bytes }
                break
            }
        }
        if (found === undefined) {
            warnings.push({
                path: attachments[0]?.path ?? '',
                message:
                    'the file is missing from the attachment storage, and the vault does not have its bytes any more: its note shows it as missing until its next update'
            })
            continue
        }
        try {
            await device.attachments.put(key, found.bytes)
            uploaded.push(key)
            warnings.push({
                path: found.path,
                message:
                    'the file was missing from the attachment storage (the cleanup of another device can delete it), and it is uploaded again'
            })
        } catch (error) {
            warnings.push({
                path: found.path,
                message: `the file is missing from the attachment storage, and it could not be uploaded again: ${messageOf(error)}`
            })
        }
    }
    return { uploaded, warnings }
}

/**
 * Every path of the content store that the publication of a plan can write or
 * remove: the cleaned note and the manifest entry of each of its notes.
 */
function storePathsOf(plan: PublicationPlan, scan: Scan, time: string): string[] {
    const paths = new Set<string>()
    // The entry of a move of a journal is at its new path in the scan, and
    // the entry of a pairing is still at its old path.
    const ids = new Map([...scan.manifest].map(([path, entry]) => [path, entry.id]))
    const journalMoves = new Set(scan.queue.renamed.map((move) => `${move.from}\n${move.to}`))
    for (const { from, to } of plan.move) {
        const id = journalMoves.has(`${from}\n${to}`) ? ids.get(to) : ids.get(from)
        if (id !== undefined) {
            ids.set(to, id)
            for (const file of [...filesOfNote(from, id), `${NOTES_FOLDER}/${to}`]) {
                paths.add(file)
            }
        }
    }
    for (const path of [...plan.forcedRemove, ...plan.publish, ...plan.update, ...plan.remove]) {
        for (const file of filesOfNote(path, ids.get(path) ?? noteId(path, time))) {
            paths.add(file)
        }
    }
    for (const entry of [...scan.displaced, ...scan.released]) {
        paths.add(manifestFile(entry.id))
    }
    if (scan.journals.read) {
        paths.add(RENAMES_FILE)
    }
    // The publication marks the events of the plan as shown (R69).
    if (plan.edits.length > 0) {
        paths.add(EDITS_FILE)
    }
    return sortByCodePoint([...paths])
}

/** What the writes of a plan did. */
interface Written {
    readonly report: Omit<
        PublicationReport,
        | 'attachmentsDeleted'
        | 'attachmentsUploaded'
        | 'propertyRemoved'
        | 'propertySet'
        | 'warnings'
    >
    /** The paths of the content store that changed. */
    readonly written: readonly string[]
    /** The manifest after the writes, by the vault path of each note. */
    readonly manifest: ReadonlyMap<string, ManifestEntry>
}

/** The files of one note to write or to remove, and its entry after the write. */
interface Unit {
    readonly files: readonly StoreFile[]
    readonly entry: ManifestEntry
    /** The attachments to upload before the files are written. */
    readonly attachments: readonly Attachment[]
}

/**
 * Writes the files of a plan into the copy, and commits and pushes them. The
 * moves and the forced removals come first: when one fails, the whole publication stops. A
 * note whose uploads or files fail is left out and reported (PUB-26).
 */
async function writeAll(
    device: Device,
    journal: Backup,
    uploads: Uploads,
    computed: Computed,
    run: Run & {
        /** The id of the plan, for the message of the commit. */
        readonly plan: string
        /** Throws when the lock of the run is not its own any more. */
        readonly ownLock: () => Promise<void>
    }
): Promise<Written> {
    const { scan, texts } = computed
    const lists = computed.plan
    const written: string[] = []
    const manifest = new Map(scan.manifest)
    // The moves come first (R66): the published version moves as it is, and a
    // move that fails stops the whole publication, as a forced removal does.
    // A forced removal can take the new path of a move.
    // The entry of a move of a journal is at its new path in the scan, and
    // the entry of a pairing is still at its old path.
    const journalMoves = new Set(scan.queue.renamed.map((move) => `${move.from}\n${move.to}`))
    const removing = new Set([...lists.remove, ...lists.forcedRemove])
    const targets = new Set<string>()
    // In three phases, so that a move into a path that another move leaves,
    // and a swap, lose no text: every old text is read first, then the old
    // files that no move writes again are removed, then the new files are
    // written.
    const steps: { move: Move; entry: ManifestEntry; text: string | undefined }[] = []
    const fail = (move: Move, error: unknown): Stop =>
        new Stop(
            `the note "${move.from}" could not be moved to "${move.to}" in the content store: ${messageOf(error)}`,
            { cause: error }
        )
    for (const move of lists.move) {
        try {
            let entry: ManifestEntry | undefined
            if (journalMoves.has(`${move.from}\n${move.to}`)) {
                entry = manifest.get(move.to)
            } else {
                const before = manifest.get(move.from)
                entry = before === undefined ? undefined : movedEntry(before, move.to)
                manifest.delete(move.from)
            }
            if (entry === undefined) {
                throw new Error('the note has no manifest entry')
            }
            manifest.set(move.to, entry)
            targets.add(move.to)
            let text: string | undefined
            if (entry.state === 'published') {
                const from = `${NOTES_FOLDER}/${move.from}`
                text = await device.store.read(from)
                if (text === undefined) {
                    throw new Error(`the copy has no ${from}`)
                }
            }
            steps.push({ move, entry, text })
        } catch (error) {
            throw fail(move, error)
        }
    }
    const rewritten = new Set(
        steps
            .filter((step) => step.text !== undefined && !removing.has(step.move.to))
            .map((step) => step.move.to)
    )
    for (const { move, text } of steps) {
        try {
            if (text !== undefined && !rewritten.has(move.from)) {
                const from = `${NOTES_FOLDER}/${move.from}`
                if (await journal.apply({ path: from, text: undefined })) {
                    written.push(from)
                }
            }
        } catch (error) {
            throw fail(move, error)
        }
    }
    for (const { move, entry, text } of steps) {
        try {
            const files: StoreFile[] = [
                { path: manifestFile(entry.id), text: toCanonicalJson(entry) }
            ]
            if (text !== undefined && !removing.has(move.to)) {
                files.push({ path: `${NOTES_FOLDER}/${move.to}`, text })
            }
            for (const file of files) {
                if (await journal.apply(file)) {
                    written.push(file.path)
                }
            }
        } catch (error) {
            throw fail(move, error)
        }
    }
    // An unpublished entry whose path a move took leaves the manifest with the
    // move (rule 6 of the moves): its note has no cleaned note in the store.
    for (const entry of scan.displaced) {
        try {
            if (await journal.apply({ path: manifestFile(entry.id), text: undefined })) {
                written.push(manifestFile(entry.id))
            }
        } catch (error) {
            throw new Stop(
                `the entry of the unpublished note "${entry.path}" could not leave the manifest: ${messageOf(error)}`,
                { cause: error }
            )
        }
    }
    // An entry whose held update ended is written without its mark (issue 106).
    for (const entry of scan.released) {
        try {
            const file = { path: manifestFile(entry.id), text: toCanonicalJson(entry) }
            if (await journal.apply(file)) {
                written.push(file.path)
            }
        } catch (error) {
            throw new Stop(
                `the entry of the note "${entry.path}" could not be written without its held update: ${messageOf(error)}`,
                { cause: error }
            )
        }
    }
    // Then the forced removals, which follow the takedown rule: the
    // note leaves the manifest (PUB-21, PUB-84). When one fails, the whole
    // publication stops: no note is published while a note under a guard
    // stays live.
    for (const path of lists.forcedRemove) {
        try {
            const entry = manifest.get(path)
            if (entry === undefined) {
                throw new Error('the note has no manifest entry')
            }
            for (const file of filesOfNote(path, entry.id)) {
                if (await journal.apply({ path: file, text: undefined })) {
                    written.push(file)
                }
            }
            manifest.delete(path)
        } catch (error) {
            throw new Stop(
                `a guard excludes "${path}", and it could not be removed from the content store: ${messageOf(error)}`,
                { cause: error }
            )
        }
    }
    const failed: { path: string; reason: string }[] = []
    const done = { published: [] as string[], updated: [] as string[], removed: [] as string[] }
    const apply = async (path: string, list: string[], unit: () => Unit): Promise<void> => {
        try {
            const { files, entry, attachments } = unit()
            // The uploads come first: a note whose file is not in the storage is never published.
            await uploads.upload(attachments)
            written.push(...(await applyUnit(journal, files)))
            manifest.set(path, entry)
            list.push(path)
        } catch (error) {
            if (error instanceof Stop) {
                throw error
            }
            // The move of the note already changed its files (rule 4 of a publication).
            if (targets.has(path)) {
                throw new Stop(
                    `the note "${path}" moved, and its update failed: ${messageOf(error)}`,
                    { cause: error }
                )
            }
            // A failure of one note leaves that note out (PUB-26).
            failed.push({ path, reason: messageOf(error) })
        }
    }
    const noteUnit = (path: string): Unit => {
        const noteTexts = texts.get(path)
        if (noteTexts === undefined) {
            throw new Error('the plan has no text for the note')
        }
        const entry = entryOf(path, noteTexts, manifest.get(path), run.time)
        return {
            files: [
                { path: `${NOTES_FOLDER}/${path}`, text: noteTexts.cleaned },
                { path: manifestFile(entry.id), text: toCanonicalJson(entry) }
            ],
            entry,
            attachments: noteTexts.attachments
        }
    }
    for (const path of lists.publish) {
        await apply(path, done.published, () => noteUnit(path))
    }
    for (const path of lists.update) {
        await apply(path, done.updated, () => noteUnit(path))
    }
    for (const path of lists.remove) {
        await apply(path, done.removed, () => {
            const entry = manifest.get(path)
            if (entry === undefined) {
                throw new Error('the note has no manifest entry')
            }
            const unpublished: ManifestEntry = { ...entry, state: 'unpublished' }
            return {
                files: [
                    { path: `${NOTES_FOLDER}/${path}`, text: undefined },
                    { path: manifestFile(entry.id), text: toCanonicalJson(unpublished) }
                ],
                entry: unpublished,
                attachments: []
            }
        })
    }

    // The read marker of the journals goes with the same commit (R66).
    if (scan.journals.read) {
        if (
            await journal.apply({
                path: RENAMES_FILE,
                text: toCanonicalJson(scan.journals.markers)
            })
        ) {
            written.push(RENAMES_FILE)
        }
    }
    // The events that the plan showed are marked as shown, in the same
    // commit, so the next plan shows only the newer ones (R69). A
    // publication never makes the file.
    if (lists.edits.length > 0) {
        const log: EditsLog = {
            edits: scan.edits.edits,
            published: scan.edits.published + lists.edits.length
        }
        if (await journal.apply({ path: EDITS_FILE, text: editsText(log) })) {
            written.push(EDITS_FILE)
        }
    }
    // The keys that the guards withdrew, in the same commit (issue 120): every
    // deployment deletes them from the object storage of the host.
    const withdrawn = await withdrawnAfter(device, scan, manifest)
    if (await journal.apply({ path: WITHDRAWN_FILE, text: withdrawn })) {
        written.push(WITHDRAWN_FILE)
    }
    const planned = new Set([...lists.update, ...lists.remove])
    const skipped = scan.queue.changed.filter((path) => !planned.has(path))
    const report = {
        failed: failed.sort((one, two) => compareCodePoints(one.path, two.path)),
        forcedRemoved: lists.forcedRemove,
        moved: lists.move,
        ...done,
        skipped
    }
    if (written.length > 0) {
        await run.ownLock()
        await device.store.commitAndPush(
            [
                `Publish: ${String(done.published.length)} new, ${String(done.updated.length)} updated, ${String(done.removed.length)} removed, ${String(lists.forcedRemove.length)} forced, ${String(skipped.length)} skipped, ${String(lists.move.length)} moved`,
                '',
                `Device: ${run.device}`,
                `Face: ${run.face}`,
                // The recovery of a run that stopped halfway finds its commit by this line.
                `Plan: ${run.plan}`
            ].join('\n'),
            [...new Set(written)]
        )
    }
    return { report, written: [...new Set(written)], manifest }
}

/**
 * Applies exactly one plan, by its id.
 *
 * It computes the record of the plan again: when the new record is not the
 * stored one, the plan is stale and nothing is published. The forced
 * removals come first: when one fails, nothing is published. Then the
 * attachments go to the attachment storage, and the cleaned notes and the
 * manifest entries go to the content store in one commit, which is pushed. A
 * note whose uploads or files fail is left out and reported. Only after the
 * push, the state property is corrected in the vault. Then every file of the
 * attachment storage that no published note uses is deleted.
 */
export async function publish(given: Device, id: string, run: Run): Promise<PublicationReport> {
    const device = forRun(given)
    checkRun(run)
    if (!PLAN_ID.test(id)) {
        throw new Error(`"${id}" is not the id of a plan: an id is 16 hexadecimal digits`)
    }
    const holder: LockHolder = {
        command: 'publish',
        device: run.device,
        face: run.face,
        time: run.time
    }
    return await withLock(device, holder, (ownLock) => apply(device, id, run, ownLock))
}

/** Checks what a face gives to a run: the time, the name of the device and the face. */
function checkRun(run: Run): void {
    if (!isCanonicalTime(run.time)) {
        throw new Error(
            `the time of the run must be a real date and time in UTC, to the second: "${run.time}" is not`
        )
    }
    if (!isOneLine(run.device)) {
        throw new Error('the name of the device must be one line of text')
    }
    if (!FACES.includes(run.face)) {
        throw new Error(`"${run.face}" is not a face of the tool`)
    }
}

/**
 * Unpublishes the named published notes in one step (PUB-80, R65): the plan
 * of the selection that removes them and holds every other changed note is
 * stored, then applied as `publish` applies a plan, with one lock of the
 * device for both. Only the named notes leave, with the forced removals that
 * every plan holds.
 */
export async function unpublish(
    given: Device,
    paths: readonly string[],
    run: Run,
    /** The forced removals and the notes of `guardedAttachments` that the author named (rule 10). */
    accept: readonly string[] = []
): Promise<PublicationReport> {
    const device = forRun(given)
    checkRun(run)
    if (paths.length === 0) {
        throw new Error('an unpublish names at least one note')
    }
    const remove = new Set(paths)
    const holder: LockHolder = {
        command: 'publish',
        device: run.device,
        face: run.face,
        time: run.time
    }
    return await withLock(device, holder, async (ownLock) => {
        // A publication that stopped halfway is put back first. When it
        // stopped after its push, the correction of the property is owed.
        const owed = (await recover(device, ownLock))?.step === 'correct'
        // One fetch and one scan: the plan is applied as it was computed, so
        // it cannot be stale.
        const computed = await recordFor(
            device,
            (scan) =>
                normalSelection({
                    accept,
                    include: [],
                    hold: scan.queue.changed.filter((path) => !remove.has(path)),
                    remove: [...remove]
                }),
            'must'
        )
        // Only the author lets an agent take an entry away (rule 10).
        refuseUnaccepted(computed.plan, computed.selection, run.face)
        const id = await store(device, computed)
        return await applyCurrent(device, id, run, ownLock, owed, computed)
    })
}

/**
 * Takes the named notes down at once (`documentation/Canonical Form.md`, "A
 * takedown"; PUB-81 to PUB-84, PUB-99, business rule 16): each note leaves
 * the content store with its manifest entry, in one commit that is pushed,
 * with no plan. Then the files of the attachment storage that no published
 * note uses go, and the state property leaves the notes. It reads no plan,
 * scans no vault and asks no Starter Kit, so nothing but the copy can stop it.
 */
export async function takedown(
    given: Device,
    paths: readonly string[],
    run: Run
): Promise<TakedownReport> {
    const device = forRun(given)
    checkRun(run)
    if (paths.length === 0) {
        throw new Error('a takedown names at least one note')
    }
    for (const path of paths) {
        if (!isVaultPath(path)) {
            throw new Error(`"${path}" is not a vault path`)
        }
    }
    const named = sortByCodePoint([...new Set(paths)])
    const holder: LockHolder = {
        command: 'takedown',
        device: run.device,
        face: run.face,
        time: run.time
    }
    return await withLock(device, holder, (ownLock) => takeDownLocked(device, named, run, ownLock))
}

/** The takedown of the named notes, with the lock of the device. */
async function takeDownLocked(
    device: Device,
    named: readonly string[],
    run: Run,
    ownLock: () => Promise<void>
): Promise<TakedownReport> {
    // A publication that stopped halfway is put back first. When it stopped
    // after its push, the correction of the property is owed: the next
    // publication makes it.
    const owed = (await recover(device, ownLock))?.step === 'correct'
    // The copy must follow the content store: an older manifest would miss a
    // note, and the push would be refused.
    refuseWhenBehind((await device.store.verify('must')).behind)
    const manifest = await readManifest(device.store)
    // First the files of the storage that no published note uses: a takedown
    // that stopped after its push left the files of its notes there, and its
    // notes have no entry any more, so this run stops below when it names
    // them again. No other run could clean the storage when no publication
    // can run (PUB-99).
    await ownLock()
    const early = await deleteUnused(device, publishedKeys(manifest))
    const unknown = named.find((path) => !manifest.has(path))
    if (unknown !== undefined) {
        throw new Error(
            `"${unknown}" is the path of no manifest entry, and a takedown needs the exact path that the manifest names. Nothing is taken down${nearPaths(unknown, manifest)}${await movesTo(device, unknown, manifest)}${cleanupLines(early)}`
        )
    }
    const entries = named.flatMap((path) => manifest.get(path) ?? [])
    // The id names the takedown in the journal and in the message of its
    // commit, so a recovery finds the commit. It is outside the parity rule.
    const id = sha256Hex(
        toCanonicalJson({ manifest: await manifestHash(device), takedown: named })
    ).slice(0, 16)
    const paths = sortByCodePoint(entries.flatMap((entry) => filesOfNote(entry.path, entry.id)))
    const head = await device.store.head()
    await ownLock()
    await device.local.saveJournal(
        journalText({ step: 'write', correctionOwed: owed, head, paths, plan: id })
    )
    const journal = new Backup(device.store)
    try {
        const written: string[] = []
        for (const path of paths) {
            if (await journal.apply({ path, text: undefined })) {
                written.push(path)
            }
        }
        await ownLock()
        const count = named.length === 1 ? '1 note' : `${String(named.length)} notes`
        await device.store.commitAndPush(
            [
                `Takedown: ${count}`,
                '',
                `Device: ${run.device}`,
                `Face: ${run.face}`,
                // The recovery of a run that stopped halfway finds its commit by this line.
                `Plan: ${id}`
            ].join('\n'),
            written
        )
    } catch (error) {
        // Another run took the copy: this run touches nothing of it any more.
        if (error instanceof LockLost) {
            throw error
        }
        const files = await putCopyBack(device, journal, head, async () => {
            if (owed) {
                await device.local.saveJournal(journalText({ step: 'correct' }))
            } else {
                await device.local.removeJournal()
            }
        })
        throw new Error(`${messageOf(error)}. Nothing is taken down, ${files}`, { cause: error })
    }
    // The push arrived. When another run took the copy, this run changes
    // nothing more: the other run owns the journal.
    await ownLock()
    await device.local.saveJournal(journalText({ step: 'correct' }))
    const after = new Map(manifest)
    for (const path of named) {
        after.delete(path)
    }
    // The files go first: they are public. No file of the vault is read, so a
    // file under a guard that a published entry lists waits for the cleanup of
    // the next publication.
    const storage = await deleteUnused(device, publishedKeys(after))
    // The two cleanups give the same warning for a name that is not a key:
    // it is written one time.
    const storageWarnings = mergeWarnings(early, storage)
    const property = await removeState(device, named)
    if (!owed) {
        await device.local.removeJournal()
    }
    return {
        attachmentsDeleted: sortByCodePoint([...early.deleted, ...storage.deleted]),
        propertyRemoved: property.propertyRemoved,
        storageWarnings: storageWarnings.sort(byPath),
        takenDown: named,
        warnings: property.warnings.sort(byPath)
    }
}

/** The order of warnings: by their paths, in the order of the code points. */
function byPath(one: { readonly path: string }, two: { readonly path: string }): number {
    return compareCodePoints(one.path, two.path)
}

/**
 * The warnings of the two cleanups of a takedown, each one time. A warning of
 * the first cleanup about a file that the second one deleted is left out.
 */
function mergeWarnings(
    early: { readonly warnings: readonly { path: string; message: string }[] },
    late: {
        readonly deleted: readonly string[]
        readonly warnings: readonly { path: string; message: string }[]
    }
): { path: string; message: string }[] {
    const deleted = new Set(late.deleted)
    const seen = new Set<string>()
    const merged: { path: string; message: string }[] = []
    for (const warning of [...early.warnings, ...late.warnings]) {
        // A name of the storage can hold a line break: a key of joined texts
        // could be the key of another warning.
        const key = JSON.stringify([warning.path, warning.message])
        if (!seen.has(key) && !deleted.has(warning.path)) {
            seen.add(key)
            merged.push(warning)
        }
    }
    return merged
}

/**
 * The characters that the refusal of a takedown removes at the two ends of a
 * named path before it looks for the paths near it: the code points of the
 * Unicode property White_Space, and U+FEFF. `trim()` is not used: it removes
 * U+FEFF and not U+0085, and `trim` of Rust does the opposite.
 */
const SPACES = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff
])

/** The text without the characters of `SPACES` at its two ends. */
function withoutSpacesAtTheEnds(text: string): string {
    let start = 0
    let end = text.length
    // Each code point of the set is one unit of UTF-16.
    while (start < end && SPACES.has(text.charCodeAt(start))) start += 1
    while (end > start && SPACES.has(text.charCodeAt(end - 1))) end -= 1
    return text.slice(start, end)
}

/** The folded forms that a named path gives, also with the end `.md` added. */
function nearForms(path: string): Set<string> {
    const typed = withoutSpacesAtTheEnds(path)
    return new Set([foldedForm(typed), foldedForm(`${typed}.md`)])
}

/**
 * The paths of the manifest that a path names in another letter case or
 * Unicode form, or without its end `.md`, as the end of the message of a
 * refusal. The site resolves such an address to the note, so the refusal
 * must never read as "already gone". A folded form names one published note
 * at most (URL contract, rule 9), but unpublished entries can share it.
 */
function nearPaths(path: string, manifest: ReadonlyMap<string, ManifestEntry>): string {
    const forms = nearForms(path)
    const near = sortByCodePoint([...manifest.keys()].filter((key) => forms.has(foldedForm(key))))
    return near.length === 0
        ? ''
        : `. The manifest names: ${near.map((key) => `"${key}"`).join(', ')}`
}

/**
 * The moves of the new lines of the rename journals whose new path a path
 * names, also in another letter case or Unicode form or without its end
 * `.md`, as the end of the message of a refusal (issue 105): until a
 * publication applies the move, the manifest has the note at its old path.
 * A journal or a marker that cannot be read gives nothing: the refusal
 * stays a refusal.
 */
async function movesTo(
    device: Device,
    path: string,
    manifest: ReadonlyMap<string, ManifestEntry>
): Promise<string> {
    let positions: ReadonlyMap<string, string>
    try {
        const journals = await readJournals(
            device.renames,
            parseMarkers(await device.store.read(RENAMES_FILE))
        )
        positions = foldMoves(manifest.keys(), journals.lines).positions
    } catch {
        return ''
    }
    const forms = nearForms(path)
    const moves = sortByCodePoint([...positions.keys()])
        .map((from) => ({ from, to: positions.get(from) ?? from }))
        .filter(({ from, to }) => from !== to && forms.has(foldedForm(to)))
    return moves
        .map(
            ({ from, to }) =>
                `. A rename journal moves "${from}" to "${to}", and the next publication applies the move: until then, a takedown names "${from}"`
        )
        .join('')
}

/** The most lines of a list in the message of a refusal. */
const MOST_LINES = 20

/** What the first cleanup of a takedown did, as the end of the message of a refusal. */
function cleanupLines(early: {
    readonly deleted: readonly string[]
    readonly warnings: readonly { path: string; message: string }[]
}): string {
    const more = (count: number): string =>
        count > MOST_LINES ? `, and ${String(count - MOST_LINES)} more` : ''
    const deleted =
        early.deleted.length === 0
            ? ''
            : `\nThe takedown deleted ${String(early.deleted.length)} file(s) of the attachment storage that no published note uses: ${early.deleted.slice(0, MOST_LINES).join(', ')}${more(early.deleted.length)}`
    const warnings = warningLines(early.warnings.slice(0, MOST_LINES))
    const hidden =
        early.warnings.length > MOST_LINES
            ? `\n- and ${String(early.warnings.length - MOST_LINES)} more warnings`
            : ''
    return `${deleted}${warnings}${hidden}`
}

/**
 * Removes the state property of the notes that were taken down, when the
 * vault has them at exactly their paths. A note in a folder of the deny list
 * is never read or written. Without a configuration that can be read, no note
 * is written.
 */
async function removeState(
    device: Device,
    paths: readonly string[]
): Promise<{
    readonly propertyRemoved: string[]
    readonly warnings: { path: string; message: string }[]
}> {
    const propertyRemoved: string[] = []
    const warnings: { path: string; message: string }[] = []
    let configuration: Configuration
    try {
        configuration = parseConfiguration(await device.store.read(CONFIGURATION_FILE))
    } catch (error) {
        warnings.push({
            path: '',
            message: `the configuration of the content store cannot be read, so the ${STATE_PROPERTY} property of the notes that were taken down is not removed: remove it by hand (${messageOf(error)})`
        })
        return { propertyRemoved, warnings }
    }
    for (const path of paths) {
        if (guardOfPath(path, configuration) !== undefined) {
            continue
        }
        try {
            const text = await device.vault.read(path)
            if (text === undefined || removeProperty(text, STATE_PROPERTY) === text) {
                continue
            }
            const write = await writeState(device, path, text, false)
            if (write.written) {
                propertyRemoved.push(path)
            } else {
                warnings.push({ path, message: write.warning })
            }
        } catch (error) {
            warnings.push({
                path,
                message: `the ${STATE_PROPERTY} property could not be removed: ${messageOf(error)}`
            })
        }
    }
    return { propertyRemoved, warnings }
}

/**
 * The warnings of a cleanup of the attachment storage, as the end of the
 * message of a refusal: nothing when there is none (issue 77).
 */
function warningLines(warnings: readonly { path: string; message: string }[]): string {
    if (warnings.length === 0) return ''
    // A line break of a name of the storage is written as \\n: one warning, one line.
    const lines = warnings.map(({ path, message }) =>
        path === '' ? `- ${message}` : `- ${path.replaceAll('\n', '\\n')}: ${message}`
    )
    return `\nThe cleanup of the attachment storage gave these warnings:\n${lines.join('\n')}`
}

/** The type of a note as a line of a refusal: its name, or `no type`. */
function typeText(noteType: NoteType | undefined): string {
    return noteType === undefined ? 'no type' : `"${noteType.name}"`
}

/** The note types of the notes of a record, by their paths. */
function recordTypes(record: string): Map<string, NoteType | undefined> {
    let parsed: unknown
    try {
        parsed = parseJson(record)
    } catch {
        parsed = undefined
    }
    const state = isRecord(parsed) ? parsed['state'] : undefined
    const notes = isRecord(state) && Array.isArray(state['notes']) ? state['notes'] : []
    const types = new Map<string, NoteType | undefined>()
    for (const note of notes) {
        if (isRecord(note) && typeof note['path'] === 'string') {
            const noteType = note['noteType']
            types.set(note['path'], isNoteType(noteType) ? noteType : undefined)
        }
    }
    return types
}

/**
 * The notes of both records whose note type is another one in the new record
 * (issue 96, R83): one line each, `- <path>: <type in the plan> in the plan,
 * <type now> now`, in the order of the records. A line break of a path is
 * written `\n`.
 */
function noteTypeChanges(stored: string, current: string): string[] {
    const before = recordTypes(stored)
    const lines: string[] = []
    for (const [path, now] of recordTypes(current)) {
        if (!before.has(path)) continue
        const was = before.get(path)
        if (sameNoteType(was, now)) continue
        const other =
            was !== undefined && now !== undefined && was.name === now.name
                ? ', with another display name, prefix or suffix'
                : ''
        lines.push(
            `- ${path.replaceAll('\n', '\\n')}: ${typeText(was)} in the plan, ${typeText(now)} now${other}`
        )
    }
    return lines
}

/** The publication of a plan, with the lock of the device. */
async function apply(
    device: Device,
    id: string,
    run: Run,
    ownLock: () => Promise<void>
): Promise<PublicationReport> {
    // A publication that stopped halfway is put back first. When it stopped
    // after its push, the correction of the property is owed.
    const owed = (await recover(device, ownLock))?.step === 'correct'
    const record = await device.local.load(id)
    if (record === undefined) {
        throw new Error(`there is no plan with the id ${id} on this device`)
    }
    const selection = selectionOf(record, id)
    const current = await recordFor(device, () => selection, 'must')
    if (current.record !== record) {
        const { scan } = current
        // The run fetched and the copy follows the content store: the
        // storage can be cleaned, so a file that came under a guard leaves it
        // also when the plan is stale.
        // A run of an agent face keeps the guarded files of the entries
        // that its accept does not name (rule 10).
        const cleanup = await cleanStorage(
            device,
            scan.manifest,
            scan.isGuardedFile,
            keepsGuardedFor(run.face, selection)
        )
        const types = noteTypeChanges(record, current.record)
        throw new Error(
            types.length > 0
                ? `the plan ${id} is stale: the note type of a note of the plan changed since the plan was made. Make a new plan\n${types.join('\n')}\nOther changes can also make the plan stale.${warningLines(cleanup.warnings)}`
                : `the plan ${id} is stale: a note of the plan, the publication queue, a rename journal, the configuration or the content store changed. Make a new plan${warningLines(cleanup.warnings)}`
        )
    }
    // Only the author lets an agent take an entry away (rule 10).
    refuseUnaccepted(current.plan, selection, run.face)
    return await applyCurrent(device, id, run, ownLock, owed, current)
}

/**
 * The writes of a plan whose record was just computed, with the lock of the
 * device: the journal, the files, the commit and the push, the correction of
 * the property and the cleanup of the storage. `owed` is true when an earlier
 * publication still owes its correction.
 */
async function applyCurrent(
    device: Device,
    id: string,
    run: Run,
    ownLock: () => Promise<void>,
    owed: boolean,
    current: Computed
): Promise<PublicationReport> {
    const { scan } = current
    // The journal comes before the first write into the copy: a run that
    // stops halfway is put back by the next one. A plan with no note still
    // writes the withdrawn keys when they change (issue 120).
    const planned = storePathsOf(current.plan, scan, run.time)
    const paths =
        planned.length > 0 ||
        (await withdrawnAfter(device, scan, scan.manifest)) !==
            (await device.store.read(WITHDRAWN_FILE))
            ? sortByCodePoint([...planned, WITHDRAWN_FILE])
            : planned
    const head = await device.store.head()
    await ownLock()
    if (paths.length > 0) {
        await device.local.saveJournal(
            journalText({ step: 'write', correctionOwed: owed, head, paths, plan: id })
        )
    }
    /** The journal after the run: `correct` while a correction is owed, else none. */
    const settle = async (correct: boolean): Promise<void> => {
        if (correct) {
            await device.local.saveJournal(journalText({ step: 'correct' }))
        } else if (paths.length > 0) {
            await device.local.removeJournal()
        }
    }
    const journal = new Backup(device.store)
    const uploads = new Uploads(device)
    let outcome: Written
    try {
        outcome = await writeAll(device, journal, uploads, current, { ...run, plan: id, ownLock })
    } catch (error) {
        // Another run took the copy: this run touches nothing of it any more,
        // or it would put its files back over the work of the other run.
        if (error instanceof LockLost) {
            throw error
        }
        // An upload that stays would be public with no entry.
        const kept = await uploads.takeBack(scan.manifest, scan.isGuardedFile)
        const files = await putCopyBack(device, journal, head, async () => {
            await settle(owed)
        })
        const storage =
            kept.length === 0
                ? ''
                : `. These uploads could not be deleted from the attachment storage, and the next publication deletes them: ${kept.join(', ')}`
        throw new Error(`${messageOf(error)}. Nothing is published, ${files}${storage}`, {
            cause: error
        })
    }
    const { report, written, manifest } = outcome
    // The push arrived, but when another run took the copy, this run changes
    // nothing more: the other run owns the journal.
    await ownLock()
    // With nothing to commit there is no push, and without a push no property
    // is corrected, unless an earlier run pushed and stopped before its
    // correction.
    const correct = written.length > 0 || owed
    await settle(correct)
    let correction: Pick<PublicationReport, 'propertyRemoved' | 'propertySet' | 'warnings'> = {
        propertyRemoved: [],
        propertySet: [],
        warnings: []
    }
    if (correct) {
        // The push succeeded: the manifest of the copy is the manifest of the
        // content store. The vault now says the same.
        const published = new Set(
            [...manifest].filter(([, entry]) => entry.state === 'published').map(([path]) => path)
        )
        correction = await correctState(device, scan, published)
    }
    // The copy follows the content store: the run fetched it and was not
    // behind, and a push, when there was one, succeeded.
    // A run of an agent face keeps the guarded files of the entries that
    // its accept does not name (rule 10), also with nothing to commit.
    const cleanup = await cleanStorage(
        device,
        manifest,
        scan.isGuardedFile,
        keepsGuardedFor(run.face, current.selection)
    )
    if (correct) {
        await device.local.removeJournal()
    }
    return {
        ...report,
        attachmentsDeleted: cleanup.deleted,
        attachmentsUploaded: sortByCodePoint([...uploads.uploaded, ...cleanup.uploaded]),
        ...correction,
        warnings: [
            ...scan.renameWarnings,
            ...reservedAliasWarnings(current.texts, [...report.published, ...report.updated]),
            ...liveQueryWarnings(current.texts, [...report.published, ...report.updated]),
            ...correction.warnings,
            ...cleanup.warnings
        ].sort((one, two) => compareCodePoints(one.path, two.path))
    }
}

/** What the `guards` command gives (`documentation/Canonical Form.md`, "The edits of the guards"). */
// A type alias, not an interface: the canonical form takes any object of data.
export type GuardsReport = {
    /** The deny list of the configuration, in its order. */
    readonly denyList: readonly string[]
    /** The events since the last publication, as the plan shows them. */
    readonly edits: readonly EditEvent[]
    /** The open proposals, as the queue shows them. */
    readonly proposals: readonly EditEvent[]
}

/**
 * The guards (R69): the deny list, the events of the edits of the guards
 * since the last publication, and the open proposals. It reads no network,
 * takes no lock and writes nothing. It reads the configuration without the
 * check of GATE-38, so an agent can read a deny list that stops every
 * publication, and correct it with an edit (PUB-91).
 */
export async function guards(given: Device): Promise<GuardsReport> {
    const device = forRun(given)
    // The files of the copy can be half written while a run holds the lock.
    await refuseWhenLocked(device)
    await device.store.verify('none')
    const configuration = parseConfiguration(await configurationText(device))
    const log = parseEdits(await device.store.read(EDITS_FILE))
    return {
        denyList: configuration.denyList,
        edits: eventsSince(log),
        proposals: openProposals(log)
    }
}

/** An edit of the guards: its action and its path (a folder, or the vault path of a note). */
export interface EditRequest {
    readonly action: EditAction
    readonly path: string
}

/**
 * What the author confirms: the id of the proposal, the entries that would
 * leave the content store, and the published notes that would lose an
 * attachment, as the dialog showed them.
 */
export interface Confirmation {
    readonly proposal: string
    readonly removes: readonly string[]
    readonly affects: readonly string[]
    /** For an `allow`: the published notes that would link to a file of the folder, as the dialog showed them (rule 11). */
    readonly opens: readonly string[]
}

/**
 * A Starter Kit that gives no note a type: the entries that an edit takes
 * away do not depend on the note types, so an edit never asks the Starter
 * Kit, and a missing one does not stop it.
 */
const NO_NOTE_TYPES: NoteTypes = {
    recognize: (paths) =>
        Promise.resolve({ noteTypes: [], notes: paths.map((path) => ({ path, noteType: null })) })
}

/** What an edit reads of the copy, with the lock. */
interface EditContext {
    readonly configurationText: string
    readonly configuration: Configuration
    readonly log: EditsLog
}

/** What the check of an edit found. */
interface CheckedEdit {
    /** The vault paths of the manifest entries that the edit takes away, sorted. */
    readonly removes: readonly string[]
    /** The vault paths of the published entries, not in `removes`, that use an attachment that a `deny` puts under the guard, sorted. */
    readonly affects: readonly string[]
    /** For an edit of a note: its text as the check read it, and its text after the write. */
    readonly note?: { readonly before: string; readonly after: string }
}

/** The replacement character: it stands for bytes of a name that are not valid Unicode. */
const NOT_UNICODE = String.fromCharCode(0xfffd)

/** True when a part of the path is a name that is not part of the vault: hidden, or not valid Unicode. */
function isOutsideVault(path: string): boolean {
    return path.split('/').some((part) => part.startsWith('.') || part.includes(NOT_UNICODE))
}

function checkAction(action: string): void {
    if (!(EDIT_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(
            `"${action}" is not an edit of the guards: the edits are deny, allow, ignore and unignore`
        )
    }
}

/** The lock of an edit. */
function editHolder(run: Run): LockHolder {
    return { command: 'edit', device: run.device, face: run.face, time: run.time }
}

/**
 * The start of an edit, with the lock: a run that stopped halfway is put
 * back, and the copy must follow the content store, as for a publication.
 * The result is true when a correction of the property is owed.
 */
async function prepareEdit(device: Device, ownLock: () => Promise<void>): Promise<boolean> {
    const owed = (await recover(device, ownLock))?.step === 'correct'
    refuseWhenBehind((await device.store.verify('must')).behind)
    return owed
}

async function editContext(device: Device): Promise<EditContext> {
    const text = await configurationText(device)
    return {
        configurationText: text,
        // No check of GATE-38: an edit is how an agent corrects a deny list
        // entry that names no folder (PUB-91).
        configuration: parseConfiguration(text),
        log: parseEdits(await device.store.read(EDITS_FILE))
    }
}

/**
 * The vault of one read: each note, each file and each listing is read one
 * time, so the scans of an edit with the two sets of guards see one state of
 * the vault (rule 2). A write during the edit cannot make them differ.
 */
function oneRead(vault: Device['vault']): Device['vault'] {
    const texts = new Map<string, Promise<string | undefined>>()
    const bytes = new Map<string, Promise<Uint8Array | undefined>>()
    const listings = new Map<string, Promise<Awaited<ReturnType<Device['vault']['list']>>>>()
    const folders = new Map<string, Promise<boolean>>()
    const once = <T>(cache: Map<string, Promise<T>>, path: string, read: () => Promise<T>) => {
        const kept = cache.get(path)
        if (kept !== undefined) {
            return kept
        }
        const reading = read()
        cache.set(path, reading)
        return reading
    }
    const read: Device['vault'] = {
        ...vault,
        list: (folder) => once(listings, folder, () => vault.list(folder)),
        read: (path) => once(texts, path, () => vault.read(path)),
        readBytes: (path) => once(bytes, path, () => vault.readBytes(path)),
        hasFolder: (path) => once(folders, path, () => vault.hasFolder(path)),
        forRun: () => read
    }
    return read
}

/** The forced removals of the plan of a scan (rule 3 of the plan): published and unpublished entries. */
function forcedRemovals(scan: Scan): Set<string> {
    const missing = new Set(scan.queue.missing)
    return new Set([
        ...scan.queue.toRemove.filter((path) => !missing.has(path)),
        ...scan.queue.unpublishedUnderGuard
    ])
}

/** A note read in another form for a scan: the note with or without the ignore property. */
type NoteForm = { readonly path: string; readonly text: string }

/**
 * The scans of one read (rule 2): the vault, the journals and the manifest
 * are read one time, and each call gives the queue of that read with a set
 * of guards (a deny list, and a note read in another form). A deny list
 * entry that names no folder lists no file, so it does not stop a scan.
 */
async function scansOfOneRead(
    device: Device,
    log: EditsLog
): Promise<{
    readonly vault: Device['vault']
    readonly scan: (denyList: readonly string[], note?: NoteForm) => Promise<Scan>
}> {
    const vault = oneRead(device.vault)
    const journals = await readJournals(
        device.renames,
        parseMarkers(await device.store.read(RENAMES_FILE))
    )
    const manifest = await readManifest(device.store)
    const scan = async (denyList: readonly string[], note?: NoteForm): Promise<Scan> => {
        const present: string[] = []
        for (const folder of denyList) {
            if (await vault.hasFolder(folder)) {
                present.push(folder)
            }
        }
        return await computeQueue({
            vault:
                note === undefined
                    ? vault
                    : {
                          ...vault,
                          read: async (path) =>
                              path === note.path ? note.text : await vault.read(path)
                      },
            manifest,
            journals,
            configuration: { denyList: present },
            noteTypes: NO_NOTE_TYPES,
            edits: log
        })
    }
    return { vault, scan }
}

/**
 * What a set of guards takes away against another one (rule 2): `removes`
 * is the forced removals of `after` that are not forced removals of
 * `before`. With `files` (a deny), `affects` is the published entries that
 * are a forced removal in neither scan and that use an attachment under a
 * guard in `after` and not in `before` (rule 8 of "A publication").
 */
async function takenAway(
    before: Scan,
    after: Scan,
    files: boolean
): Promise<{ removes: string[]; affects: string[] }> {
    const forcedBefore = forcedRemovals(before)
    const forcedAfter = forcedRemovals(after)
    const removes = sortByCodePoint([...forcedAfter].filter((path) => !forcedBefore.has(path)))
    const affects: string[] = []
    if (files) {
        for (const [path, entry] of after.manifest) {
            if (entry.state !== 'published' || forcedAfter.has(path) || forcedBefore.has(path)) {
                continue
            }
            for (const attachment of entry.attachments) {
                if (
                    (await after.isGuardedFile(attachment.path, attachment.hash)) &&
                    !(await before.isGuardedFile(attachment.path, attachment.hash))
                ) {
                    affects.push(path)
                    break
                }
            }
        }
    }
    return { removes, affects: sortByCodePoint(affects) }
}

/**
 * What an edit takes away (rule 2): one read of the vault, of the journals
 * and of the manifest, and the queue of that read with the guards as they
 * are and with the edit applied (the new deny list, or the note read with
 * the ignore property). An ignore guards a note, not a file: it has no
 * `affects`.
 */
async function editLists(
    device: Device,
    context: EditContext,
    applied: { readonly denyList: readonly string[]; readonly note?: NoteForm }
): Promise<{ removes: string[]; affects: string[] }> {
    const { scan } = await scansOfOneRead(device, context.log)
    const before = await scan(context.configuration.denyList)
    const after = await scan(applied.denyList, applied.note)
    return await takenAway(before, after, applied.note === undefined)
}

/**
 * What a confirmed `allow` opens (rule 11): the published notes that would
 * link to a file of the folder, whose next update would upload it, and the
 * count of the notes of the folder that become candidates.
 */
async function allowOpens(
    device: Device,
    context: EditContext,
    folder: string
): Promise<{ opens: string[]; candidates: number; inside: string[] }> {
    const { vault, scan } = await scansOfOneRead(device, context.log)
    const before = await scan(context.configuration.denyList)
    const after = await scan(context.configuration.denyList.filter((one) => one !== folder))
    const forced = forcedRemovals(after)
    const opens: string[] = []
    for (const [path, entry] of after.manifest) {
        if (entry.state !== 'published' || forced.has(path) || !after.notes.has(path)) {
            continue
        }
        const text = await vault.read(path)
        if (text === undefined) {
            continue
        }
        const { files } = linksOf(sourceOf(text), path, after.index, after.guarded)
        if (files.some((file) => file.path.startsWith(`${folder}/`))) {
            opens.push(path)
        }
    }
    const candidates = new Set(before.queue.new)
    // The published entries inside the folder (a deny that the author
    // confirmed and that no publication applied yet): they stay published.
    const inside = [...before.manifest]
        .filter(([path, entry]) => entry.state === 'published' && path.startsWith(`${folder}/`))
        .map(([path]) => path)
    return {
        opens: sortByCodePoint(opens),
        inside: sortByCodePoint(inside),
        candidates: after.queue.new.filter(
            (path) => path.startsWith(`${folder}/`) && !candidates.has(path)
        ).length
    }
}

/**
 * Rule 10 of "The edits of the guards": a publication of an agent face stops
 * when its plan takes an entry away (`forcedRemove`) or makes a published
 * note lose a file (`guardedAttachments`) that `accept` of its selection
 * does not name: whatever made the guard, only the author lets a note leave.
 * The face `plugin` never stops here: the author sees the plan in the view.
 */
function refuseUnaccepted(plan: PublicationPlan, selection: NormalSelection, face: Face): void {
    if (face === 'plugin') {
        return
    }
    const accepted = new Set(selection.accept)
    const forced = plan.forcedRemove.filter((path) => !accepted.has(path))
    const guarded = plan.guardedAttachments.filter((path) => !accepted.has(path))
    if (forced.length === 0 && guarded.length === 0) {
        return
    }
    const parts = [
        ...(forced.length === 0 ? [] : [`it takes away ${listText(forced)}`]),
        ...(guarded.length === 0 ? [] : [`${listText(guarded)} would lose a file under a guard`])
    ]
    throw new Error(
        `the plan names paths that accept does not name: ${parts.join(', and ')}. Nothing is published from the face ${face}: name these paths in accept only when the author named them in the request, or let the author publish the plan in the publication center of Obsidian`
    )
}

/** The text of a confirmation of the lists: the paths, or `none`. */
function listText(paths: readonly string[]): string {
    return paths.length === 0 ? 'none' : paths.map((path) => `"${path}"`).join(', ')
}

/** True when the two lists hold the same paths, each list taken one time per path. */
function sameList(seen: readonly string[], now: readonly string[]): boolean {
    const sorted = sortByCodePoint([...new Set(seen)])
    return sorted.length === now.length && sorted.every((path, index) => path === now[index])
}

/** Stops a `deny` when the configuration holds a number that the two implementations write in other forms (rule 8). */
function refuseInexactNumbers(text: string): void {
    const number = inexactNumberOf(text)
    if (number !== undefined) {
        throw new Error(
            `${CONFIGURATION_FILE} has the number ${number}, which is not a whole number that both implementations write again with the same bytes (a fraction, an exponent, a negative zero, or a number outside ±9,007,199,254,740,991), so nothing is applied. Write it as a whole number with no exponent, commit ${CONFIGURATION_FILE} and push it`
        )
    }
}

/**
 * Checks an edit by rule 3 of "The edits of the guards", and computes the
 * entries that it takes away. With `open`, an open proposal with the same
 * action and the same path stops it too. It throws with the reason.
 */
async function checkEdit(
    device: Device,
    context: EditContext,
    action: EditAction,
    path: string,
    open: boolean
): Promise<CheckedEdit> {
    if (!isVaultPath(path)) {
        throw new Error(
            `"${path}" is not a vault path: write it as "Folder/Sub folder" or "Folder/Note.md", relative to the root of the vault`
        )
    }
    const { denyList } = context.configuration
    let checked: CheckedEdit = { removes: [], affects: [] }
    if (action === 'deny') {
        if (denyList.includes(path)) {
            throw new Error(`"${path}" is already in the deny list`)
        }
        if (isOutsideVault(path) || !(await device.vault.hasFolder(path))) {
            throw new Error(
                `"${path}" is not a folder of the vault, with exactly that name (letter case and Unicode form)`
            )
        }
        // Before the open proposals: the configuration must be written again
        // with the same bytes in both implementations (rule 8).
        refuseInexactNumbers(context.configurationText)
    } else if (action === 'allow') {
        if (!denyList.includes(path)) {
            throw new Error(`"${path}" is not an entry of the deny list`)
        }
    } else {
        checked = {
            removes: [],
            affects: [],
            note: await checkNoteEdit(device, context, action, path)
        }
    }
    if (
        open &&
        openProposals(context.log).some(
            (proposal) => proposal.action === action && proposal.path === path
        )
    ) {
        throw new Error(
            `there is already an open proposal to ${action} "${path}": the author confirms or rejects it in the publication center of Obsidian`
        )
    }
    if (action === 'deny') {
        return await editLists(device, context, { denyList: [...denyList, path] })
    }
    if (action === 'ignore' && checked.note !== undefined) {
        const { removes } = await editLists(device, context, {
            denyList,
            note: { path, text: checked.note.after }
        })
        return { ...checked, removes }
    }
    return checked
}

/** Checks an edit of the ignore property of a note. The result is the text of the note and its text after the write. */
async function checkNoteEdit(
    device: Device,
    context: EditContext,
    action: 'ignore' | 'unignore',
    path: string
): Promise<{ before: string; after: string }> {
    if (!path.endsWith('.md')) {
        throw new Error(`"${path}" is not a note: its name does not end in .md`)
    }
    if (guardOfPath(path, context.configuration) !== undefined) {
        throw new Error(
            `"${path}" is in a folder of the deny list: the tool never reads or writes a file there`
        )
    }
    const text = isOutsideVault(path) ? undefined : await device.vault.read(path)
    if (text === undefined) {
        throw new Error(`there is no note at "${path}" in the vault, with exactly that path`)
    }
    const excluded = namesInProperties(text, IGNORE_PROPERTY)
    if (action === 'ignore') {
        if (excluded) {
            throw new Error(`the ${IGNORE_PROPERTY} property already excludes "${path}"`)
        }
        if (hasFlowProperties(text)) {
            throw new Error(
                `the properties of "${path}" are in the flow form of YAML ({ } or [ ]), and the tool does not write into that form: the author sets the ${IGNORE_PROPERTY} property by hand`
            )
        }
        const after = setProperty(text, IGNORE_PROPERTY, 'true')
        // A write never leaves a guard in a state that the edit did not state.
        if (!namesInProperties(after, IGNORE_PROPERTY)) {
            throw new Error(
                `the ${IGNORE_PROPERTY} property cannot be written so that it excludes "${path}": the author sets it by hand`
            )
        }
        return { before: text, after }
    }
    if (!excluded) {
        throw new Error(`the ${IGNORE_PROPERTY} property does not exclude "${path}"`)
    }
    const after = removeProperty(text, IGNORE_PROPERTY)
    if (namesInProperties(after, IGNORE_PROPERTY)) {
        throw new Error(
            `"${path}" would still be excluded after the removal of the ${IGNORE_PROPERTY} property: the key is in the value of another property, in the flow form, or in a form that the removal does not touch. The author edits the note by hand`
        )
    }
    return { before: text, after }
}

/** The configuration with another deny list, in the canonical form, with every other key of the file kept. */
function configurationWith(text: string, denyList: readonly string[]): string {
    // Also for an allow: TypeScript cannot tell 1.0 from 1 (rule 8).
    refuseInexactNumbers(text)
    const value = parseJson(text)
    if (!isRecord(value)) {
        throw new Error(`${CONFIGURATION_FILE} is not an object`)
    }
    try {
        return toCanonicalJson({ ...(value as Record<string, CanonicalValue>), denyList })
    } catch (error) {
        throw new Error(
            `${CONFIGURATION_FILE} cannot be written in the canonical form: ${messageOf(error)}`,
            { cause: error }
        )
    }
}

/**
 * Writes the ignore property of a note as the check computed it. The note
 * is read again first, and it is not written when its text is not the text
 * that the check read (rule 9).
 */
async function writeIgnore(
    device: Device,
    path: string,
    note: { readonly before: string; readonly after: string }
): Promise<void> {
    if (
        (await device.vault.read(path)) !== note.before ||
        !(await device.vault.write(path, note.after, note.before))
    ) {
        throw new Error(`"${path}" changed since the check of the edit, and it is not written`)
    }
}

/** The journal after an edit: `correct` while a correction of the property is owed, else none. */
async function settleEdit(device: Device, owed: boolean): Promise<void> {
    if (owed) {
        await device.local.saveJournal(journalText({ step: 'correct' }))
    } else {
        await device.local.removeJournal()
    }
}

/**
 * Writes the event into the log, and the configuration when it changes, in
 * one commit that is checked and pushed, with the run journal (rule 5). When
 * the commit or the push fails, the files are put back. `failed` is the end
 * of the message after a failure: what is applied, or not.
 */
async function commitEvent(
    device: Device,
    context: EditContext,
    event: EditEvent,
    configuration: string | undefined,
    run: Run,
    owed: boolean,
    ownLock: () => Promise<void>,
    failed: string
): Promise<void> {
    const head = await device.store.head()
    await ownLock()
    await device.local.saveJournal(
        journalText({
            step: 'write',
            correctionOwed: owed,
            head,
            paths: [CONFIGURATION_FILE, EDITS_FILE],
            plan: event.id
        })
    )
    const backup = new Backup(device.store)
    try {
        const written: string[] = []
        if (
            configuration !== undefined &&
            (await backup.apply({ path: CONFIGURATION_FILE, text: configuration }))
        ) {
            written.push(CONFIGURATION_FILE)
        }
        if (
            await backup.apply({ path: EDITS_FILE, text: editsText(withEvent(context.log, event)) })
        ) {
            written.push(EDITS_FILE)
        }
        await ownLock()
        await device.store.commitAndPush(
            [
                `Edit: ${event.action} (${event.state})`,
                '',
                `Device: ${run.device}`,
                `Face: ${run.face}`,
                // The recovery of a run that stopped halfway finds its commit by this line.
                `Plan: ${event.id}`
            ].join('\n'),
            written
        )
    } catch (error) {
        // Another run took the copy: this run touches nothing of it any more.
        if (error instanceof LockLost) {
            throw error
        }
        const files = await putCopyBack(
            device,
            backup,
            head,
            async () => {
                await settleEdit(device, owed)
            },
            'plan, publish, takedown or edit'
        )
        throw new Error(`${messageOf(error)}. ${failed}, ${files}`, { cause: error })
    }
    await ownLock()
    await settleEdit(device, owed)
}

/**
 * Applies an event: the property of a note first for an `ignore` (a
 * stricter guard is safe, rule 6), then the commit of the event with the
 * configuration for a `deny` or an `allow`, then the removal of the
 * property for a confirmed `unignore` (rule 7).
 */
async function applyEvent(
    device: Device,
    context: EditContext,
    event: EditEvent,
    checked: CheckedEdit,
    run: Run,
    owed: boolean,
    ownLock: () => Promise<void>
): Promise<void> {
    const applies = event.state === 'applied' || event.state === 'confirmed'
    const { denyList } = context.configuration
    const configuration = !applies
        ? undefined
        : event.action === 'deny'
          ? configurationWith(context.configurationText, [...denyList, event.path])
          : event.action === 'allow'
            ? configurationWith(
                  context.configurationText,
                  denyList.filter((folder) => folder !== event.path)
              )
            : undefined
    const note = checked.note
    const propertyFirst = applies && event.action === 'ignore' && note !== undefined
    if (propertyFirst) {
        // The note is written only while the lock is the lock of this run.
        await ownLock()
        await writeIgnore(device, event.path, note)
    }
    await commitEvent(
        device,
        context,
        event,
        configuration,
        run,
        owed,
        ownLock,
        propertyFirst
            ? `The ${IGNORE_PROPERTY} property stays in the note "${event.path}" (a stricter guard is safe), but the log of the edits has no event for it`
            : 'Nothing is applied'
    )
    if (applies && event.action === 'unignore' && note !== undefined) {
        try {
            await ownLock()
            await writeIgnore(device, event.path, note)
        } catch (error) {
            throw new Error(
                `the confirmation is in the log of the edits, but the ${IGNORE_PROPERTY} property could not be removed from "${event.path}", so the guard stays closed: remove the property by hand (${messageOf(error)})`,
                { cause: error }
            )
        }
    }
}

/**
 * An edit of the guards by an agent or the author (R69): `deny` and `ignore`
 * apply at once when they take no manifest entry away, and else they are a
 * proposal with the list `removes`; `allow` and `unignore` are always a
 * proposal. It takes the lock of the device, puts back a run that stopped
 * halfway, fetches the content store and stops when the copy is behind. The
 * event goes into `edits.json` in one commit that is pushed. The result is
 * the event.
 */
export async function edit(given: Device, request: EditRequest, run: Run): Promise<EditEvent> {
    const device = forRun(given)
    checkRun(run)
    checkAction(request.action)
    return await withLock(device, editHolder(run), async (ownLock) => {
        const owed = await prepareEdit(device, ownLock)
        const context = await editContext(device)
        const checked = await checkEdit(device, context, request.action, request.path, true)
        // A deny that takes an attachment away from a published note needs
        // the author too (R69, review round 2).
        const proposed =
            isLooser(request.action) || checked.removes.length > 0 || checked.affects.length > 0
        const event = makeEvent({
            action: request.action,
            affects: proposed ? checked.affects : [],
            device: run.device,
            face: run.face,
            path: request.path,
            removes: proposed ? checked.removes : [],
            state: proposed ? 'proposed' : 'applied',
            time: run.time
        })
        await applyEvent(device, context, event, checked, run, owed, ownLock)
        return event
    })
}

/** Only the author decides a proposal, in the view (rule 7). */
function checkAuthor(run: Run): void {
    if (run.face !== 'plugin') {
        throw new Error(
            'only the author confirms or rejects a proposal, in the publication center of Obsidian: the command line program and the MCP server cannot'
        )
    }
}

/** The open proposal with this id. It throws when there is none. */
function openProposalOf(context: EditContext, id: string): EditEvent {
    const found = openProposals(context.log).find((event) => event.id === id)
    if (found === undefined) {
        throw new Error(
            `"${id}" is not an open proposal: the author or another device decided it already, or the log of the edits has no such proposal. Check again`
        )
    }
    return found
}

/** What a proposal takes away now: the proposal, and its list `removes` computed again. */
export interface ProposalReview {
    readonly proposal: EditEvent
    /** The entries that would leave the content store, sorted. */
    readonly removes: readonly string[]
    /** The published notes that would lose an attachment, sorted. */
    readonly affects: readonly string[]
    /** For an `allow`: the published notes that link to a file of the folder, whose next update would upload it, sorted (rule 11). */
    readonly opens: readonly string[]
    /** For an `allow`: how many notes of the folder become candidates (rule 11). */
    readonly candidates: number
    /**
     * For an `allow`: the published entries inside the folder (a deny that
     * no publication applied yet), sorted: they stay published, and their
     * changes publish as for every published note.
     */
    readonly inside: readonly string[]
}

/**
 * The proposal with its list `removes` as a confirmation now would compute
 * it, for the dialog of the view (rule 7). It checks the edit again by rule
 * 3, without the open proposal. It reads no network, takes no lock and
 * writes nothing; it stops while the lock of the device is taken or a run
 * stopped halfway, as `status` does.
 */
export async function reviewProposal(given: Device, id: string): Promise<ProposalReview> {
    const device = forRun(given)
    await refuseWhenLocked(device)
    if ((await readJournal(device))?.step === 'write') {
        throw new Error(
            'a run stopped halfway on this device. The review of a proposal writes nothing, so it does not put the copy back: the next plan, publish, takedown or edit puts it back'
        )
    }
    await device.store.verify('none')
    const context = await editContext(device)
    const proposal = openProposalOf(context, id)
    const checked = await checkEdit(device, context, proposal.action, proposal.path, false)
    const opened =
        proposal.action === 'allow'
            ? await allowOpens(device, context, proposal.path)
            : { opens: [], candidates: 0, inside: [] }
    return { proposal, removes: checked.removes, affects: checked.affects, ...opened }
}

/**
 * The author confirms a proposal, in the view (rule 7). The edit is checked
 * again, and its list `removes` is computed again: when it is not the list
 * that the view showed, nothing is applied, as for a stale plan. The result
 * is the event of the confirmation.
 */
export async function confirmProposal(
    given: Device,
    confirmation: Confirmation,
    run: Run
): Promise<EditEvent> {
    const device = forRun(given)
    checkRun(run)
    checkAuthor(run)
    return await withLock(device, editHolder(run), async (ownLock) => {
        const owed = await prepareEdit(device, ownLock)
        const context = await editContext(device)
        const proposal = openProposalOf(context, confirmation.proposal)
        const checked = await checkEdit(device, context, proposal.action, proposal.path, false)
        const { opens } =
            proposal.action === 'allow'
                ? await allowOpens(device, context, proposal.path)
                : { opens: [] }
        if (!sameList(confirmation.opens, opens)) {
            throw new Error(
                `the published notes that would link to a file of the folder changed since the dialog showed them (now: ${listText(opens)}), so nothing is applied: open the dialog of the proposal again`
            )
        }
        if (
            !sameList(confirmation.removes, checked.removes) ||
            !sameList(confirmation.affects, checked.affects)
        ) {
            throw new Error(
                `the entries that the proposal takes away from the content store, or the published notes that would lose an attachment, changed since the dialog showed them (now: ${listText(checked.removes)} leave; ${listText(checked.affects)} lose an attachment), so nothing is applied: open the dialog of the proposal again`
            )
        }
        const event = makeEvent({
            action: proposal.action,
            device: run.device,
            face: run.face,
            path: proposal.path,
            proposal: proposal.id,
            removes: checked.removes,
            affects: checked.affects,
            state: 'confirmed',
            time: run.time
        })
        await applyEvent(device, context, event, checked, run, owed, ownLock)
        return event
    })
}

/** The author rejects a proposal, in the view (rule 7): only its event is written. The result is the event. */
export async function rejectProposal(given: Device, id: string, run: Run): Promise<EditEvent> {
    const device = forRun(given)
    checkRun(run)
    checkAuthor(run)
    return await withLock(device, editHolder(run), async (ownLock) => {
        const owed = await prepareEdit(device, ownLock)
        const context = await editContext(device)
        const proposal = openProposalOf(context, id)
        const event = makeEvent({
            action: proposal.action,
            device: run.device,
            face: run.face,
            path: proposal.path,
            proposal: proposal.id,
            state: 'rejected',
            time: run.time
        })
        await applyEvent(device, context, event, { removes: [], affects: [] }, run, owed, ownLock)
        return event
    })
}
