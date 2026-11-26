import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { availableParallelism } from 'node:os'
import { caseOf } from './random/case.ts'
import { makeRunner, runSeeds, type CaseRun, type Runner } from './random/run.ts'
import { sharedScenario } from './random/shared.ts'
import { buildRustProgram } from './harness.ts'

// The short run of the random parity test (issue 112): the cases of fixed
// seeds, each on the TypeScript and on the Rust implementation, compared step
// by step (the queue, the plan, the lists of a report, an event, a refusal,
// and every file left in the vault, the content store, the attachment storage
// and the stored plans). A failure names its seed: `bun run parity:random
// --seed <seed> --count 1` runs it again, and `--print` gives it as a shared
// queue scenario. A failure here blocks a release.

/** The seeds of the short run. */
const SEEDS = Array.from({ length: 200 }, (_, index) => index + 1)

/** The cases that run at the same time. Each one runs its own git processes. */
const PARALLEL = Math.min(16, Math.max(4, availableParallelism()))

let runner: Runner
let runs: CaseRun[] = []

beforeAll(async () => {
    runner = await makeRunner(await buildRustProgram())
    runs = await runSeeds(runner, SEEDS, PARALLEL)
}, 600_000)

afterAll(async () => {
    await runner[Symbol.asyncDispose]()
})

/** The texts of the results of the TypeScript runs, one per step, to count what the cases did. */
function results(): string[] {
    return runs.flatMap((run) =>
        run.typescript.map((result) => JSON.stringify([result.plan, result.outcome]))
    )
}

describe('the short run of the random parity test', () => {
    test('both implementations give the same result at each step of each case', () => {
        const failures = runs
            .filter((run) => run.difference !== undefined)
            .map((run) => {
                const step = run.difference?.step ?? 0
                const why = run.given.steps[step]?.why ?? ''
                return `seed ${String(run.given.seed)}, step ${String(step + 1)} (${why}): ${run.difference?.part ?? ''}`
            })
        expect(failures).toEqual([])
        expect(runs.length).toBe(SEEDS.length)
    })

    // The comparison must have something to compare: the cases reach the
    // guards, the renames, the takedowns and the moves, where the reviews of
    // issues 40 and 42 found their blockers.
    test('the cases reach the guards, the renames, the takedowns and the refusals', () => {
        const texts = results()
        const count = (pattern: RegExp) => texts.filter((text) => pattern.test(text)).length
        expect(count(/"forcedRemove":\["/u)).toBeGreaterThan(0)
        expect(count(/"move":\[\{/u)).toBeGreaterThan(0)
        expect(count(/"renamed":\[\{/u)).toBeGreaterThan(0)
        expect(count(/"takenDown":\["/u)).toBeGreaterThan(0)
        expect(count(/"removed":\["/u)).toBeGreaterThan(0)
        expect(count(/"attachmentsUploaded":\["/u)).toBeGreaterThan(0)
        expect(count(/has the publish_ignore property/u)).toBeGreaterThan(0)
        expect(count(/is in a folder of the deny list/u)).toBeGreaterThan(0)
        // Most steps succeed: a case of refusals only compares little.
        const refused = count(/"refused":/u)
        expect(refused).toBeLessThan(texts.length / 4)
    })
})

describe('the cases of the random parity test', () => {
    test('the same seed gives the same case again, and another seed another case', () => {
        expect(caseOf(41)).toEqual(caseOf(41))
        expect(caseOf(41)).not.toEqual(caseOf(42))
    })

    test('a case prints as a shared queue scenario that states each step', () => {
        const run = runs.find((each) => each.given.steps.some((step) => step.do === 'unpublish'))
        if (run === undefined) {
            throw new Error('no case of the short run has an unpublish')
        }
        const scenario = sharedScenario(run.given, run.typescript, run.rust)
        const steps = scenario['steps'] as Record<string, unknown>[]
        expect(scenario['name']).toBe(`random case of the seed ${String(run.given.seed)}`)
        expect(scenario['vault']).toEqual(run.given.vault)
        expect(steps.at(-1)?.['do']).toBe('expect')
        for (const step of steps) {
            if (
                ['status', 'publish', 'unpublish', 'takedown', 'edit'].includes(String(step['do']))
            ) {
                // Each run states what it gave: a refusal, or its result.
                const states = ['refused', 'queue', 'report', 'event'].filter((key) => key in step)
                expect(states.length).toBe(1)
            }
        }
        // The shared file is JSON: the scenario goes there as it is.
        expect(JSON.parse(JSON.stringify(scenario))).toEqual(scenario)
    })
})
