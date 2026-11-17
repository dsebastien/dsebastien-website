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
 * Computes the publication plan.
 *
 * The skeleton finds nothing: every list is empty. The first slice reads the
 * vault, the manifest, the configuration and the selection.
 */
export function computePlan(): PublicationPlan {
    return { publish: [], update: [], remove: [] }
}
