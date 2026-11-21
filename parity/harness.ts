import { fileURLToPath } from 'node:url'
import { FIXTURE_NOTE_TYPES } from '@dsebastien-website/testing'

// The parity harness: it builds the Rust command line program and runs it, so
// that a test can compare its output with the output of the TypeScript
// implementation, byte by byte.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE = 'dsebastien-vault-publish'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The path of the program in one line of the build messages of cargo, when the line has it. */
function executableOf(line: string): string | undefined {
    if (!line.startsWith('{')) {
        return undefined
    }
    const message: unknown = JSON.parse(line)
    if (!isRecord(message) || message['reason'] !== 'compiler-artifact') {
        return undefined
    }
    const target = message['target']
    const executable = message['executable']
    const isProgram = isRecord(target) && target['name'] === PACKAGE
    return isProgram && typeof executable === 'string' ? executable : undefined
}

/**
 * Builds the Rust program with cargo and returns its path. Cargo says where
 * the program is, so the folder of the build output is not guessed.
 */
export async function buildRustProgram(): Promise<string> {
    const child = Bun.spawn(
        // The compiler writes its errors as readable text to the error output,
        // and the list of what it built as JSON to the standard output.
        [
            'cargo',
            'build',
            '--locked',
            '--package',
            PACKAGE,
            '--message-format=json-render-diagnostics'
        ],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }
    )
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
    ])
    if ((await child.exited) !== 0) {
        throw new Error(`cargo could not build the Rust program:\n${stderr}`)
    }
    const program = stdout
        .split('\n')
        .map(executableOf)
        .find((path) => path !== undefined)
    if (program === undefined) {
        throw new Error('cargo did not say where the Rust program is')
    }
    return program
}

/** What a run of the Rust program gave. The output is bytes: the parity rule compares bytes. */
export interface RustRun {
    exitCode: number
    stdout: Uint8Array
    stderr: string
}

/**
 * Runs the Rust program with the arguments. `environment` adds variables, for
 * example the crash switch of its debug build.
 */
export async function runRustProgram(
    program: string,
    args: readonly string[],
    environment: Record<string, string> = {}
): Promise<RustRun> {
    const child = Bun.spawn([program, ...args], {
        cwd: ROOT,
        // The Starter Kit of the tests: the answers for the fixture vault, as
        // the TypeScript side of a parity test reads them (decision R61).
        env: {
            ...process.env,
            DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES: FIXTURE_NOTE_TYPES,
            ...environment
        },
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text()
    ])
    return { exitCode: await child.exited, stdout, stderr }
}
