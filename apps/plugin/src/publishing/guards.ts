import type { Configuration } from './configuration.ts'
import { namesInProperties } from './frontmatter.ts'

// The two guards (ADR 0011): a note under a guard is never published,
// whatever is selected. The Rust twin is `cli/src/guards.rs`.

/** The property that says that the tool must never publish a note. */
export const IGNORE_PROPERTY = 'publish_ignore'

export type Guard = 'deny-list' | 'ignore-property'

/** The guard that excludes the path alone: a folder of the deny list covers every file below it. */
export function guardOfPath(path: string, configuration: Configuration): Guard | undefined {
    return configuration.denyList.some((folder) => path.startsWith(`${folder}/`))
        ? 'deny-list'
        : undefined
}

/** The guard that excludes the note, or `undefined` when no guard does. */
export function guardOf(
    path: string,
    text: string,
    configuration: Configuration
): Guard | undefined {
    const guard = guardOfPath(path, configuration)
    if (guard !== undefined) {
        return guard
    }
    // The reading fails closed: every form of the key excludes the note,
    // unless its value is exactly `false`.
    if (namesInProperties(text, IGNORE_PROPERTY)) {
        return 'ignore-property'
    }
    return undefined
}
