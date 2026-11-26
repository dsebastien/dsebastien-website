import { isAttachmentKey } from '@dsebastien-website/resolver'
import { toCanonicalJson } from './canonical.ts'
import { parseJson } from './json.ts'
import { sortByCodePoint } from './order.ts'

// The keys that the guards withdrew (issue 120, decision of the author R78, after R45):
// a published entry can still list an attachment whose file came under a
// guard (its note is held, or the plan of an agent keeps it). The tool deletes
// that file from the attachment folder of its device, and writes its key
// into `withdrawn.json` of the content store, in the commit of each
// publication, so that every deployment, from any machine, deletes it from
// the object storage of the host and never uploads it again. The file holds
// keys only: never a vault path or a name.

/** The file of the withdrawn keys in the content store. */
export const WITHDRAWN_FILE = 'withdrawn.json'

/**
 * Reads the withdrawn keys from the text of `withdrawn.json`: an object with
 * the one field `keys`, a list of keys, each one time, in the order of the
 * code points, at least one. A content store without the file has none. It
 * throws for any other text: a list that the tool cannot read could put a
 * file under a guard back on the host.
 */
export function parseWithdrawn(text: string | undefined): string[] {
    if (text === undefined) {
        return []
    }
    let value: unknown
    try {
        value = parseJson(text)
    } catch (error) {
        throw new Error(
            `${WITHDRAWN_FILE} of the content store is not JSON: ${error instanceof Error ? error.message : 'it failed'}. No run is possible until it is corrected`,
            { cause: error }
        )
    }
    const refuse = (why: string): never => {
        throw new Error(
            `${WITHDRAWN_FILE} of the content store cannot be read: ${why}. No run is possible until it is corrected`
        )
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return refuse('it is not an object')
    }
    const fields = Object.keys(value)
    if (fields.length !== 1 || fields[0] !== 'keys') {
        return refuse('its only field is not "keys"')
    }
    const keys: unknown = (value as { keys: unknown }).keys
    if (!Array.isArray(keys) || keys.length === 0) {
        return refuse('"keys" is not a list with at least one key')
    }
    const read: string[] = []
    for (const key of keys) {
        if (typeof key !== 'string' || !isAttachmentKey(key)) {
            return refuse('an item of "keys" is not a key of the attachment storage')
        }
        const last = read.at(-1)
        if (last !== undefined && last >= key) {
            return refuse('the keys are not each one time in their order')
        }
        read.push(key)
    }
    return read
}

/** The text of `withdrawn.json` with these keys, or `undefined` when there is none: then the file is removed. */
export function withdrawnText(keys: readonly string[]): string | undefined {
    const sorted = sortByCodePoint([...new Set(keys)])
    return sorted.length === 0 ? undefined : toCanonicalJson({ keys: sorted })
}

/**
 * The withdrawn keys after a publication, sorted (rule 8 of a publication):
 * the earlier withdrawn keys, and the keys that the guards withdraw in the
 * manifest before and after the run (a file that counts for no note), less
 * every key that a published entry after the run lists from a file under no
 * guard. So a key leaves the list only when a note uses its bytes openly
 * again, for example after a confirmed `allow`: a key that no entry lists any
 * more stays, because the release before can still list it.
 */
export function withdrawnKeys(sets: {
    readonly earlier: readonly string[]
    readonly guardedBefore: Iterable<string>
    readonly guardedAfter: Iterable<string>
    readonly usedAfter: Iterable<string>
}): string[] {
    const used = new Set(sets.usedAfter)
    return sortByCodePoint(
        [...new Set([...sets.earlier, ...sets.guardedBefore, ...sets.guardedAfter])].filter(
            (key) => !used.has(key)
        )
    )
}
