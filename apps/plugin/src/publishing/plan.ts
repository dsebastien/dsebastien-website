import { sortByCodePoint } from './order.ts'

// The publication plan as data: the exact list of what one publication will
// do. The Rust twin is `cli/src/plan.rs`. Change both in the same commit.

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

/**
 * Computes the publication plan.
 *
 * The skeleton finds nothing: every list is empty. The first slice reads the
 * vault, the manifest, the configuration and the selection.
 */
export function computePlan(): PublicationPlan {
    return makePlan({ publish: [], update: [], remove: [] })
}
