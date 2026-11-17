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

    test('lets no job and no step fail without failing the run', async () => {
        const jobs = readJobs(await readWorkflow())
        const tolerant = [...jobs, ...jobs.flatMap(readSteps)].filter(
            (entry) => 'continue-on-error' in entry
        )
        expect(tolerant).toEqual([])
    })
})
