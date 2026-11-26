import { sortTooLarge } from './attachments.ts'
import type { TooLarge } from './attachments.ts'
import { isVaultPath } from './configuration.ts'
import { eventsSince } from './edits.ts'
import type { EditEvent } from './edits.ts'
import { guardOfPath, IGNORE_PROPERTY } from './guards.ts'
import {
    firstPart,
    foldedForm,
    isChangedByObsidian,
    isReservedRootName,
    obsidianPath,
    obsidianTwins
} from './names.ts'
import { sortByCodePoint } from './order.ts'
import { compareCodePoints } from './order.ts'
import type { Move, QueueLists, Scan } from './queue.ts'

// The publication plan as data: the exact list of what one publication will
// do. The rules are in `documentation/Canonical Form.md`, sections "The
// selection" and "The publication plan". The Rust twin is `cli/src/plan.rs`.
// Change both in the same commit.

/**
 * The notes that one publication publishes, updates and removes, as vault
 * paths. Each list is sorted by path, in the order of the code points.
 */
// A type alias, not an interface: the canonical form takes any object of data,
// and an interface is not one for the compiler.
export type PublicationPlan = {
    /**
     * The events of the edits of the guards that no publication showed yet,
     * in the order of the log (R69, GATE-07, GATE-40). A new event makes a
     * stored plan stale, and the publication marks them as shown.
     */
    readonly edits: readonly EditEvent[]
    /** The forced removals: the notes with a manifest entry that a guard excludes, also unpublished ones (R64). No selection changes this list (PUB-21). */
    readonly forcedRemove: readonly string[]
    /**
     * The published entries, after the plan, whose `attachments` list a file
     * that is under a guard now (rule 8 of "A publication"): the publication
     * would delete the file, and the note would show it as missing. Sorted.
     */
    readonly guardedAttachments: readonly string[]
    /** The moves: of the new lines of the rename journals, and of the pairings of the selection (R66). Sorted by `from`. */
    readonly move: readonly Move[]
    readonly publish: readonly string[]
    readonly update: readonly string[]
    readonly remove: readonly string[]
}

/** What the author, or an agent that he started, selected for one plan. */
export interface Selection {
    /** The vault paths of the notes to publish. A new candidate enters a plan only through this list. */
    readonly include: readonly string[]
    /** The vault paths of the notes to leave out: their live version stays. */
    readonly hold?: readonly string[]
    /** The vault paths of the published notes to unpublish. */
    readonly remove?: readonly string[]
    /** The pairings that the author confirms: a published note that is missing, and the candidate that is that note now (PUB-62, PUB-96). */
    readonly pair?: readonly Move[]
    /**
     * The forced removals and the notes of `guardedAttachments` that the
     * author named: an agent face applies a plan only when it names each of
     * them (rule 10 of "The edits of the guards"). It changes nothing in the plan.
     */
    readonly accept?: readonly string[]
}

/** A selection with its three lists, each path one time, sorted. It is a part of the record of a plan. */
export type NormalSelection = {
    readonly accept: readonly string[]
    readonly hold: readonly string[]
    readonly include: readonly string[]
    /** Each pairing one time, sorted by `from`. */
    readonly pair: readonly Move[]
    readonly remove: readonly string[]
}

/** A selection that cannot become a plan. The message says which path and why. */
export class SelectionError extends Error {
    override readonly name = 'SelectionError'
}

/**
 * Makes a plan from its four lists. Each list is put in the order of the
 * canonical form here, so that no caller can give a plan in another order.
 */
export function makePlan(lists: {
    edits?: readonly EditEvent[]
    forcedRemove: readonly string[]
    guardedAttachments?: readonly string[]
    move?: readonly Move[]
    publish: readonly string[]
    update: readonly string[]
    remove: readonly string[]
}): PublicationPlan {
    return {
        // The events keep the order of the log.
        edits: [...(lists.edits ?? [])],
        forcedRemove: sortByCodePoint(lists.forcedRemove),
        guardedAttachments: sortByCodePoint(lists.guardedAttachments ?? []),
        move: sortMoves(lists.move ?? []),
        publish: sortByCodePoint(lists.publish),
        update: sortByCodePoint(lists.update),
        remove: sortByCodePoint(lists.remove)
    }
}

