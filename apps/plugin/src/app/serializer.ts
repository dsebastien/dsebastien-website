import type { ListRefresh, RefreshMoment, RefreshResult } from '../publishing/ports.ts'
import type { PluginHost } from './starter-kit.ts'
import { isChangedByObsidian } from '../publishing/names.ts'

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

/**
 * The form of `textHash` of a note of the answer: the hash of the text after
 * the last write of the call (issue 111). An older serializer gives none.
 */
const TEXT_HASH = /^sha256:[0-9a-f]{64}$/u

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
 * True when Obsidian gives this path another form: its own `normalizePath`
 * changes it, or the rule of the tool says so (`isChangedByObsidian`, also
 * when the face has no Obsidian). The serializer would then refresh another
 * file, maybe a note that is not in the plan (issue 110): such a path is not
 * asked. A plan never publishes such a note (decision R72).
 */
function changedByObsidian(path: string, normalize: (path: string) => string): boolean {
    return normalize(path) !== path || isChangedByObsidian(path)
}

/** The same message for every path: no note is refreshed. */
function noneRefreshed(paths: readonly string[], message: string, wrote: boolean): RefreshResult {
    return {
        refreshed: new Set(),
        written: new Map(),
        wrote,
        problems: paths.map((path) => ({ path, message }))
    }
}

/** The notes that Dataview has not indexed yet, when the answer names them (`stalePaths`). */
function staleOf(answer: Record<string, unknown>): string {
    const stale = answer['stalePaths']
    return Array.isArray(stale) &&
        stale.length > 0 &&
        stale.every((path) => typeof path === 'string')
        ? ` (not indexed yet: ${stale.map((path: string) => `"${path}"`).join(', ')})`
        : ''
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
    const written = new Map<string, number>()
    const textHashes = new Map<string, string>()
    const problems: { path: string; message: string }[] = []
    let wrote = false
    for (const [index, path] of paths.entries()) {
        const entry = notes[index]
        if (
            !isRecord(entry) ||
            entry['path'] !== path ||
            (entry['resolvedPath'] !== null && typeof entry['resolvedPath'] !== 'string') ||
            !Number.isSafeInteger(entry['writes']) ||
            (entry['writes'] as number) < 0 ||
            typeof entry['outcome'] !== 'string' ||
            !isListOf(entry['errors'], ['query', 'message']) ||
            !isListOf(entry['skipped'], ['query', 'reason']) ||
            (entry['textHash'] !== undefined &&
                (typeof entry['textHash'] !== 'string' || !TEXT_HASH.test(entry['textHash'])))
        ) {
            return undefined
        }
        const { outcome, errors, skipped } = entry
        if (!REFRESHED.has(outcome) && !NOT_REFRESHED.has(outcome)) {
            return undefined
        }
        // `writes`: how many times the serializer wrote the note in this call
        // (one pass or more), also when a later pass failed.
        const writes = entry['writes'] as number
        if (writes > 0 || outcome === 'updated' || outcome === 'conflict') {
            // `updated` with no write: another program brought the refreshed
            // text during the refresh. A conflict: another write changed the
            // note. Either way the text is not the one of the first scan.
            wrote = true
        }
        if (writes > 0 && typeof entry['resolvedPath'] === 'string') {
            written.set(entry['resolvedPath'], writes)
            if (typeof entry['textHash'] === 'string') {
                textHashes.set(entry['resolvedPath'], entry['textHash'])
            }
        }
        if (state !== 'ready') {
            problems.push({ path, message: `${STATES.get(state) ?? state}${staleOf(answer)}` })
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
    return { refreshed, written, textHashes, wrote, problems }
}

/**
 * The words of a problem after a run (R84): no plan follows, so the lists
 * are not published as saved, they stay as they are in the note.
 */
function afterRun(message: string): string {
    return message
        .replaceAll('the lists are published as saved', 'the lists stay as they are')
        .replaceAll('its lists are published as saved', 'its lists stay as they are')
        .replaceAll(
            'Make the plan again in a moment',
            'Publish again later, or run the Dataview Serializer on the note later'
        )
}

/** The same result, with the words of `moment`. */
function worded(result: RefreshResult, moment: RefreshMoment): RefreshResult {
    return moment === 'after-run'
        ? {
              ...result,
              problems: result.problems.map((one) => ({ ...one, message: afterRun(one.message) }))
          }
        : result
}

/**
 * The Dataview Serializer of a running Obsidian. Each refresh finds the
 * plugin again: it can be turned off, updated or turned on between two runs.
 * It never throws: a plugin that is not enabled, too old, slower than the
 * limit, or that gives an answer that cannot be read refreshes no note, and
 * says why.
 *
 * A refresh that is still running after the limit is not asked again: the
 * next refresh waits for it first, within the same limit.
 *
 * @param normalize `normalizePath` of Obsidian
 * @param limit the longest wait for the answer, in milliseconds
 */
export function serializerLists(
    app: PluginHost,
    normalize: (path: string) => string,
    limit = REFRESH_LIMIT
): ListRefresh {
    let running: Promise<unknown> = Promise.resolve()
    return {
        async refresh(given, moment = 'before-plan') {
            return worded(await refreshOnce(given), moment)
        }
    }

    async function refreshOnce(given: readonly string[]): Promise<RefreshResult> {
        const changed = given.filter((path) => changedByObsidian(path, normalize))
        const paths = given.filter((path) => !changedByObsidian(path, normalize))
        if ((await settledWithin(running, limit)) === 'late') {
            return noneRefreshed(
                given,
                'the Dataview Serializer still runs an earlier refresh: the lists are published as saved',
                true
            )
        }
        const { result, call } = await refreshOf(app, paths, limit)
        running = call
        return {
            ...result,
            problems: [
                ...result.problems,
                ...changed.map((path) => ({
                    path,
                    message:
                        'Obsidian gives this file name another path (a no-break space, a backslash, a slash too many or a name that is not in the composed Unicode form): its lists are published as saved (issue 110)'
                }))
            ]
        }
    }
}

/** Waits for a promise, at most `limit` milliseconds. */
async function settledWithin(promise: Promise<unknown>, limit: number): Promise<'done' | 'late'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => {
            resolve('late')
        }, limit)
    })
    try {
        return await Promise.race([
            promise.then(
                () => 'done' as const,
                () => 'done' as const
            ),
            late
        ])
    } finally {
        clearTimeout(timer)
    }
}

