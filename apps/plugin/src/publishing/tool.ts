import { toCanonicalJson } from './canonical.ts'
import { CLEANING_VERSION, cleanNote, sourceOf, STATE_PROPERTY } from './clean.ts'
import { CONFIGURATION_FILE, parseConfiguration } from './configuration.ts'
import type { Configuration } from './configuration.ts'
import { setProperty } from './frontmatter.ts'
import { contentHash, sha256Hex } from './hash.ts'
import { MANIFEST_FOLDER, NOTES_FOLDER, noteId, readManifest } from './manifest.ts'
import type { ManifestEntry } from './manifest.ts'
import { sortByCodePoint } from './order.ts'
import { computePlan } from './plan.ts'
import type { PublicationPlan, Selection } from './plan.ts'
import type { Device } from './ports.ts'

// The operations of the publishing tool. Every face calls these: the plugin,
// and the tests in the place of the command line program, whose Rust twin is
// `cli/src/tool.rs`. No rule of the publishing logic lives in a face.

/** A plan and the id under which it is stored on the device. */
export interface StoredPlan {
    readonly id: string
    readonly plan: PublicationPlan
}

/** What a publication did. */
export interface PublicationReport {
    /** The vault paths of the notes that are published now. */
    readonly published: readonly string[]
    /** The vault paths of the notes whose state property was corrected. */
    readonly corrected: readonly string[]
}

/** The form of the id of a plan: 16 hexadecimal digits. An id is never used as a path in another form. */
const PLAN_ID = /^[0-9a-f]{16}$/

/** A time in the canonical form: UTC, to the second. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** The source of a note of the plan. It throws when the vault no longer has the note. */
async function sourceOfNote(device: Device, path: string): Promise<string> {
    const text = await device.vault.read(path)
    if (text === undefined) {
        throw new Error(`"${path}" does not exist in the vault`)
    }
    return sourceOf(text)
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

/**
 * Computes the plan of a selection and its record: the plan, the selection,
 * and the state that the plan was computed from, in the canonical form.
 */
async function recordFor(
    device: Device,
    selection: Selection
): Promise<{ plan: PublicationPlan; record: string }> {
    await device.store.verify()
    const { configuration, hash } = await readConfiguration(device)
    const plan = await computePlan({
        vault: device.vault,
        manifest: await readManifest(device.store),
        configuration,
        selection
    })
    const notes: { path: string; sourceHash: string }[] = []
    for (const path of plan.publish) {
        notes.push({ path, sourceHash: contentHash(await sourceOfNote(device, path)) })
    }
    const record = toCanonicalJson({
        plan,
        selection: { include: sortByCodePoint([...new Set(selection.include)]) },
        state: { configuration: hash, manifest: await manifestHash(device), notes }
    })
    return { plan, record }
}

/**
 * Computes a publication plan and stores it on the device. It writes nothing
 * into the vault and nothing into the content of the store.
 */
export async function plan(device: Device, selection: Selection): Promise<StoredPlan> {
    const { plan: computed, record } = await recordFor(device, selection)
    // The id names the record. It is outside the parity rule (TOOL-30).
    const id = sha256Hex(record).slice(0, 16)
    await device.plans.save(id, record)
    return { id, plan: computed }
}

/** Reads the selection of a stored record. It throws when the record is not one. */
function selectionOf(record: string, id: string): Selection {
    let value: unknown
    try {
        value = JSON.parse(record)
    } catch {
        value = undefined
    }
    const selection = isRecord(value) ? value['selection'] : undefined
    const include = isRecord(selection) ? selection['include'] : undefined
    if (!Array.isArray(include) || !include.every((path) => typeof path === 'string')) {
        throw new Error(`the stored plan ${id} cannot be read`)
    }
    return { include }
}

/**
 * Applies exactly one plan, by its id.
 *
 * It computes the record of the plan again: when a note of the plan, the
 * configuration or the manifest changed since the plan, the plan is stale and
 * nothing is published. Then the cleaned notes and their manifest entries go
 * to the content store in one commit, which is pushed. Only after the push,
 * the state property of the published notes is corrected in the vault.
 *
 * @param time the time of the run, in the canonical form. It is an input: the logic reads no clock.
 */
export async function publish(
    device: Device,
    id: string,
    time: string
): Promise<PublicationReport> {
    if (!isCanonicalTime(time)) {
        throw new Error(
            `the time of the run must be a real date and time in UTC, to the second: "${time}" is not`
        )
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
            `the plan ${id} is stale: a note of the plan, the configuration or the content store changed. Make a new plan`
        )
    }

    const written: string[] = []
    for (const path of current.plan.publish) {
        const source = await sourceOfNote(device, path)
        const cleaned = cleanNote(source)
        const entry: ManifestEntry = {
            attachments: [],
            cleanedHash: contentHash(cleaned),
            cleaningVersion: CLEANING_VERSION,
            firstPublished: time,
            formerPaths: [],
            id: noteId(path, time),
            lastPublished: time,
            path,
            sourceHash: contentHash(source),
            state: 'published'
        }
        const note = `${NOTES_FOLDER}/${path}`
        const manifest = `${MANIFEST_FOLDER}/${entry.id}.json`
        await device.store.write(note, cleaned)
        await device.store.write(manifest, toCanonicalJson(entry))
        written.push(note, manifest)
    }
    if (written.length === 0) {
        return { published: [], corrected: [] }
    }
    await device.store.commitAndPush(
        `Publish: ${String(current.plan.publish.length)} new, 0 updated, 0 removed`,
        written
    )

    // The push succeeded: the notes are published. The vault now says so.
    const corrected: string[] = []
    for (const path of current.plan.publish) {
        const text = await device.vault.read(path)
        const wanted = text === undefined ? undefined : setProperty(text, STATE_PROPERTY, 'true')
        if (wanted !== undefined && wanted !== text) {
            await device.vault.write(path, wanted)
            corrected.push(path)
        }
    }
    return { published: current.plan.publish, corrected }
}