function unique(paths: readonly string[] | undefined): string[] {
    return sortByCodePoint([...new Set(paths ?? [])])
}

/** Moves sorted by `from`, then by `to`, each one time. */
function sortMoves(moves: readonly Move[]): Move[] {
    const seen = new Set<string>()
    return [...moves]
        .sort(
            (one, two) => compareCodePoints(one.from, two.from) || compareCodePoints(one.to, two.to)
        )
        .filter((move) => {
            const key = `${move.from}\n${move.to}`
            if (seen.has(key)) {
                return false
            }
            seen.add(key)
            return true
        })
        .map(({ from, to }) => ({ from, to }))
}

/** The selection with each path one time, in the order of the canonical form. */
export function normalSelection(selection: Selection): NormalSelection {
    // A face can give data that the types do not hold: a pairing is an object
    // with exactly a text `from` and a text `to`.
    const pairs: unknown = selection.pair ?? []
    if (!Array.isArray(pairs)) {
        throw new SelectionError('the pairings of the selection are not a list')
    }
    for (const pairing of pairs as unknown[]) {
        const value: unknown = pairing
        if (
            typeof value !== 'object' ||
            value === null ||
            Object.keys(value).length !== 2 ||
            typeof (value as Record<string, unknown>)['from'] !== 'string' ||
            typeof (value as Record<string, unknown>)['to'] !== 'string'
        ) {
            throw new SelectionError(
                'a pairing of the selection is not an object with a text "from" and a text "to"'
            )
        }
    }
    return {
        accept: unique(selection.accept),
        hold: unique(selection.hold),
        include: unique(selection.include),
        pair: sortMoves(selection.pair ?? []),
        remove: unique(selection.remove)
    }
}

/** Why a path that is in no list of the queue cannot be published. */
function reasonOutOfQueue(path: string, scan: Scan): string {
    if (guardOfPath(path, scan.configuration) !== undefined) {
        return 'is in a folder of the deny list'
    }
    if (scan.ignored.has(path)) {
        return `has the ${IGNORE_PROPERTY} property`
    }
    return 'does not exist in the vault as a note. A symbolic link and a name that starts with a dot are not part of the vault'
}

/**
 * Computes the publication plan of a selection from the queue.
 *
 * A plan without paths holds the changed notes only. A new candidate enters a
 * plan only when its path is included (PUB-19, PUB-54). Every plan holds
 * every forced removal: a note with a manifest entry that a guard excludes,
 * published or unpublished, leaves the content store at the next publication,
 * whatever is selected, and it cannot be held (PUB-21, R64).
 * A selection that cannot become a plan stops with a `SelectionError`.
 * A note of `tooLarge` (the candidates of the selection) or of `tooLarge` of
 * the queue is held: it links to a file above the size limit (issue 72).
 */
