import { toCanonicalJson } from './canonical.ts'
import { isVaultPath } from './configuration.ts'
import { sha256Hex } from './hash.ts'
import { parseJson } from './json.ts'
import { compareCodePoints, sortByCodePoint } from './order.ts'
import { isCanonicalTime, isFace, isOneLine } from './run.ts'
import type { Face } from './run.ts'

// The log of the edits of the guards and their proposals: `edits.json` of the
// content store (issue 42, decisions R69). The rules are in
// `documentation/Canonical Form.md`, section "The edits of the guards". The
// Rust twin is `cli/src/edits.rs`. Change both in the same commit.

/** The path of the log in the content store. */
export const EDITS_FILE = 'edits.json'

/** The edits of the guards: two that make the guards stricter, two that make them looser. */
export const EDIT_ACTIONS = ['deny', 'allow', 'ignore', 'unignore'] as const
export type EditAction = (typeof EDIT_ACTIONS)[number]

/** The states of an event. */
export const EDIT_STATES = ['applied', 'proposed', 'confirmed', 'rejected'] as const
export type EditState = (typeof EDIT_STATES)[number]

/** One event of the log. It is never changed and never removed. */
// A type alias, not an interface: the canonical form takes any object of data.
export type EditEvent = {
    readonly action: EditAction
    /** The name of the device of the run. */
    readonly device: string
    readonly face: Face
    /** 16 small hexadecimal digits of the SHA-256 of the event without `id`, in the canonical form. */
    readonly id: string
    /** The folder (`deny`, `allow`) or the vault path of the note (`ignore`, `unignore`). */
    readonly path: string
    /** For `confirmed` and `rejected`: the id of the proposal. */
    readonly proposal?: string
    /** For `proposed` and `confirmed`: the vault paths of the manifest entries that the edit takes away, sorted. No key when there is none. */
    readonly removes?: readonly string[]
    readonly state: EditState
    readonly time: string
}

/** `edits.json` as data. */
// A type alias, not an interface: the canonical form takes any object of data.
export type EditsLog = {
    /** The events, in the order in which they were written. */
    readonly edits: readonly EditEvent[]
    /** How many events of `edits` a publication showed. */
    readonly published: number
}

/** The log of a content store without `edits.json`. */
export const NO_EDITS: EditsLog = { edits: [], published: 0 }

/** True for an edit that makes the guards looser: always a proposal (R69, decision 1). */
export function isLooser(action: EditAction): boolean {
    return action === 'allow' || action === 'unignore'
}

