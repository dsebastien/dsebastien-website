// The rule of the automated budgets of the publishing tool (issue 59, R97,
// PERF-02, PERF-03, PERF-15, TEST-06). The budgets are set for the real vault
// of the author. The test runs on the invented corpus, on any machine, so its
// ceiling is the budget scaled twice: by the size of the corpus, and by the
// speed of the machine, which a short fixed reference workload measures in
// the same run.

/** The number of notes of the real vault for which the budgets are set. */
export const REAL_VAULT_NOTES = 34_000

/** The two implementations of the publishing logic (ADR 0009). */
export type Implementation = 'rust' | 'typescript'

/** One automated budget: a command of the tool, in one implementation. */
export interface ToolBudget {
    readonly id: 'PERF-02' | 'PERF-03'
    /**
     * `status`: a full check with no stored state. `plan`: a plan with no
     * selection after an edit of a few notes.
     */
    readonly command: 'status' | 'plan'
    readonly implementation: Implementation
    /** The budget on the real vault, in seconds. */
    readonly seconds: number
    /** The median that the author measured on the real vault for the budget (R97), in seconds. */
    readonly measured: number
}

/** The budgets of R97. The first-publication plan has no budget, and PERF-04 no number yet. */
export const TOOL_BUDGETS: readonly ToolBudget[] = [
    { id: 'PERF-03', command: 'status', implementation: 'rust', seconds: 15, measured: 8.97 },
    {
        id: 'PERF-03',
        command: 'status',
        implementation: 'typescript',
        seconds: 30,
        measured: 17.43
    },
    { id: 'PERF-02', command: 'plan', implementation: 'rust', seconds: 20, measured: 12.89 },
    { id: 'PERF-02', command: 'plan', implementation: 'typescript', seconds: 30, measured: 15.73 }
]

/**
 * The calibration, in seconds: the time of the reference workload that a
 * machine as fast as the machine of the author would take. It is the
 * reference time of the machine of the calibration over the largest factor
 * that its measures imply (`impliedFactor`), as `bun run budgets:tool`
 * prints it. Set on 2026-11-27 on a Windows machine of the author, with the
 * Rust `status` as the largest factor. A machine that runs the workload in
 * more time gets a ceiling that is larger by the same ratio. A value from
 * Windows keeps the factor of a Linux runner at its floor: set it again from
 * the line "calibration that this machine gives" of the first run on main.
 */
export const REFERENCE_SECONDS = 0.29

/**
 * The factor of the machine: the time of the reference workload here, over
 * its time on the machine of the calibration. It is never below 1: on a
 * faster machine the ceiling stays the budget scaled for the corpus, never a
 * stricter one.
 */
export function machineFactor(reference: number, calibration = REFERENCE_SECONDS): number {
    if (!(reference > 0) || !(calibration > 0)) {
        throw new Error('the times of the reference workload must be above zero')
    }
    return Math.max(1, reference / calibration)
}

/** The ceiling of a budget on a corpus of `notes` notes, on a machine of factor `factor`, in s. */
export function ceilingOf(budget: ToolBudget, notes: number, factor: number): number {
    return (budget.seconds * notes * factor) / REAL_VAULT_NOTES
}

/** The median of the times. */
export function median(times: readonly number[]): number {
    const sorted = [...times].sort((first, second) => first - second)
    const middle = Math.floor(sorted.length / 2)
    const upper = sorted[middle]
    if (upper === undefined) {
        throw new Error('a median needs one time at least')
    }
    const lower = sorted[middle - 1]
    return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2
}

/**
 * How much slower than the machine of the author a measure on the corpus is:
 * the measure over the measure of the author on the real vault, scaled to
 * the corpus. The calibration takes the largest one of a machine.
 */
export function impliedFactor(budget: ToolBudget, notes: number, seconds: number): number {
    return (seconds * REAL_VAULT_NOTES) / (budget.measured * notes)
}
