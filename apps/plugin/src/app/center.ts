import { canonicalPath, SITE_ORIGIN } from '@dsebastien-website/resolver'
import { toCanonicalJson } from '../publishing/canonical.ts'
import {
    describePlan,
    NO_CHOICES,
    planOfChoices,
    reconcile,
    selectionOf,
    stateOfNote
} from '../publishing/center.ts'
import type { Choices, NoteState } from '../publishing/center.ts'
import { SelectionError } from '../publishing/plan.ts'
import type { PublicationPlan } from '../publishing/plan.ts'
import { isNoteEdit } from '../publishing/edits.ts'
import type { EditEvent } from '../publishing/edits.ts'
import { refreshAfterRun, SeenNotes, seeingVault } from '../publishing/after.ts'
import type { ListsAfterRun } from '../publishing/after.ts'
import type { Device, RefreshResult } from '../publishing/ports.ts'
import {
    lastText,
    reportOfStartError,
    startedText,
    succeeded,
    takedownWaits,
    takedownWaitsText
} from '../publishing/deploy.ts'
import type {
    DeployKind,
    Deployment,
    DeployRecord,
    DeployReport,
    TakedownMarker
} from '../publishing/deploy.ts'
import {
    outcomeOfEdit,
    outcomeOfGuards,
    outcomeOfPlan,
    outcomeOfPublication,
    outcomeOfTakedown
} from '../publishing/mcp.ts'
import type { ToolCall, ToolOutcome } from '../publishing/mcp.ts'
import type { Move, PublicationQueue } from '../publishing/queue.ts'
import {
    confirmProposal,
    confirmState,
    reviewProposal,
    edit,
    guards,
    plan,
    publish,
    rejectProposal,
    status,
    statusWithEdits,
    takedown,
    unlock,
    unpublish
} from '../publishing/tool.ts'
import type {
    ProposalReview,
    PublicationReport,
    Run,
    StoredPlan,
    TakedownReport
} from '../publishing/tool.ts'
import { canonicalTime } from './rename-journal.ts'

// The controller of the publication center (issue 39, decision R67): what the
// view starts, one activity at a time, in the background. It holds the last
// queue, the choices of the author, the run log and the report, and it calls
// the operations of the publishing logic (`tool.ts`). It imports no Obsidian:
// the plugin gives it the device, the pull and the clock. The view only shows
// its state (section 18.1 of the spec).

/** What the controller needs from the plugin. */
export interface CenterHost {
    /** The device of the settings. It throws with a message that names the missing setting. */
    device(): Device
    /** Pulls the content store into the copy (`pullContentStore`). */
    pull(): Promise<void>
    now(): Date
    /** The name of this device, for the commit of a publication. One line of text. */
    readonly deviceName: string
    /**
     * Called when a publication starts: its plan is the plan of the label
     * (PERF-04). `clickedAt` is the moment of the click, when the view gave it.
     */
    started?(label: string, clickedAt: number | undefined): void
    /**
     * Runs the deploy of the site after a push (issue 32, BUILD-02, PUB-42):
     * the deploy command of the site, as a child process, with the settings
     * of this device. It never throws: a failure, or a missing setting, is in
     * the report. It runs with `--takedown` also while the marker of a
     * takedown is set. Without it, nothing is deployed (the tests of the logic).
     */
    deploy?(kind: DeployKind, signal: AbortSignal): Promise<Deployment>
    /** The marker of the takedowns of this device (`TakedownMarker`). */
    takedowns?(): TakedownMarker
    /** The record of the deploys of this device: whether one runs, and the last report. */
    record?(): DeployRecord
    /**
     * The size and the time of the last change of a note of the vault, read
     * as the face reads them for an event of Obsidian, or `undefined` when
     * the note cannot be read. Without it, every event is an edit.
     */
    stat?(path: string): Promise<FileStat | undefined>
    /**
     * Waits until Obsidian read the state property of each note as the run
     * left it (its metadata cache), at most `limit` milliseconds, before the
     * refresh after a run (R84). It gives the paths that it still has not
     * read. Without it, the refresh does not wait.
     */
    indexed?(written: readonly PropertyWrite[], limit: number): Promise<readonly string[]>
}

/** A note whose state property a run wrote: set when `published`, else removed. */
export interface PropertyWrite {
    readonly path: string
    readonly published: boolean
}

/** The longest wait for Obsidian to read the property that a run wrote, before the refresh after the run. */
export const INDEX_LIMIT = 30 * 1000

/** The size and the time of the last change of a file, as the face reads them. */
export interface FileStat {
    readonly size: number
    readonly mtime: number
}

/** An event of a note: its path, and its size and time after the event when the face could read them. */
interface NoteEvent {
    readonly path: string
    readonly stat: FileStat | undefined
}

/** The result of one activity: refused, failed, or done. */
export type RunResult =
    | { readonly refused: string; readonly failure?: never }
    | { readonly refused?: never; readonly failure?: string }

/**
 * The deploy after the last push (PUB-42): it runs, or its report with the
 * whole output of the child, until the author closes it. The output can name
 * the address of a removed note: the view shows it on demand, and it goes
 * nowhere else (an agent gets the report only).
 */
export type DeploymentState =
    | { readonly running: true }
    | { readonly running: false; readonly report: DeployReport; readonly output: string }

/** What the controller does now. */
export type Activity =
    | 'idle'
    | 'checking'
    | 'planning'
    | 'publishing'
    | 'taking down'
    | 'pulling'
    | 'unlocking'
    | 'answering'
    | 'editing'
    | 'reviewing'
    | 'refreshing the lists'

/** The name of an activity in a message. */
const ACTIVITY_NAMES: Record<Activity, string> = {
    'idle': 'nothing',
    'checking': 'check',
    'planning': 'dry run',
    'publishing': 'publication',
    'taking down': 'takedown',
    'pulling': 'pull',
    'unlocking': 'unlock',
    'answering': 'request of an agent',
    'editing': 'edit of the guards',
    'reviewing': 'review of a proposal',
    'refreshing the lists': 'refresh of the lists after a run'
}

/**
 * The activity of each tool of the MCP server. `status` and `plan` are
 * answering: they change nothing that the view shows (a plan can put back a
 * publication that stopped halfway, which `status` refuses to read; in
 * Obsidian it also refreshes the frozen lists of its notes, R71).
 */
const TOOL_ACTIVITIES: Record<Exclude<ToolCall['tool'], 'deploy'>, Activity> = {
    status: 'answering',
    plan: 'answering',
    publish: 'publishing',
    unpublish: 'publishing',
    takedown: 'taking down',
    guards: 'answering',
    deny: 'editing',
    allow: 'editing',
    ignore: 'editing',
    unignore: 'editing',
    unlock: 'unlocking',
    confirm_store_state: 'editing'
}

export interface LogLine {
    /** The time, in the canonical form. */
    readonly time: string
    readonly text: string
}

/** The live address of a published or updated note (story 92). */
export interface Address {
    readonly path: string
    readonly url: string
}

/** The report of the last run, until the author closes it (PUB-43). */
export type Report =
    | {
          readonly kind: 'publication'
          readonly report: PublicationReport
          readonly addresses: readonly Address[]
          /** The refresh of the frozen lists after the run (R84), when it ended. */
          readonly lists?: ListsAfterRun
      }
    | {
          readonly kind: 'takedown'
          readonly report: TakedownReport
          readonly addresses: readonly Address[]
          /** The refresh of the frozen lists after the run (R84), when it ended. */
          readonly lists?: ListsAfterRun
      }

