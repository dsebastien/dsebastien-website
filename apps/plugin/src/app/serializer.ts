import type { ListRefresh, RefreshResult } from '../publishing/ports.ts'
import type { PluginHost } from './starter-kit.ts'

// The Dataview Serializer inside Obsidian, as the publishing logic needs it:
// the refresh of the frozen lists of the notes of a plan (PUB-35, decision
// R71). The plugin answers through its API, `refreshNotes(paths)`, with one
// outcome per note. The face reads the answer strictly: an answer that it
// cannot read refreshes no note.

/** The id of the Dataview Serializer plugin in Obsidian. */
export const SERIALIZER_ID = 'dataview-serializer'

/** The longest wait for the answer of the serializer: after it, no note counts as refreshed. */
export const REFRESH_LIMIT = 10 * 60 * 1000

/** The outcomes of a note that count as refreshed (rule 7 of "The frozen lists of a note"). */
const REFRESHED: ReadonlySet<string> = new Set(['updated', 'unchanged'])

/** Why a note with another outcome is not refreshed. */
const NOT_REFRESHED: ReadonlyMap<string, string> = new Map([
    ['no-queries', 'the Dataview Serializer found no query to run in this note'],
    [
        'ignored',
        'the Dataview Serializer ignores this note (the property dataview_serializer_ignore, an Excalidraw drawing or a note named Canvas.md): its lists are published as saved'
    ],
    ['not-found', 'the Dataview Serializer found no note at this path'],
    ['conflict', 'the note changed during the refresh: its lists are published as saved'],
    ['failed', 'a query failed'],
    ['not-run', 'the refresh did not run']
])

/** Why no note is refreshed, for each state of the answer that is not `ready`. */
const STATES: ReadonlyMap<string, string> = new Map([
    [
        'disabled-on-device',
        'the Dataview Serializer is turned off on this device: the lists are published as saved'
    ],
    ['dataview-not-loaded', 'Dataview is not loaded: the lists are published as saved'],
    [
        'dataview-index-not-ready',
        'the index of Dataview is not ready yet (Obsidian just started): the lists are published as saved. Make the plan again in a moment'
    ],
    [
        'dataview-index-busy',
        'Dataview is still indexing recent edits: the lists are published as saved. Make the plan again in a moment'
    ]
])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/** True when the value is a list of objects whose given keys are texts. */
function isListOf(value: unknown, keys: readonly string[]): value is Record<string, string>[] {
    return (
        Array.isArray(value) &&
        value.every((item) => isRecord(item) && keys.every((key) => typeof item[key] === 'string'))
    )
}

/**
 * True when Obsidian gives this path another form (`normalizePath`: the
 * composed Unicode form, a space for U+00A0 and U+202F). The serializer
 * would then refresh another file, maybe a note that is not in the plan
 * (issue 110): such a path is not asked.
 */
function changedByObsidian(path: string): boolean {
    return path.normalize('NFC') !== path || /[\u00a0\u202f]/u.test(path)
}

/** The same message for every path: no note is refreshed. */
function noneRefreshed(paths: readonly string[], message: string, wrote: boolean): RefreshResult {
    return {
        refreshed: new Set(),
        written: new Set(),
        wrote,
        problems: paths.map((path) => ({ path, message }))
    }
}

