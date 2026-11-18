import { toCanonicalJson } from './canonical.ts'
import { CLEANING_VERSION, cleanNote, sourceOf, STATE_PROPERTY } from './clean.ts'
import { CONFIGURATION_FILE, parseConfiguration } from './configuration.ts'
import type { Configuration } from './configuration.ts'
import { removeProperty, setProperty } from './frontmatter.ts'
import { contentHash, sha256Hex } from './hash.ts'
import { MANIFEST_FOLDER, manifestFile, NOTES_FOLDER, noteId, readManifest } from './manifest.ts'
import type { ManifestEntry } from './manifest.ts'
import { compareCodePoints } from './order.ts'
import { computePlan, normalSelection } from './plan.ts'
import type { NormalSelection, PublicationPlan, Selection } from './plan.ts'
import type { Device } from './ports.ts'
import { computeQueue } from './queue.ts'
import type { PublicationQueue, Scan } from './queue.ts'

// The operations of the publishing tool. Every face calls these: the plugin,
// and the tests in the place of the command line program, whose Rust twin is
// `cli/src/tool.rs`. No rule of the publishing logic lives in a face.

/** A plan and the id under which it is stored on the device. */
export interface StoredPlan {
    readonly id: string
    readonly plan: PublicationPlan
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
    /** The notes of the plan that were left out, with the reason. */
    readonly failed: readonly { readonly path: string; readonly reason: string }[]
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

/** True when the text is one line with something to read: no control character, not only spaces. */
function isOneLine(text: string): boolean {
    return text.trim() !== '' && !/\p{Cc}/u.test(text)
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
}

/** Checks the content store, reads the configuration and the manifest, and scans the vault. */
async function readState(device: Device): Promise<State> {
    await device.store.verify()
    const { configuration, hash } = await readConfiguration(device)
    const manifest = await readManifest(device.store)
    return {
        scan: await computeQueue({ vault: device.vault, manifest, configuration }),
        configurationHash: hash
    }
}

/**
 * The publication queue: the four lists of what waits for a publication. It
 * writes nothing into the vault and nothing into the content store.
 */
export async function status(device: Device): Promise<PublicationQueue> {
    return (await readState(device)).scan.queue
}

/** The source and the cleaned note of one note of a plan. */
interface NoteTexts {
    readonly source: string
    readonly cleaned: string
}

/** A plan with everything that its publication needs. */
interface Computed {
    readonly plan: PublicationPlan
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
async function recordFor(device: Device, selection: NormalSelection): Promise<Computed> {
    const { scan, configurationHash } = await readState(device)
    const plan = computePlan(scan, selection)
    const texts = new Map<string, NoteTexts>()
    const notes: { cleanedHash: string; path: string; sourceHash: string }[] = []
    // The two lists have no path in common, and each one is sorted.
    for (const path of [...plan.publish, ...plan.update]) {
        const text = await device.vault.read(path)
        if (text === undefined) {
            throw new Error(`"${path}" does not exist in the vault any more`)
        }
        const source = sourceOf(text)
        const cleaned = cleanNote(source)
        texts.set(path, { source, cleaned })
        notes.push({ cleanedHash: contentHash(cleaned), path, sourceHash: contentHash(source) })
    }
    // In the order of the canonical form: never the default order of texts.
    notes.sort((one, two) => compareCodePoints(one.path, two.path))
    const record = toCanonicalJson({
        plan,
        selection,
        state: { configuration: configurationHash, manifest: await manifestHash(device), notes }
    })
    return { plan, record, scan, texts }
}

/**
 * Computes a publication plan and stores it on the device. It writes nothing
 * into the vault and nothing into the content of the store.
 */
export async function plan(device: Device, selection: Selection): Promise<StoredPlan> {
    const { plan: computed, record } = await recordFor(device, normalSelection(selection))
    // The id names the record. It is outside the parity rule (TOOL-30).
    const id = sha256Hex(record).slice(0, 16)
    await device.plans.save(id, record)
    return { id, plan: computed }
}

/** Reads the selection of a stored record. It throws when the record is not one. */
function selectionOf(record: string, id: string): NormalSelection {
    let value: unknown
    try {
        value = JSON.parse(record)
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
 * Writes the files of one note. They are one unit: when a write fails, the
 * files are put back as they were, and the error goes to the caller.
 *
 * @returns the paths that changed
 */
async function applyUnit(device: Device, files: readonly StoreFile[]): Promise<string[]> {
    const changed: string[] = []
    try {
        for (const file of files) {
            if (file.text !== undefined) {
                await device.store.write(file.path, file.text)
                changed.push(file.path)
            } else if (await device.store.remove(file.path)) {
                changed.push(file.path)
            }
        }
    } catch (error) {
        await device.store.discard(files.map((file) => file.path))
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
        cleanedHash: contentHash(texts.cleaned),
        cleaningVersion: CLEANING_VERSION,
        sourceHash: contentHash(texts.source)
    }
    if (before === undefined) {
        return {
            attachments: [],
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
            if (isPublished) {
                await device.vault.write(path, setProperty(text, STATE_PROPERTY, 'true'))
                propertySet.push(path)
            } else {
                await device.vault.write(path, removeProperty(text, STATE_PROPERTY))
                propertyRemoved.push(path)
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

/**
 * Applies exactly one plan, by its id.
 *
 * It computes the record of the plan again: when the new record is not the
 * stored one, the plan is stale and nothing is published. Then the cleaned
 * notes and the manifest entries go to the content store in one commit, which
 * is pushed. A note whose files cannot be written is left out and reported.
 * Only after the push, the state property is corrected in the vault.
 */
export async function publish(device: Device, id: string, run: Run): Promise<PublicationReport> {
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
    const record = await device.plans.load(id)
    if (record === undefined) {
        throw new Error(`there is no plan with the id ${id} on this device`)
    }
    const current = await recordFor(device, selectionOf(record, id))
    if (current.record !== record) {
        throw new Error(
            `the plan ${id} is stale: a note of the plan, the publication queue, the configuration or the content store changed. Make a new plan`
        )
    }
    const { scan, texts } = current
    const lists = current.plan

    const written: string[] = []
    const failed: { path: string; reason: string }[] = []
    const done = { published: [] as string[], updated: [] as string[], removed: [] as string[] }
    const apply = async (
        path: string,
        list: string[],
        files: () => readonly StoreFile[]
    ): Promise<void> => {
        try {
            written.push(...(await applyUnit(device, files())))
            list.push(path)
        } catch (error) {
            // A failure of one note leaves that note out (PUB-26).
            failed.push({ path, reason: messageOf(error) })
        }
    }
    const noteFiles = (path: string): readonly StoreFile[] => {
        const noteTexts = texts.get(path)
        if (noteTexts === undefined) {
            throw new Error('the plan has no text for the note')
        }
        const entry = entryOf(path, noteTexts, scan.manifest.get(path), run.time)
        return [
            { path: `${NOTES_FOLDER}/${path}`, text: noteTexts.cleaned },
            { path: manifestFile(entry.id), text: toCanonicalJson(entry) }
        ]
    }
    for (const path of lists.publish) {
        await apply(path, done.published, () => noteFiles(path))
    }
    for (const path of lists.update) {
        await apply(path, done.updated, () => noteFiles(path))
    }
    for (const path of lists.remove) {
        await apply(path, done.removed, () => {
            const entry = scan.manifest.get(path)
            if (entry === undefined) {
                throw new Error('the note has no manifest entry')
            }
            const unpublished: ManifestEntry = { ...entry, state: 'unpublished' }
            return [
                { path: `${NOTES_FOLDER}/${path}`, text: undefined },
                { path: manifestFile(entry.id), text: toCanonicalJson(unpublished) }
            ]
        })
    }

    const planned = new Set([...lists.update, ...lists.remove])
    const skipped = scan.queue.changed.filter((path) => !planned.has(path))
    const report = { failed, ...done, skipped }
    if (written.length === 0) {
        // Nothing to commit, so no push: without a push, no property is corrected.
        return { ...report, propertyRemoved: [], propertySet: [], warnings: [] }
    }
    await device.store.commitAndPush(
        [
            `Publish: ${String(done.published.length)} new, ${String(done.updated.length)} updated, ${String(done.removed.length)} removed, ${String(skipped.length)} skipped`,
            '',
            `Device: ${run.device}`,
            `Face: ${run.face}`
        ].join('\n'),
        written
    )

    // The push succeeded: the manifest of the copy is the manifest of the
    // content store. The vault now says the same.
    const published = new Set(
        [...scan.manifest].filter(([, entry]) => entry.state === 'published').map(([path]) => path)
    )
    for (const path of done.published) {
        published.add(path)
    }
    for (const path of done.removed) {
        published.delete(path)
    }
    return { ...report, ...(await correctState(device, scan, published)) }
}