export interface CenterState {
    /** The queue of the last check, or `undefined` before the first one. */
    readonly queue?: PublicationQueue
    /**
     * The events of the edits of the guards since the last publication, at
     * the last check (R69): the plan shows them, and the publication marks
     * them as shown.
     */
    readonly edits?: readonly EditEvent[]
    /** The published entries whose attachments list a file under a guard, at the last check: the plan names the ones that stay (`guardedAttachments`). */
    readonly guardedEntries?: readonly string[]
    /** When the last check ended. */
    readonly checkedAt?: Date
    readonly activity: Activity
    /** The message of the last failure, until the next activity. */
    readonly error?: string
    /**
     * The message of the last publication, unpublish or takedown that
     * failed, until the author closes it or the next one starts: another
     * activity never takes it away (the run log keeps it too).
     */
    readonly failure?: string
    /** The plan of the last dry run, or of a publication that stopped because its plan changed. */
    readonly dryRun?: StoredPlan
    readonly report?: Report
    /** The deploy after the last push, apart from the report of the publication. */
    readonly deployment?: DeploymentState
    /** True when a takedown of this device waits for a deploy that succeeds. */
    readonly takedownWaits?: boolean
    readonly log: readonly LogLine[]
    /**
     * The last line of the log of the last activity, before the check that
     * ends it: the result that the notice at the end of a run shows.
     */
    readonly outcome?: string
    readonly choices: Choices
}

/** A deploy that waits for the end of the current one. */
interface PendingDeploy {
    kind: DeployKind
    done: Promise<Deployment>
}

/** The most lines that the run log keeps. */
const LOG_LINES = 200

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'it failed'
}

/** The live address of a note. */
export function addressOf(path: string): string {
    return `${SITE_ORIGIN}${canonicalPath(path)}`
}

/** The live addresses of the notes that a publication published, updated or moved (story 92). */
function addressesOf(report: PublicationReport): Address[] {
    return [...report.published, ...report.updated, ...report.moved.map((move) => move.to)]
        .sort()
        .map((path) => ({ path, url: addressOf(path) }))
}

/** The line of the run log at the end of a deploy. */
function deployLine(report: DeployReport): string {
    if (succeeded(report)) {
        return report.live
            ? `Deploy done: live at ${report.url ?? 'the host'}`
            : `Deploy done, not live yet: ${report.warnings.join('; ') || 'the deployment record does not name the new revision'}`
    }
    if (report.deploy === 'skipped' && report.build === 'skipped') {
        return `Nothing deployed: ${report.error ?? 'no reason'}`
    }
    return `Deploy failed (build ${report.build}, deploy ${report.deploy}): ${report.error ?? 'no reason'}`
}

/** The counts of a publication, for the log. */
function countsOf(report: PublicationReport): string {
    return `${String(report.published.length)} new, ${String(report.updated.length)} updated, ${String(report.removed.length)} removed, ${String(report.forcedRemoved.length)} forced, ${String(report.moved.length)} moved, ${String(report.failed.length)} failed`
}

function samePlan(one: PublicationPlan, two: PublicationPlan): boolean {
    return JSON.stringify(one) === JSON.stringify(two)
}

/** The paths that a plan names, as the text of a message. */
function pathsOfPlan(plan: PublicationPlan): string {
    const paths = [
        ...plan.publish,
        ...plan.update,
        ...plan.remove,
        ...plan.forcedRemove,
        ...plan.move.map((move) => move.to)
    ]
    const shown = paths.slice(0, 10).map((path) => `"${path}"`)
    return paths.length > 10
        ? `${shown.join(', ')} and ${String(paths.length - 10)} more`
        : shown.join(', ')
}

export class PublicationCenter {
    #state: CenterState = { activity: 'idle', log: [], choices: NO_CHOICES }
    readonly #listeners = new Set<() => void>()
    /** The notes that changed after the last check began. */
    #changed = new Set<string>()
    /**
     * The writes of the tool that are no edit: the size and the time of each
     * note after the last write of a run. An event of the note with that
     * size and time is that write, however many events it gives and however
     * late they come; any other event is an edit.
     */
    readonly #ownWrites = new Map<string, FileStat>()
    /** The edits that Obsidian reports while a refresh of the lists runs (R71). */
    #duringRefresh: NoteEvent[] | undefined
    /** The source hash of each new note and moved edited note at the last check (issue 111). */
    #checkedSources: ReadonlyMap<string, string> = new Map()
    /** The text hashes that the serializer gave for its writes since the last check (issue 111). */
    readonly #refreshedTexts = new Map<string, Set<string>>()
    /** The notes that a refresh wrote since the last check with no text hash in its answer. */
    readonly #writtenWithoutHash = new Set<string>()
    /**
     * The takedowns that started while the current refresh of the lists
     * runs (issue 111): the refresh returns only after them. `undefined`
     * when no refresh runs.
     */
    #duringRefreshRuns: Promise<void>[] | undefined
    /** The takedowns that wait for the end of an activity: a refresh that starts wakes them. */
    #waitingTakedowns: (() => void)[] = []
    /** The last takedown that runs during a refresh: one takedown at a time holds the copy. */
    #refreshTakedown: Promise<void> = Promise.resolve()
    /** The notes whose state property the run wrote: the refresh after the run is owed (R84). */
    #owed: readonly PropertyWrite[] | undefined
    /** What the check after a run read, while a refresh after the run is owed. */
    #seen: SeenNotes | undefined
    /** The edits that Obsidian reports while a run that writes into the notes runs: judged after the run recorded its writes. */
    #duringRun: NoteEvent[] | undefined
    /** The activity that runs now, so that a takedown can wait for its end. */
    #current: Promise<void> = Promise.resolve()
    /** False after a run changed the copy, until the next check: the queue is old then. */
    #fresh = false
    /** The deploy that runs now. */
    #deploying: Promise<Deployment> | undefined
    /** The stop of the deploy that runs now. */
    #stopDeploy: AbortController | undefined
    /** True when the call of an agent that runs failed after its push. */
    readonly #served = { pushed: false }
    /** The deploy that waits for the end of the current one: one for every push that came meanwhile. */
    #pendingDeploy: PendingDeploy | undefined
    /** The plan of the last queue and choices: a render asks for it more than one time. */
    #counted:
        | {
              queue: PublicationQueue
              choices: Choices
              edits: readonly EditEvent[] | undefined
              plan: PublicationPlan
          }
        | undefined

    constructor(private readonly host: CenterHost) {}

    get state(): CenterState {
        return this.#state
    }