export function computePlan(
    scan: Scan,
    selection: NormalSelection,
    tooLarge: readonly TooLarge[] = []
): PublicationPlan {
    const { queue } = scan
    const refuse = (path: string, reason: string): never => {
        throw new SelectionError(`"${path}" ${reason}`)
    }
    const pairFrom = selection.pair.map((pairing) => pairing.from)
    const pairTo = selection.pair.map((pairing) => pairing.to)
    // The `to` of a pairing can be held: the move happens, the update waits.
    const heldTo = new Set(selection.hold.filter((path) => pairTo.includes(path)))
    const all = [
        ...selection.hold,
        ...selection.include,
        ...selection.remove,
        ...pairFrom,
        ...pairTo.filter((path) => !heldTo.has(path))
    ]
    for (const path of [...all, ...selection.accept]) {
        if (!isVaultPath(path)) {
            refuse(path, 'is not a vault path')
        }
        if (!path.endsWith('.md')) {
            refuse(path, 'is not a note: its name does not end in .md')
        }
    }
    const twice = sortByCodePoint(all).find((path, index, paths) => paths[index + 1] === path)
    if (twice !== undefined) {
        refuse(twice, 'is in more than one list of the selection')
    }

    const candidates = new Set(queue.new)
    const changed = new Set(queue.changed)
    const waiting = new Set(queue.toRemove)
    const unchanged = new Set(queue.unchanged)
    // A published note is a forced removal when a guard excludes it. A note
    // whose file is only missing from this vault is not one (PUB-95).
    const onlyMissing = new Set(queue.missing)
    const forced = queue.toRemove.filter((path) => !onlyMissing.has(path))
    const underGuard = new Set(forced)
    const unpublishedUnderGuard = new Set(queue.unpublishedUnderGuard)
    for (const path of selection.include) {
        if (waiting.has(path)) {
            refuse(path, 'is published and waits for its removal: it cannot be published again')
        }
        if (!candidates.has(path) && !changed.has(path) && !unchanged.has(path)) {
            refuse(path, reasonOutOfQueue(path, scan))
        }
    }
    for (const path of selection.hold) {
        if (underGuard.has(path)) {
            refuse(path, 'is published and a guard excludes it: its removal cannot be held')
        }
        if (unpublishedUnderGuard.has(path)) {
            refuse(path, 'is unpublished and a guard excludes it: its removal cannot be held')
        }
        if (
            !candidates.has(path) &&
            !changed.has(path) &&
            !waiting.has(path) &&
            !unchanged.has(path)
        ) {
            refuse(path, 'is not a note of the publication queue: there is nothing to hold')
        }
    }
    for (const path of selection.remove) {
        if (scan.manifest.get(path)?.state !== 'published') {
            // The queue has a moved note at its new path (issue 105).
            const move = queue.renamed.find((one) => one.from === path)
            refuse(
                path,
                move === undefined
                    ? 'is not published: there is nothing to remove'
                    : `is not published at this path: a rename journal moves the note to "${move.to}", and the plan names it there`
            )
        }
    }
    const pairedTo = new Set<string>()
    for (const { from, to } of selection.pair) {
        if (pairedTo.has(to)) {
            refuse(to, 'is the candidate of more than one pairing')
        }
        pairedTo.add(to)
        if (queue.renamed.some((move) => move.to === from)) {
            refuse(
                from,
                'is the new path of a move of a rename journal in this plan: publish the move first, then confirm the pairing'
            )
        }
        if (!onlyMissing.has(from)) {
            refuse(
                from,
                'is not a published note that is missing from this vault: it cannot be paired'
            )
        }
        if (!candidates.has(to) || scan.manifest.has(to)) {
            refuse(to, 'is not a candidate with no manifest entry: it cannot be paired')
        }
    }

    const plan = planLists(queue, selection, eventsSince(scan.edits), scan.guardedEntries, tooLarge)
    refuseObsidianPaths(scan, plan, selection.pair)
    refuseRootNames(scan, plan, selection.pair)
    // accept only names what an agent face must see named (rule 8).
    const acceptable = new Set([...plan.forcedRemove, ...plan.guardedAttachments])
    for (const path of selection.accept) {
        if (!acceptable.has(path)) {
            refuse(
                path,
                'is in accept, but it is neither a forced removal nor a note of guardedAttachments of the plan: accept names only those'
            )
        }
    }
    return plan
}

/**
 * Stops a plan that publishes a note, or pairs a note with a path, that
 * Obsidian reads as another path or as the path of another note of the scan
 * (rule 4 of section "Paths" of the canonical form, decision R72): its
 * links, the Starter Kit and the refresh of its lists would not find it, or
 * would find the other file. The author gives the file another name. A plan
 * without a new note and without a pairing never stops here, so no forced
 * removal waits for this rule.
 */