/** Reads the answer of `refreshNotes` for these paths, or gives `undefined` when it cannot. */
function readAnswer(paths: readonly string[], answer: unknown): RefreshResult | undefined {
    if (!isRecord(answer) || !Array.isArray(answer['notes'])) {
        return undefined
    }
    const state = answer['state']
    const notes: unknown[] = answer['notes']
    if (typeof state !== 'string' || (state !== 'ready' && !STATES.has(state))) {
        return undefined
    }
    if (notes.length !== paths.length) {
        return undefined
    }
    const refreshed = new Set<string>()
    const written = new Set<string>()
    const problems: { path: string; message: string }[] = []
    let wrote = false
    for (const [index, path] of paths.entries()) {
        const entry = notes[index]
        if (
            !isRecord(entry) ||
            entry['path'] !== path ||
            (entry['resolvedPath'] !== null && typeof entry['resolvedPath'] !== 'string') ||
            typeof entry['outcome'] !== 'string' ||
            !isListOf(entry['errors'], ['query', 'message']) ||
            !isListOf(entry['skipped'], ['query', 'reason'])
        ) {
            return undefined
        }
        const { outcome, errors, skipped } = entry
        if (!REFRESHED.has(outcome) && !NOT_REFRESHED.has(outcome)) {
            return undefined
        }
        if (outcome === 'updated' || outcome === 'conflict') {
            // A conflict: another write changed the note during the refresh.
            wrote = true
        }
        if (outcome === 'updated' && typeof entry['resolvedPath'] === 'string') {
            written.add(entry['resolvedPath'])
        }
        if (state !== 'ready') {
            problems.push({ path, message: STATES.get(state) ?? state })
        } else if (REFRESHED.has(outcome) && entry['resolvedPath'] !== path) {
            // The serializer processed another file than the one of this path.
            problems.push({
                path,
                message:
                    'the Dataview Serializer refreshed another file than this one: its lists are published as saved'
            })
        } else if (REFRESHED.has(outcome) && errors.length === 0 && skipped.length === 0) {
            refreshed.add(path)
        } else if (errors.length > 0) {
            problems.push({
                path,
                message: `a query failed: ${errors.map((error) => (error['query'] === '' ? String(error['message']) : `${String(error['query'])}: ${String(error['message'])}`)).join('; ')}`
            })
        } else if (skipped.length > 0) {
            problems.push({
                path,
                message: `a query kept its old output: ${skipped.map((query) => `${String(query['query'])}: ${String(query['reason'])}`).join('; ')}`
            })
        } else {
            problems.push({ path, message: NOT_REFRESHED.get(outcome) ?? outcome })
        }
    }
    return { refreshed, written, wrote, problems }
}

/**
 * The Dataview Serializer of a running Obsidian. Each refresh finds the
 * plugin again: it can be turned off, updated or turned on between two runs.
 * It never throws: a plugin that is not enabled, too old, slower than the
 * limit, or that gives an answer that cannot be read refreshes no note, and
 * says why.
 *
 * @param limit the longest wait for the answer, in milliseconds
 */
export function serializerLists(app: PluginHost, limit = REFRESH_LIMIT): ListRefresh {
    return {
        async refresh(given) {
            const changed = given.filter(changedByObsidian)
            const paths = given.filter((path) => !changedByObsidian(path))
            const result = await refreshOf(app, paths, limit)
            return {
                ...result,
                problems: [
                    ...result.problems,
                    ...changed.map((path) => ({
                        path,
                        message:
                            'Obsidian gives this file name another path (a no-break space, or another Unicode form): its lists are published as saved (issue 110)'
                    }))
                ]
            }
        }
    }
}

/** Asks the serializer for these paths. */
async function refreshOf(
    app: PluginHost,
    paths: readonly string[],
    limit: number
): Promise<RefreshResult> {
    if (paths.length === 0) {
        return noneRefreshed([], '', false)
    }
    const plugin = app.plugins.plugins[SERIALIZER_ID]
    const api = isRecord(plugin) ? plugin['api'] : undefined
    const refreshNotes = isRecord(api) ? api['refreshNotes'] : undefined
    if (typeof refreshNotes !== 'function') {
        return noneRefreshed(
            paths,
            plugin === undefined
                ? 'the Dataview Serializer plugin is not enabled in this vault: the lists are published as saved'
                : 'the Dataview Serializer plugin has no refreshNotes: it needs version 3.9.0 or later',
            false
        )
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => {
            resolve('late')
        }, limit)
    })
    let answer: unknown
    try {
        answer = await Promise.race([
            (refreshNotes as (this: unknown, paths: string[]) => unknown).call(api, [...paths]),
            late
        ])
    } catch (error) {
        // A note can have been written before the error: the plan is
        // computed again.
        return noneRefreshed(
            paths,
            `the refresh of the Dataview Serializer failed: ${error instanceof Error ? error.message : String(error)}`,
            true
        )
    } finally {
        clearTimeout(timer)
    }
    if (answer === 'late') {
        return noneRefreshed(
            paths,
            `the Dataview Serializer did not answer within ${String(Math.round(limit / 1000))} s: the lists are published as saved`,
            true
        )
    }
    return (
        readAnswer(paths, answer) ??
        noneRefreshed(
            paths,
            'the Dataview Serializer gave an answer that the tool cannot read: the lists are published as saved',
            true
        )
    )
}