    /** Calls the listener after each change of the state. The result removes it. */
    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    #set(change: Partial<CenterState>): void {
        this.#state = { ...this.#state, ...change }
        for (const listener of this.#listeners) {
            listener()
        }
    }

    #log(text: string): void {
        const line = { time: canonicalTime(this.host.now()), text }
        this.#set({ log: [...this.#state.log, line].slice(-LOG_LINES) })
    }

    /** Changes the choices of the author. Before the first check, nothing can be chosen. */
    choose(change: (queue: PublicationQueue, choices: Choices) => Choices): void {
        const { queue } = this.#state
        if (queue !== undefined) {
            // A new choice makes the plan of the last dry run old.
            const { dryRun: _old, ...rest } = this.#state
            this.#state = rest
            this.#set({ choices: change(queue, this.#state.choices) })
        }
    }

    /** The plan of the choices, from the last queue: what the publish button states. */
    plan(): PublicationPlan | undefined {
        const { queue, choices, edits, guardedEntries } = this.#state
        if (queue === undefined) {
            return undefined
        }
        // The edits and the guarded entries come with the queue, from one check.
        if (
            this.#counted?.queue !== queue ||
            this.#counted.choices !== choices ||
            this.#counted.edits !== edits
        ) {
            this.#counted = {
                queue,
                choices,
                edits,
                plan: planOfChoices(queue, choices, edits ?? [], guardedEntries ?? [])
            }
        }
        return this.#counted.plan
    }

    /** The label of the publish button. */
    label(): string {
        const counted = this.plan()
        return counted === undefined ? 'Check first' : describePlan(counted)
    }

    /**
     * A note was edited, made or renamed in the vault after the check, with
     * its size and its time after the event (as `stat` of the host reads
     * them). It calls no listener: Obsidian reports every file at its start,
     * and every write of the state property after a publication. An event
     * whose note has the size and the time of the last write of a run is
     * that write, no edit.
     */
    noteChanged(path: string, stat?: FileStat): void {
        // While the lists are refreshed, the events wait: after the refresh,
        // one event of each write that it reports is that write.
        if (this.#duringRefresh !== undefined) {
            this.#duringRefresh.push({ path, stat })
            return
        }
        // While a run that writes into the notes runs, the events wait too:
        // Obsidian reports a write before the run can record it.
        if (this.#duringRun !== undefined) {
            this.#duringRun.push({ path, stat })
            return
        }
        if (!this.#isOwnWrite(path, stat)) {
            this.#changed.add(path)
        }
    }

    /**
     * True when the note has the size and the time of the last write of a
     * run: the event is that write. Another size or time is an edit, and the
     * write is forgotten.
     */
    #isOwnWrite(path: string, stat: FileStat | undefined): boolean {
        const own = this.#ownWrites.get(path)
        if (own === undefined) {
            return false
        }
        if (stat !== undefined && stat.size === own.size && stat.mtime === own.mtime) {
            return true
        }
        this.#ownWrites.delete(path)
        return false
    }

    /** The path of a note in the content store: a note that a move of the queue moved is there at its old path. */
    storePathOf(path: string): string {
        const moves = [...(this.#state.queue?.renamed ?? []), ...this.#state.choices.pair]
        return moves.find((move) => move.to === path)?.from ?? path
    }

    /** Records the size and the time of each note that a run wrote, before the check after the run. */
    async #wrote(paths: Iterable<string>): Promise<void> {
        for (const path of paths) {
            const stat = await this.host.stat?.(path).catch(() => undefined)
            if (stat === undefined) {
                this.#ownWrites.delete(path)
            } else {
                this.#ownWrites.set(path, stat)
            }
        }
    }

    /**
     * The device of the host, whose refresh of the frozen lists (PUB-35, R71)
     * counts its writes as writes of the tool, not as edits: else a new note
     * with a list would be refused as "changed after the check". The events
     * of a refresh wait for its end: then the size and the time of each note
     * that it wrote are recorded, one event of each write that it reports is
     * that write, an event of a note as the last write of a run left it is
     * that write too, and every other event is an edit.
     */
    #device(): Device {
        const given = this.host.device()
        const seen = this.#seen
        const device =
            seen === undefined ? given : { ...given, vault: seeingVault(given.vault, seen) }
        const { lists } = device
        if (lists === undefined) {
            return device
        }
        return {
            ...device,
            lists: {
                refresh: async (paths, moment) => {
                    const waiting: NoteEvent[] = []
                    this.#duringRefresh = waiting
                    // A takedown never waits for a refresh (issue 111): it
                    // touches no list, and a plan that it makes stale is
                    // refused at its publication.
                    const runs: Promise<void>[] = []
                    this.#duringRefreshRuns = runs
                    for (const wake of this.#waitingTakedowns.splice(0)) {
                        wake()
                    }
                    let result: RefreshResult | undefined
                    try {
                        result = await lists.refresh(paths, moment)
                        return result
                    } finally {
                        // The refresh returns after the takedowns that started
                        // during it: the plan is then computed on their copy,
                        // and their writes are recorded before the events are
                        // judged.
                        this.#duringRefreshRuns = undefined
                        await Promise.allSettled(runs)
                        const writes = new Map(result?.written ?? [])
                        // The texts that the serializer wrote: a new note
                        // with one of them is the note of the check (issue 111).
                        for (const path of writes.keys()) {
                            const hash = result?.textHashes?.get(path)
                            if (hash === undefined) {
                                this.#writtenWithoutHash.add(path)
                            } else {
                                this.#refreshedTexts.set(
                                    path,
                                    new Set([...(this.#refreshedTexts.get(path) ?? []), hash])
                                )
                            }
                        }
                        // One event for each write of the refresh is that
                        // write; any other event is an edit, unless the note
                        // is as the last write of a run left it.
                        const settle = (events: readonly NoteEvent[]): void => {
                            for (const { path, stat } of events) {
                                const left = writes.get(path) ?? 0
                                if (left > 0) {
                                    writes.set(path, left - 1)
                                } else if (!this.#isOwnWrite(path, stat)) {
                                    this.#changed.add(path)
                                }
                            }
                        }
                        // The events of the refresh are judged before its
                        // writes are recorded: an edit during the refresh is
                        // never taken for its write.
                        settle(waiting.splice(0))
                        await this.#wrote(writes.keys())
                        // The events that came while the notes were read.
                        settle(waiting.splice(0))
                        this.#duringRefresh = undefined
                        if (result !== undefined && result.written.size > 0) {
                            this.#log(
                                `Lists refreshed by the Dataview Serializer: ${[...result.written.keys()].map((path) => `"${path}"`).join(', ')}`
                            )
                        }
                    }
                }
            }
        }
    }

    /**
     * Logs the notes of a plan whose lists were not refreshed, the notes with a
     * live query (R71, REN-14) and the notes held for the size limit of an
     * attachment (issue 72).
     */
    #logLists(stored: StoredPlan): void {
        if (stored.listsNotRefreshed.length > 0) {
            this.#log(
                `Lists not refreshed, published as they are in the note now: ${stored.listsNotRefreshedReasons.map((one) => `"${one.path}": ${one.reason}`).join('; ')}`
            )
        }
        if (stored.liveQueries.length > 0) {
            this.#log(
                `Live query blocks, not on the page: ${stored.liveQueries.map((path) => `"${path}"`).join(', ')}`
            )
        }
        // One line per note and file above the size limit (issue 72).
        for (const item of stored.tooLarge) {
            this.#log(
                `Held, above the size limit of an attachment: "${item.path}" links "${item.file}" (${String(item.size)} bytes)`
            )
        }
    }

    /** Records that the run wrote the state property of these notes: the refresh after the run is owed (R84). */
    #oweRefresh(device: Device, set: readonly string[], removed: readonly string[]): void {
        // Without a serializer, no refresh is owed.
        if (device.lists === undefined) {
            return
        }
        this.#owed = [
            ...set.map((path) => ({ path, published: true })),
            ...removed.map((path) => ({ path, published: false }))
        ]
    }

    /**
     * Refreshes the frozen lists that read the state property, after a
     * publication, an unpublish or a takedown and the check after it (R84).
     * The report and the log of the run are already there: a restart during
     * the refresh loses only the refresh. It first waits until Obsidian read
     * the new property of each note that the run wrote, at most
     * `INDEX_LIMIT`. The run is done: a refresh that fails is logged and
     * reported, and fails nothing. The device is the one of `#device`, so
     * the writes of the refresh are no edits and the log names them.
     */
    async #refreshAfter(
        written: readonly PropertyWrite[],
        seen: SeenNotes | undefined
    ): Promise<void> {
        try {
            await this.#refreshOnce(written, seen)
        } catch (error) {
            // Nothing of the refresh fails the run, which is done.
            const message = `the refresh after the run failed: ${messageOf(error)}`
            this.#log(`Lists not refreshed after the run: ${message}`)
            const { report } = this.#state
            if (report !== undefined) {
                this.#set({
                    report: {
                        ...report,
                        lists: { listsRefreshed: [], refreshProblems: [{ path: '', message }] }
                    }
                })
            }
        }
    }

    async #refreshOnce(
        written: readonly PropertyWrite[],
        seen: SeenNotes | undefined
    ): Promise<void> {
        let device: Device
        try {
            device = this.#device()
        } catch (error) {
            this.#log(`Lists not refreshed after the run: ${messageOf(error)}`)
            return
        }
        if (device.lists === undefined) {
            return
        }
        const indexed = this.host.indexed?.bind(this.host)
        const late =
            written.length > 0 && indexed !== undefined ? await indexed(written, INDEX_LIMIT) : []
        const found = await refreshAfterRun(device, seen)
        const lists: ListsAfterRun = {
            listsRefreshed: found.listsRefreshed,
            refreshProblems: [
                ...late.map((path) => ({
                    path,
                    message: `Obsidian had not read the new public_note property of this note after ${String(INDEX_LIMIT / 1000)} s, so a list that reads it can still show the old state: run the Dataview Serializer on that list later`
                })),
                ...found.refreshProblems
            ]
        }
        if (lists.refreshProblems.length > 0) {
            this.#log(
                `Lists not refreshed after the run, they stay as they are in the note: ${lists.refreshProblems.map((one) => (one.path === '' ? one.message : `"${one.path}": ${one.message}`)).join('; ')}`
            )
        }
        const { report } = this.#state
        if (report !== undefined) {
            this.#set({ report: { ...report, lists } })
        }
    }

    /** The state of a note at the last check (TOOL-23). */
    stateOf(path: string): NoteState {
        return stateOfNote(this.#state.queue, this.#state.choices, path, this.#changed.has(path))
    }

    /** Closes the report (PUB-43). */
    closeReport(): void {
        const { report: _closed, ...rest } = this.#state
        this.#state = rest
        this.#set({})
    }

    /** Closes the report of the deploy. A deploy that runs stays. */
    closeDeployment(): void {
        if (this.#state.deployment?.running !== false) {
            return
        }
        const { deployment: _closed, ...rest } = this.#state
        this.#state = rest
        this.#set({})
    }

    /**
     * Runs the deploy again, with no publication (for example after a
     * failure). It waits for the end of the deploy that runs.
     */
    async deploy(takedown = false): Promise<DeployReport | undefined> {
        return (await this.#deploy({ push: 'skipped', takedown }))?.report
    }

    /**
     * Stops the deploy that runs, with the programs that it started: it
     * fails with a message, and a deploy that waits runs after it. The
     * marker of a takedown stays. False when no deploy runs.
     */
    stopDeploy(): boolean {
        const stop = this.#stopDeploy
        if (stop === undefined || stop.signal.aborted) {
            return false
        }
        this.#log('Deploy stopped by the author')
        stop.abort()
        return true
    }

    /** True when the call of an agent failed after its push; it clears the mark. */
    #takeServedPush(): boolean {
        const pushed = this.#served.pushed
        this.#served.pushed = false
        return pushed
    }

    /**
     * Runs a publication, an unpublish or a takedown. When it fails after
     * its push (the run journal says that the correction is owed, and the
     * commit of the copy moved), the push happened: `pushed` is called, so
     * that the deploy still starts, and the message says so. A takedown
     * writes its entry in the marker of the takedowns before its push, with
     * the commit of the copy before it, then the commit of its push after
     * it; the entry goes when nothing was pushed.
     */
    async #pushing<T>(
        device: Device,
        work: () => Promise<T>,
        pushed: () => void,
        isTakedown = false
    ): Promise<T> {
        const before = await device.store.head().catch(() => undefined)
        const entry = isTakedown ? await this.#addTakedown(before) : undefined
        const settle = async (done: boolean): Promise<void> => {
            if (entry === undefined) {
                return
            }
            try {
                const after = done ? await device.store.head().catch(() => undefined) : undefined
                if (!done) {
                    await entry.marker.remove(entry.id)
                } else if (after !== undefined && after !== before) {
                    await entry.marker.replace(entry.id, { commit: after })
                }
            } catch (error) {
                this.#log(`The marker of the takedown could not be written: ${messageOf(error)}`)
            }
            await this.refreshTakedowns()
        }
        try {
            const result = await work()
            await settle(true)
            return result
        } catch (error) {
            if (!(await this.#pushedAnyway(device, before))) {
                await settle(false)
                throw error
            }
            await settle(true)
            pushed()
            throw new Error(
                `The push happened, so the deploy starts, but a later step of the run failed: ${messageOf(error)}`,
                { cause: error }
            )
        }
    }

    /** Writes the entry of a takedown before its push. A marker that cannot be written is logged. */
    async #addTakedown(
        before: string | undefined
    ): Promise<{ marker: TakedownMarker; id: string } | undefined> {
        const marker = this.host.takedowns?.()
        if (marker === undefined) {
            return undefined
        }
        try {
            return { marker, id: await marker.add({ above: before ?? null }) }
        } catch (error) {
            this.#log(
                `The marker of the takedown could not be written: ${messageOf(error)}. Deploy with --takedown until a deploy succeeds`
            )
            return undefined
        }
    }

    /** Reads again whether a takedown of this device waits for its deploy (the view shows it). */
    async refreshTakedowns(): Promise<boolean> {
        const marker = this.host.takedowns?.()
        const waits = marker === undefined ? false : await takedownWaits(marker)
        if (this.#state.takedownWaits !== waits) {
            this.#set({ takedownWaits: waits })
        }
        return waits
    }

    /** True when the run journal says that a push happened and the commit of the copy is not the one before the run. */
    async #pushedAnyway(device: Device, before: string | undefined): Promise<boolean> {
        const journal = await device.local.loadJournal().catch(() => undefined)
        let step: unknown
        try {
            step =
                journal === undefined ? undefined : (JSON.parse(journal) as { step?: unknown }).step
        } catch {
            step = undefined
        }
        if (step !== 'correct') {
            return false
        }
        const after = await device.store.head().catch(() => before)
        return after !== before
    }

    /**
     * Starts the deploy after a push (issue 32). It runs outside the lock of
     * the device and outside the activities: the publication is done at the
     * push, the author keeps working, and the push of a takedown never waits
     * for a deploy. One deploy runs at a time, in the order of the pushes: a
     * push during a deploy gets one more deploy after it, which covers every
     * push that came meanwhile (with `--takedown` when one was a takedown), so
     * the last release is the build of the last push. The deploy of a
     * takedown waits behind the deploy that runs (about a minute), and the
     * marker of the takedown keeps it until a deploy with `--takedown`
     * succeeds. `undefined` when the host deploys nothing.
     */
    #deploy(asked: DeployKind): Promise<Deployment> | undefined {
        const run = this.host.deploy?.bind(this.host)
        if (run === undefined) {
            return undefined
        }
        const pending = this.#pendingDeploy
        if (pending !== undefined) {
            pending.kind = {
                push: pending.kind.push === 'ok' || asked.push === 'ok' ? 'ok' : 'skipped',
                takedown: pending.kind.takedown || asked.takedown
            }
            return pending.done
        }
        const current = this.#deploying
        if (current === undefined) {
            return this.#startDeploy(run, asked)
        }
        const next: PendingDeploy = {
            kind: asked,
            done: current.then(() => {
                this.#pendingDeploy = undefined
                return this.#startDeploy(run, next.kind)
            })
        }
        this.#pendingDeploy = next
        return next.done
    }

    #startDeploy(run: NonNullable<CenterHost['deploy']>, kind: DeployKind): Promise<Deployment> {
        this.#log(kind.takedown ? 'Deploy started, after a takedown' : 'Deploy started')
        this.#set({ deployment: { running: true } })
        const stop = new AbortController()
        this.#stopDeploy = stop
        const running = (async (): Promise<Deployment> => {
            let deployment: Deployment
            try {
                deployment = await run(kind, stop.signal)
            } catch (error) {
                deployment = { report: reportOfStartError(messageOf(error), kind), output: '' }
            }
            const { report, output } = deployment
            this.#set({ deployment: { running: false, report, output } })
            this.#log(deployLine(report))
            await this.refreshTakedowns()
            return deployment
        })()
        this.#deploying = running
        void running.finally(() => {
            if (this.#deploying === running) {
                this.#deploying = undefined
                this.#stopDeploy = undefined
            }
        })
        return running
    }

    /**
     * Runs one activity, when no other one runs. It refuses the activity
     * with a line of the log otherwise. A request of an agent that only
     * reads is waited for: it never holds the author back (issue 41).
     *
     * With `after`, a check runs at the end, in the same activity, also when
     * the work failed: a run that changed the copy makes the queue old, and
     * no other activity may start between the run and its check. A check
     * that fails keeps the failure of the run when there is one. After a run
     * of an agent, the check keeps the marks of the ticked notes.
     */
    async #run(
        activity: Activity,
        name: string,
        work: () => Promise<void>,
        after: 'none' | 'author' | 'agent' = 'none'
    ): Promise<RunResult> {
        while (this.#state.activity === 'answering' && activity !== 'answering') {
            await this.#current
        }
        if (this.#state.activity !== 'idle') {
            const text = `${name} refused: a ${ACTIVITY_NAMES[this.#state.activity]} runs already`
            this.#log(text)
            // A check that another activity refuses is no failure: every
            // activity checks again at its end.
            if (activity !== 'checking') {
                this.#set({ error: `${text}. Try again when it ends.` })
            }
            return { refused: text }
        }
        // A request of an agent that only reads leaves the error of the
        // author: only its own failure replaces it. The failure of a
        // publication or a takedown stays until the next one starts.
        const pushes = activity === 'publishing' || activity === 'taking down'
        // The refresh after a run keeps the error of its run too (R84).
        if (activity !== 'answering' && activity !== 'refreshing the lists') {
            const { error: _old, failure: kept, ...rest } = this.#state
            this.#state = pushes || kept === undefined ? rest : { ...rest, failure: kept }
        }
        this.#set({ activity: activity })
        let failure: string | undefined
        // A publication, a takedown and an edit of the guards write into the
        // notes: the events of their writes wait for the end of the work,
        // when the writes are recorded (review of issue 106).
        const waiting: NoteEvent[] | undefined = pushes || activity === 'editing' ? [] : undefined
        // A run that wrote the state property owes the refresh of the lists
        // that read it (R84), after the check, which reads the notes.
        let owed: readonly PropertyWrite[] | undefined
        let seen: SeenNotes | undefined
        this.#duringRun = waiting
        const running = (async () => {
            try {
                try {
                    await work()
                } catch (error) {
                    failure = messageOf(error)
                    this.#log(`${name} failed: ${failure}`)
                    this.#set(pushes ? { error: failure, failure } : { error: failure })
                } finally {
                    if (waiting !== undefined) {
                        this.#duringRun = undefined
                        for (const { path, stat } of waiting) {
                            if (!this.#isOwnWrite(path, stat)) {
                                this.#changed.add(path)
                            }
                        }
                    }
                }
                const outcome = this.#state.log.at(-1)?.text
                if (outcome !== undefined) {
                    this.#set({ outcome })
                }
                owed = this.#owed
                this.#owed = undefined
                if (after !== 'none') {
                    this.#seen = owed === undefined ? undefined : new SeenNotes()
                    try {
                        await this.#check(after === 'agent')
                        seen = this.#seen
                    } catch (error) {
                        this.#log(`Check failed: ${messageOf(error)}`)
                        failure ??= messageOf(error)
                        if (this.#state.error === undefined) {
                            this.#set({ error: messageOf(error) })
                        }
                    } finally {
                        this.#seen = undefined
                    }
                }
            } finally {
                this.#set({ activity: 'idle' })
            }
            // The refresh after the run is its own activity: the deploy and
            // the answer of an agent do not wait for it.
            const written = owed
            if (written !== undefined) {
                void this.#run('refreshing the lists', 'Refresh of the lists after the run', () =>
                    this.#refreshAfter(written, seen)
                )
            }
        })()
        this.#current = running
        await running
        return failure === undefined ? {} : { failure }
    }

    /** Closes the message of the last publication or takedown that failed. */
    closeFailure(): void {
        const { failure: _closed, ...rest } = this.#state
        this.#state = rest
        this.#set({})
    }

    /**
     * The check of the vault and of the copy: the four lists, the moves and
     * the pairings. The edits before it are no marks after it. With
     * `keepTicked` (a check after a run of an agent, issue 41), the new
     * notes, the moved notes whose text changed, and the notes that the
     * author ticked stay marked: the author did not look at the lists, and a
     * publication of the view must stop on them.
     */
    async #check(keepTicked = false): Promise<void> {
        this.#log('Check started')
        const device = this.#device()
        // The edits before this check: they are marks again when it fails.
        const before = this.#changed
        this.#changed = new Set()
        // The texts of the check that the author saw (issue 111).
        const sources = this.#checkedSources
        const texts = new Map(this.#refreshedTexts)
        const unhashed = new Set(this.#writtenWithoutHash)
        try {
            await this.#checkWith(device)
        } catch (error) {
            for (const path of before) {
                this.#changed.add(path)
            }
            throw error
        }
        if (!keepTicked) {
            return
        }
        const { choices, queue } = this.#state
        const kept = new Set([
            ...choices.include,
            ...choices.pair.map((one) => one.to),
            ...(queue?.new ?? []),
            ...(queue?.movedEdited ?? [])
        ])
        for (const path of before) {
            if (kept.has(path)) {
                this.#changed.add(path)
            }
        }
        // A kept note keeps the text of the check before the run of the
        // agent: a publication of the view stops when the plan holds another
        // one (issue 111).
        const now = new Map(this.#checkedSources)
        for (const path of kept) {
            const source = sources.get(path)
            if (source !== undefined) {
                now.set(path, source)
            }
            const hashes = texts.get(path)
            if (hashes !== undefined) {
                this.#refreshedTexts.set(path, hashes)
            }
            if (unhashed.has(path)) {
                this.#writtenWithoutHash.add(path)
            }
        }
        this.#checkedSources = now
    }

    async #checkWith(device: Device): Promise<void> {
        // The copy is fetched first, when the network allows it, so that
        // `behind` is the state of now (PUB-30, PERF-16). Not while a run
        // holds the lock of the device: `status` then stops with its message.
        const lock = await device.local.lock({ command: 'check' })
        let fetched = { reached: true }
        if (lock.taken) {
            try {
                fetched = await device.store.verify('try')
            } finally {
                await device.local.release(lock.text)
            }
        }
        const { queue, edits, guardedEntries, sources } = await statusWithEdits(device)
        this.#checkedSources = sources
        this.#refreshedTexts.clear()
        this.#writtenWithoutHash.clear()
        this.#fresh = true
        this.#set({
            queue,
            edits,
            guardedEntries,
            checkedAt: this.host.now(),
            choices: reconcile(queue, this.#state.choices)
        })
        const { counts } = queue
        this.#log(
            `Check done: ${String(counts.new)} new, ${String(counts.changed)} changed, ${String(counts.toRemove)} to remove, ${String(counts.unchanged)} unchanged${fetched.reached ? '' : ' (no network: the last fetch)'}`
        )
    }

    /** Checks the vault (PUB-30, PUB-31). The result says when another activity refused it, or why it failed. */
    check(): Promise<RunResult> {
        return this.#run('checking', 'Check', () => this.#check())
    }

    /**
     * A dry run: the plan of the choices, from the vault. It writes nothing
     * but the frozen lists that the refresh before the plan updates (PUB-33,
     * R71).
     */
    dryRun(): Promise<RunResult> {
        return this.#run('planning', 'Dry run', async () => {
            const { queue, choices } = this.#state
            if (queue === undefined) {
                throw new Error('check the vault first')
            }
            const device = this.#device()
            const stored = await plan(device, selectionOf(queue, choices))
            this.#set({ dryRun: stored })
            this.#log(
                `Dry run: ${describePlan(stored.plan)}${stored.offline ? ' (no network: the last fetch)' : ''}`
            )
            this.#logLists(stored)
        })
    }

    /**
     * Publishes the plan of the label (PUB-34). The plan is made again from
     * the vault first: when it is not the plan that the label states, nothing
     * is published, and the view shows the new plan.
     */
    async publish(clickedAt?: number): Promise<void> {
        // Set by the work of the run: the push succeeded.
        const done = { pushed: false }
        await this.#run(
            'publishing',
            'Publication',
            async () => {
                const { queue, choices, edits, guardedEntries } = this.#state
                if (queue === undefined) {
                    throw new Error('check the vault first')
                }
                const expected = planOfChoices(queue, choices, edits ?? [], guardedEntries ?? [])
                const selection = selectionOf(queue, choices)
                const device = this.#device()
                let stored: StoredPlan
                try {
                    stored = await plan(device, selectionOf(queue, choices))
                } catch (error) {
                    if (error instanceof SelectionError) {
                        throw new Error(
                            `The selection changed since the check, so nothing was published: ${error.message}. Check the lists and publish again.`,
                            { cause: error }
                        )
                    }
                    throw error
                }
                // A new note that changed after the check can be another note at
                // the same path: the author never saw it in the lists. The
                // texts of the plan decide, not the events (issue 111).
                this.#refuseChangedNewNotes(queue, expected, selection.pair, stored)
                if (!samePlan(stored.plan, expected)) {
                    this.#set({ dryRun: stored })
                    throw new Error(
                        `The plan changed since the check, so nothing was published. The plan is now: ${describePlan(stored.plan)} (${pathsOfPlan(stored.plan)}). Check the lists and publish again.`
                    )
                }
                this.#logLists(stored)
                this.#log(`Publication started: ${describePlan(expected)}`)
                this.host.started?.(describePlan(expected), clickedAt)
                this.#fresh = false
                const report = await this.#pushing(
                    device,
                    () =>
                        publish(device, stored.id, {
                            time: canonicalTime(this.host.now()),
                            device: this.host.deviceName,
                            face: 'plugin'
                        }),
                    () => {
                        done.pushed = true
                    }
                )
                done.pushed = true
                await this.#wrote([...report.propertySet, ...report.propertyRemoved])
                this.#set({
                    report: { kind: 'publication', report, addresses: addressesOf(report) }
                })
                this.#log(`Publication done: ${countsOf(report)}`)
                this.#oweRefresh(device, report.propertySet, report.propertyRemoved)
            },
            'author'
        )
        if (done.pushed) {
            void this.#deploy({ push: 'ok', takedown: false })
        }
    }

    /**
     * Takes notes down at once, with no plan (PUB-81, TOOL-25). `shown` is
     * the path of each note in the content store as its dialog named it: the
     * takedown stops when a check finds another one.
     */
    async takedown(paths: readonly string[], shown?: readonly string[]): Promise<void> {
        // A takedown does not wait for a publication (PUB-99), but one run
        // at a time holds the copy: it runs at the end of the current one,
        // or at once while the current one waits for a refresh of the lists
        // (issue 111).
        while (this.#state.activity !== 'idle') {
            const runs = this.#duringRefreshRuns
            if (runs !== undefined) {
                await this.#takedownDuringRefresh(runs, paths, shown)
                return
            }
            await Promise.race([
                this.#current,
                new Promise<void>((resolve) => {
                    this.#waitingTakedowns.push(resolve)
                })
            ])
        }
        // Set by the work of the run: the push succeeded.
        const done = { pushed: false }
        await this.#run(
            'taking down',
            'Takedown',
            () => this.#takedownWork(paths, shown, done),
            'author'
        )
        if (done.pushed) {
            void this.#deploy({ push: 'ok', takedown: true })
        }
    }

    /**
     * A takedown that starts while a refresh of the lists runs (issue 111),
     * inside the activity that waits for the refresh: the refresh returns
     * after it. It checks again at its end, as every run that changed the
     * copy, and one such takedown runs at a time.
     */
    async #takedownDuringRefresh(
        runs: Promise<void>[],
        paths: readonly string[],
        shown: readonly string[] | undefined
    ): Promise<void> {
        const done = { pushed: false }
        const before = this.#refreshTakedown
        const run = (async () => {
            await before
            const { error: _old, failure: _kept, ...rest } = this.#state
            this.#state = rest
            this.#log('Takedown started while the lists are refreshed')
            try {
                await this.#takedownWork(paths, shown, done)
            } catch (error) {
                const failure = messageOf(error)
                this.#log(`Takedown failed: ${failure}`)
                this.#set({ error: failure, failure })
            }
            // The activity that waits for the refresh decides on the texts of
            // the check that the author saw, not on this one.
            const sources = this.#checkedSources
            const texts = new Map(this.#refreshedTexts)
            const unhashed = new Set(this.#writtenWithoutHash)
            const marks = new Set(this.#changed)
            try {
                await this.#check()
            } catch (error) {
                this.#log(`Check failed: ${messageOf(error)}`)
            }
            this.#checkedSources = sources
            for (const [path, hashes] of texts) {
                this.#refreshedTexts.set(path, hashes)
            }
            for (const path of unhashed) {
                this.#writtenWithoutHash.add(path)
            }
            for (const path of marks) {
                this.#changed.add(path)
            }
        })()
        this.#refreshTakedown = run
        runs.push(run)
        await run
        if (done.pushed) {
            void this.#deploy({ push: 'ok', takedown: true })
        }
    }

    /** The work of a takedown (PUB-81): the check when the queue is old, the takedown, its report. */
    async #takedownWork(
        paths: readonly string[],
        shown: readonly string[] | undefined,
        done: { pushed: boolean }
    ): Promise<void> {
        const device = this.#device()
        // The queue tells where a note is in the content store: after a
        // run that changed the copy, it is checked again first.
        if (!this.#fresh || this.#changed.size > 0) {
            // Nothing but the copy stops a takedown (PUB-99): a check that
            // fails (a deny list entry that names no folder, a stopped
            // run) leaves the last check.
            try {
                await this.#checkWith(device)
            } catch (error) {
                this.#log(
                    `Takedown: the check before it failed, so it uses the last check (${messageOf(error)})`
                )
            }
        }
        // A note that a move of the queue moved is still at its old path
        // in the content store until the next publication.
        const stored = paths.map((path) => this.storePathOf(path))
        if (shown !== undefined && stored.some((path, index) => path !== shown[index])) {
            throw new Error(
                `The note moved in the content store since its dialog opened, so nothing was taken down: open its dialog again (${stored.map((path) => `"${path}"`).join(', ')})`
            )
        }
        this.#log(`Takedown started: ${stored.map((path) => `"${path}"`).join(', ')}`)
        this.#fresh = false
        const report = await this.#pushing(
            device,
            () =>
                takedown(device, stored, {
                    time: canonicalTime(this.host.now()),
                    device: this.host.deviceName,
                    face: 'plugin'
                }),
            () => {
                done.pushed = true
            },
            true
        )
        done.pushed = true
        await this.#wrote(report.propertyRemoved)
        this.#set({ report: { kind: 'takedown', report, addresses: [] } })
        this.#log(`Takedown done: ${String(report.takenDown.length)} taken down`)
        this.#oweRefresh(device, [], report.propertyRemoved)
        if (report.storageWarnings.length > 0) {
            // A file that stays in the storage can still be public (issue 38).
            throw new Error(
                `The note was taken down, but the attachment storage gave warnings: a file can still be public. Take the note down again, or delete these files by hand: ${report.storageWarnings.map((one) => `${one.path}: ${one.message}`).join('. ')}`
            )
        }
    }

    /**
     * Runs a call of a tool of the MCP server (issue 41, TOOL-03), as the
     * command of the same name of the command line program does, with the
     * face "mcp-server". It waits for the end of the current activity, so one
     * run at a time holds the copy. The log, the report and the error show
     * what the agent did, and a call that changed the copy checks again. A
     * failure throws, with its message for the agent.
     */
    async serve(call: ToolCall): Promise<ToolOutcome> {
        if (call.tool === 'deploy') {
            return await this.#serveDeploy(call.takedown === true, call.last === true)
        }
        let outcome: ToolOutcome | undefined
        let failure: unknown
        const activity = TOOL_ACTIVITIES[call.tool]
        this.#served.pushed = false
        // The loop and the start of the run are one step: no other activity
        // starts between them.
        while (this.#state.activity !== 'idle') {
            await this.#current
        }
        await this.#run(
            activity,
            `Agent ${call.tool}`,
            async () => {
                try {
                    outcome = await this.#serve(call)
                } catch (error) {
                    failure = error
                    throw error
                }
                if (outcome.failure !== undefined) {
                    // The report is written: the view shows what failed too.
                    throw new Error(outcome.failure)
                }
            },
            // A call that changed the copy checks again, in its own activity.
            activity === 'answering' ? 'none' : 'agent'
        )
        const pushedThenFailed = this.#takeServedPush()
        if (outcome === undefined && pushedThenFailed) {
            void this.#deploy({ push: 'ok', takedown: call.tool === 'takedown' })
        }
        if (outcome !== undefined) {
            // A push that succeeded starts the deploy, after the check of the
            // run. The agent never waits for a build: it gets the report of
            // a deploy that started, and reads the result later with the
            // tool deploy and last (PUB-42).
            const pushed =
                call.tool === 'publish' || call.tool === 'unpublish' || call.tool === 'takedown'
            const kind: DeployKind = { push: 'ok', takedown: call.tool === 'takedown' }
            const deployment = pushed ? this.#deploy(kind) : undefined
            return deployment === undefined ? outcome : { ...outcome, deploy: startedText(kind) }
        }
        throw failure instanceof Error
            ? failure
            : new Error(`a ${ACTIVITY_NAMES[this.#state.activity]} runs already: try again`)
    }

    /**
     * The `deploy` tool. With `last`, the last deploy report of the record
     * and whether a deploy runs, with no new deploy. Else the deploy again,
     * in the background: the answer is the report of a deploy that started.
     */
    async #serveDeploy(takedown: boolean, last: boolean): Promise<ToolOutcome> {
        if (last) {
            const record = this.host.record?.()
            const stored = await record?.last().catch(() => undefined)
            const running =
                this.#deploying !== undefined ||
                (await record?.running().catch(() => false)) === true
            const waits = await this.refreshTakedowns()
            return { output: lastText(stored, running, waits) }
        }
        this.#log(takedown ? 'Agent deploy, with --takedown' : 'Agent deploy')
        const kind: DeployKind = { push: 'skipped', takedown }
        if (this.#deploy(kind) === undefined) {
            throw new Error('this face deploys nothing')
        }
        return { output: startedText(kind) }
    }

    async #serve(call: Exclude<ToolCall, { tool: 'deploy' }>): Promise<ToolOutcome> {
        const device = this.#device()
        const run: Run = {
            time: canonicalTime(this.host.now()),
            device: this.host.deviceName,
            face: 'mcp-server'
        }
        switch (call.tool) {
            case 'status': {
                this.#log('Agent status')
                const output = toCanonicalJson(await status(device))
                // A takedown that waits is said after the report, outside it.
                return (await this.refreshTakedowns())
                    ? { output, deploy: takedownWaitsText() }
                    : { output }
            }
            case 'plan': {
                this.#log('Agent plan')
                // A plan can put back a publication that stopped halfway,
                // which writes the copy: a takedown checks again first.
                this.#fresh = false
                const stored = await plan(device, {
                    include: call.include,
                    hold: call.hold,
                    remove: call.remove,
                    pair: call.pair,
                    accept: call.accept ?? []
                })
                this.#log(`Agent plan ${stored.id}: ${describePlan(stored.plan)}`)
                this.#logLists(stored)
                return outcomeOfPlan(stored)
            }
            case 'publish':
            case 'unpublish': {
                this.#log(
                    call.tool === 'publish'
                        ? `Agent publication started: plan ${call.plan}`
                        : `Agent unpublish started: ${call.paths.map((path) => `"${path}"`).join(', ')}`
                )
                this.#fresh = false
                const report = await this.#pushing(
                    device,
                    () =>
                        call.tool === 'publish'
                            ? publish(device, call.plan, run)
                            : unpublish(device, call.paths, run, call.accept ?? []),
                    () => {
                        this.#served.pushed = true
                    }
                )
                await this.#wrote([...report.propertySet, ...report.propertyRemoved])
                this.#set({
                    report: { kind: 'publication', report, addresses: addressesOf(report) }
                })
                this.#log(`Agent publication done: ${countsOf(report)}`)
                this.#oweRefresh(device, report.propertySet, report.propertyRemoved)
                return outcomeOfPublication(report)
            }
            case 'takedown': {
                this.#log(
                    `Agent takedown started: ${call.paths.map((path) => `"${path}"`).join(', ')}`
                )
                this.#fresh = false
                const report = await this.#pushing(
                    device,
                    () => takedown(device, call.paths, run),
                    () => {
                        this.#served.pushed = true
                    },
                    true
                )
                await this.#wrote(report.propertyRemoved)
                this.#set({ report: { kind: 'takedown', report, addresses: [] } })
                this.#oweRefresh(device, [], report.propertyRemoved)
                this.#log(`Agent takedown done: ${String(report.takenDown.length)} taken down`)
                return outcomeOfTakedown(report)
            }
            case 'guards': {
                this.#log('Agent guards')
                return outcomeOfGuards(await guards(device))
            }
            case 'deny':
            case 'allow':
            case 'ignore':
            case 'unignore': {
                this.#log(`Agent edit started: ${call.tool} "${call.path}"`)
                this.#fresh = false
                const event = await edit(device, { action: call.tool, path: call.path }, run)
                if (event.state === 'applied' && call.tool === 'ignore') {
                    await this.#wrote([call.path])
                }
                this.#log(`Agent edit done: ${call.tool} "${call.path}" (${event.state})`)
                return outcomeOfEdit(event)
            }
            case 'confirm_store_state': {
                this.#log(`Agent confirmation of the state started: ${call.head}`)
                this.#fresh = false
                const confirmed = await confirmState(device, call.head, run)
                this.#log(`Agent confirmation of the state done: ${call.head}`)
                return { output: toCanonicalJson(confirmed) }
            }
            case 'unlock': {
                this.#fresh = false
                const removed = await unlock(device)
                this.#log(
                    removed
                        ? 'Agent unlock done: the lock was removed'
                        : 'Agent unlock done: there was no lock'
                )
                return { output: toCanonicalJson({ removed }) }
            }
        }
    }

    /**
     * The proposal with the entries that it takes away now (rule 7): the
     * dialog of a confirmation opens with this list, computed again when it
     * opens. `undefined` when the review failed: the error says why.
     */
    async reviewProposal(proposal: EditEvent): Promise<ProposalReview | undefined> {
        let review: ProposalReview | undefined
        await this.#run('reviewing', 'Review', async () => {
            review = await reviewProposal(this.#device(), proposal.id)
        })
        return review
    }

    /**
     * The author confirms an open proposal of an edit of the guards (R69),
     * then checks again, with the lists of the review that the dialog
     * showed: when the edit would take other entries or attachments away
     * now, nothing is applied.
     */
    async confirmProposal(review: ProposalReview): Promise<void> {
        await this.#decide(review.proposal, 'Confirm', (device, run) =>
            confirmProposal(
                device,
                {
                    proposal: review.proposal.id,
                    removes: review.removes,
                    affects: review.affects,
                    opens: review.opens
                },
                run
            )
        )
    }

    /** The author rejects an open proposal of an edit of the guards (R69), then checks again. */
    async rejectProposal(proposal: EditEvent): Promise<void> {
        await this.#decide(proposal, 'Reject', (device, run) =>
            rejectProposal(device, proposal.id, run)
        )
    }

    async #decide(
        proposal: EditEvent,
        name: 'Confirm' | 'Reject',
        work: (device: Device, run: Run) => Promise<EditEvent>
    ): Promise<void> {
        await this.#run(
            'editing',
            name,
            async () => {
                const device = this.#device()
                this.#log(`${name} started: ${proposal.action} "${proposal.path}"`)
                this.#fresh = false
                const event = await work(device, {
                    time: canonicalTime(this.host.now()),
                    device: this.host.deviceName,
                    face: 'plugin'
                })
                if (event.state === 'confirmed' && isNoteEdit(event.action)) {
                    await this.#wrote([event.path])
                }
                this.#log(`${name} done: ${event.action} "${event.path}" (${event.state})`)
            },
            'author'
        )
    }

    /**
     * The author confirms the state of the content store at this commit,
     * after the difference that an error named (R104), then checks again.
     */
    async confirmState(head: string): Promise<void> {
        await this.#run(
            'editing',
            'Confirmation of the state',
            async () => {
                this.#log(`Confirmation of the state started: ${head}`)
                this.#fresh = false
                const { confirmed } = await confirmState(this.#device(), head, {
                    time: canonicalTime(this.host.now()),
                    device: this.host.deviceName,
                    face: 'plugin'
                })
                this.#log(
                    confirmed
                        ? `Confirmation of the state done: ${head} is sealed`
                        : 'Confirmation of the state done: the state was sealed already'
                )
            },
            'author'
        )
    }

    /** Pulls the content store into the copy, on a click of the author (R67), then checks again. */
    async pull(): Promise<void> {
        await this.#run(
            'pulling',
            'Pull',
            async () => {
                this.#log('Pull started: git pull --ff-only origin main')
                this.#fresh = false
                await this.host.pull()
                this.#log('Pull done')
            },
            'author'
        )
    }

    /**
     * Stops a publication when a new note of the plan, or the new note of a
     * pairing, changed after the check: another note can have its path, which
     * the author never saw in the lists. Its tick goes away, so a second click
     * never publishes it unseen.
     */
    #refuseChangedNewNotes(
        queue: PublicationQueue,
        expected: PublicationPlan,
        pairs: readonly Move[],
        stored: StoredPlan
    ): void {
        // A ticked moved note whose text is not the published text can be
        // another note too (R67).
        const moved = new Set(queue.movedEdited)
        const fresh = [
            ...new Set([
                ...expected.publish,
                ...expected.update.filter((path) => moved.has(path)),
                ...pairs.map((one) => one.to)
            ])
        ].filter((path) => this.#changedSinceCheck(path, stored))
        if (fresh.length === 0) {
            return
        }
        const gone = new Set(fresh)
        this.#set({
            choices: {
                ...this.#state.choices,
                include: this.#state.choices.include.filter((path) => !gone.has(path)),
                pair: this.#state.choices.pair.filter((one) => !gone.has(one.to))
            }
        })
        throw new Error(
            `A new note changed after the check, so nothing was published and its tick is gone: ${fresh.map((path) => `"${path}"`).join(', ')}. The lists are checked again: check them, tick again and publish.`
        )
    }

    /**
     * True when the plan holds another text of the note than the check:
     * its source is not the source of the check, and its text is not one
     * that the serializer wrote since (issue 111). A note that the plan does
     * not write is no change. When the serializer gave no hash of its write,
     * the events decide for that note, as before: an event that is not one
     * of its writes is an edit.
     */
    #changedSinceCheck(path: string, stored: StoredPlan): boolean {
        const planned = stored.hashes.get(path)
        if (planned === undefined || planned.source === this.#checkedSources.get(path)) {
            return false
        }
        if (this.#refreshedTexts.get(path)?.has(planned.text) === true) {
            return false
        }
        return !this.#writtenWithoutHash.has(path) || this.#changed.has(path)
    }

    /**
     * The text of the lock of the device, for the confirmation of its
     * removal: `undefined` when there is none, or when the settings name no
     * device.
     */
    async lockText(): Promise<string | undefined> {
        try {
            return await this.host.device().local.readLock()
        } catch {
            return undefined
        }
    }

    /**
     * Removes the lock that a run left when it stopped halfway (a crash, a
     * power cut, Obsidian closed during a run), then checks again. The next
     * dry run, publication or takedown puts the copy back (PUB-27, PUB-94).
     * Only when no run of any face runs on this device.
     */
    async unlock(): Promise<void> {
        await this.#run(
            'unlocking',
            'Unlock',
            async () => {
                this.#fresh = false
                const removed = await unlock(this.#device())
                this.#log(
                    removed ? 'Unlock done: the lock was removed' : 'Unlock done: there was no lock'
                )
            },
            'author'
        )
    }
}
