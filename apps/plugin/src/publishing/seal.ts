import { createHmac, timingSafeEqual } from 'node:crypto'
import { CONFIGURATION_FILE, parseConfiguration } from './configuration.ts'
import { sha256Hex } from './hash.ts'
import { parseJson } from './json.ts'
import { MANIFEST_FOLDER, NOTES_FOLDER } from './manifest.ts'
import { compareCodePoints, sortByCodePoint } from './order.ts'

// The seal of the content store (decision R104, `documentation/Canonical
// Form.md`, "The seal of the content store"). Every commit that the tool
// writes carries a seal: an HMAC with the seal key of the vault over its
// parent and the state that the tool trusts. Before a run, the tool checks
// that the state of the last commit is the sealed state. The Rust twin is
// `cli/src/seal.rs`; the shared cases are in `fixtures/canonical/seal.json`.

/** The name of the seal key, in the environment or in the `.env` file at the root of the vault. */
export const SEAL_KEY_VARIABLE = 'VAULT_PUBLISH_SEAL_KEY'

/** The files and folders of the content store that the seal covers. */
export const SEALED_PATHS: readonly string[] = [
    CONFIGURATION_FILE,
    'edits.json',
    MANIFEST_FOLDER,
    NOTES_FOLDER,
    'renames.json',
    'withdrawn.json'
]

/** How many commits of the first-parent chain the check reads, from the last one. */
export const SEAL_HISTORY = 100

/** The most entries of each list of a difference that its text names. */
export const NAMED_IN_TEXT = 20

/** One file of a commit, as `git ls-tree -r` gives it. */
// A type alias, not an interface: the shared cases are data.
export type TreeFile = {
    readonly mode: string
    /** The object id of git. */
    readonly object: string
    readonly path: string
}

/** One commit of the first-parent chain. */
export interface Commit {
    readonly id: string
    /** The first parent, or `undefined` for a first commit. */
    readonly parent: string | undefined
    readonly message: string
}

/** The seal key, or why there is none. */
export type SealKey = { readonly key: Uint8Array } | { readonly problem: string }

const HEX_KEY = /^[0-9a-fA-F]{64}$/u
const SEAL_LINE = /^Seal: ([0-9a-f]{64})$/u

/**
 * The value of a variable in the text of a `.env` file: lines `NAME=value`,
 * with an optional `export `, white space around the name and the value, and
 * one pair of single or double quotes around the value. A line that starts
 * with `#` is a comment. The last line of the name wins.
 */
export function envValue(text: string, name: string): string | undefined {
    let found: string | undefined
    for (const raw of text.split('\n')) {
        let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        line = line.trim()
        if (line === '' || line.startsWith('#')) {
            continue
        }
        if (line.startsWith('export ')) {
            line = line.slice('export '.length).trimStart()
        }
        const equals = line.indexOf('=')
        if (equals < 0 || line.slice(0, equals).trim() !== name) {
            continue
        }
        let value = line.slice(equals + 1).trim()
        const first = value[0]
        if (
            value.length >= 2 &&
            (first === '"' || first === "'") &&
            value[value.length - 1] === first
        ) {
            value = value.slice(1, -1)
        }
        found = value
    }
    return found
}

/** The message of a missing seal key: how to make one and where to put it. */
export const MISSING_KEY = `the seal key of the content store is missing: every commit of the tool carries a seal, and nothing is planned, published or edited without it (R104). Put the line ${SEAL_KEY_VARIABLE}=<64 hexadecimal digits> in the .env file at the root of the vault, or set ${SEAL_KEY_VARIABLE} in the environment. Make the key one time with openssl rand -hex 32, and give the same key to every device that publishes. Never put it into the content store or a repository`

/**
 * The seal key: the variable of the environment when it is set and not
 * empty, else the variable of the `.env` file at the root of the vault.
 */
