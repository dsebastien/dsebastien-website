import { isVaultPath } from './configuration.ts'
import { bytesHash, contentHash } from './hash.ts'
import { parseJson } from './json.ts'
import { compareCodePoints, sortByCodePoint } from './order.ts'
import type { RenameJournals } from './ports.ts'

// The rename journals and the read marker of the content store (decision
// R66, issue 37). The rules are in `documentation/Canonical Form.md`, section
// "The rename journal". The Rust twin is `cli/src/renames.rs`. Change both in
// the same commit.

/** The file of the content store that counts the lines of each journal that the publications read. */
export const RENAMES_FILE = 'renames.json'

/** The folder of the journals in the vault, below the configuration folder of Obsidian. */
export const JOURNAL_FOLDER = 'plugins/dsebastien-vault-publish/renames'

/** The form of the name of a journal: 16 small hexadecimal digits and `.jsonl`. */
const JOURNAL_NAME = /^[0-9a-f]{16}\.jsonl$/

/** A time in the canonical form: UTC, to the second. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** The form of a hash in the marker: `sha256:` and 64 small hexadecimal digits. */
const HASH = /^sha256:[0-9a-f]{64}$/

/** One rename that Obsidian reported: a note, or a folder with everything below it. */
export interface JournalLine {
    readonly from: string
    readonly kind: 'note' | 'folder'
    readonly time: string
    readonly to: string
}

/** How many lines of one journal the publications read, and the hash of their bytes. */
export type Marker = { readonly hash: string; readonly lines: number }

/** The read marker of the content store: a marker per journal, by its name. */
export type Markers = Readonly<Record<string, Marker>>

/** A warning of the journals or of the moves, with the name of the journal or the path of the note. */
export interface RenameWarning {
    readonly path: string
    readonly message: string
}

