import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Acceptance criteria of issue 16: a CI workflow runs the type check, the lint,
// the tests and the format check on each push, and fails when one fails. The
// Astro check is part of the checks.
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readWorkflow(): Promise<Record<string, unknown>> {
    const workflow: unknown = Bun.YAML.parse(await Bun.file(WORKFLOW).text())
    if (!isRecord(workflow)) {
        throw new Error('ci.yml is not a mapping')
    }
    return workflow
}

function readJobs(workflow: Record<string, unknown>): Record<string, unknown>[] {
    const jobs = workflow['jobs']
    if (!isRecord(jobs)) {
        throw new Error('ci.yml has no jobs')
    }
    return Object.values(jobs).filter(isRecord)
}

function readSteps(job: Record<string, unknown>): Record<string, unknown>[] {
    const steps = job['steps']
    return Array.isArray(steps) ? steps.filter(isRecord) : []
}

async function readCommands(): Promise<string[]> {
    const jobs = readJobs(await readWorkflow())
    return jobs
        .flatMap(readSteps)
        .map((step) => step['run'])
        .filter((run) => typeof run === 'string')
        .map((run) => run.trim())
}

describe('CI workflow', () => {
    test('runs on each push, on every branch', async () => {
        const workflow = await readWorkflow()
        const triggers = workflow['on']
        if (!isRecord(triggers)) {
            throw new Error('ci.yml has no triggers')
        }
        expect(Object.keys(triggers)).toContain('push')
        // No filter: a push to any branch starts the checks.
        expect(triggers['push']).toBeNull()
    })

    test.each([
        ['the type check', 'bun run tsc'],
        ['the lint', 'bun run lint'],
        ['the tests', 'bun run test'],
        ['the format check', 'bun run format:check'],
        ['the Astro check', 'bun run check'],
        ['the build of the site', 'bun run build'],
        ['the format check of the Rust code', 'bun run rust:format:check'],
        ['the lint of the Rust code', 'bun run rust:lint'],
        ['the tests of the Rust code', 'bun run rust:test']
    ])('runs %s as a step of its own', async (_name, command) => {
        expect(await readCommands()).toContain(command)
    })

    test('runs the Rust checks on Linux and on Windows', async () => {
        const jobs = readJobs(await readWorkflow())
        const rust = jobs.find((job) =>
            readSteps(job).some((step) => step['run'] === 'bun run rust:test')
        )
        const strategy = rust?.['strategy']
        const matrix = isRecord(strategy) ? strategy['matrix'] : undefined
        const systems = isRecord(matrix) ? matrix['os'] : undefined
        expect(systems).toEqual(['ubuntu-latest', 'windows-latest'])
        // The job must run on the system of the matrix, not on a fixed one.
        expect(rust?.['runs-on']).toBe('${{ matrix.os }}')
    })

    // The parity test is one of the tests: it builds the Rust program and
    // compares its output with the TypeScript implementation (issue 29).
    test('gives the Rust toolchain to the job that runs the tests', async () => {
        const jobs = readJobs(await readWorkflow())
        const tests = jobs.find((job) =>
            readSteps(job).some((step) => step['run'] === 'bun run test')
        )
        const steps = tests === undefined ? [] : readSteps(tests)
        const toolchain = steps.findIndex(
            (step) =>
                typeof step['uses'] === 'string' &&
                step['uses'].startsWith('dtolnay/rust-toolchain@')
        )
        expect(toolchain).toBeGreaterThanOrEqual(0)
        expect(toolchain).toBeLessThan(steps.findIndex((step) => step['run'] === 'bun run test'))
    })

    // The browser tests (issue 57) drive the installed Chrome: the job of the
    // tests runs on the full Ubuntu image, and names the version of Chrome first.
    test('runs the tests on a system with Chrome, and shows its version first', async () => {
        const jobs = readJobs(await readWorkflow())
        const tests = jobs.find((job) =>
            readSteps(job).some((step) => step['run'] === 'bun run test')
        )
        expect(tests?.['runs-on']).toBe('ubuntu-latest')
        const steps = tests === undefined ? [] : readSteps(tests)
        const chrome = steps.findIndex((step) => step['run'] === 'google-chrome --version')
        expect(chrome).toBeGreaterThanOrEqual(0)
        expect(chrome).toBeLessThan(steps.findIndex((step) => step['run'] === 'bun run test'))
    })

    // The time budgets of the note page (issue 47, R57): Lighthouse needs
    // Chrome, which the full Ubuntu image of GitHub has.
    test('runs the time budgets of the note page in a job of its own, on a system with Chrome', async () => {
        const jobs = readJobs(await readWorkflow())
        const budgets = jobs.filter((job) =>
            readSteps(job).some((step) => step['run'] === 'bun run budgets')
        )
        expect(budgets).toHaveLength(1)
        expect(budgets[0]?.['runs-on']).toBe('ubuntu-latest')
        expect(readSteps(budgets[0] ?? {}).some((step) => step['run'] === 'bun run test')).toBe(
            false
        )
    })

    // The budget of the first search (issue 51, R57): the invented corpus of
    // full size is written first, in the job of the budgets.
    test('runs the budget of the first search on the invented corpus, in the job of the budgets', async () => {
        const jobs = readJobs(await readWorkflow())
        const budgets = jobs.find((job) =>
            readSteps(job).some((step) => step['run'] === 'bun run budgets')
        )
        const steps = readSteps(budgets ?? {})
        const runs = steps.map((step) => step['run'])
        const corpus = runs.indexOf('bun run corpus')
        const search = runs.indexOf('bun run budgets:search')
        expect(corpus).toBeGreaterThanOrEqual(0)
        expect(search).toBeGreaterThan(corpus)
        // It runs also when a time budget of the note page failed.
        expect(steps[corpus]?.['if']).toBe('${{ !cancelled() }}')
        expect(steps[search]?.['if']).toBe('${{ !cancelled() }}')
    })

    // The budgets of the publishing tool (issue 59, R97, PERF-15): on the
    // same corpus, with the Rust toolchain for the release build, in the job
    // of the budgets and not in the job of the tests.
    test('runs the tool budgets on the corpus, in the job of the budgets', async () => {
        const jobs = readJobs(await readWorkflow())
        const tool = jobs.filter((job) =>
            readSteps(job).some((step) => step['run'] === 'bun run budgets:tool')
        )
        expect(tool).toHaveLength(1)
        const steps = readSteps(tool[0] ?? {})
        const runs = steps.map((step) => step['run'])
        expect(runs).toContain('bun run budgets')
        expect(runs).not.toContain('bun run test')
        const budget = runs.indexOf('bun run budgets:tool')
        expect(budget).toBeGreaterThan(runs.indexOf('bun run corpus'))
        // On main and on manual runs only.
        const onMain =
            "${{ !cancelled() && (github.ref == 'refs/heads/main' || " +
            "github.event_name == 'workflow_dispatch') }}"
        expect(steps[budget]?.['if']).toBe(onMain)
        const rust = steps.findIndex((step) => step['name'] === 'Setup Rust')
        expect(rust).toBeGreaterThanOrEqual(0)
        expect(rust).toBeLessThan(budget)
        expect(steps[rust]?.['if']).toBe(onMain)
    })

    test('lets no job and no step fail without failing the run', async () => {
        const jobs = readJobs(await readWorkflow())
        const tolerant = [...jobs, ...jobs.flatMap(readSteps)].filter(
            (entry) => 'continue-on-error' in entry
        )
        expect(tolerant).toEqual([])
    })
})
