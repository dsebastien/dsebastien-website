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
    /**
     * For `proposed` and `confirmed` of `deny`: the vault paths of the
     * published entries, not in `removes`, that use an attachment that the
     * edit puts under the guard (R69, review round 2), sorted. No key when
     * there is none.
     */
    readonly affects?: readonly string[]
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
 * Makes an event with its id. `removes` and `affects` are sorted by path,
 * each path one time, and an empty list has no key.
 */
export function makeEvent(fields: {
    readonly action: EditAction
    readonly affects?: readonly string[]
    readonly device: string
    readonly face: Face
    readonly path: string
    readonly proposal?: string
    readonly removes?: readonly string[]
    readonly state: EditState
    readonly time: string
}): EditEvent {
    const { affects, removes, proposal, ...rest } = fields
    const sorted = sortByCodePoint([...new Set(removes ?? [])])
    const affected = sortByCodePoint([...new Set(affects ?? [])])
    const event = {
        ...rest,
        ...(affected.length === 0 ? {} : { affects: affected }),
        ...(proposal === undefined ? {} : { proposal }),
        ...(sorted.length === 0 ? {} : { removes: sorted })
    }
    return { ...event, id: eventId(event) }
}

/** The keys that an event can have. */
const EVENT_KEYS = new Set([
    'action',
    'affects',
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

/** The message of a log that is not valid: it names the file. */
function notValid(reason: string): Error {
    return new Error(
        `${EDITS_FILE} of the content store is not valid: ${reason}. No run is possible until it is corrected`
    )
}

/**
 * Reads the log from the text of its file, strictly, in the order of checks
 * of the Rust twin and with its texts. A content store without the file has
 * no event. It throws, with a message that names the file, when the text is
 * not a valid log: `published` above the number of events, an `id` that is
 * not the hash of its event, or a decision of a proposal that is not an
 * earlier proposal that no other event decided.
 */
export function parseEdits(text: string | undefined): EditsLog {
    if (text === undefined) {
        return NO_EDITS
    }
    let value: unknown
    try {
        value = parseJson(text)
    } catch {
        throw notValid('it is not JSON')
    }
    if (!isRecord(value) || Object.keys(value).length !== 2) {
        throw notValid('it must be an object with exactly "edits" and "published"')
    }
    const { edits, published } = value
    if (!Array.isArray(edits)) {
        throw notValid('"edits" must be a list of events')
    }
    if (typeof published !== 'number' || !Number.isSafeInteger(published) || published < 0) {
        throw notValid('"published" must be a whole number from 0')
    }
    const events: EditEvent[] = []
    // The proposals that no event decided yet, by their ids.
    const open = new Map<string, EditEvent>()
    for (const [index, item] of (edits as unknown[]).entries()) {
        const place = String(index + 1)
        const event = readEvent(item, (why) => {
            throw notValid(`the event ${place} ${why}`)
        })
        if (event.proposal !== undefined) {
            const proposal = open.get(event.proposal)
            if (proposal === undefined) {
                throw notValid(
                    `the event ${place} decides "${event.proposal}", which is not an earlier proposal that no other event decided`
                )
            }
            if (proposal.action !== event.action || proposal.path !== event.path) {
                throw notValid(`the event ${place} has another action or path than its proposal`)
            }
            open.delete(event.proposal)
        }
        if (event.state === 'proposed') {
            open.set(event.id, event)
        }
        events.push(event)
    }
    if (published > events.length) {
        throw notValid(
            `"published" is ${String(published)}, above the number of events (${String(events.length)})`
        )
    }
    return { edits: events, published }
}

/**
 * A list `removes` or `affects` of an event: vault paths, sorted, each one
 * time, not empty. `undefined` when the event has no such key. `refuse`
 * throws with the reason.
 */
function pathListOf(
    value: unknown,
    key: 'removes' | 'affects',
    allowed: boolean,
    which: string,
    refuse: (why: string) => never
): string[] | undefined {
    if (value === undefined) {
        return undefined
    }
    if (!allowed) {
        return refuse(`has a list "${key}", which only ${which} have`)
    }
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every(
            (one, at) =>
                typeof one === 'string' &&
                isVaultPath(one) &&
                (at === 0 || compareCodePoints(String(value[at - 1]), one) < 0)
        )
    ) {
        return refuse(`has a list "${key}" that is not vault paths, each one time, sorted`)
    }
    return value as string[]
}

/** Reads one event, in the order of checks of the Rust twin. `refuse` throws with the reason. */
function readEvent(item: unknown, refuse: (why: string) => never): EditEvent {
    if (!isRecord(item)) {
        return refuse('is not an object')
    }
    // The first key in the order of the code points, as the Rust twin finds it.
    const other = sortByCodePoint(Object.keys(item)).find((key) => !EVENT_KEYS.has(key))
    if (other !== undefined) {
        return refuse(`has the key "${other}", which no event has`)
    }
    const required = (key: string): string => {
        const found = item[key]
        return typeof found === 'string' ? found : refuse(`has no text "${key}"`)
    }
    const action = required('action')
    const state = required('state')
    const path = required('path')
    const face = required('face')
    const device = required('device')
    const time = required('time')
    const id = required('id')
    if (!(EDIT_ACTIONS as readonly string[]).includes(action)) {
        return refuse(`has the action "${action}", which is not deny, allow, ignore or unignore`)
    }
    if (!(EDIT_STATES as readonly string[]).includes(state)) {
        return refuse(
            `has the state "${state}", which is not applied, proposed, confirmed or rejected`
        )
    }
    const edit = action as EditAction
    const status = state as EditState
    if (!isVaultPath(path) || (isNoteEdit(edit) && !path.endsWith('.md'))) {
        return refuse('has a path that is not the vault path of a folder or of a note')
    }
    if (!isFace(face)) {
        return refuse(`has the face "${face}", which is not a face of the tool`)
    }
    if (!isOneLine(device)) {
        return refuse('has a name of the device that is not one line of text')
    }
    if (!isCanonicalTime(time)) {
        return refuse('has a time that is not a real date and time in UTC, to the second')
    }
    if (status === 'applied' && isLooser(edit)) {
        return refuse(`is an ${edit} that applied, but such an edit is always a proposal`)
    }
    const decision = status === 'confirmed' || status === 'rejected'
    // Only the author decides a proposal, in the view (rule 7).
    if (decision && face !== 'plugin') {
        return refuse(
            `is a decision of the face "${face}": only the author decides a proposal, in the view (the face plugin)`
        )
    }
    const proposal = item['proposal']
    if (proposal === undefined && decision) {
        return refuse('decides no proposal: it has no "proposal"')
    }
    if (
        proposal !== undefined &&
        (!decision || typeof proposal !== 'string' || !EVENT_ID.test(proposal))
    ) {
        return refuse('has a "proposal" that is not the id of a proposal it decides')
    }
    const listed = status === 'proposed' || status === 'confirmed'
    const removes = pathListOf(
        item['removes'],
        'removes',
        listed,
        'a proposal and a confirmation',
        refuse
    )
    const affects = pathListOf(
        item['affects'],
        'affects',
        listed && edit === 'deny',
        'a proposal and a confirmation of a deny',
        refuse
    )
    if (!EVENT_ID.test(id)) {
        return refuse('has no id of 16 small hexadecimal digits')
    }
    const event: EditEvent = {
        action: edit,
        ...(affects === undefined ? {} : { affects }),
        device,
        face,
        id,
        path,
        ...(typeof proposal === 'string' ? { proposal } : {}),
        ...(removes === undefined ? {} : { removes }),
        state: status,
        time
    }
    if (eventId(event) !== id) {
        return refuse(`has the id "${id}", which is not the hash of the event`)
    }
    return event
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
