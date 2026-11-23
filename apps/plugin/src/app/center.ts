import { canonicalPath, SITE_ORIGIN } from '@dsebastien-website/resolver'
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
import type { Device } from '../publishing/ports.ts'
import type { PublicationQueue } from '../publishing/queue.ts'
import { plan, publish, status, takedown } from '../publishing/tool.ts'
import type { PublicationReport, StoredPlan, TakedownReport } from '../publishing/tool.ts'
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
}

/** What the controller does now. */
export type Activity = 'idle' | 'checking' | 'planning' | 'publishing' | 'taking down' | 'pulling'

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
    /** When the last check ended. */
    readonly checkedAt?: Date
    readonly activity: Activity
    /** The message of the last failure, until the next activity. */
    readonly error?: string
    /** The plan of the last dry run, or of a publication that stopped because its plan changed. */
    readonly dryRun?: StoredPlan
    readonly report?: Report
    readonly log: readonly LogLine[]
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
        const { queue, choices } = this.#state
        return queue === undefined ? undefined : planOfChoices(queue, choices)
    }

    /** The label of the publish button. */
    label(): string {
        const counted = this.plan()
        return counted === undefined ? 'Check first' : describePlan(counted)
    }

    /** A note was edited, made or renamed in the vault after the check. */
    noteChanged(path: string): void {
        this.#changed.add(path)
        this.#set({})
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
     * with a line of the log otherwise.
     */
    async #run(activity: Activity, name: string, work: () => Promise<void>): Promise<void> {
        if (this.#state.activity !== 'idle') {
            this.#log(
                `${name} refused: a ${this.#state.activity === 'checking' ? 'check' : this.#state.activity} runs already`
            )
            return
        }
        const { error: _old, ...rest } = this.#state
        this.#state = rest
        this.#set({ activity: activity })
        try {
            await work()
        } catch (error) {
            this.#log(`${name} failed: ${messageOf(error)}`)
            this.#set({ error: messageOf(error) })
        } finally {
            this.#set({ activity: 'idle' })
        }
    }

    /** The check of the vault and of the copy: the four lists, the moves and the pairings. */
    async #check(): Promise<void> {
        this.#log('Check started')
        const device = this.host.device()
        this.#changed = new Set()
        // The copy is fetched first, when the network allows it, so that
        // `behind` is the state of now (PUB-30, PERF-16).
        const fetched = await device.store.verify('try')
        const queue = await status(device)
        this.#set({
            queue,
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

    /** A dry run: the plan of the choices, from the vault, with nothing written (PUB-33). */
    dryRun(): Promise<void> {
        return this.#run('planning', 'Dry run', async () => {
            const { queue, choices } = this.#state
            if (queue === undefined) {
                throw new Error('check the vault first')
            }
            const device = this.host.device()
            const stored = await plan(device, selectionOf(queue, choices))
            this.#set({ dryRun: stored })
            this.#log(
                `Dry run: ${describePlan(stored.plan)}${stored.offline ? ' (no network: the last fetch)' : ''}`
            )
        })
    }

    /**
     * Publishes the plan of the label (PUB-34). The plan is made again from
     * the vault first: when it is not the plan that the label states, nothing
     * is published, and the view shows the new plan.
     */
    async publish(): Promise<void> {
        await this.#run('publishing', 'Publication', async () => {
            const { queue, choices } = this.#state
            if (queue === undefined) {
                throw new Error('check the vault first')
            }
            const expected = planOfChoices(queue, choices)
            this.#log(`Publication started: ${describePlan(expected)}`)
            const device = this.host.device()
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
            if (!samePlan(stored.plan, expected)) {
                this.#set({ dryRun: stored })
                throw new Error(
                    `The plan changed since the check, so nothing was published. The plan is now: ${describePlan(stored.plan)} (${pathsOfPlan(stored.plan)}). Check the lists and publish again.`
                )
            }
            const report = await publish(device, stored.id, {
                time: canonicalTime(this.host.now()),
                device: this.host.deviceName,
                face: 'plugin'
            })
            this.#set({
                report: {
                    kind: 'publication',
                    report,
                    addresses: [
                        ...report.published,
                        ...report.updated,
                        ...report.moved.map((move) => move.to)
                    ]
                        .sort()
                        .map((path) => ({ path, url: addressOf(path) }))
                },
                choices: NO_CHOICES
            })
            this.#log(
                `Publication done: ${String(report.published.length)} new, ${String(report.updated.length)} updated, ${String(report.removed.length)} removed, ${String(report.forcedRemoved.length)} forced, ${String(report.moved.length)} moved, ${String(report.failed.length)} failed`
            )
        })
        await this.#checkAfter()
    }

    /** Takes notes down at once, with no plan (PUB-81, TOOL-25). */
    async takedown(paths: readonly string[]): Promise<void> {
        await this.#run('taking down', 'Takedown', async () => {
            this.#log(`Takedown started: ${paths.map((path) => `"${path}"`).join(', ')}`)
            const report = await takedown(this.host.device(), paths, {
                time: canonicalTime(this.host.now()),
                device: this.host.deviceName,
                face: 'plugin'
            })
            this.#set({ report: { kind: 'takedown', report, addresses: [] } })
            this.#log(`Takedown done: ${String(report.takenDown.length)} taken down`)
            if (report.storageWarnings.length > 0) {
                // A file that stays in the storage can still be public (issue 38).
                throw new Error(
                    `the attachment storage gave warnings: a file can still be public. ${report.storageWarnings.map((one) => `${one.path}: ${one.message}`).join('. ')}`
                )
            }
        })
        await this.#checkAfter()
    }

    /** Pulls the content store into the copy, on a click of the author (R67), then checks again. */
    async pull(): Promise<void> {
        await this.#run('pulling', 'Pull', async () => {
            this.#log('Pull started: git pull --ff-only origin main')
            await this.host.pull()
            this.#log('Pull done')
        })
        await this.#checkAfter()
    }

    /** A check after a run that changed the copy, unless the run failed before it changed anything. */
    async #checkAfter(): Promise<void> {
        const failed = this.#state.error
        await this.check()
        if (failed !== undefined && this.#state.error === undefined) {
            // The failure of the run stays visible after the check.
            this.#set({ error: failed })
        }
    }
}
