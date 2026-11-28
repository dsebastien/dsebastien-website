import { isChangedByObsidian, obsidianPath } from '../publishing/names.ts'

// The one rule for the path by which the plugin asks Obsidian for a note of
// the scan, and back (issue 114). Obsidian knows a file only by its Obsidian
// path (`obsidianPath`): a no-break space, a backslash or a name that is not
// in the composed Unicode form gives another path than the vault path of the
// scan. Two files with one Obsidian path are twins (R72): Obsidian lists one
// file for both, so the plugin never asks it for either. It imports no
// Obsidian.

/** What the plugin knows of the Obsidian paths of the notes, at the last check. */
export interface ObsidianNames {
    /** The Obsidian twins of the scan (R72): each with the first other file of its Obsidian path. */
    readonly twins: ReadonlyMap<string, string>
    /** The vault path of each note whose path Obsidian changes and that has no twin, by its Obsidian path. */
    readonly changed: ReadonlyMap<string, string>
    /** The Obsidian paths of the twins: Obsidian shows one of two files there. */
    readonly twinPaths: ReadonlySet<string>
}

/** The note that Obsidian opens for a vault path, or why it opens none. */
export type NoteTarget =
    | { readonly kind: 'open'; readonly path: string }
    | { readonly kind: 'twin'; readonly message: string }

/**
 * The Obsidian names of the notes of a check: the twins of the scan, and the
 * notes whose path Obsidian changes, by their Obsidian path.
 *
 * @param notes the vault paths of the notes of the scan (more paths do no harm)
 * @param twins the twins of the scan (`obsidianTwins`)
 */
export function obsidianNamesOf(
    notes: Iterable<string>,
    twins: ReadonlyMap<string, string>
): ObsidianNames {
    const changed = new Map<string, string>()
    for (const path of notes) {
        if (isChangedByObsidian(path) && !twins.has(path)) {
            changed.set(obsidianPath(path), path)
        }
    }
    const twinPaths = new Set([...twins.keys()].map((path) => obsidianPath(path)))
    return { twins, changed, twinPaths }
}

/**
 * The path by which to ask Obsidian for the note at this vault path: its
 * Obsidian path. A twin gets none, with the message for the author: Obsidian
 * could give the other file. Before the first check, the path is as it is,
 * as on the way back.
 */
export function noteTarget(path: string, names: ObsidianNames | undefined): NoteTarget {
    if (names === undefined) {
        return { kind: 'open', path }
    }
    const twin = names.twins.get(path)
    if (twin !== undefined) {
        return {
            kind: 'twin',
            message: `"${path}" cannot be opened: the file "${twin}" has the same path in Obsidian ("${obsidianPath(path)}"), so Obsidian can take one for the other. Give one of the two files another name`
        }
    }
    return { kind: 'open', path: obsidianPath(path) }
}

/**
 * The vault path of the note that Obsidian shows at this Obsidian path, or
 * `undefined` for the Obsidian path of twins: Obsidian can show either file.
 */
export function vaultPathOf(path: string, names: ObsidianNames | undefined): string | undefined {
    if (names === undefined) {
        return path
    }
    if (names.twinPaths.has(path)) {
        return undefined
    }
    return names.changed.get(path) ?? path
}

/**
 * The path by which a write into a note asks Obsidian for it, or `undefined`
 * when the write goes through Node: a path that Obsidian changes and a twin
 * (issue 114 changes no write path). Before the first check, no twin is known.
 */
export function writePathOf(path: string, names: ObsidianNames | undefined): string | undefined {
    return isChangedByObsidian(path) || names?.twins.has(path) === true ? undefined : path
}

/**
 * The names without this path, after Obsidian renamed or deleted the file at
 * it: the path is no longer known as the Obsidian path of a note of the
 * check, or of twins, in both directions, until the next check. The same
 * names when they do not hold it.
 *
 * @param path the old path of the file, as Obsidian names it
 */
export function forgetPath(
    names: ObsidianNames | undefined,
    path: string
): ObsidianNames | undefined {
    if (names === undefined) {
        return undefined
    }
    const holds = (vault: string): boolean => vault === path || obsidianPath(vault) === path
    const changed = [...names.changed].filter(
        ([obsidian, vault]) => obsidian !== path && vault !== path
    )
    const twins = [...names.twins].filter(([vault, other]) => !holds(vault) && !holds(other))
    if (changed.length === names.changed.size && twins.length === names.twins.size) {
        return names
    }
    const kept = new Map(twins)
    return {
        twins: kept,
        changed: new Map(changed),
        twinPaths: new Set([...kept.keys()].map((vault) => obsidianPath(vault)))
    }
}