export function sealKeyOf(environment: string | undefined, envFile: string | undefined): SealKey {
    const fromEnvironment = environment?.trim() ?? ''
    const [value, source] =
        fromEnvironment !== ''
            ? [fromEnvironment, 'the environment']
            : [
                  (envFile === undefined ? undefined : envValue(envFile, SEAL_KEY_VARIABLE)) ?? '',
                  'the .env file of the vault'
              ]
    if (value === '') {
        return { problem: MISSING_KEY }
    }
    if (!HEX_KEY.test(value)) {
        return {
            problem: `${SEAL_KEY_VARIABLE} of ${source} is not 64 hexadecimal digits, so no seal can be checked or written (R104). Make a key with openssl rand -hex 32, and give the same key to every device that publishes`
        }
    }
    return { key: Uint8Array.from(Buffer.from(value, 'hex')) }
}

/** The HMAC-SHA256 of a text as UTF-8, in small hexadecimal digits. */
export function hmacSha256(key: Uint8Array, text: string): string {
    return createHmac('sha256', key).update(text, 'utf8').digest('hex')
}

/** The digest of the sealed state of a commit: one line per file, in the order of the code points of the paths. */
export function stateDigest(files: readonly TreeFile[]): string {
    const sorted = [...files].sort((one, two) => compareCodePoints(one.path, two.path))
    return sha256Hex(sorted.map((file) => `${file.mode} ${file.object} ${file.path}\n`).join(''))
}

/** The seal of a commit with this parent and these files. */
export function sealOf(
    key: Uint8Array,
    parent: string | undefined,
    files: readonly TreeFile[]
): string {
    return hmacSha256(
        key,
        `dsebastien-vault-publish seal 1\nparent ${parent ?? 'none'}\nstate ${stateDigest(files)}\n`
    )
}

/** The seal that the last line of a commit message holds, or `undefined`. */
export function sealLineOf(message: string): string | undefined {
    const lines = message.split('\n').filter((line) => line.trim() !== '')
    return SEAL_LINE.exec(lines[lines.length - 1] ?? '')?.[1]
}

/** The message with its seal as its last line. */
export function withSeal(message: string, seal: string): string {
    return `${message.replace(/\n+$/u, '')}\nSeal: ${seal}\n`
}

/** True when the two seals are the same, in a time that does not depend on where they differ. */
export function sameSeal(one: string, two: string): boolean {
    const left = Buffer.from(one, 'utf8')
    const right = Buffer.from(two, 'utf8')
    return left.length === right.length && timingSafeEqual(left, right)
}

/** The files of `git ls-tree -r -z --full-tree`: `<mode> <type> <object>\t<path>`, each ended by a NUL. Only blobs and links count. */
export function parseTreeListing(text: string): TreeFile[] {
    const files: TreeFile[] = []
    for (const entry of text.split('\0')) {
        if (entry === '') {
            continue
        }
        const tab = entry.indexOf('\t')
        const [mode, type, object] = entry.slice(0, tab).split(' ')
        if (tab < 0 || mode === undefined || object === undefined || type === undefined) {
            throw new Error(`git gave a line of a tree that cannot be read: ${entry}`)
        }
        if (type === 'blob' || type === 'commit') {
            files.push({ mode, object, path: entry.slice(tab + 1) })
        }
    }
    return files.sort((one, two) => compareCodePoints(one.path, two.path))
}

/** One manifest entry that differs from the sealed state. */
// A type alias, not an interface: the shared cases are data.
export type EntryChange = {
    readonly change: 'added' | 'changed' | 'removed'
    readonly file: string
    /** The vault path of the entry: the new one, or the one of the sealed state for a removal. */
    readonly path: string
    /** The state of the entry before and after; `none` for an entry that is not there, `?` for one that cannot be read. */
    readonly before: string
    readonly after: string
}

/** How the state of the last commit differs from the last sealed state. */
// A type alias, not an interface: the shared cases are data.
export type StoreDifference = {
    /** The last commit of the copy: a confirmation names it. */
    readonly head: string
    /** The last commit with a valid seal, or `none`: the store has no sealed state yet. */
    readonly sealed: string
    /** The manifest entries that differ, in the order of their files. */
    readonly entries: readonly EntryChange[]
    /** The folders that left the deny list: the guards are looser. */
    readonly denyListRemoved: readonly string[]
    readonly denyListAdded: readonly string[]
    /** The other files that differ (`configuration.json`, the logs, the cleaned notes), with their change. */
    readonly files: readonly { readonly path: string; readonly change: string }[]
}