function refuseObsidianPaths(scan: Scan, plan: PublicationPlan, pairs: readonly Move[]): void {
    const paths = [...plan.publish, ...pairs.map((pairing) => pairing.to)]
    if (paths.length === 0) {
        return
    }
    const twins = obsidianTwins(scan.notes.keys())
    for (const path of paths) {
        if (isChangedByObsidian(path)) {
            throw new SelectionError(
                `"${path}" cannot be published: Obsidian reads its path as "${obsidianPath(path)}" (a no-break space, a backslash, a slash too many or a name that is not in the composed Unicode form), so its links and its note type would not find it. Give the file another name, in Obsidian or outside it`
            )
        }
        const twin = twins.get(path)
        if (twin !== undefined) {
            throw new SelectionError(
                `"${path}" cannot be published: the file "${twin}" has the same path in Obsidian ("${obsidianPath(path)}"), so Obsidian can take one for the other. Give one of the two files another name`
            )
        }
    }
}

/** The vault path of a note without `.md`: the text of its URL. */
function withoutSuffix(path: string): string {
    return path.slice(0, -'.md'.length)
}

/**
 * Stops a plan that publishes a note when a note would take a reserved root
 * name of the site, or when two published paths after the plan would be one
 * URL for the resolver (URL-09 of the spec, section "The root names of the
 * site" of the canonical form). A plan without a new note never stops here,
 * so no forced removal waits for these rules.
 */
function refuseRootNames(scan: Scan, plan: PublicationPlan, pairs: readonly Move[]): void {
    if (plan.publish.length === 0 && pairs.length === 0) {
        return
    }
    for (const path of [...plan.publish, ...pairs.map((pairing) => pairing.to)]) {
        const name = withoutSuffix(path.slice(path.lastIndexOf('/') + 1))
        if (isReservedRootName(name)) {
            throw new SelectionError(
                `"${path}" cannot be published: its file name "${name}" is a reserved root name of the site`
            )
        }
        if (path.includes('/') && isReservedRootName(firstPart(path))) {
            throw new SelectionError(
                `"${path}" cannot be published: its first folder "${firstPart(path)}" is a reserved root name of the site`
            )
        }
    }
    const leaving = new Set([
        ...plan.forcedRemove,
        ...plan.remove,
        ...pairs.map((pairing) => pairing.from)
    ])
    const notes = [
        ...[...scan.manifest.values()]
            .filter((entry) => entry.state === 'published' && !leaving.has(entry.path))
            .map((entry) => entry.path),
        ...plan.publish,
        ...pairs.map((pairing) => pairing.to)
    ]
    // Each text of a URL: the path of each note, and each folder of it. A
    // note and a folder with the same text are one text: the note wins.
    const texts = new Set<string>()
    for (const path of notes) {
        const text = withoutSuffix(path)
        texts.add(text)
        for (let slash = text.indexOf('/'); slash >= 0; slash = text.indexOf('/', slash + 1)) {
            texts.add(text.slice(0, slash))
        }
    }
    const byFolded = new Map<string, string>()
    for (const text of sortByCodePoint([...texts])) {
        const folded = foldedForm(text)
        const other = byFolded.get(folded)
        if (other !== undefined) {
            throw new SelectionError(
                `"${other}" and "${text}" cannot both be published: they differ only in letter case or in Unicode form, and the site gives them one URL`
            )
        }
        byFolded.set(folded, text)
    }
}

/**
 * The lists of the plan of a selection, from the queue and the events of the
 * edits of the guards since the last publication: what `computePlan` gives
 * for a selection that it does not refuse. A face counts the plan of a
 * selection with it before the author clicks (TOOL-21): the label of the
 * publish button and the plan come from this one function. A note of
 * `tooLarge` of the queue, or of the candidates `tooLarge`, is held (issue 72).
 * The queue reads no links of the candidates, so a face that gives no
 * `tooLarge` can count a ticked candidate that the plan then holds for the
 * size limit: the label of the publish button can count one note more than
 * the plan publishes.
 */
