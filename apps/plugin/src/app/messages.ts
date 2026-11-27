// The messages of the publication center as the view and the notices show
// them (issue 106): the names in a message isolated from the text around
// them, and the buttons that lead out of an error. It imports no Obsidian.

/** First strong isolate and pop directional isolate (Unicode bidirectional algorithm). */
const FSI = '⁨'
const PDI = '⁩'

/** The isolates and the embeddings of the bidirectional algorithm: U+202A to U+202E and U+2066 to U+2069. */
const CONTROLS = /[‪-‮⁦-⁩]/gu

/**
 * A name isolated from the text around it (U+2068 and U+2069). An isolate
 * or an embedding inside the name is shown as its code (`<U+2069>`): it
 * could end the isolation early, and the rest of the name would then
 * reorder the text around it.
 */
export function isolateName(name: string): string {
    const shown = name.replace(
        CONTROLS,
        (control) => `<U+${(control.codePointAt(0) ?? 0).toString(16).toUpperCase()}>`
    )
    return `${FSI}${shown}${PDI}`
}

/**
 * The text with each name between double quotes isolated from the text
 * around it (`isolateName`), as the rows of the view isolate their names: a
 * right-to-left mark in a file name never reorders the rest of the message.
 * A quote opens a name at the start of the text or after a space, a bracket
 * or a colon, and the name ends at the next quote that the end of the text,
 * a space or a punctuation mark follows. A name that is isolated already,
 * with no other isolate or embedding inside, stays as it is.
 */
export function isolateNames(text: string): string {
    return text.replace(
        /(^|[\s([{:])"([^"\n]*?)"(?=$|[\s.,;:!?)\]}])/gu,
        (_all, before: string, name: string) => {
            const inner = name.slice(1, -1)
            const isolated =
                name.length >= 2 &&
                name.startsWith(FSI) &&
                name.endsWith(PDI) &&
                inner.replace(CONTROLS, '') === inner
            return `${before}"${isolated ? name : isolateName(name)}"`
        }
    )
}

/** The computer and the system of a run, as a lock names them. */
export interface Computer {
    readonly host?: string
    readonly system?: string
}

/**
 * What the confirmation of the removal of the lock says of the run that
 * holds it (issue 106): whether its process still runs here. A process of
 * WSL or of another computer cannot be seen from here.
 *
 * @param holder what the lock names (`lockHolderOf`), or `undefined` when there is no lock
 * @param runs true when a process with this number runs here
 * @param here the computer and the system of this run
 */
export function lockState(
    holder: (Computer & { readonly command?: string; readonly process?: number }) | undefined,
    runs: (id: number) => boolean,
    here: Computer
): string {
    if (holder === undefined) {
        return 'There is no lock now.'
    }
    const run = holder.command === undefined ? 'a run' : `a run of ${holder.command}`
    if (holder.process === undefined) {
        return `The lock was taken by ${run}, and it names no process: the tool cannot tell whether that run still runs.`
    }
    const id = String(holder.process)
    const named = holder.host !== undefined && holder.system !== undefined
    if (
        named &&
        (holder.host.toLowerCase() !== here.host?.toLowerCase() || holder.system !== here.system)
    ) {
        return `The lock was taken by ${run} in the process ${id} on ${holder.host ?? ''} (${holder.system ?? ''}), not on this computer: the tool cannot see whether that run still runs.`
    }
    return runs(holder.process)
        ? `The lock was taken by ${run} in the process ${id}, and a process with that number still runs here: that run can still hold it. Remove it only when you know that it stopped.`
        : `The lock was taken by ${run} in the process ${id}: no process with that number runs here; a run in WSL or on another computer cannot be seen.`
}

/** The buttons that lead out of an error of the publication center. */
export interface WaysOut {
    /** The settings of the device are wrong or missing. */
    readonly settings: boolean
    /** The copy is behind the content store, or has no configuration yet: a pull. */
    readonly pull: boolean
    /** A lock of the device stops the runs: its removal, after a confirmation. */
    readonly unlock: boolean
    /**
     * The state of the content store is not sealed (R104): the last commit
     * that the difference names, which a confirmation seals. No key for
     * another error.
     */
    readonly confirmState?: string
}

/** The buttons for an error, from its text. */
export function waysOut(error: string): WaysOut {
    const head = /confirm-state --head ([0-9a-f]{40}(?:[0-9a-f]{24})?)\b/u.exec(error)?.[1]
    return {
        settings:
            error.includes('settings of Vault Publish') ||
            error.includes('must be an absolute path') ||
            error.includes('is not the root of a git repository') ||
            error.includes('it is not a clone of the content store'),
        pull:
            error.includes('commit(s) behind the content store') ||
            error.includes('configuration.json in its last commit'),
        unlock: error.includes('a publication runs on this device, or one stopped halfway'),
        ...(head === undefined ? {} : { confirmState: head })
    }
}
