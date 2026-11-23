import { compareCodePoints, sortByCodePoint } from './order.ts'
import { planLists } from './plan.ts'
import type { NormalSelection, PublicationPlan } from './plan.ts'
import type { Move, QueueLists } from './queue.ts'

// The model of the publication center of the plugin (issue 39, decision
// R67): the ticks of the author, the selection that they give, the plan that
// the publish button states, the rows of the four lists, the filters and the
// state of the open note. The view only shows it (section 18.1 of the spec).
// It is a part of the plugin, outside the parity rule (TOOL-30): the command
// line program takes the lists of a selection as they are.

/**
 * What the author ticked and unticked. The defaults (PUB-19) need no entry:
 * a changed note is published unless it is held, a candidate and a note that
 * is missing from this vault are not, and a pairing is not confirmed.
 */
export interface Choices {
    /** The ticked candidates, and the ticked moved notes whose text changed (R67). */
    readonly include: readonly string[]
    /** The unticked changed notes that the author edited. */
    readonly hold: readonly string[]
    /** True when the one line of the technical updates is unticked (PUB-24). */
    readonly holdTechnical: boolean
    /** The published notes to unpublish: the marked ones, and the ticked notes that are missing. */
    readonly unpublish: readonly string[]
    /** The confirmed pairings, and the pairings by hand (PUB-62, PUB-96). */
    readonly pair: readonly Move[]
}

/** No tick changed: the default selection. */
export const NO_CHOICES: Choices = {
    include: [],
    hold: [],
    holdTechnical: false,
    unpublish: [],
    pair: []
}

/** The pairings of the choices that the queue still allows: a missing note and a candidate, each one time. */
function pairsOf(queue: QueueLists, choices: Choices): Move[] {
    const missing = new Set(queue.missing)
    const candidates = new Set(queue.new)
    const from = new Set<string>()
    const to = new Set<string>()
    const pairs: Move[] = []
    for (const pairing of choices.pair) {
        if (
            missing.has(pairing.from) &&
            candidates.has(pairing.to) &&
            !from.has(pairing.from) &&
            !to.has(pairing.to)
        ) {
            from.add(pairing.from)
            to.add(pairing.to)
            pairs.push({ from: pairing.from, to: pairing.to })
        }
    }
    return pairs
}

/** The published notes that the author can unpublish: not the forced removals. */
function publishedOf(queue: QueueLists): Set<string> {
    return new Set([...queue.changed, ...queue.unchanged, ...queue.missing])
}

/** The changed notes that the author edited: a technical update has the one line of its own, a moved note whose text changed waits for a tick. */
function editedOf(queue: QueueLists): string[] {
    const other = new Set([...queue.technicalUpdates, ...queue.movedEdited])
    return queue.changed.filter((path) => !other.has(path))
}

/** The paths that `include` can name: the candidates and the moved notes whose text changed. */
function includableOf(queue: QueueLists): Set<string> {
    return new Set([...queue.new, ...queue.movedEdited])
}

/** The selection of the choices, for `plan` of the logic. Each list is sorted by path. */
export function selectionOf(queue: QueueLists, choices: Choices): NormalSelection {
    const pairs = pairsOf(queue, choices)
    const pairFrom = new Set(pairs.map((pairing) => pairing.from))
    const pairTo = new Set(pairs.map((pairing) => pairing.to))
    const candidates = includableOf(queue)
    const published = publishedOf(queue)
    const remove = new Set(
        choices.unpublish.filter((path) => published.has(path) && !pairFrom.has(path))
    )
    const edited = new Set(editedOf(queue))
    const hold = [
        ...choices.hold.filter((path) => edited.has(path)),
        ...(choices.holdTechnical ? queue.technicalUpdates : [])
    ].filter((path) => !remove.has(path))
    return {
        include: sortByCodePoint([
            ...new Set(choices.include.filter((path) => candidates.has(path) && !pairTo.has(path)))
        ]),
        hold: sortByCodePoint([...new Set(hold)]),
        remove: sortByCodePoint([...remove]),
        pair: pairs.sort((one, two) => compareCodePoints(one.from, two.from))
    }
}

/**
 * The plan of the choices, from the queue alone, with the function that makes
 * every plan (`planLists`): the publish button states it (TOOL-21). A
 * publication makes the plan again from the vault, and stops when it differs.
 */
