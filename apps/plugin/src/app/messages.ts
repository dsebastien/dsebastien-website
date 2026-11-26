// The messages of the publication center as the view and the notices show
// them (issue 106): the names in a message isolated from the text around
// them, and the buttons that lead out of an error. It imports no Obsidian.

/** First strong isolate and pop directional isolate (Unicode bidirectional algorithm). */
const FSI = '⁨'
const PDI = '⁩'

/**
 * The text with each name between double quotes isolated from the text
 * around it (U+2068 and U+2069), as the rows of the view isolate their
 * names: a right-to-left mark in a file name never reorders the rest of the
 * message. A quote opens a name at the start of the text or after a space,
 * a bracket or a colon, and the name ends at the next quote that the end of
 * the text, a space or a punctuation mark follows; a name that is isolated
 * already stays as it is.
 */
export function isolateNames(text: string): string {
    return text.replace(
        /(^|[\s([{:])"([^"\n]*?)"(?=$|[\s.,;:!?)\]}])/gu,
        (_all, before: string, name: string) =>
            name.startsWith(FSI) && name.endsWith(PDI)
                ? `${before}"${name}"`
                : `${before}"${FSI}${name}${PDI}"`
    )
}

/**
 * What the confirmation of the removal of the lock says of the run that
 * holds it (issue 106): whether its process still runs on this computer.
 *
 * @param holder what the lock names (`lockHolderOf`), or `undefined` when there is no lock
 * @param runs true when a process with this number runs on this computer
 */
export function lockState(
    holder: { readonly command?: string; readonly process?: number } | undefined,
    runs: (id: number) => boolean
): string {
    if (holder === undefined) {
        return 'There is no lock now.'
    }
    const run = holder.command === undefined ? 'a run' : `a run of ${holder.command}`
    if (holder.process === undefined) {
        return `The lock was taken by ${run}, and it names no process: the tool cannot tell whether that run still runs.`
    }
    const id = String(holder.process)
    return runs(holder.process)
        ? `The lock was taken by ${run} in the process ${id}, and a process with that number still runs on this computer: that run can still hold it. Remove it only when you know that it stopped.`
        : `The lock was taken by ${run} in the process ${id}, which no longer runs on this computer: the run stopped.`
}

/** The buttons that lead out of an error of the publication center. */
export interface WaysOut {
    /** The settings of the device are wrong or missing. */
    readonly settings: boolean
    /** The copy is behind the content store, or has no configuration yet: a pull. */
    readonly pull: boolean
    /** A lock of the device stops the runs: its removal, after a confirmation. */
    readonly unlock: boolean
}

/** The buttons for an error, from its text. */
export function waysOut(error: string): WaysOut {
    return {
        settings:
            error.includes('settings of Vault Publish') ||
            error.includes('must be an absolute path') ||
            error.includes('is not the root of a git repository') ||
            error.includes('it is not a clone of the content store'),
        pull:
            error.includes('commit(s) behind the content store') ||
            error.includes('configuration.json in its last commit'),
        unlock: error.includes('a publication runs on this device, or one stopped halfway')
    }
}
