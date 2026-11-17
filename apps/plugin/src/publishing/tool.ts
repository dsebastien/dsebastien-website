import { toCanonicalJson } from './canonical.ts'
import { CLEANING_VERSION, cleanNote, sourceOf, STATE_PROPERTY } from './clean.ts'
import { CONFIGURATION_FILE, parseConfiguration } from './configuration.ts'
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

/** A time in the canonical form: UTC, to the second. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The record of a plan: the plan and the selection that gave it, in the canonical form. */
function recordOf(plan: PublicationPlan, selection: Selection): string {
    return toCanonicalJson({
        plan,
        selection: { include: sortByCodePoint([...new Set(selection.include)]) }
    })
}

async function planFor(device: Device, selection: Selection): Promise<PublicationPlan> {
    return await computePlan({
        vault: device.vault,
        manifest: await readManifest(device.store),
        configuration: parseConfiguration(await device.store.read(CONFIGURATION_FILE)),
        selection
    })
}

/**
 * Computes a publication plan and stores it on the device. It writes nothing
 * into the vault and nothing into the content of the store.
 */
export async function plan(device: Device, selection: Selection): Promise<StoredPlan> {
    const computed = await planFor(device, selection)
    const record = recordOf(computed, selection)
    // The id names the record. It is outside the parity rule (TOOL-30).
    const id = sha256Hex(record).slice(0, 16)
    await device.plans.save(id, record)
    return { id, plan: computed }
}

/** Reads the selection of a stored record. It throws when the record is not one. */
function selectionOf(record: string, id: string): Selection {
    const value: unknown = JSON.parse(record)
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
 * It computes the plan again: when the vault or the content store changed
 * since the plan, the plan is stale and nothing is published. Then the cleaned
 * notes and their manifest entries go to the content store in one commit,
 * which is pushed. Only after the push, the state property of the published
 * notes is corrected in the vault.
 *
 * @param time the time of the run, in the canonical form. It is an input: the logic reads no clock.
 */
export async function publish(
    device: Device,
    id: string,
    time: string
): Promise<PublicationReport> {
    if (!TIME.test(time)) {
        throw new Error(`the time of the run must be in UTC, to the second: "${time}" is not`)
    }
    const record = await device.plans.load(id)
    if (record === undefined) {
        throw new Error(`there is no plan with the id ${id} on this device`)
    }
    const selection = selectionOf(record, id)
    const current = await planFor(device, selection)
    if (recordOf(current, selection) !== record) {
        throw new Error(
            `the plan ${id} is stale: the vault or the content store changed. Make a new plan`
        )
    }

    for (const path of current.publish) {
        const text = await device.vault.read(path)
        if (text === undefined) {
            throw new Error(`"${path}" does not exist in the vault`)
        }
        const source = sourceOf(text)
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
        await device.store.write(`${NOTES_FOLDER}/${path}`, cleaned)
        await device.store.write(`${MANIFEST_FOLDER}/${entry.id}.json`, toCanonicalJson(entry))
    }
    if (current.publish.length === 0) {
        return { published: [], corrected: [] }
    }
    await device.store.commitAndPush(
        `Publish: ${String(current.publish.length)} new, 0 updated, 0 removed`
    )

    // The push succeeded: the notes are published. The vault now says so.
    const corrected: string[] = []
    for (const path of current.publish) {
        const text = await device.vault.read(path)
        const wanted = text === undefined ? undefined : setProperty(text, STATE_PROPERTY, 'true')
        if (wanted !== undefined && wanted !== text) {
            await device.vault.write(path, wanted)
            corrected.push(path)
        }
    }
    return { published: current.publish, corrected }
}