export function planOfChoices(queue: QueueLists, choices: Choices): PublicationPlan {
    return planLists(queue, selectionOf(queue, choices))
}

function counted(count: number, one: string, many: string): string {
    return `${String(count)} ${count === 1 ? one : many}`
}

/** True when the plan publishes, updates, removes and moves nothing. */
export function isEmptyPlan(plan: PublicationPlan): boolean {
    return (
        plan.publish.length +
            plan.update.length +
            plan.remove.length +
            plan.forcedRemove.length +
            plan.move.length ===
        0
    )
}

/** The label of the publish button: exactly what the plan does. */
export function describePlan(plan: PublicationPlan): string {
    if (isEmptyPlan(plan)) {
        return 'Nothing to publish'
    }
    const parts = [
        [plan.publish.length, counted(plan.publish.length, 'new', 'new')],
        [plan.update.length, counted(plan.update.length, 'update', 'updates')],
        [plan.remove.length, counted(plan.remove.length, 'removal', 'removals')],
        [
            plan.forcedRemove.length,
            counted(plan.forcedRemove.length, 'forced removal', 'forced removals')
        ],
        [plan.move.length, counted(plan.move.length, 'move', 'moves')]
    ] as const
    return `Publish: ${parts
        .filter(([count]) => count > 0)
        .map(([, text]) => text)
        .join(', ')}`
}

/** The lists of the view: the four lists of the queue, with the marks of the author. */
export type ViewList = 'new' | 'changed' | 'toRemove' | 'unchanged'

/** Why a row is in its list. */
export type RowGroup =
    | 'candidate'
    | 'paired'
    | 'changed'
    | 'technical'
    | 'movedEdited'
    | 'forced'
    | 'unpublishedUnderGuard'
    | 'unpublish'
    | 'missing'
    | 'unchanged'

/** One row of a list of the view. */
export interface Row {
    readonly path: string
    readonly group: RowGroup
    /** False when the row has no check box (an unchanged note). */
    readonly checkable: boolean
    /** True when the row is part of the plan. */
    readonly ticked: boolean
    /** True when a tick of the row changes nothing: a forced removal, a technical update, a paired note. */
    readonly locked: boolean
    /** The other note of a confirmed pairing. */
    readonly pairedWith?: string
}

function row(path: string, group: RowGroup, ticked: boolean, locked = false): Row {
    return { path, group, checkable: group !== 'unchanged', ticked, locked }
}

/** The rows of the four lists of the view. Each group is sorted by path. */
export function rowsOf(queue: QueueLists, choices: Choices): Record<ViewList, Row[]> {
    const selection = selectionOf(queue, choices)
    const include = new Set(selection.include)
    const hold = new Set(selection.hold)
    const remove = new Set(selection.remove)
    const pairTo = new Map(selection.pair.map((pairing) => [pairing.to, pairing.from]))
    const pairFrom = new Map(selection.pair.map((pairing) => [pairing.from, pairing.to]))
    const technical = new Set(queue.technicalUpdates)
    const movedEdited = new Set(queue.movedEdited)
    const missing = new Set(queue.missing)
    const paired = (path: string, other: string): Row => ({
        ...row(path, 'paired', true, true),
        pairedWith: other
    })
    const marked = sortByCodePoint(
        [...queue.changed, ...queue.unchanged].filter((path) => remove.has(path))
    )
    return {
        new: queue.new.map((path) => {
            const other = pairTo.get(path)
            return other === undefined
                ? row(path, 'candidate', include.has(path))
                : paired(path, other)
        }),
        changed: queue.changed
            .filter((path) => !remove.has(path))
            .map((path) =>
                movedEdited.has(path)
                    ? row(path, 'movedEdited', include.has(path))
                    : technical.has(path)
                      ? row(path, 'technical', !hold.has(path), true)
                      : row(path, 'changed', !hold.has(path))
            ),
        toRemove: [
            ...queue.toRemove
                .filter((path) => !missing.has(path))
                .map((path) => row(path, 'forced', true, true)),
            ...queue.unpublishedUnderGuard.map((path) =>
                row(path, 'unpublishedUnderGuard', true, true)
            ),
            ...marked.map((path) => row(path, 'unpublish', true)),
            ...queue.missing.map((path) => {
                const other = pairFrom.get(path)
                return other === undefined
                    ? row(path, 'missing', remove.has(path))
                    : paired(path, other)
            })
        ],
        unchanged: queue.unchanged
            .filter((path) => !remove.has(path))
            .map((path) => row(path, 'unchanged', false))
    }
}

