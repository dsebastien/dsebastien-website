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

/**
 * The one file of the content store that the seal does not cover: the
 * redirect list, which only the author writes, at the root, by its exact
 * name, as a regular file (mode 100644). Every other file of a commit is
 * sealed, also a link or an executable file at that path.
 */
export const UNSEALED_FILE = 'redirects.json'

/** The mode of git of a regular file. */
const REGULAR_FILE = '100644'

/** True when the seal covers this file of the content store. */
export function isSealedFile(file: TreeFile): boolean {
    return file.path !== UNSEALED_FILE || file.mode !== REGULAR_FILE
}

/** The files of a commit that the seal covers. */
export function sealedFiles(files: readonly TreeFile[]): TreeFile[] {
    return files.filter(isSealedFile)
}

/** How many commits of the first-parent chain the check reads, from the last one. */
export const SEAL_HISTORY = 100

/** The most entries of each list of a difference that its text names, but the published ones. */
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
    /** Every parent of the commit, in the order of git: none for a first commit. */
    readonly parents: readonly string[]
    readonly message: string
}

/** The seal key, or why there is none. */
export type SealKey = { readonly key: Uint8Array } | { readonly problem: string }

const HEX_KEY = /^[0-9a-fA-F]{64}$/u
const SEAL_LINE = /^Seal: ([0-9a-f]{64})$/u

/** What `trimmed` takes away at the ends: the white space of ASCII and a byte order mark. */
const TRIMMED = new Set([' ', '\t', '\n', '\r', '\f', '\v', '﻿'])

/**
 * The text without the white space of ASCII (space, tab, line feed, carriage
 * return, form feed, vertical tab) and the byte order mark at its ends, and
 * nothing else: the Rust twin takes away the same characters.
 */
export function trimmed(text: string, ends: 'both' | 'start' = 'both'): string {
    let start = 0
    let end = text.length
    while (start < end && TRIMMED.has(text.charAt(start))) {
        start += 1
    }
    while (ends === 'both' && end > start && TRIMMED.has(text.charAt(end - 1))) {
        end -= 1
    }
    return text.slice(start, end)
}

/**
 * The value of a variable in the text of a `.env` file: lines `NAME=value`,
 * with an optional `export `, white space around the name and the value, and
 * one pair of single or double quotes around the value. A line that starts
 * with `#` is a comment. The last line of the name wins.
 */
