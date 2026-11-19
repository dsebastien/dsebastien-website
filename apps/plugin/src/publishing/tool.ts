import { attachmentsOf, keyOf } from './attachments.ts'
import type { Attachment } from './attachments.ts'
import { toCanonicalJson } from './canonical.ts'
import { CLEANING_VERSION, cleanNote, sourceOf, STATE_PROPERTY } from './clean.ts'
import { linksOf } from './links.ts'
import { CONFIGURATION_FILE, isVaultPath, parseConfiguration } from './configuration.ts'
import type { Configuration } from './configuration.ts'
import { hasFlowProperties, namesInProperties, removeProperty, setProperty } from './frontmatter.ts'
import { IGNORE_PROPERTY } from './guards.ts'
import { bytesHash, contentHash, sha256Hex } from './hash.ts'
import { parseJson } from './json.ts'
import type { NoteLink } from './links.ts'
import { MANIFEST_FOLDER, manifestFile, NOTES_FOLDER, noteId, readManifest } from './manifest.ts'
import type { ManifestEntry } from './manifest.ts'
import { compareCodePoints, sortByCodePoint } from './order.ts'
import { computePlan, normalSelection } from './plan.ts'
import type { NormalSelection, PublicationPlan, Selection } from './plan.ts'
import type { Device, Fetch, LockHolder } from './ports.ts'
import { computeQueue } from './queue.ts'
import type { PublicationQueue, Scan } from './queue.ts'

// The operations of the publishing tool. Every face calls these: the plugin,
// and the tests in the place of the command line program, whose Rust twin is
// `cli/src/tool.rs`. No rule of the publishing logic lives in a face.

/** A plan and the id under which it is stored on the device. */
export interface StoredPlan {
    readonly id: string
    readonly plan: PublicationPlan
    /** True when the content store could not be reached and the plan uses the last fetch (PERF-16). */
    readonly offline: boolean
}

/** The faces of the tool that can start a publication. */
export const FACES = ['plugin', 'command-line', 'mcp-server'] as const
export type Face = (typeof FACES)[number]

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

/** The form of the id of a plan: 16 hexadecimal digits. An id is never used as a path in another form. */
const PLAN_ID = /^[0-9a-f]{16}$/

/** A time in the canonical form: UTC, to the second. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTextList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'it failed'
}

/** True when the text is a real date and time in the canonical form. */
function isCanonicalTime(time: string): boolean {
    if (!TIME.test(time)) {
        return false
    }
    const date = new Date(time)
    // A date that does not exist (month 13, day 31 of a short month) does not
    // come back as the same text.
    return !Number.isNaN(date.getTime()) && `${date.toISOString().slice(0, 19)}Z` === time
}

/** True when the text is one line with something to read: no control character, and not only spaces (U+0020). */
function isOneLine(text: string): boolean {
    return !/\p{Cc}/u.test(text) && /[^ ]/u.test(text)
}

/** Reads the configuration and checks it against the vault. */
async function readConfiguration(
    device: Device
): Promise<{ configuration: Configuration; hash: string }> {
    const text = await device.store.read(CONFIGURATION_FILE)
    const configuration = parseConfiguration(text)
    // A deny list entry that names no folder would exclude nothing: a renamed
    // folder, or another letter case, would make its notes candidates (GATE-38).
    for (const folder of configuration.denyList) {
        if (!(await device.vault.hasFolder(folder))) {
            throw new Error(
                `the deny list names "${folder}", which is not a folder of the vault. No publication is possible until the deny list is corrected`
            )
        }
    }
    return { configuration, hash: text === undefined ? 'none' : contentHash(text) }
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
    if (fetch !== 'none' && behind > 0) {
        throw new Error(
            `the copy of the content store is ${String(behind)} commit(s) behind the content store: another device published since the last pull. Nothing can be planned or published until the copy is up to date: pull first (git pull --ff-only origin main)`
        )
    }
    const { configuration, hash } = await readConfiguration(device)
    const manifest = await readManifest(device.store)
    return {
        scan: await computeQueue({ vault: device.vault, manifest, configuration }),
        configurationHash: hash,
        behind,
        reached
    }
}

