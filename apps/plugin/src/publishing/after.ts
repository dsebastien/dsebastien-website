import { STATE_PROPERTY } from './clean.ts'
import { configurationText, parseConfiguration } from './configuration.ts'
import { hasListToRefresh, queryNamesProperty } from './frozen.ts'
import { guardOf } from './guards.ts'
import { obsidianTwins } from './names.ts'
import { sortByCodePoint } from './order.ts'
import type { Device, Vault } from './ports.ts'
import { scanDenied, scanVault } from './queue.ts'

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

/** True when the text has a list to refresh (rule 4) whose query names a property of the publication. */
function readsPublication(text: string): boolean {
    return queryNamesProperty(text, PUBLICATION_PROPERTIES) && hasListToRefresh(text)
}

/**
 * What a scan of the vault read, for the refresh after a run: the text of
 * the rare notes whose list reads a property of the publication. So the
 * refresh reads the texts of the vault no second time.
 */
export class SeenNotes {
    readonly candidates = new Map<string, string>()

    note(path: string, text: string): void {
        if (readsPublication(text)) {
            this.candidates.set(path, text)
        }
    }
}

/** A vault that gives each note that it reads to `seen`. */
export function seeingVault(vault: Vault, seen: SeenNotes): Vault {
    return {
        list: (folder) => vault.list(folder),
        read: async (path) => {
            const text = await vault.read(path)
            if (text !== undefined && path.endsWith('.md')) {
                seen.note(path, text)
            }
            return text
        },
        readBytes: (path) => vault.readBytes(path),
        size: (path) => vault.size(path),
        hasFolder: (path) => vault.hasFolder(path),
        write: (path, text, before) => vault.write(path, text, before),
        forRun: () => seeingVault(vault.forRun(), seen)
    }
}

/**
 * The notes to refresh after a run: the notes outside the guards with a list
 * to refresh (rule 4 of "The frozen lists of a note") whose query names a
 * property of `PUBLICATION_PROPERTIES`, sorted by path. With `seen`, the
 * texts that the check after the run read; without it, one read of each
 * note outside the folders of the deny list. The notes are always listed
 * again, which reads no file, for the twins. A note with a twin is not
 * asked (R72), also a twin of a file of the deny list, and the serializer
 * face does not ask a path that Obsidian changes (issue 110). Each note is
 * read again just before the call, and its guards are checked on that text.
 */
export async function notesToRefreshAfter(
    device: Device,
    seen?: SeenNotes
): Promise<{
    readonly paths: string[]
    readonly problems: { readonly path: string; readonly message: string }[]
}> {
    const vault = device.vault.forRun()
    const configuration = parseConfiguration(await configurationText(device))
    const problems: { path: string; message: string }[] = []
    // The listing reads no file: the twins are computed over every note of
    // now, whatever the check read (R72).
    const notes = (await scanVault(vault, configuration)).notes
    let candidates: Iterable<string>
    if (seen === undefined) {
        const found: string[] = []
        for (const path of notes) {
            try {
                const text = await vault.read(path)
                if (text !== undefined && readsPublication(text)) {
                    found.push(path)
                }
            } catch (error) {
                problems.push({
                    path,
                    message: `the note cannot be read, so its lists are not refreshed: ${messageOf(error)}`
                })
            }
        }
        candidates = found
    } else {
        candidates = seen.candidates.keys()
    }
    const { files: denied } = await scanDenied(vault, configuration)
    const twins = obsidianTwins([...notes, ...denied])
    const paths: string[] = []
    for (const path of candidates) {
        if (twins.has(path)) {
            continue
        }
        // The text of now: a guard added since the scan is seen.
        let text: string | undefined
        try {
            text = await vault.read(path)
        } catch (error) {
            problems.push({
                path,
                message: `the note cannot be read, so its lists are not refreshed: ${messageOf(error)}`
            })
            continue
        }
        if (
            text !== undefined &&
            readsPublication(text) &&
            guardOf(path, text, configuration) === undefined
        ) {
            paths.push(path)
        }
    }
    return { paths: sortByCodePoint(paths), problems }
}

/**
 * Asks the serializer of the device to refresh the notes of
 * `notesToRefreshAfter`, after the correction of the state property. It
 * never throws. Without a serializer, it asks nothing and reports nothing:
 * a refresh after a run is not owed. A note that the refresh writes and that
 * is published is a changed note for the next plan.
 */
export async function refreshAfterRun(device: Device, seen?: SeenNotes): Promise<ListsAfterRun> {
    const { lists } = device
    if (lists === undefined) {
        return { listsRefreshed: [], refreshProblems: [] }
    }
    let found: Awaited<ReturnType<typeof notesToRefreshAfter>>
    try {
        found = await notesToRefreshAfter(device, seen)
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
    const { paths, problems } = found
    if (paths.length === 0) {
        return { listsRefreshed: [], refreshProblems: problems }
    }
    try {
        const result = await lists.refresh(paths, 'after-run')
        return {
            listsRefreshed: sortByCodePoint([...result.written.keys()]),
            refreshProblems: [...problems, ...result.problems]
        }
    } catch (error) {
        return {
            listsRefreshed: [],
            refreshProblems: [
                ...problems,
                ...paths.map((path) => ({
                    path,
                    message: `the refresh of the Dataview Serializer failed: ${messageOf(error)}`
                }))
            ]
        }
    }
}