export function planLists(
    queue: QueueLists,
    selection: NormalSelection,
    edits: readonly EditEvent[],
    guardedEntries: readonly string[],
    tooLarge: readonly TooLarge[] = []
): PublicationPlan {
    const tooLargeNotes = new Set([...queue.tooLarge, ...tooLarge].map((item) => item.path))
    return listsOf(queue, selection, edits, guardedEntries, tooLargeNotes)
}

/**
 * The items of `tooLarge` of a plan (issue 72): the items of the queue and of
 * the candidates whose note the plan would publish or update without the size
 * limit. Sorted by path, then by file.
 */
export function heldForSize(
    queue: QueueLists,
    selection: NormalSelection,
    tooLarge: readonly TooLarge[]
): TooLarge[] {
    const unheld = listsOf(queue, selection, [], [], new Set())
    const planned = new Set([...unheld.publish, ...unheld.update])
    return sortTooLarge([...queue.tooLarge, ...tooLarge].filter((item) => planned.has(item.path)))
}

/**
 * The plan of a selection with the size limit of an attachment (issue 72):
 * the plan, and its items of `tooLarge`. The files that the candidates of the
 * selection link to are only stated, never read.
 */
export async function planWithSizes(
    scan: Scan,
    selection: NormalSelection
): Promise<{ readonly plan: PublicationPlan; readonly tooLarge: TooLarge[] }> {
    const candidates = new Set(scan.queue.new)
    const named = [...selection.include, ...selection.pair.map((pairing) => pairing.to)]
    const found = await scan.tooLargeOf(
        sortByCodePoint([...new Set(named.filter((path) => candidates.has(path)))])
    )
    return {
        plan: computePlan(scan, selection, found),
        tooLarge: heldForSize(scan.queue, selection, found)
    }
}

function listsOf(
    queue: QueueLists,
    selection: NormalSelection,
    edits: readonly EditEvent[],
    guardedEntries: readonly string[],
    tooLargeNotes: ReadonlySet<string>
): PublicationPlan {
    const onlyMissing = new Set(queue.missing)
    const forced = queue.toRemove.filter((path) => !onlyMissing.has(path))
    const underGuard = new Set(forced)
    const candidates = new Set(queue.new)
    const pairTo = selection.pair.map((pairing) => pairing.to)
    const held = new Set(selection.hold)
    const removed = new Set(selection.remove)
    // The update of a moved note whose text changed waits for a tick (R67).
    const included = new Set(selection.include)
    const waiting = new Set(queue.movedEdited.filter((path) => !included.has(path)))
    const forcedRemove = [...forced, ...queue.unpublishedUnderGuard]
    const remove = selection.remove.filter((path) => !underGuard.has(path))
    // The published entries that stay, at their paths after the plan, and
    // whose attachments list a file under a guard now.
    const leaving = new Set([...forcedRemove, ...remove])
    const pairedTo = new Map(selection.pair.map((pairing) => [pairing.from, pairing.to]))
    const guardedAttachments = guardedEntries
        .filter((path) => !leaving.has(path))
        .map((path) => pairedTo.get(path) ?? path)
    return makePlan({
        edits,
        // An unpublished note under a guard leaves the manifest too (decision R64).
        forcedRemove,
        guardedAttachments,
        // Every move of the journals, which no selection holds, and the pairings (R66).
        move: [...queue.renamed, ...selection.pair],
        // A note that links to a file above the size limit is held (issue 72).
        publish: selection.include.filter(
            (path) => candidates.has(path) && !tooLargeNotes.has(path)
        ),
        update: [
            ...queue.changed.filter(
                (path) =>
                    !held.has(path) &&
                    !removed.has(path) &&
                    !waiting.has(path) &&
                    !tooLargeNotes.has(path)
            ),
            ...pairTo.filter((path) => !held.has(path) && !tooLargeNotes.has(path))
        ],
        // A guard wins over an unpublish: the note leaves the manifest.
        remove
    })
}
