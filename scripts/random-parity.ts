import { availableParallelism } from 'node:os'
import { parseArgs } from 'node:util'
import { buildRustProgram } from '../parity/harness.ts'
import { caseOf } from '../parity/random/case.ts'
import { makeRunner, runSeeds, type CaseRun } from '../parity/random/run.ts'
import { sharedScenario } from '../parity/random/shared.ts'

// The long run of the random parity test (issue 112), on request. It runs the
// cases of the seeds `seed` to `seed + count - 1` on both implementations and
// prints the seed of each case where they differ. The same seed gives the
// same case again, with the same version of the generator
// (`parity/random/case.ts`).
//
//   bun run parity:random                          1,000 cases from a seed of the clock
//   bun run parity:random --seed 5000 --count 300
//   bun run parity:random --seed 5017 --print      the case as a shared queue scenario
//
// `--print` runs one case and writes it as a scenario of
// `fixtures/canonical/queue.json`, cut after the first step where the two
// implementations differ. The short run is in `parity/random.spec.ts`.

/** The largest seed: the generator keeps 32 bits of it. */
const LARGEST_SEED = 2 ** 32 - 1

function wholeNumber(text: string, name: string, smallest: number, largest: number): number {
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(value) || value < smallest || value > largest) {
        throw new Error(
            `--${name} must be a whole number from ${String(smallest)} to ${String(largest)}, and "${text}" is not`
        )
    }
    return value
}

function write(line: string): void {
    process.stdout.write(`${line}\n`)
}

/** One line for a case where the two implementations differ. */
function failureLine(run: CaseRun): string {
    const step = run.difference?.step ?? 0
    const why = run.given.steps[step]?.why ?? ''
    return `seed ${String(run.given.seed)}: step ${String(step + 1)} (${why}), ${run.difference?.part ?? ''} differ`
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            seed: { type: 'string' },
            count: { type: 'string', default: '1000' },
            parallel: { type: 'string', default: String(Math.min(16, availableParallelism())) },
            print: { type: 'boolean', default: false },
            verbose: { type: 'boolean', default: false }
        },
        strict: true
    })
    // A run with no seed takes one from the clock, and says which.
    const seed = wholeNumber(
        values.seed ?? String(Date.now() % LARGEST_SEED),
        'seed',
        0,
        LARGEST_SEED
    )
    const count = values.print ? 1 : wholeNumber(values.count, 'count', 1, 10_000_000)
    const parallel = wholeNumber(values.parallel, 'parallel', 1, 64)
    if (seed + count - 1 > LARGEST_SEED) {
        throw new Error(`--seed plus --count passes the largest seed, ${String(LARGEST_SEED)}`)
    }

    const program = await buildRustProgram()
    await using runner = await makeRunner(program)
    const seeds = Array.from({ length: count }, (_, index) => seed + index)

    if (values.print) {
        const [run] = await runSeeds(runner, seeds, 1)
        if (run === undefined) {
            throw new Error('the case did not run')
        }
        const until = run.difference?.step ?? caseOf(seed).steps.length - 1
        write(JSON.stringify(sharedScenario(run.given, run.typescript, run.rust, until), null, 4))
        if (run.difference !== undefined) {
            process.stderr.write(`${failureLine(run)}\n`)
            process.stderr.write(`TypeScript:\n${run.difference.typescript}\n`)
            process.stderr.write(`Rust:\n${run.difference.rust}\n`)
        }
        return
    }

    write(`random parity: seeds ${String(seed)} to ${String(seed + count - 1)}`)
    const started = performance.now()
    let done = 0
    const failures: CaseRun[] = []
    await runSeeds(runner, seeds, parallel, (run) => {
        done += 1
        if (run.difference !== undefined) {
            failures.push(run)
            write(failureLine(run))
            if (values.verbose) {
                write(`TypeScript:\n${run.difference.typescript}\nRust:\n${run.difference.rust}`)
            }
        }
        if (done % 100 === 0) {
            write(`${String(done)} cases, ${String(failures.length)} differ`)
        }
    })
    const seconds = Math.round((performance.now() - started) / 1000)
    write(
        `${String(count)} cases in ${String(seconds)} s, ${String(failures.length)} differ` +
            (failures.length > 0
                ? `: seeds ${failures.map((run) => String(run.given.seed)).join(', ')}`
                : '')
    )
    if (failures.length > 0) {
        process.exitCode = 1
    }
}

await main()
