import { isVaultPath } from './configuration.ts'
import { guardOfPath, IGNORE_PROPERTY } from './guards.ts'
import { sortByCodePoint } from './order.ts'
import type { Scan } from './queue.ts'

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
}

/** A selection with its three lists, each path one time, sorted. It is a part of the record of a plan. */
export type NormalSelection = {
    readonly hold: readonly string[]
    readonly include: readonly string[]
    readonly remove: readonly string[]
}

/** A selection that cannot become a plan. The message says which path and why. */
export class SelectionError extends Error {
    override readonly name = 'SelectionError'
}

/**
 * Makes a plan from its three lists. Each list is put in the order of the
 * canonical form here, so that no caller can give a plan in another order.
 */
export function makePlan(lists: {
    publish: readonly string[]
    update: readonly string[]
    remove: readonly string[]
}): PublicationPlan {
    return {
        publish: sortByCodePoint(lists.publish),
        update: sortByCodePoint(lists.update),
        remove: sortByCodePoint(lists.remove)
    }
}

function unique(paths: readonly string[] | undefined): string[] {
    return sortByCodePoint([...new Set(paths ?? [])])
}

/** The selection with each path one time, in the order of the canonical form. */
export function normalSelection(selection: Selection): NormalSelection {
    return {
        hold: unique(selection.hold),
        include: unique(selection.include),
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
 * plan only when its path is included (PUB-19, PUB-54). A selection that
 * cannot become a plan stops with a `SelectionError`.
 */
export function computePlan(scan: Scan, selection: NormalSelection): PublicationPlan {
    const { queue } = scan
    const refuse = (path: string, reason: string): never => {
        throw new SelectionError(`"${path}" ${reason}`)
    }
    const all = [...selection.hold, ...selection.include, ...selection.remove]
    for (const path of all) {
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
    for (const path of selection.include) {
        if (waiting.has(path)) {
            refuse(path, 'is published and waits for its removal: it cannot be published again')
        }
        if (!candidates.has(path) && !changed.has(path) && !unchanged.has(path)) {
            refuse(path, reasonOutOfQueue(path, scan))
        }
    }
    for (const path of selection.hold) {
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
            refuse(path, 'is not published: there is nothing to remove')
        }
    }

    const held = new Set(selection.hold)
    const removed = new Set(selection.remove)
    return makePlan({
        publish: selection.include.filter((path) => candidates.has(path)),
        update: queue.changed.filter((path) => !held.has(path) && !removed.has(path)),
        remove: selection.remove
    })
}