/** The device with the vault of one run: each folder of the vault is listed one time. */
function forRun(device: Device): Device {
    return { ...device, vault: device.vault.forRun() }
}

/** What the lock of the device holds, for a message: one line. */
function lockMessage(text: string): string {
    return `a publication runs on this device, or one stopped halfway (the lock holds ${text.replace(/\s+/gu, ' ').trim()}). When no publication runs, remove the lock with the unlock command: the next plan or publish then puts the copy back`
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
 * next plan or publish puts the copy back. True when a lock was there.
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

/** True when the path is a path of a note or of a manifest entry in the content store. */
function isStorePath(path: string): boolean {
    return (
        isVaultPath(path) &&
        (path.startsWith(`${NOTES_FOLDER}/`) ||
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
async function recover(device: Device): Promise<RunJournal | undefined> {
    const journal = await readJournal(device)
    if (journal?.step !== 'write') {
        return journal
    }
    const result = await device.store.recover(journal.head, journal.paths, journal.plan)
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
    const device = forRun(given)
    await refuseWhenLocked(device)
    if ((await readJournal(device))?.step === 'write') {
        throw new Error(
            'a publication stopped halfway on this device. status writes nothing, so it does not put the copy back: the next plan or publish puts it back'
        )
    }
    const state = await readState(device, 'none')
    return { ...state.scan.queue, behind: state.behind }
}

/** The source, the cleaned note, the links and the attachments of one note of a plan. */
interface NoteTexts {
    readonly source: string
    readonly cleaned: string
    readonly links: readonly NoteLink[]
    readonly attachments: readonly Attachment[]
}

/** A plan with everything that its publication needs. */
interface Computed {
    readonly plan: PublicationPlan
    /** False when the content store could not be reached and the plan uses the last fetch. */
    readonly reached: boolean
    /** The record of the plan, in the canonical form. */
    readonly record: string
    readonly scan: Scan
    /** The texts of the notes to publish and to update, as the record names them by their hashes. */
    readonly texts: ReadonlyMap<string, NoteTexts>
}

/**
 * Computes the plan of a selection and its record: the plan, the selection,
 * and the state that the plan was computed from, in the canonical form.
 */
async function recordFor(
    device: Device,
    selection: NormalSelection,
    fetch: Fetch
): Promise<Computed> {
    const { scan, configurationHash, reached } = await readState(device, fetch)
    const plan = computePlan(scan, selection)
    const texts = new Map<string, NoteTexts>()
    const notes: {
        attachments: readonly Attachment[]
        cleanedHash: string
        links: readonly NoteLink[]
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
        texts.set(path, { source, cleaned, links, attachments })
        notes.push({
            attachments,
            cleanedHash: contentHash(cleaned),
            links,
            path,
            sourceHash: contentHash(source)
        })
    }
    // In the order of the canonical form: never the default order of texts.
    notes.sort((one, two) => compareCodePoints(one.path, two.path))
    const record = toCanonicalJson({
        plan,
        selection,
        state: { configuration: configurationHash, manifest: await manifestHash(device), notes }
    })
    return { plan, reached, record, scan, texts }
}

/**
 * Computes a publication plan and stores it on the device. It writes nothing
 * into the vault and nothing into the content of the store.
 */
export async function plan(given: Device, selection: Selection): Promise<StoredPlan> {
    const device = forRun(given)
    await refuseWhenLocked(device)
    // A publication that stopped halfway left files in the copy: they are put
    // back first, with the lock, so that no publication starts in the middle.
    if ((await readJournal(device))?.step === 'write') {
        await withLock(device, { command: 'plan' }, () => recover(device))
    }
    const computed = await recordFor(device, normalSelection(selection), 'try')
    // The id names the record. It is outside the parity rule (TOOL-30).
    const id = sha256Hex(computed.record).slice(0, 16)
    await device.local.save(id, computed.record)
    return { id, plan: computed.plan, offline: !computed.reached }
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
        const { hold, include, remove } = selection
        if (isTextList(hold) && isTextList(include) && isTextList(remove)) {
            return normalSelection({ hold, include, remove })
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
        attachments: texts.attachments,
        cleanedHash: contentHash(texts.cleaned),
        cleaningVersion: CLEANING_VERSION,
        links: texts.links,
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
    // the last date: the author did not edit the note (PUB-24).
    const edited = before.state !== 'published' || before.sourceHash !== hashes.sourceHash
    return {
        ...before,
        ...hashes,
        lastPublished: edited ? time : before.lastPublished,
        state: 'published'
    }
}

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
                warnings.push({
                    path,
                    message: `the note changed during the publication: its ${STATE_PROPERTY} property is corrected at the next publication`
                })
                continue
            }
            // A new line below a line in the flow form of YAML (`{ }`, `[ ]`)
            // is not valid YAML. The note stays as the author wrote it.
            if (hasFlowProperties(text)) {
                warnings.push({
                    path,
                    message: `the properties of the note are in the flow form of YAML ({ } or [ ]), and the tool does not write into that form: correct the ${STATE_PROPERTY} property by hand`
                })
                continue
            }
            const wanted = isPublished
                ? setProperty(text, STATE_PROPERTY, 'true')
                : removeProperty(text, STATE_PROPERTY)
            // The write must not change what the guard reads. In an odd form
            // of the properties, a line of the ignore property can belong to
            // the state property, or the new lines can close properties that
            // were open. Such a note is never written.
            if (
                namesInProperties(wanted, IGNORE_PROPERTY) !==
                namesInProperties(text, IGNORE_PROPERTY)
            ) {
                warnings.push({
                    path,
                    message: `the ${STATE_PROPERTY} property cannot be corrected with no change to what the ignore property says: correct it by hand`
                })
                continue
            }
            await device.vault.write(path, wanted)
            ;(isPublished ? propertySet : propertyRemoved).push(path)
        } catch (error) {
            warnings.push({
                path,
                message: `the ${STATE_PROPERTY} property could not be corrected: ${messageOf(error)}`
            })
        }
    }
    return { propertyRemoved, propertySet, warnings }
}

/**
 * The keys of the files of the attachment storage that the published notes of
 * a manifest use. An attachment whose file is under a guard now is used by no
 * note, also when an entry that the plan held still lists it.
 */
async function usedKeys(
    manifest: ReadonlyMap<string, ManifestEntry>,
    isGuarded: Scan['isGuardedFile']
): Promise<Set<string>> {
    const keys = new Set<string>()
    for (const entry of manifest.values()) {
        if (entry.state === 'published') {
            for (const attachment of entry.attachments) {
                if (!(await isGuarded(attachment.path, attachment.hash))) {
                    keys.add(keyOf(attachment.hash))
                }
            }
        }
    }
    return keys
}

/** The form of the name of a file of the attachment storage: a key, or a key that is being written. */
const STORAGE_NAME = /^(?:[0-9a-f]{64}|\.[0-9a-f]{64}\.part)$/

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
            const bytes = await this.#device.vault.readBytes(attachment.path)
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
    isGuarded: Scan['isGuardedFile']
): Promise<{
    readonly deleted: string[]
    readonly uploaded: string[]
    readonly warnings: { path: string; message: string }[]
}> {
    const used = await usedKeys(manifest, isGuarded)
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
        return { deleted, uploaded: [], warnings }
    }
    for (const name of sortByCodePoint(names)) {
        if (used.has(name)) {
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
    const repaired = await repairStorage(device, manifest, isGuarded, new Set(names))
    return { deleted, uploaded: repaired.uploaded, warnings: [...warnings, ...repaired.warnings] }
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
                bytes = await device.vault.readBytes(attachment.path)
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
    for (const path of [...plan.forcedRemove, ...plan.publish, ...plan.update, ...plan.remove]) {
        paths.add(`${NOTES_FOLDER}/${path}`)
        paths.add(manifestFile(scan.manifest.get(path)?.id ?? noteId(path, time)))
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
 * forced removals come first: when one fails, the whole publication stops. A
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
    // The forced removals come first, and they follow the takedown rule: the
    // note leaves the manifest (PUB-21, PUB-84). When one fails, the whole
    // publication stops: no note is published while a note under a guard
    // stays live.
    for (const path of lists.forcedRemove) {
        try {
            const entry = scan.manifest.get(path)
            if (entry === undefined) {
                throw new Error('the note has no manifest entry')
            }
            for (const file of [`${NOTES_FOLDER}/${path}`, manifestFile(entry.id)]) {
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
            // A failure of one note leaves that note out (PUB-26).
            failed.push({ path, reason: messageOf(error) })
        }
    }
    const noteUnit = (path: string): Unit => {
        const noteTexts = texts.get(path)
        if (noteTexts === undefined) {
            throw new Error('the plan has no text for the note')
        }
        const entry = entryOf(path, noteTexts, scan.manifest.get(path), run.time)
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
            const entry = scan.manifest.get(path)
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

    const planned = new Set([...lists.update, ...lists.remove])
    const skipped = scan.queue.changed.filter((path) => !planned.has(path))
    const report = {
        failed: failed.sort((one, two) => compareCodePoints(one.path, two.path)),
        forcedRemoved: lists.forcedRemove,
        ...done,
        skipped
    }
    if (written.length > 0) {
        await run.ownLock()
        await device.store.commitAndPush(
            [
                `Publish: ${String(done.published.length)} new, ${String(done.updated.length)} updated, ${String(done.removed.length)} removed, ${String(lists.forcedRemove.length)} forced, ${String(skipped.length)} skipped`,
                '',
                `Device: ${run.device}`,
                `Face: ${run.face}`,
                // The recovery of a run that stopped halfway finds its commit by this line.
                `Plan: ${run.plan}`
            ].join('\n'),
            written
        )
    }
    return { report, written, manifest }
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

/** The publication of a plan, with the lock of the device. */
async function apply(
    device: Device,
    id: string,
    run: Run,
    ownLock: () => Promise<void>
): Promise<PublicationReport> {
    // A publication that stopped halfway is put back first. When it stopped
    // after its push, the correction of the property is owed.
    const owed = (await recover(device))?.step === 'correct'
    const record = await device.local.load(id)
    if (record === undefined) {
        throw new Error(`there is no plan with the id ${id} on this device`)
    }
    const current = await recordFor(device, selectionOf(record, id), 'must')
    const { scan } = current
    if (current.record !== record) {
        // The run fetched and the copy follows the content store: the
        // storage can be cleaned, so a file that came under a guard leaves it
        // also when the plan is stale.
        await cleanStorage(device, scan.manifest, scan.isGuardedFile)
        throw new Error(
            `the plan ${id} is stale: a note of the plan, the publication queue, the configuration or the content store changed. Make a new plan`
        )
    }
    // The journal comes before the first write into the copy: a run that
    // stops halfway is put back by the next one.
    const paths = storePathsOf(current.plan, scan, run.time)
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
        // Files that stay in the copy would be read as published at the next
        // run, and an upload that stays would be public with no entry.
        const stayed = await journal.putAllBack()
        const kept = await uploads.takeBack(scan.manifest, scan.isGuardedFile)
        // A file that could not be put back, or a commit that git could not
        // take back, stays in the journal, so the next run puts it back. The
        // journal of another run that took the copy is never touched.
        if (
            !(error instanceof LockLost) &&
            stayed.length === 0 &&
            (await device.store.head()) === head
        ) {
            await settle(owed)
        }
        const files =
            stayed.length === 0
                ? 'and the files of the copy are as they were before'
                : `and these files of the copy could not be put back: ${stayed.join(', ')}. The next plan or publish puts them back`
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
    const cleanup = await cleanStorage(device, manifest, scan.isGuardedFile)
    if (correct) {
        await device.local.removeJournal()
    }
    return {
        ...report,
        attachmentsDeleted: cleanup.deleted,
        attachmentsUploaded: sortByCodePoint([...uploads.uploaded, ...cleanup.uploaded]),
        ...correction,
        warnings: [...correction.warnings, ...cleanup.warnings].sort((one, two) =>
            compareCodePoints(one.path, two.path)
        )
    }
}