/** Asks the serializer for these paths. `call` is the call itself, which can run after the limit. */
async function refreshOf(
    app: PluginHost,
    paths: readonly string[],
    limit: number
): Promise<{ result: RefreshResult; call: Promise<unknown> }> {
    const done = (result: RefreshResult): { result: RefreshResult; call: Promise<unknown> } => ({
        result,
        call: Promise.resolve()
    })
    if (paths.length === 0) {
        return done(noneRefreshed([], '', false))
    }
    const plugin = app.plugins.plugins[SERIALIZER_ID]
    const api = isRecord(plugin) ? plugin['api'] : undefined
    const refreshNotes = isRecord(api) ? api['refreshNotes'] : undefined
    if (typeof refreshNotes !== 'function') {
        return done(
            noneRefreshed(
                paths,
                plugin === undefined
                    ? 'the Dataview Serializer plugin is not enabled in this vault: the lists are published as saved'
                    : 'the Dataview Serializer plugin has no refreshNotes: it needs version 3.9.0 or later',
                false
            )
        )
    }
    // A throw of the API becomes a rejection of the call.
    const call: Promise<unknown> = Promise.resolve().then(() =>
        (refreshNotes as (this: unknown, paths: string[]) => unknown).call(api, [...paths])
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => {
            resolve('late')
        }, limit)
    })
    let answer: unknown
    try {
        answer = await Promise.race([call, late])
    } catch (error) {
        // A note can have been written before the error: the plan is
        // computed again.
        return {
            result: noneRefreshed(
                paths,
                `the refresh of the Dataview Serializer failed: ${error instanceof Error ? error.message : String(error)}`,
                true
            ),
            call
        }
    } finally {
        clearTimeout(timer)
    }
    if (answer === 'late') {
        return {
            result: noneRefreshed(
                paths,
                `the Dataview Serializer did not answer within ${String(Math.round(limit / 1000))} s: the lists are published as saved`,
                true
            ),
            call
        }
    }
    return {
        result:
            readAnswer(paths, answer) ??
            noneRefreshed(
                paths,
                'the Dataview Serializer gave an answer that the tool cannot read: the lists are published as saved',
                true
            ),
        call
    }
}