function without(paths: readonly string[], path: string): string[] {
    return paths.filter((one) => one !== path)
}

function flip(paths: readonly string[], path: string): string[] {
    return paths.includes(path) ? without(paths, path) : [...paths, path]
}

/**
 * The choices after a tick or an untick of the row of a path. A locked row
 * and a row with no check box change nothing.
 */
export function toggleRow(queue: QueueLists, choices: Choices, path: string): Choices {
    const rows = rowsOf(queue, choices)
    const found = [...rows.new, ...rows.changed, ...rows.toRemove].find((one) => one.path === path)
    if (found === undefined || found.locked || !found.checkable) {
        return choices
    }
    switch (found.group) {
        case 'candidate':
        case 'movedEdited':
            return { ...choices, include: flip(choices.include, path) }
        case 'changed':
            return { ...choices, hold: flip(choices.hold, path) }
        case 'unpublish':
        case 'missing':
            return { ...choices, unpublish: flip(choices.unpublish, path) }
        default:
            return choices
    }
}

/**
 * The choices with every row of these paths ticked or unticked: "select
 * shown" and "unselect shown". A note that is missing from this vault is never
 * in a bulk choice: each one is a choice of its own (PUB-95).
 */
export function setTicks(
    queue: QueueLists,
    choices: Choices,
    paths: readonly string[],
    ticked: boolean
): Choices {
    const rows = rowsOf(queue, choices)
    const byPath = new Map(
        [...rows.new, ...rows.changed, ...rows.toRemove].map((one) => [one.path, one])
    )
    const include = new Set(choices.include)
    const hold = new Set(choices.hold)
    const unpublish = new Set(choices.unpublish)
    for (const path of paths) {
        const found = byPath.get(path)
        if (found === undefined || found.locked || !found.checkable || found.ticked === ticked) {
            continue
        }
        if (found.group === 'candidate' || found.group === 'movedEdited') {
            if (ticked) include.add(path)
            else include.delete(path)
        } else if (found.group === 'changed') {
            if (ticked) hold.delete(path)
            else hold.add(path)
        } else if (found.group === 'unpublish') {
            if (ticked) unpublish.add(path)
            else unpublish.delete(path)
        }
    }
    return { ...choices, include: [...include], hold: [...hold], unpublish: [...unpublish] }
}

/** The choices after a tick or an untick of the one line of the technical updates. */
export function toggleTechnical(choices: Choices): Choices {
    return { ...choices, holdTechnical: !choices.holdTechnical }
}

/** The choices with a published note marked for its unpublish: it shows, ticked, in "to remove". */
export function markUnpublish(queue: QueueLists, choices: Choices, path: string): Choices {
    const markable = new Set([...queue.changed, ...queue.unchanged])
    if (!markable.has(path) || choices.unpublish.includes(path)) {
        return choices
    }
    return { ...choices, unpublish: [...choices.unpublish, path] }
}

function samePairing(one: Move, two: Move): boolean {
    return one.from === two.from && one.to === two.to
}

/** The choices after the confirmation of a pairing, or the end of it. */
export function togglePairing(choices: Choices, pairing: Move): Choices {
    const confirmed = choices.pair.some((one) => samePairing(one, pairing))
    return {
        ...choices,
        pair: confirmed
            ? choices.pair.filter((one) => !samePairing(one, pairing))
            : [
                  ...choices.pair.filter(
                      (one) => one.from !== pairing.from && one.to !== pairing.to
                  ),
                  { from: pairing.from, to: pairing.to }
              ]
    }
}

/** The choices with a pairing by hand (PUB-96): a missing note and the candidate that is that note now. */
export function pairByHand(choices: Choices, from: string, to: string): Choices {
    return togglePairing(
        {
            ...choices,
            pair: choices.pair.filter((one) => one.from !== from && one.to !== to)
        },
        { from, to }
    )
}