export function envValue(text: string, name: string): string | undefined {
    let found: string | undefined
    for (const raw of text.split('\n')) {
        let line = trimmed(raw)
        if (line === '' || line.startsWith('#')) {
            continue
        }
        if (line.startsWith('export ')) {
            line = trimmed(line.slice('export '.length), 'start')
        }
        const equals = line.indexOf('=')
        if (equals < 0 || trimmed(line.slice(0, equals)) !== name) {
            continue
        }
        let value = trimmed(line.slice(equals + 1))
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
 * empty (after `trimmed`), else the variable of the `.env` file at the root
 * of the vault.
 */
export function sealKeyOf(environment: string | undefined, envFile: string | undefined): SealKey {
    const fromEnvironment = trimmed(environment ?? '')
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

/**
 * The digest of the sealed state of a commit: one record
 * `<mode> <object> <path>` ended by a NUL per file (a path of git never holds
 * a NUL), in the order of the code points of the paths.
 */
export function stateDigest(files: readonly TreeFile[]): string {
    const sorted = [...files].sort((one, two) => compareCodePoints(one.path, two.path))
    return sha256Hex(sorted.map((file) => `${file.mode} ${file.object} ${file.path}\0`).join(''))
}

/** The seal of a commit with these parents (in the order of git) and these sealed files. */
export function sealOf(
    key: Uint8Array,
    parents: readonly string[],
    files: readonly TreeFile[]
): string {
    const lines = parents.length === 0 ? ['none'] : parents
    return hmacSha256(
        key,
        `dsebastien-vault-publish seal 1\n${lines.map((parent) => `parent ${parent}\n`).join('')}state ${stateDigest(files)}\n`
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

/**
 * What a difference compares with: the last commit with a valid seal that
 * the copy trusts (`seal`), the mark of the copy when the history has no
 * such commit (`mark`), the live content revision of the host when the copy
 * has no mark and no such commit (`live`), or nothing (`none`).
 */
export type DifferenceBase = 'seal' | 'mark' | 'live' | 'none'

/** How the state of the last commit differs from the last sealed state. */
// A type alias, not an interface: the shared cases are data.
export type StoreDifference = {
    /** The last commit of the copy: a confirmation names it. */
    readonly head: string
    /** What the difference compares with. */
    readonly base: DifferenceBase
    /** The commit of the base, or `none`. */
    readonly sealed: string
    /** The manifest entries that differ, in the order of their files. */
    readonly entries: readonly EntryChange[]
    /** The folders that left the deny list: the guards are looser. */
    readonly denyListRemoved: readonly string[]
    readonly denyListAdded: readonly string[]
    /** The folders that left the list `noindexFolders` (their notes can be indexed) and the ones that came in. */
    readonly noindexRemoved: readonly string[]
    readonly noindexAdded: readonly string[]
    /** The other files that differ (`configuration.json`, the logs, the cleaned notes), with their change. */
    readonly files: readonly { readonly path: string; readonly change: string }[]
}

/** The result of the check of the seal. */
export type SealCheck =
    | { readonly status: 'empty' }
    | { readonly status: 'sealed' }
    | { readonly status: 'differs'; readonly difference: StoreDifference }

/**
 * What the check reads of the copy: its first-parent chain, the files of a
 * commit, the texts of objects, and the mark of the copy: the last sealed
 * commit that the copy pushed or confirmed, in its git folder, never in a commit.
 */
export interface SealedHistory {
    commits(limit: number): Promise<readonly Commit[]>
    /** Every file of a commit (`git ls-tree -r`), sorted by path. It throws when the commit is not known. */
    files(commit: string): Promise<readonly TreeFile[]>
    /** The texts of these objects of git, by object id. An object that cannot be read is not in the result. */
    objects(ids: readonly string[]): Promise<ReadonlyMap<string, string>>
    /** The mark of the copy, or `undefined`. */
    mark(): Promise<string | undefined>
    setMark(commit: string): Promise<void>
    /** True when `ancestor` is `commit` or one of its ancestors; false also when one is not known. */
    descends(commit: string, ancestor: string): Promise<boolean>
}

/**
 * Checks the seal of the copy. It walks the first-parent chain from the last
 * commit (at most `SEAL_HISTORY` commits) and takes the newest commit whose
 * seal is valid for its parents and its state; a commit with more than one
 * parent stops the walk, so no merge lies between the last commit and the
 * sealed one, and the sealed one is no merge. That commit is trusted when
 * it is the mark of the copy or descends from it; a copy with no mark takes
 * the live content revision of the host (`floor`, the deploy only) as its
 * lower bound, and with neither it trusts the commit. The
 * check writes nothing: the mark moves only when the tool pushes a sealed
 * commit (a confirmation included). The check passes when the trusted commit has the sealed
 * state of the last commit: a later commit of the redirect list alone is no
 * difference.
 */
export async function checkSeal(
    store: SealedHistory,
    key: Uint8Array,
    floor?: string
): Promise<SealCheck> {
    const commits = await store.commits(SEAL_HISTORY)
    const head = commits[0]
    if (head === undefined) {
        return { status: 'empty' }
    }
    const headFiles = sealedFiles(await store.files(head.id))
    let found: { id: string; files: readonly TreeFile[] } | undefined
    for (const commit of commits) {
        if (commit.parents.length > 1) {
            break
        }
        const seal = sealLineOf(commit.message)
        if (seal === undefined) {
            continue
        }
        const files = commit === head ? headFiles : sealedFiles(await store.files(commit.id))
        if (sameSeal(seal, sealOf(key, commit.parents, files))) {
            found = { id: commit.id, files }
            break
        }
    }
    const own = await store.mark()
    const mark = own ?? floor
    const read = (ids: readonly string[]): Promise<ReadonlyMap<string, string>> =>
        store.objects(ids)
    if (
        found !== undefined &&
        (mark === undefined || mark === found.id || (await store.descends(found.id, mark)))
    ) {
        if (stateDigest(found.files) === stateDigest(headFiles)) {
            return { status: 'sealed' }
        }
        return {
            status: 'differs',
            difference: await differenceOf(head.id, 'seal', found.id, found.files, headFiles, read)
        }
    }
    if (mark !== undefined) {
        // The commit of the mark can be gone from the copy: then every file is added.
        const markFiles = await store.files(mark).then(sealedFiles, () => [])
        return {
            status: 'differs',
            difference: await differenceOf(
                head.id,
                own === undefined ? 'live' : 'mark',
                mark,
                markFiles,
                headFiles,
                read
            )
        }
    }
    return {
        status: 'differs',
        difference: await differenceOf(head.id, 'none', undefined, [], headFiles, read)
    }
}

/** The state and the vault path of a manifest entry, read leniently: a difference names what it can. */
function entryFacts(file: TreeFile | undefined, text: string | undefined): EntryFacts {
    if (file === undefined) {
        return { state: 'none', path: '' }
    }
    if (text !== undefined) {
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
    }
    return { state: '?', path: '' }
}

interface EntryFacts {
    readonly state: string
    readonly path: string
}

/** The two lists of a configuration, or `undefined` when it cannot be read. */
function configurationOf(
    file: TreeFile | undefined,
    text: string | undefined
): { denyList: readonly string[]; noindexFolders: readonly string[] } | undefined {
    if (file === undefined) {
        return { denyList: [], noindexFolders: [] }
    }
    if (text === undefined) {
        return undefined
    }
    try {
        return parseConfiguration(text)
    } catch {
        return undefined
    }
}

/** True for a file of the manifest folder in any letter case: a checkout on Windows reads `Manifest/` as `manifest/`. */
function isManifestFile(path: string): boolean {
    return path.slice(0, MANIFEST_FOLDER.length + 1).toLowerCase() === `${MANIFEST_FOLDER}/`
}

/** The folders of `one` that `two` does not have, sorted. */
function missingFrom(one: readonly string[], two: readonly string[]): string[] {
    return sortByCodePoint(one.filter((folder) => !two.includes(folder)))
}

/**
 * The difference between the files of the base (the commit `sealed`,
 * `undefined` for none) and the state of the last commit. `read` gives the
 * texts of objects of git.
 */
export async function differenceOf(
    head: string,
    base: DifferenceBase,
    sealed: string | undefined,
    sealedFiles: readonly TreeFile[],
    headFiles: readonly TreeFile[],
    read: (objects: readonly string[]) => Promise<ReadonlyMap<string, string>>
): Promise<StoreDifference> {
    const before = new Map(sealedFiles.map((file) => [file.path, file]))
    const after = new Map(headFiles.map((file) => [file.path, file]))
    const changes: {
        path: string
        change: 'added' | 'changed' | 'removed'
        one: TreeFile | undefined
        two: TreeFile | undefined
    }[] = []
    for (const path of sortByCodePoint([...new Set([...before.keys(), ...after.keys()])])) {
        const one = before.get(path)
        const two = after.get(path)
        if (one === undefined) {
            changes.push({ path, change: 'added', one, two })
        } else if (two === undefined) {
            changes.push({ path, change: 'removed', one, two })
        } else if (one.mode !== two.mode || one.object !== two.object) {
            changes.push({ path, change: 'changed', one, two })
        }
    }
    // Every entry and the configuration are read, in one read of objects:
    // the text names every entry that is published after the change.
    const wanted = sortByCodePoint([
        ...new Set(
            changes
                .filter(({ path }) => isManifestFile(path) || path === CONFIGURATION_FILE)
                .flatMap(({ one, two }) => [one?.object, two?.object])
                .filter((object): object is string => object !== undefined)
        )
    ])
    const texts = wanted.length === 0 ? new Map<string, string>() : await read(wanted)
    const textOf = (file: TreeFile | undefined): string | undefined =>
        file === undefined ? undefined : texts.get(file.object)
    const entries: EntryChange[] = []
    const files: { path: string; change: string }[] = []
    let denyListRemoved: readonly string[] = []
    let denyListAdded: readonly string[] = []
    let noindexRemoved: readonly string[] = []
    let noindexAdded: readonly string[] = []
    for (const { path, change, one, two } of changes) {
        if (isManifestFile(path)) {
            const old = entryFacts(one, textOf(one))
            const now = entryFacts(two, textOf(two))
            entries.push({
                change,
                file: path,
                path: now.path === '' ? old.path : now.path,
                before: old.state,
                after: now.state
            })
            continue
        }
        if (path === CONFIGURATION_FILE) {
            const old = configurationOf(one, textOf(one))
            const now = configurationOf(two, textOf(two))
            if (old === undefined || now === undefined) {
                files.push({ path, change: `${change}, cannot be read` })
                continue
            }
            denyListRemoved = missingFrom(old.denyList, now.denyList)
            denyListAdded = missingFrom(now.denyList, old.denyList)
            noindexRemoved = missingFrom(old.noindexFolders, now.noindexFolders)
            noindexAdded = missingFrom(now.noindexFolders, old.noindexFolders)
        }
        files.push({ path, change })
    }
    return {
        head,
        base,
        sealed: sealed ?? 'none',
        entries,
        denyListRemoved,
        denyListAdded,
        noindexRemoved,
        noindexAdded,
        files
    }
}

/** The quoted list of folders. */
function foldersText(folders: readonly string[]): string {
    return folders.map((folder) => `"${folder}"`).join(', ')
}

/** The beginning of the text of a difference, by its base. */
function startOf(difference: StoreDifference): string {
    switch (difference.base) {
        case 'none':
            return `the content store has no sealed state yet (a store from before R104, or a new one), and this copy trusted none before, so the tool does not trust its state: it plans and publishes nothing until you confirm it one time. Its state at ${difference.head}`
        case 'mark':
            return `the content store has no sealed state that the tool can trust: no commit of the last ${String(SEAL_HISTORY)} (and none before a merge) has a valid seal and descends from ${difference.sealed}, the last sealed commit that this copy trusted. More than ${String(SEAL_HISTORY)} commits that no tool wrote, a merge, or an older history that a forced push put back can cause it. Nothing is planned or published until you confirm it. What differs from that commit`
        case 'live':
            return `the content store has no sealed state that the deploy can trust: this copy has no mark yet, and no commit of the last ${String(SEAL_HISTORY)} (and none before a merge) has a valid seal and is the live content revision ${difference.sealed} of the host or descends from it. An older history that a forced push put back can cause it. Nothing is built until you confirm it. What differs from the live content revision`
        case 'seal':
            return `the state of the content store at ${difference.head} is not the state that a commit of the tool sealed (${difference.sealed}): a commit that no tool wrote changed it (a push of someone else, or an edit by hand). Nothing is planned or published until you confirm it. What differs from the sealed state`
    }
}

/** The message of a difference: what changed since the last sealed state, and how to confirm it. */
export function differenceText(difference: StoreDifference): string {
    const parts: string[] = []
    const named = (entry: EntryChange): string =>
        `"${entry.path === '' ? entry.file : entry.path}" (${entry.before} to ${entry.after})`
    for (const change of ['added', 'changed', 'removed'] as const) {
        const entries = difference.entries.filter((entry) => entry.change === change)
        if (entries.length === 0) {
            continue
        }
        // Every entry that is published after the change is named; of the
        // others, at most `NAMED_IN_TEXT`.
        const published = entries.filter((entry) => entry.after === 'published')
        const others = entries.filter((entry) => entry.after !== 'published')
        const shown = [...published, ...others.slice(0, NAMED_IN_TEXT)].map(named).join(', ')
        const more = others.length - NAMED_IN_TEXT
        parts.push(
            `manifest entries ${change} (${String(entries.length)}): ${shown}${more > 0 ? ` and ${String(more)} more` : ''}`
        )
    }
    if (difference.denyListRemoved.length > 0) {
        parts.push(
            `folders that left the deny list, so the guards are looser: ${foldersText(difference.denyListRemoved)}`
        )
    }
    if (difference.denyListAdded.length > 0) {
        parts.push(`folders added to the deny list: ${foldersText(difference.denyListAdded)}`)
    }
    if (difference.noindexRemoved.length > 0) {
        parts.push(
            `folders that left the noindex folders, so their notes can be indexed: ${foldersText(difference.noindexRemoved)}`
        )
    }
    if (difference.noindexAdded.length > 0) {
        parts.push(`folders added to the noindex folders: ${foldersText(difference.noindexAdded)}`)
    }
    const notes = difference.files.filter((file) => file.path.startsWith(`${NOTES_FOLDER}/`))
    const others = difference.files.filter((file) => !file.path.startsWith(`${NOTES_FOLDER}/`))
    if (others.length > 0) {
        // Every other file is named: a file of any name can change what the tools read.
        parts.push(
            `files of the store: ${others.map((file) => `${file.path} (${file.change})`).join(', ')}`
        )
    }
    if (notes.length > 0) {
        const shown = notes
            .slice(0, NAMED_IN_TEXT)
            .map((file) => `${file.path} (${file.change})`)
            .join(', ')
        const more = notes.length - NAMED_IN_TEXT
        parts.push(
            `cleaned notes (${String(notes.length)}): ${shown}${more > 0 ? ` and ${String(more)} more` : ''}`
        )
    }
    return `${startOf(difference)}: ${parts.length === 0 ? 'no file' : parts.join('; ')}. When you made or accept every change, confirm the state of commit ${difference.head} (the command confirm-state --head ${difference.head}, the action of the publication center, or the MCP tool confirm_store_state); else take the commits back in the content store`
}

/** The error of a run that the seal refuses: the face shows the difference and offers the confirmation. */
export class SealDiffers extends Error {
    constructor(readonly difference: StoreDifference) {
        super(differenceText(difference))
    }
}