/** What the journals of the vault hold, against the read marker of the content store. */
export interface JournalState {
    /** The new valid lines of every journal, in the order of the moves. */
    readonly lines: readonly JournalLine[]
    /** Every valid line of every journal, in the same order: for the folder of a deny list entry. */
    readonly all: readonly JournalLine[]
    /** The read marker after a publication that reads these lines. */
    readonly markers: Markers
    /** True when the publication changes the read marker. */
    readonly read: boolean
    /** The hash of the journals, for the record of a plan. */
    readonly hash: string
    readonly warnings: readonly RenameWarning[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the text is a real date and time in the canonical form. */
function isCanonicalTime(time: string): boolean {
    if (!TIME.test(time)) {
        return false
    }
    const date = new Date(time)
    return !Number.isNaN(date.getTime()) && `${date.toISOString().slice(0, 19)}Z` === time
}

/**
 * Reads the read marker from the text of `renames.json`. A content store
 * without the file read no line. It throws when the text is not a marker: a
 * marker that the tool cannot read could apply old lines again.
 */
export function parseMarkers(text: string | undefined): Markers {
    if (text === undefined) {
        return {}
    }
    let value: unknown
    try {
        value = parseJson(text)
    } catch (error) {
        throw new Error(
            `${RENAMES_FILE} of the content store is not JSON: ${error instanceof Error ? error.message : 'it failed'}`,
            { cause: error }
        )
    }
    const refuse = (why: string): never => {
        throw new Error(`${RENAMES_FILE} of the content store cannot be read: ${why}`)
    }
    if (!isRecord(value)) {
        return refuse('it is not an object')
    }
    const markers: Record<string, Marker> = {}
    for (const [name, marker] of Object.entries(value)) {
        if (!JOURNAL_NAME.test(name)) {
            refuse(`"${name}" is not the name of a journal`)
        }
        if (
            !isRecord(marker) ||
            Object.keys(marker).length !== 2 ||
            typeof marker['hash'] !== 'string' ||
            !HASH.test(marker['hash']) ||
            typeof marker['lines'] !== 'number' ||
            !Number.isSafeInteger(marker['lines']) ||
            marker['lines'] < 0
        ) {
            return refuse(`the marker of "${name}" is not a hash and a count of lines`)
        }
        markers[name] = { hash: marker['hash'], lines: marker['lines'] }
    }
    return markers
}

/** The text of a line of a journal, with its line feed: the canonical form on one line. */
export function journalLine(line: JournalLine): string {
    // The keys in the order of the code points. JSON.stringify writes a text
    // as the canonical form does: the quote, the backslash and the control
    // characters escaped, every other character as it is.
    return `{"from":${JSON.stringify(line.from)},"kind":${JSON.stringify(line.kind)},"time":${JSON.stringify(line.time)},"to":${JSON.stringify(line.to)}}\n`
}

/** The line of a rename that Obsidian reported, or `undefined` when the journal does not record it. */
export function renameLine(
    kind: 'file' | 'folder',
    from: string,
    to: string,
    time: string
): JournalLine | undefined {
    if (from === to || !isVaultPath(from) || !isVaultPath(to)) {
        return undefined
    }
    if (kind === 'folder') {
        return { from, kind: 'folder', time, to }
    }
    // A file that is a note before and after: another file is no note of the
    // manifest, and a note that loses its end leaves the vault of the tool.
    return from.endsWith('.md') && to.endsWith('.md') ? { from, kind: 'note', time, to } : undefined
}

/** Reads one line of a journal: `undefined` when it is not a valid line. */
function readLine(bytes: Uint8Array): JournalLine | undefined {
    let text: string
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
        return undefined
    }
    let value: unknown
    try {
        value = parseJson(text)
    } catch {
        return undefined
    }
    if (!isRecord(value) || Object.keys(value).length !== 4) {
        return undefined
    }
    const { from, kind, time, to } = value
    if (
        typeof from !== 'string' ||
        typeof to !== 'string' ||
        typeof time !== 'string' ||
        (kind !== 'note' && kind !== 'folder') ||
        from === to ||
        !isVaultPath(from) ||
        !isVaultPath(to) ||
        !isCanonicalTime(time) ||
        (kind === 'note' && (!from.endsWith('.md') || !to.endsWith('.md')))
    ) {
        return undefined
    }
    return { from, kind, time, to }
}

/** The complete lines of a journal: the bytes before each line feed. The bytes after the last one are not a line yet. */
function linesOf(bytes: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = []
    let start = 0
    for (let at = bytes.indexOf(0x0a); at >= 0; at = bytes.indexOf(0x0a, start)) {
        lines.push(bytes.subarray(start, at))
        start = at + 1
    }
    return lines
}

/** The bytes of the first lines of a journal, with their line feeds. */
function prefixOf(bytes: Uint8Array, lines: readonly Uint8Array[], count: number): Uint8Array {
    let end = 0
    for (const line of lines.slice(0, count)) {
        end += line.length + 1
    }
    return bytes.subarray(0, end)
}

/**
 * Reads the journals against the read marker. A journal that was cut or
 * edited applies none of its lines, and its marker becomes all its lines. A
 * line that is not valid is counted, not applied, and gives a warning.
 */
export async function readJournals(
    journals: RenameJournals,
    markers: Markers
): Promise<JournalState> {
    const names = sortByCodePoint((await journals.list()).filter((name) => JOURNAL_NAME.test(name)))
    const warnings: RenameWarning[] = []
    const next: Record<string, Marker> = { ...markers }
    const fresh: { name: string; lines: JournalLine[] }[] = []
    const every: { name: string; lines: JournalLine[] }[] = []
    let read = false
    let hashes = ''
    for (const name of names) {
        const bytes = await journals.read(name)
        if (bytes === undefined) {
            continue
        }
        const lines = linesOf(bytes)
        const whole = bytesHash(prefixOf(bytes, lines, lines.length))
        hashes += `${name}\n${whole}\n`
        const marker = markers[name]
        let first = 0
        if (marker !== undefined) {
            if (
                lines.length < marker.lines ||
                bytesHash(prefixOf(bytes, lines, marker.lines)) !== marker.hash
            ) {
                warnings.push({
                    path: name,
                    message:
                        'the journal was cut or edited since the last publication: none of its lines is applied, and its notes can show as pairings'
                })
                first = lines.length
            } else {
                first = marker.lines
            }
        }
        const valid: JournalLine[] = []
        const added: JournalLine[] = []
        for (const [index, bytesOfLine] of lines.entries()) {
            const line = readLine(bytesOfLine)
            if (line !== undefined) {
                valid.push(line)
                if (index >= first) {
                    added.push(line)
                }
            } else if (index >= first) {
                warnings.push({
                    path: name,
                    message: `line ${String(index + 1)} of the journal is not a rename, and it is not applied`
                })
            }
        }
        every.push({ name, lines: valid })
        fresh.push({ name, lines: added })
        const after: Marker = { hash: whole, lines: lines.length }
        if (marker?.hash !== after.hash || marker.lines !== after.lines) {
            if (marker !== undefined || after.lines > 0) {
                next[name] = after
                read = true
            }
        }
    }
    return {
        lines: merged(fresh),
        all: merged(every),
        markers: next,
        read,
        hash: contentHash(hashes),
        warnings
    }
}

/**
 * The lines of the journals in one order: the next line of each journal,
 * then the one with the earliest time; for the same time, the journal whose
 * name comes first. The lines of one journal keep their order.
 */
function merged(
    journals: readonly { name: string; lines: readonly JournalLine[] }[]
): JournalLine[] {
    const at = journals.map(() => 0)
    const result: JournalLine[] = []
    for (;;) {
        let best = -1
        for (const [index, journal] of journals.entries()) {
            const line = journal.lines[at[index] ?? 0]
            const current = journals[best]?.lines[at[best] ?? 0]
            if (
                line !== undefined &&
                (current === undefined || compareCodePoints(line.time, current.time) < 0)
            ) {
                best = index
            }
        }
        const journal = journals[best]
        const line = journal?.lines[at[best] ?? 0]
        if (journal === undefined || line === undefined) {
            return result
        }
        result.push(line)
        at[best] = (at[best] ?? 0) + 1
    }
}

/**
 * The path of each manifest path after the lines, by the fold of the moves
 * (rules 1 and 2 of the moves). A note moves when it is at `from`, and a
 * folder moves each path below it. A move to a path that another entry holds
 * does not happen, with a warning.
 */
export function foldMoves(
    paths: Iterable<string>,
    lines: readonly JournalLine[]
): {
    readonly positions: Map<string, string>
    /** The time of the last line that moved each entry that moved. */
    readonly times: Map<string, string>
    readonly warnings: RenameWarning[]
} {
    // The entry at each current path, and the current path of each entry.
    const at = new Map<string, string>()
    const positions = new Map<string, string>()
    for (const path of paths) {
        at.set(path, path)
        positions.set(path, path)
    }
    const times = new Map<string, string>()
    const warnings: RenameWarning[] = []
    const moveTo = (entry: string, from: string, to: string, time: string): void => {
        at.delete(from)
        at.set(to, entry)
        positions.set(entry, to)
        times.set(entry, time)
    }
    for (const line of lines) {
        if (line.kind === 'note') {
            const entry = at.get(line.from)
            if (entry === undefined) {
                continue
            }
            if (at.has(line.to)) {
                warnings.push({
                    path: entry,
                    message: `the journal moves the note from "${line.from}" to "${line.to}", where another note of the manifest is: it does not move`
                })
                continue
            }
            moveTo(entry, line.from, line.to, line.time)
            continue
        }
        const prefix = `${line.from}/`
        const movers = sortByCodePoint([...at.keys()].filter((path) => path.startsWith(prefix)))
        const moving = new Set(movers)
        const targets = movers.map((path) => `${line.to}/${path.slice(prefix.length)}`)
        const moved: [string, string, string][] = []
        for (const [index, path] of movers.entries()) {
            const target = targets[index] ?? ''
            const entry = at.get(path) ?? ''
            const holder = at.get(target)
            if (holder !== undefined && !moving.has(target)) {
                warnings.push({
                    path: entry,
                    message: `the journal moves the note from "${path}" to "${target}", where another note of the manifest is: it does not move`
                })
                continue
            }
            moved.push([entry, path, target])
        }
        for (const [, path] of moved) {
            at.delete(path)
        }
        for (const [entry, , target] of moved) {
            at.set(target, entry)
            positions.set(entry, target)
            times.set(entry, line.time)
        }
    }
    return { positions, times, warnings }
}

/** The former paths of an entry that moves from `from` to `to`: without `to`, with `from` at the end. */
export function formerPathsAfter(
    formerPaths: readonly string[],
    from: string,
    to: string
): string[] {
    const kept = formerPaths.filter((path) => path !== to)
    return kept.includes(from) ? kept : [...kept, from]
}

/**
 * The new path that the journals give to a folder of the deny list that is
 * not in the vault (PUB-91): every valid line, in the order of the moves,
 * moves that folder or a folder above it. `undefined` when no line moves it.
 */
export function movedFolder(folder: string, lines: readonly JournalLine[]): string | undefined {
    let path = folder
    for (const line of lines) {
        if (line.kind !== 'folder') {
            continue
        }
        if (path === line.from) {
            path = line.to
        } else if (path.startsWith(`${line.from}/`)) {
            path = `${line.to}/${path.slice(line.from.length + 1)}`
        }
    }
    return path === folder ? undefined : path
}
