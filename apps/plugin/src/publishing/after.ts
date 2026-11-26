import { STATE_PROPERTY } from './clean.ts'
import { CONFIGURATION_FILE, parseConfiguration } from './configuration.ts'
import { hasListToRefresh, queryNamesProperty } from './frozen.ts'
import { guardOf } from './guards.ts'
import { obsidianTwins } from './names.ts'
import { sortByCodePoint } from './order.ts'
import type { Device } from './ports.ts'
import { scanVault } from './queue.ts'

// The refresh of the frozen lists after a publication, an unpublish and a
// takedown (decision R84, issue 134), in Obsidian only: the Rust program has
// no refresh (PUB-101). The run is done when it starts: what it reports
// fails no run.

/** The properties that a publication writes into the vault: it sets and removes the state property. */
export const PUBLICATION_PROPERTIES: readonly string[] = [STATE_PROPERTY]

/** What the refresh after a run did, for the author. Outside the parity rule. */
export interface ListsAfterRun {
    /** The notes that the refresh wrote, sorted by path. */
    readonly listsRefreshed: readonly string[]
    /** Why a note was not refreshed, in the form of the refresh before a plan. */
    readonly refreshProblems: readonly { readonly path: string; readonly message: string }[]
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * The notes to refresh after a run: the notes outside the guards with a list
 * to refresh (rule 4 of "The frozen lists of a note") whose query names a
 * property of `PUBLICATION_PROPERTIES`, sorted by path. It reads the vault as
 * a plan scans it: the folders of the deny list are not listed. A note with a
 * twin is not asked (R72), and the serializer face does not ask a path that
 * Obsidian changes (issue 110).
 */
export async function notesToRefreshAfter(device: Device): Promise<string[]> {
    const vault = device.vault.forRun()
    const configuration = parseConfiguration(await device.store.read(CONFIGURATION_FILE))
    const { notes } = await scanVault(vault, configuration)
    const twins = obsidianTwins(notes)
    const paths: string[] = []
    for (const path of notes) {
        if (twins.has(path)) {
            continue
        }
        const text = await vault.read(path).catch(() => undefined)
        if (
            text !== undefined &&
            queryNamesProperty(text, PUBLICATION_PROPERTIES) &&
            hasListToRefresh(text) &&
            guardOf(path, text, configuration) === undefined
        ) {
            paths.push(path)
        }
    }
    return sortByCodePoint(paths)
}

/**
 * Asks the serializer of the device to refresh the notes of
 * `notesToRefreshAfter`, after the correction of the state property. It
 * never throws. Without a serializer, it asks nothing and reports nothing:
 * a refresh after a run is not owed. A note that the refresh writes and that
 * is published is a changed note for the next plan.
 */
export async function refreshAfterRun(device: Device): Promise<ListsAfterRun> {
    const { lists } = device
    if (lists === undefined) {
        return { listsRefreshed: [], refreshProblems: [] }
    }
    let paths: string[]
    try {
        paths = await notesToRefreshAfter(device)
    } catch (error) {
        return {
            listsRefreshed: [],
            refreshProblems: [
                {
                    path: '',
                    message: `the notes with a list to refresh could not be found: ${messageOf(error)}`
                }
            ]
        }
    }
    if (paths.length === 0) {
        return { listsRefreshed: [], refreshProblems: [] }
    }
    try {
        const result = await lists.refresh(paths)
        return {
            listsRefreshed: sortByCodePoint([...result.written.keys()]),
            refreshProblems: result.problems
        }
    } catch (error) {
        return {
            listsRefreshed: [],
            refreshProblems: paths.map((path) => ({
                path,
                message: `the refresh of the Dataview Serializer failed: ${messageOf(error)}`
            }))
        }
    }
}