/** The result of the check of the seal. */
export type SealCheck =
    | { readonly status: 'empty' }
    | { readonly status: 'sealed' }
    | { readonly status: 'differs'; readonly difference: StoreDifference }

/** What the check reads of the copy: its first-parent chain, the files of a commit, a file of a commit. */
export interface SealedHistory {
    commits(limit: number): Promise<readonly Commit[]>
    files(commit: string, paths: readonly string[]): Promise<readonly TreeFile[]>
    readAt(commit: string, path: string): Promise<string | undefined>
}

/**
 * Checks the seal of the copy: the newest commit of the first-parent chain
 * (at most `SEAL_HISTORY` commits) whose seal is valid for its parent and its
 * state must hold the state of the last commit. A commit after it that
 * changes no sealed path (the redirect list) is no difference.
 */
export async function checkSeal(store: SealedHistory, key: Uint8Array): Promise<SealCheck> {
    const commits = await store.commits(SEAL_HISTORY)
    const head = commits[0]
    if (head === undefined) {
        return { status: 'empty' }
    }
    const headFiles = await store.files(head.id, SEALED_PATHS)
    const headDigest = stateDigest(headFiles)
    for (const commit of commits) {
        const seal = sealLineOf(commit.message)
        if (seal === undefined) {
            continue
        }
        const files = commit === head ? headFiles : await store.files(commit.id, SEALED_PATHS)
        if (sameSeal(seal, sealOf(key, commit.parent, files))) {
            if (stateDigest(files) === headDigest) {
                return { status: 'sealed' }
            }
            return {
                status: 'differs',
                difference: await differenceOf(head.id, commit.id, files, headFiles, (at, path) =>
                    store.readAt(at, path)
                )
            }
        }
    }
    return {
        status: 'differs',
        difference: await differenceOf(head.id, undefined, [], headFiles, (at, path) =>
            store.readAt(at, path)
        )
    }
}

/** The state and the vault path of a manifest entry, read leniently: a difference names what it can. */
function entryFacts(text: string | undefined): { state: string; path: string } {
    if (text === undefined) {
        return { state: 'none', path: '' }
    }
    try {
        const value = parseJson(text)
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const record = value as Record<string, unknown>
            const state = record['state']
            const path = record['path']
            return {
                state: typeof state === 'string' ? state : '?',
                path: typeof path === 'string' ? path : ''
            }
        }
    } catch {
        // Below: an entry that cannot be read.
    }
    return { state: '?', path: '' }
}

/** The deny list of a configuration text, or `undefined` when it cannot be read. */
function denyListOf(text: string | undefined): readonly string[] | undefined {
    if (text === undefined) {
        return []
    }
    try {
        return parseConfiguration(text).denyList
    } catch {
        return undefined
    }
}

/**
 * The difference between the sealed state (`sealed`, `undefined` for none,
 * with its files) and the state of the last commit. `read` gives a file of a
 * commit.
 */
export async function differenceOf(
    head: string,
    sealed: string | undefined,
    sealedFiles: readonly TreeFile[],
    headFiles: readonly TreeFile[],
    read: (commit: string, path: string) => Promise<string | undefined>
): Promise<StoreDifference> {
    const before = new Map(sealedFiles.map((file) => [file.path, file]))
    const after = new Map(headFiles.map((file) => [file.path, file]))
    const changes: { path: string; change: 'added' | 'changed' | 'removed' }[] = []
    for (const path of sortByCodePoint([...new Set([...before.keys(), ...after.keys()])])) {
        const one = before.get(path)
        const two = after.get(path)
        if (one === undefined) {
            changes.push({ path, change: 'added' })
        } else if (two === undefined) {
            changes.push({ path, change: 'removed' })
        } else if (one.mode !== two.mode || one.object !== two.object) {
            changes.push({ path, change: 'changed' })
        }
    }
    const readSealed = (path: string): Promise<string | undefined> =>
        sealed === undefined ? Promise.resolve(undefined) : read(sealed, path)
    const entries: EntryChange[] = []
    const files: { path: string; change: string }[] = []
    let denyListRemoved: readonly string[] = []
    let denyListAdded: readonly string[] = []
    // Only the entries that a text names are read: a first check of a large
    // store lists every entry as added.
    const named = new Map<string, number>()
    for (const { path, change } of changes) {
        if (path.startsWith(`${MANIFEST_FOLDER}/`)) {
            const count = named.get(change) ?? 0
            named.set(change, count + 1)
            if (count >= NAMED_IN_TEXT) {
                entries.push({ change, file: path, path: '', before: '', after: '' })
                continue
            }
            const one = entryFacts(change === 'added' ? undefined : await readSealed(path))
            const two = entryFacts(change === 'removed' ? undefined : await read(head, path))
            entries.push({
                change,
                file: path,
                path: two.path === '' ? one.path : two.path,
                before: one.state,
                after: two.state
            })
            continue
        }
        if (path === CONFIGURATION_FILE) {
            const old = denyListOf(await readSealed(path))
            const now = denyListOf(change === 'removed' ? undefined : await read(head, path))
            if (old !== undefined && now !== undefined) {
                denyListRemoved = sortByCodePoint(old.filter((folder) => !now.includes(folder)))
                denyListAdded = sortByCodePoint(now.filter((folder) => !old.includes(folder)))
            }
        }
        files.push({ path, change })
    }
    return {
        head,
        sealed: sealed ?? 'none',
        entries,
        denyListRemoved,
        denyListAdded,
        files
    }
}