/** True for an edit of a note (the ignore property), false for an edit of the deny list. */
export function isNoteEdit(action: EditAction): boolean {
    return action === 'ignore' || action === 'unignore'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The id of an event: 16 small hexadecimal digits of the SHA-256 of its canonical form without `id`. */
export function eventId(event: Omit<EditEvent, 'id'>): string {
    const { id: _id, ...rest } = event as EditEvent
    return sha256Hex(toCanonicalJson(rest)).slice(0, 16)
}

/**
 * Makes an event with its id. `removes` is sorted by path, each path one
 * time, and an empty list has no key.
 */
export function makeEvent(fields: {
    readonly action: EditAction
    readonly device: string
    readonly face: Face
    readonly path: string
    readonly proposal?: string
    readonly removes?: readonly string[]
    readonly state: EditState
    readonly time: string
}): EditEvent {
    const { removes, proposal, ...rest } = fields
    const sorted = sortByCodePoint([...new Set(removes ?? [])])
    const event = {
        ...rest,
        ...(proposal === undefined ? {} : { proposal }),
        ...(sorted.length === 0 ? {} : { removes: sorted })
    }
    return { ...event, id: eventId(event) }
}

/** The keys that an event can have. */
const EVENT_KEYS = new Set([
    'action',
    'device',
    'face',
    'id',
    'path',
    'proposal',
    'removes',
    'state',
    'time'
])

/** The form of an id of an event. */
const EVENT_ID = /^[0-9a-f]{16}$/u

/**
 * Reads the log from the text of its file, strictly. A content store without
 * the file has no event. It throws, with a message that names the file, when
 * the text is not a valid log: `published` above the number of events, an
 * `id` that is not the hash of its event, or a decision of a proposal that is
 * not an earlier open proposal.
 */
export function parseEdits(text: string | undefined): EditsLog {
    if (text === undefined) {
        return NO_EDITS
    }
    const refuse = (why: string): never => {
        throw new Error(
            `${EDITS_FILE} of the content store is not valid: ${why}. No run is possible until it is corrected`
        )
    }
    let value: unknown
    try {
        value = parseJson(text)
    } catch {
        return refuse('it is not JSON')
    }
    if (!isRecord(value)) {
        return refuse('it is not an object')
    }
    const other = sortByCodePoint(Object.keys(value)).find(
        (key) => key !== 'edits' && key !== 'published'
    )
    if (other !== undefined) {
        return refuse(`it has the key "${other}"`)
    }
    const { edits, published } = value
    if (!Array.isArray(edits)) {
        return refuse('"edits" is not a list')
    }
    if (typeof published !== 'number' || !Number.isSafeInteger(published) || published < 0) {
        return refuse('"published" is not a whole number of 0 or more')
    }
    if (published > edits.length) {
        return refuse(
            `"published" is ${String(published)}, above the number of events (${String(edits.length)})`
        )
    }
    const events: EditEvent[] = []
    // The proposals that no event decided yet, by their ids.
    const open = new Map<string, EditEvent>()
    for (const [index, item] of (edits as unknown[]).entries()) {
        const where = `event ${String(index + 1)}`
        const event = readEvent(item, (why) => refuse(`${where} ${why}`))
        if (event.id !== eventId(event)) {
            return refuse(`the id of ${where} is not the hash of the event`)
        }
        if (event.proposal !== undefined) {
            const proposal = open.get(event.proposal)
            if (proposal === undefined) {
                return refuse(
                    `${where} decides "${event.proposal}", which is not an earlier proposal that no event decided`
                )
            }
            if (proposal.action !== event.action || proposal.path !== event.path) {
                return refuse(`${where} has another action or path than its proposal`)
            }
            open.delete(event.proposal)
        }
        if (event.state === 'proposed') {
            open.set(event.id, event)
        }
        events.push(event)
    }
    return { edits: events, published }
}

/** Reads one event. `refuse` throws with the reason. */
function readEvent(item: unknown, refuse: (why: string) => never): EditEvent {
    if (!isRecord(item)) {
        return refuse('is not an object')
    }
    const other = sortByCodePoint(Object.keys(item)).find((key) => !EVENT_KEYS.has(key))
    if (other !== undefined) {
        return refuse(`has the key "${other}"`)
    }
    const { action, device, face, id, path, proposal, removes, state, time } = item
    if (typeof action !== 'string' || !(EDIT_ACTIONS as readonly string[]).includes(action)) {
        return refuse('has no action deny, allow, ignore or unignore')
    }
    if (typeof state !== 'string' || !(EDIT_STATES as readonly string[]).includes(state)) {
        return refuse('has no state applied, proposed, confirmed or rejected')
    }
    const edit = action as EditAction
    const status = state as EditState
    if (typeof device !== 'string' || !isOneLine(device)) {
        return refuse('has no device of one line')
    }
    if (typeof face !== 'string' || !isFace(face)) {
        return refuse('has no face plugin, command-line or mcp-server')
    }
    if (typeof id !== 'string' || !EVENT_ID.test(id)) {
        return refuse('has no id of 16 small hexadecimal digits')
    }
    if (
        typeof path !== 'string' ||
        !isVaultPath(path) ||
        (isNoteEdit(edit) && !path.endsWith('.md'))
    ) {
        return refuse('has no path of a folder or of a note')
    }
    if (typeof time !== 'string' || !isCanonicalTime(time)) {
        return refuse('has no time in the canonical form')
    }
    if (status === 'applied' && isLooser(edit)) {
        return refuse(`is an ${edit} that applied, but such an edit is always a proposal`)
    }
    const decision = status === 'confirmed' || status === 'rejected'
    if (decision !== (proposal !== undefined)) {
        return refuse('has a proposal when it is no decision, or no proposal when it is one')
    }
    // Only the author decides a proposal, in the view (rule 7).
    if (decision && face !== 'plugin') {
        return refuse(`is a decision with the face ${face}, but only the face plugin decides`)
    }
    if (proposal !== undefined && (typeof proposal !== 'string' || !EVENT_ID.test(proposal))) {
        return refuse('has no proposal of 16 small hexadecimal digits')
    }
    if (removes !== undefined) {
        if (status !== 'proposed' && status !== 'confirmed') {
            return refuse('has a list "removes", which only a proposal and a confirmation have')
        }
        if (
            !Array.isArray(removes) ||
            removes.length === 0 ||
            !removes.every(
                (one, at) =>
                    typeof one === 'string' &&
                    isVaultPath(one) &&
                    (at === 0 || compareCodePoints(String(removes[at - 1]), one) < 0)
            )
        ) {
            return refuse('has a list "removes" that is not vault paths, each one time, sorted')
        }
    }
    return {
        action: edit,
        device,
        face,
        id,
        path,
        ...(typeof proposal === 'string' ? { proposal } : {}),
        ...(removes === undefined ? {} : { removes: removes as string[] }),
        state: status,
        time
    }
}

/** The text of the log, in the canonical form. */
export function editsText(log: EditsLog): string {
    return toCanonicalJson(log)
}

/** The log with one more event at its end. */
export function withEvent(log: EditsLog, event: EditEvent): EditsLog {
    return { edits: [...log.edits, event], published: log.published }
}

/** The open proposals: each `proposed` event that no later event confirms or rejects, in the order of the log. */
export function openProposals(log: EditsLog): EditEvent[] {
    // A decision decides the last open proposal with its id: an equal
    // proposal can come again after a decision, with the same id.
    const open = new Map<string, number>()
    for (const [index, event] of log.edits.entries()) {
        if (event.state === 'proposed') {
            open.set(event.id, index)
        } else if (event.proposal !== undefined) {
            open.delete(event.proposal)
        }
    }
    const kept = new Set(open.values())
    return log.edits.filter((_event, index) => kept.has(index))
}

/** The events that no publication showed yet: the ones after the first `published` ones, in the order of the log. */
export function eventsSince(log: EditsLog): EditEvent[] {
    return log.edits.slice(log.published)
}
