import type { Configuration } from './configuration.ts'
import { guardOf, IGNORE_PROPERTY } from './guards.ts'
import type { ManifestEntry } from './manifest.ts'
import { sortByCodePoint } from './order.ts'
import type { Vault } from './ports.ts'

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

/** What the author, or an agent that he started, selected. */
export interface Selection {
    /** The vault paths of the notes to publish. */
    readonly include: readonly string[]
}

/** The inputs of a plan. The same inputs give the same plan. */
export interface PlanInput {
    readonly vault: Vault
    readonly manifest: readonly ManifestEntry[]
    readonly configuration: Configuration
    readonly selection: Selection
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

/** True when the text is a path inside a vault: relative, with `/`, and with no part that leaves a folder. */
export function isVaultPath(path: string): boolean {
    const parts = path.split('/')
    return (
        path !== '' &&
        !path.includes('\\') &&
        parts.every((part) => part !== '' && part !== '.' && part !== '..')
    )
}

/** Checks one selected path and says why it cannot be published, or `undefined` when it can. */
async function reasonToRefuse(path: string, input: PlanInput): Promise<string | undefined> {
    if (!isVaultPath(path)) {
        return 'is not a vault path'
    }
    if (!path.endsWith('.md')) {
        return 'is not a note'
    }
    const text = await input.vault.read(path)
    if (text === undefined) {
        return 'does not exist in the vault'
    }
    const guard = guardOf(path, text, input.configuration)
    if (guard === 'deny-list') {
        return 'is in a folder of the deny list'
    }
    if (guard === 'ignore-property') {
        return `has the ${IGNORE_PROPERTY} property`
    }
    if (input.manifest.some((entry) => entry.path === path)) {
        return 'is already published. A new version of a published note comes with the publication queue'
    }
    return undefined
}

/**
 * Computes the publication plan.
 *
 * The first slice knows one case: the first publication of the notes that the
 * selection includes. A path that cannot be published stops the plan with a
 * `SelectionError`. The publication queue (changed notes, removals) comes with
 * a later slice.
 */
export async function computePlan(input: PlanInput): Promise<PublicationPlan> {
    const publish = [...new Set(input.selection.include)]
    for (const path of sortByCodePoint(publish)) {
        const reason = await reasonToRefuse(path, input)
        if (reason !== undefined) {
            throw new SelectionError(`"${path}" ${reason}`)
        }
    }
    return makePlan({ publish, update: [], remove: [] })
}