/** A list of a text, with at most `NAMED_IN_TEXT` items and the count of the others. */
function listText(items: readonly string[]): string {
    const shown = items.slice(0, NAMED_IN_TEXT).join(', ')
    const more = items.length - NAMED_IN_TEXT
    return more > 0 ? `${shown} and ${String(more)} more` : shown
}

/** The message of a difference: what changed since the last sealed state, and how to confirm it. */
export function differenceText(difference: StoreDifference): string {
    const parts: string[] = []
    for (const change of ['added', 'changed', 'removed'] as const) {
        const entries = difference.entries.filter((entry) => entry.change === change)
        if (entries.length > 0) {
            parts.push(
                `manifest entries ${change} (${String(entries.length)}): ${listText(
                    // The first entries are the named ones: `differenceOf` reads them.
                    entries.map(
                        (entry) =>
                            `"${entry.path === '' ? entry.file : entry.path}" (${entry.before} to ${entry.after})`
                    )
                )}`
            )
        }
    }
    if (difference.denyListRemoved.length > 0) {
        parts.push(
            `folders that left the deny list, so the guards are looser: ${listText(difference.denyListRemoved.map((folder) => `"${folder}"`))}`
        )
    }
    if (difference.denyListAdded.length > 0) {
        parts.push(
            `folders added to the deny list: ${listText(difference.denyListAdded.map((folder) => `"${folder}"`))}`
        )
    }
    const notes = difference.files.filter((file) => file.path.startsWith(`${NOTES_FOLDER}/`))
    const others = difference.files.filter((file) => !file.path.startsWith(`${NOTES_FOLDER}/`))
    if (others.length > 0) {
        parts.push(
            `files of the store: ${listText(others.map((file) => `${file.path} (${file.change})`))}`
        )
    }
    if (notes.length > 0) {
        parts.push(
            `cleaned notes (${String(notes.length)}): ${listText(notes.map((file) => `${file.path} (${file.change})`))}`
        )
    }
    const start =
        difference.sealed === 'none'
            ? `the content store has no sealed state yet (a store from before R104, or a new one), so the tool does not trust its state: it plans and publishes nothing until you confirm it one time. Its state at ${difference.head}`
            : `the state of the content store at ${difference.head} is not the state that a commit of the tool sealed (${difference.sealed}): a commit that no tool wrote changed it (a push of someone else, or an edit by hand). Nothing is planned or published until you confirm it. What differs from the sealed state`
    return `${start}: ${parts.length === 0 ? 'no file' : parts.join('; ')}. When you made or accept every change, confirm the state of commit ${difference.head} (the command confirm-state --head ${difference.head}, the action of the publication center, or the MCP tool confirm_store_state); else take the commits back in the content store`
}

/** The error of a run that the seal refuses: the face shows the difference and offers the confirmation. */
export class SealDiffers extends Error {
    constructor(readonly difference: StoreDifference) {
        super(differenceText(difference))
    }
}