/** The choices after a new check: a choice about a note that left its list is dropped. */
export function reconcile(queue: QueueLists, choices: Choices): Choices {
    const candidates = includableOf(queue)
    const edited = new Set(editedOf(queue))
    const published = publishedOf(queue)
    return {
        include: choices.include.filter((path) => candidates.has(path)),
        hold: choices.hold.filter((path) => edited.has(path)),
        holdTechnical: choices.holdTechnical,
        unpublish: choices.unpublish.filter((path) => published.has(path)),
        pair: pairsOf(queue, choices)
    }
}

/** The filters of the view (TOOL-21): a text and a folder, together. */
export interface Filter {
    /** Words that the path must hold, in any letter case. */
    readonly text: string
    /** A folder of the vault: the rows of this folder and of the folders below it. Empty for every folder. */
    readonly folder: string
}

/** The rows that the filter shows, in their order. */
export function filterRows(rows: readonly Row[], filter: Filter): Row[] {
    const words = filter.text
        .toLowerCase()
        .split(/\s+/u)
        .filter((word) => word !== '')
    const folder = filter.folder.replace(/\/+$/u, '')
    return rows.filter((one) => {
        if (folder !== '' && !one.path.startsWith(`${folder}/`)) {
            return false
        }
        const path = one.path.toLowerCase()
        return words.every((word) => path.includes(word))
    })
}

/** The line under the filters (B11 of the tool study): shown, selected, and selected but hidden. */
export function summaryOf(
    rows: readonly Row[],
    shown: readonly Row[]
): { shown: number; total: number; selected: number; hidden: number } {
    const visible = new Set(shown.map((one) => one.path))
    const ticked = rows.filter((one) => one.checkable && one.ticked)
    return {
        shown: shown.length,
        total: rows.length,
        selected: ticked.length,
        hidden: ticked.filter((one) => !visible.has(one.path)).length
    }
}

/** The state of a note in the status bar (TOOL-23). */
export type NoteStateKind =
    | 'unknown'
    | 'unchecked'
    | 'live'
    | 'changed'
    | 'technical'
    | 'moved'
    | 'movedEdited'
    | 'new'
    | 'unpublish'
    | 'forced'
    | 'excluded'

export interface NoteState {
    readonly kind: NoteStateKind
    readonly label: string
}

const LABELS: Record<NoteStateKind, string> = {
    unknown: 'State unknown',
    unchecked: 'Not checked yet',
    live: 'Live',
    changed: 'Live: changes not published',
    technical: 'Live: an update of its links or files waits',
    moved: 'Live: moves to this path at the next publication',
    movedEdited:
        'Live: moves to this path at the next publication, and its new text waits for a tick',
    new: 'Not published',
    unpublish: 'Will be unpublished',
    forced: 'Removal forced: a guard excludes it',
    excluded: 'Not in the queue: a guard excludes it'
}

function kindOf(queue: QueueLists, choices: Choices, path: string): NoteStateKind | undefined {
    if (selectionOf(queue, choices).remove.includes(path)) {
        return 'unpublish'
    }
    if (queue.unpublishedUnderGuard.includes(path)) {
        return 'forced'
    }
    if (queue.toRemove.includes(path)) {
        return queue.missing.includes(path) ? undefined : 'forced'
    }
    if (queue.movedEdited.includes(path)) {
        return 'movedEdited'
    }
    if (queue.renamed.some((move) => move.to === path)) {
        return 'moved'
    }
    if (queue.technicalUpdates.includes(path)) {
        return 'technical'
    }
    if (queue.changed.includes(path)) {
        return 'changed'
    }
    if (queue.unchanged.includes(path)) {
        return 'live'
    }
    if (queue.new.includes(path)) {
        return 'new'
    }
    return undefined
}

/**
 * The state of a note at the last check. `edited` is true when the note
 * changed after that check: a note in no list is then not checked yet, and
 * every other state gets a mark. A note in no list that did not change is
 * under a guard: in a folder of the deny list, or with `publish_ignore`.
 */
export function stateOfNote(
    queue: QueueLists | undefined,
    choices: Choices,
    path: string,
    edited: boolean
): NoteState {
    if (queue === undefined) {
        return { kind: 'unknown', label: LABELS.unknown }
    }
    const kind = kindOf(queue, choices, path) ?? (edited ? 'unchecked' : 'excluded')
    const label = LABELS[kind]
    return {
        kind,
        label: edited && kind !== 'unchecked' ? `${label} (edited since the check)` : label
    }
}
