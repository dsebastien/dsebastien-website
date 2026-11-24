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
import type { Device, RefreshResult } from '../publishing/ports.ts'
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
}

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
    'reviewing': 'review of a proposal'
}

/**
 * The activity of each tool of the MCP server. `status` and `plan` are
 * answering: they change nothing that the view shows (a plan can put back a
 * publication that stopped halfway, which `status` refuses to read; in
 * Obsidian it also refreshes the frozen lists of its notes, R71).
 */
const TOOL_ACTIVITIES: Record<ToolCall['tool'], Activity> = {
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
    unlock: 'unlocking'
}

/** How long a write of the state property by a run is no edit, in milliseconds. */
const OWN_WRITES = 10_000

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
      }
    | {
          readonly kind: 'takedown'
          readonly report: TakedownReport
          readonly addresses: readonly Address[]
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
    /** The plan of the last dry run, or of a publication that stopped because its plan changed. */
    readonly dryRun?: StoredPlan
    readonly report?: Report
    readonly log: readonly LogLine[]
    /**
     * The last line of the log of the last activity, before the check that
     * ends it: the result that the notice at the end of a run shows.
     */
    readonly outcome?: string
    readonly choices: Choices
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
    /** The writes of the tool that are no edit: each slot holds paths until its time ends. */
    #ownWrites: { paths: Set<string>; until: number }[] = []
    /** The paths of the edits that Obsidian reports while a refresh of the lists runs (R71). */
    #duringRefresh: string[] | undefined
    /** The activity that runs now, so that a takedown can wait for its end. */
    #current: Promise<void> = Promise.resolve()
    /** False after a run changed the copy, until the next check: the queue is old then. */
    #fresh = false
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
     * A note was edited, made or renamed in the vault after the check. It
     * calls no listener: Obsidian reports every file at its start, and every
     * write of the state property after a publication. The write of the state
     * property by the last run is no edit (one event per note, for a short time).
     */
    noteChanged(path: string): void {
        // A monotonic clock of the face, not a time of the logic.
        // While the lists are refreshed, the events wait: after the refresh,
        // only one event of each note that it wrote is its own write.
        if (this.#duringRefresh !== undefined) {
            this.#duringRefresh.push(path)
            return
        }
        if (!this.#isOwnWrite(path)) {
            this.#changed.add(path)
        }
    }

    /** True when an open slot holds the path: the event is the write of a run, and it takes the path out. */
    #isOwnWrite(path: string): boolean {
        const now = performance.now()
        this.#ownWrites = this.#ownWrites.filter((slot) => now < slot.until)
        return this.#ownWrites.some((slot) => slot.paths.delete(path))
    }

    /** The path of a note in the content store: a note that a move of the queue moved is there at its old path. */
    storePathOf(path: string): string {
        const moves = [...(this.#state.queue?.renamed ?? []), ...this.#state.choices.pair]
        return moves.find((move) => move.to === path)?.from ?? path
    }

    #wrote(paths: readonly string[]): void {
        // A new slot does not drop the slot of an earlier run: the events of
        // its writes can come later.
        const now = performance.now()
        this.#ownWrites = this.#ownWrites.filter((slot) => now < slot.until)
        if (paths.length > 0) {
            this.#ownWrites.push({ paths: new Set(paths), until: now + OWN_WRITES })
        }
    }

    /**
     * The device of the host, whose refresh of the frozen lists (PUB-35, R71)
     * counts its writes as writes of the tool, not as edits: else a new note
     * with a list would be refused as "changed after the check". The events
     * of a refresh wait for its end: then one event of each note that it
     * wrote is its write, an event that an open slot of an earlier run holds
     * is that write, and every other event is an edit. A write whose event
     * comes later gets a slot.
     */
    #device(): Device {
        const device = this.host.device()
        const { lists } = device
        if (lists === undefined) {
            return device
        }
        return {
            ...device,
            lists: {
                refresh: async (paths) => {
                    this.#duringRefresh = []
                    let result: RefreshResult | undefined
                    try {
                        result = await lists.refresh(paths)
                        return result
                    } finally {
                        const events = this.#duringRefresh
                        this.#duringRefresh = undefined
                        const written = new Set(result?.written ?? [])
                        for (const path of events) {
                            // The first event of a note that the refresh wrote is
                            // its write; any other event is an edit.
                            if (!written.delete(path) && !this.#isOwnWrite(path)) {
                                this.#changed.add(path)
                            }
                        }
                        // A write whose event has not come yet.
                        this.#wrote([...written])
                        if (result !== undefined && result.written.size > 0) {
                            this.#log(
                                `Lists refreshed by the Dataview Serializer: ${[...result.written].map((path) => `"${path}"`).join(', ')}`
                            )
                        }
                    }
                }
            }
        }
    }

    /** Logs the notes of a plan whose lists were not refreshed, and the notes with a live query (R71, REN-14). */
    #logLists(stored: StoredPlan): void {
        if (stored.listsNotRefreshed.length > 0) {
            const reasons = new Map(stored.refreshProblems.map((one) => [one.path, one.message]))
            this.#log(
                `Lists not refreshed, published as saved: ${stored.listsNotRefreshed.map((path) => `"${path}": ${reasons.get(path) ?? 'the Dataview Serializer did not refresh it'}`).join('; ')}`
            )
        }
        if (stored.liveQueries.length > 0) {
            this.#log(
                `Live query blocks, not on the page: ${stored.liveQueries.map((path) => `"${path}"`).join(', ')}`
            )
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
    ): Promise<void> {
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
            return
        }
        // A request of an agent that only reads leaves the error of the
        // author: only its own failure replaces it.
        if (activity !== 'answering') {
            const { error: _old, ...rest } = this.#state
            this.#state = rest
        }
        this.#set({ activity: activity })
        const running = (async () => {
            try {
                try {
                    await work()
                } catch (error) {
                    this.#log(`${name} failed: ${messageOf(error)}`)
                    this.#set({ error: messageOf(error) })
                }
                const outcome = this.#state.log.at(-1)?.text
                if (outcome !== undefined) {
                    this.#set({ outcome })
                }
                if (after !== 'none') {
                    try {
                        await this.#check(after === 'agent')
                    } catch (error) {
                        this.#log(`Check failed: ${messageOf(error)}`)
                        if (this.#state.error === undefined) {
                            this.#set({ error: messageOf(error) })
                        }
                    }
                }
            } finally {
                this.#set({ activity: 'idle' })
            }
        })()
        this.#current = running
        await running
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
        const { queue, edits, guardedEntries } = await statusWithEdits(device)
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

    /** Checks the vault (PUB-30, PUB-31). */
    check(): Promise<void> {
        return this.#run('checking', 'Check', () => this.#check())
    }

    /**
     * A dry run: the plan of the choices, from the vault. It writes nothing
     * but the frozen lists that the refresh before the plan updates (PUB-33,
     * R71).
     */
    dryRun(): Promise<void> {
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
        await this.#run(
            'publishing',
            'Publication',
            async () => {
                const { queue, choices, edits, guardedEntries } = this.#state
                if (queue === undefined) {
                    throw new Error('check the vault first')
                }
                const expected = planOfChoices(queue, choices, edits ?? [], guardedEntries ?? [])
                // A new note that changed after the check can be another note at
                // the same path: the author never saw it in the lists.
                const selection = selectionOf(queue, choices)
                this.#refuseChangedNewNotes(queue, expected, selection.pair)
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
                // An edit during the scan of the plan counts too.
                this.#refuseChangedNewNotes(queue, expected, selection.pair)
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
                const report = await publish(device, stored.id, {
                    time: canonicalTime(this.host.now()),
                    device: this.host.deviceName,
                    face: 'plugin'
                })
                this.#wrote([...report.propertySet, ...report.propertyRemoved])
                this.#set({
                    report: { kind: 'publication', report, addresses: addressesOf(report) }
                })
                this.#log(`Publication done: ${countsOf(report)}`)
            },
            'author'
        )
    }

    /**
     * Takes notes down at once, with no plan (PUB-81, TOOL-25). `shown` is
     * the path of each note in the content store as its dialog named it: the
     * takedown stops when a check finds another one.
     */
    async takedown(paths: readonly string[], shown?: readonly string[]): Promise<void> {
        // A takedown does not wait for a publication (PUB-99), but one run
        // at a time holds the copy: it runs at the end of the current one.
        while (this.#state.activity !== 'idle') {
            await this.#current
        }
        await this.#run(
            'taking down',
            'Takedown',
            async () => {
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
                const report = await takedown(device, stored, {
                    time: canonicalTime(this.host.now()),
                    device: this.host.deviceName,
                    face: 'plugin'
                })
                this.#wrote(report.propertyRemoved)
                this.#set({ report: { kind: 'takedown', report, addresses: [] } })
                this.#log(`Takedown done: ${String(report.takenDown.length)} taken down`)
                if (report.storageWarnings.length > 0) {
                    // A file that stays in the storage can still be public (issue 38).
                    throw new Error(
                        `The note was taken down, but the attachment storage gave warnings: a file can still be public. Take the note down again, or delete these files by hand: ${report.storageWarnings.map((one) => `${one.path}: ${one.message}`).join('. ')}`
                    )
                }
            },
            'author'
        )
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
        let outcome: ToolOutcome | undefined
        let failure: unknown
        const activity = TOOL_ACTIVITIES[call.tool]
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
        if (outcome !== undefined) {
            return outcome
        }
        throw failure instanceof Error
            ? failure
            : new Error(`a ${ACTIVITY_NAMES[this.#state.activity]} runs already: try again`)
    }

    async #serve(call: ToolCall): Promise<ToolOutcome> {
        const device = this.#device()
        const run: Run = {
            time: canonicalTime(this.host.now()),
            device: this.host.deviceName,
            face: 'mcp-server'
        }
        switch (call.tool) {
            case 'status': {
                this.#log('Agent status')
                return { output: toCanonicalJson(await status(device)) }
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
                const report =
                    call.tool === 'publish'
                        ? await publish(device, call.plan, run)
                        : await unpublish(device, call.paths, run, call.accept ?? [])
                this.#wrote([...report.propertySet, ...report.propertyRemoved])
                this.#set({
                    report: {
                        kind: 'publication',
                        report,
                        addresses: addressesOf(report)
                    }
                })
                this.#log(`Agent publication done: ${countsOf(report)}`)
                return outcomeOfPublication(report)
            }
            case 'takedown': {
                this.#log(
                    `Agent takedown started: ${call.paths.map((path) => `"${path}"`).join(', ')}`
                )
                this.#fresh = false
                const report = await takedown(device, call.paths, run)
                this.#wrote(report.propertyRemoved)
                this.#set({ report: { kind: 'takedown', report, addresses: [] } })
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
                    this.#wrote([call.path])
                }
                this.#log(`Agent edit done: ${call.tool} "${call.path}" (${event.state})`)
                return outcomeOfEdit(event)
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
                    this.#wrote([event.path])
                }
                this.#log(`${name} done: ${event.action} "${event.path}" (${event.state})`)
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
        pairs: readonly Move[]
    ): void {
        // A ticked moved note whose text is not the published text can be
        // another note too (R67).
        const moved = new Set(queue.movedEdited)
        const fresh = [
            ...expected.publish,
            ...expected.update.filter((path) => moved.has(path)),
            ...pairs.map((one) => one.to)
        ].filter((path) => this.#changed.has(path))
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
