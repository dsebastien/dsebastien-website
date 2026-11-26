import type { Case } from './case.ts'
import type { Outcome, StepResult } from './run.ts'

// A random case as a scenario of the shared queue scenarios
// (`fixtures/canonical/queue.json`), so that a case that found a difference
// can join the shared cases. What each step states comes from the run of the
// TypeScript implementation; a refusal states the part of its message that
// the Rust implementation writes too. The scenario states every result of the
// run, so it fails in the implementation that disagrees.

/** The faces of the steps: the face of the command line, as in the random run. */
const FACE = 'command-line'

/** A step of a shared scenario. Its shape is checked by the two runners of the shared file. */
type SharedStep = Record<string, unknown>

/** The message of a refusal, when the other implementation writes it too. */
function says(ours: Outcome | undefined, theirs: Outcome | undefined): Record<string, string> {
    if (ours === undefined || !('refused' in ours)) {
        return {}
    }
    const other = theirs !== undefined && 'refused' in theirs ? theirs.refused : undefined
    return other === undefined || other.includes(ours.refused) ? { says: ours.refused } : {}
}

function valueOf(outcome: Outcome | undefined): Record<string, unknown> {
    return outcome !== undefined && 'value' in outcome
        ? (outcome.value as Record<string, unknown>)
        : {}
}

function refused(outcome: Outcome | undefined): boolean {
    return outcome !== undefined && 'refused' in outcome
}

/**
 * The step `expect` that states every text of the vault and of the content
 * store after the run, `null` for a file that a step before had and that is
 * gone, and every file of the attachment storage. Images of the vault are
 * left out: the step compares texts.
 */
function expectStep(results: readonly StepResult[], until: number): SharedStep {
    const last = results[until]
    if (last === undefined) {
        throw new Error('the case has no step')
    }
    const files = (part: 'vault' | 'store'): Record<string, string | null> => {
        const gone: Record<string, null> = {}
        for (const result of results.slice(0, until + 1)) {
            for (const path of Object.keys(result.files[part])) {
                gone[path] = null
            }
        }
        const text = Object.entries(last.files[part]).filter(([path]) => !path.endsWith('.png'))
        const all: Record<string, string | null> = { ...gone, ...Object.fromEntries(text) }
        return Object.fromEntries(Object.entries(all).filter(([path]) => !path.endsWith('.png')))
    }
    return {
        do: 'expect',
        why: 'every file after the steps',
        vault: files('vault'),
        store: files('store'),
        attachmentStorage: Object.fromEntries(
            Object.entries(last.files.storage).map(([key, bytes]) => [key, { bytes }])
        )
    }
}

/**
 * The case as a shared scenario, up to the step `until` (by default the last
 * one): a failure can be cut at the step where the two runs differ.
 */
export function sharedScenario(
    given: Case,
    typescript: readonly StepResult[],
    rust: readonly StepResult[],
    until = given.steps.length - 1
): Record<string, unknown> {
    const steps: SharedStep[] = []
    for (const [index, step] of given.steps.slice(0, until + 1).entries()) {
        const ours = typescript[index]
        const theirs = rust[index]
        if (ours === undefined) {
            throw new Error(`the run has no result for step ${String(index + 1)}`)
        }
        const { why } = step
        switch (step.do) {
            case 'write':
            case 'delete':
            case 'store':
            case 'guards':
                steps.push(step.do === 'guards' ? { ...step, guards: valueOf(ours.outcome) } : step)
                break
            case 'status':
                steps.push(
                    refused(ours.outcome)
                        ? {
                              do: 'status',
                              why,
                              refused: true,
                              ...says(ours.outcome, theirs?.outcome)
                          }
                        : { do: 'status', why, queue: valueOf(ours.outcome) }
                )
                break
            case 'plan':
            case 'publish': {
                const planned = step.do === 'plan' ? ours.outcome : ours.plan
                const theirPlan = step.do === 'plan' ? theirs?.outcome : theirs?.plan
                if (refused(planned)) {
                    steps.push({
                        do: 'plan',
                        why,
                        selection: step.selection,
                        refused: true,
                        ...says(planned, theirPlan)
                    })
                    break
                }
                if (step.do === 'plan') {
                    // A plan states `offline` only when it is true.
                    const { offline, ...parts } = valueOf(planned)
                    const stated = offline === true ? { ...parts, offline } : parts
                    steps.push({ do: 'plan', why, selection: step.selection, ...stated })
                    break
                }
                const run = {
                    do: 'publish',
                    why,
                    selection: step.selection,
                    time: step.time,
                    face: FACE
                }
                steps.push(
                    refused(ours.outcome)
                        ? { ...run, refused: true, ...says(ours.outcome, theirs?.outcome) }
                        : { ...run, report: valueOf(ours.outcome) }
                )
                break
            }
            case 'unpublish':
            case 'takedown':
            case 'edit': {
                const run = { ...step, face: FACE }
                if (refused(ours.outcome)) {
                    steps.push({ ...run, refused: true, ...says(ours.outcome, theirs?.outcome) })
                } else if (step.do === 'edit') {
                    steps.push({ ...run, event: valueOf(ours.outcome) })
                } else {
                    steps.push({ ...run, report: valueOf(ours.outcome) })
                }
                break
            }
        }
    }
    steps.push(expectStep(typescript, until))
    return {
        name: `random case of the seed ${String(given.seed)}`,
        denyList: given.denyList,
        vault: given.vault,
        steps
    }
}
