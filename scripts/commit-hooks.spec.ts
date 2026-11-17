import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Acceptance criterion of issue 16: a commit with a message that breaks
// Conventional Commits is refused by a hook.
//
// The hooks are config-based (Git 2.54 or later): `.gitconfig` at the root
// declares them, and `bun run setup` includes that file in the clone.
//
// The test makes a repository of its own inside the ignored `.cache` folder of
// the clone, copies the hook files into it and runs the real setup script
// there. So the real hooks run on real commits, and the history, the index and
// the work tree of the clone are never touched. The repository is inside the
// clone because the hooks call `bunx`, which finds the tools of the clone from
// there.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOOK_FILES = ['.gitconfig', 'scripts/git-hooks/format-staged.sh']

let repository: string | undefined

interface Result {
    exitCode: number
    stdout: string
}

function repositoryPath(): string {
    if (repository === undefined) {
        throw new Error('the test repository does not exist')
    }
    return repository
}

/** The environment without the variables that point git to another repository. */
function cleanEnvironment(): Record<string, string> {
    const entries = Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')
    )
    return Object.fromEntries(entries)
}

async function run(command: string[]): Promise<Result> {
    const child = Bun.spawn(command, {
        cwd: repositoryPath(),
        env: cleanEnvironment(),
        stdout: 'pipe',
        stderr: 'ignore'
    })
    const stdout = await new Response(child.stdout).text()
    return { exitCode: await child.exited, stdout }
}

async function git(...args: string[]): Promise<Result> {
    return await run(['git', ...args])
}

async function writeFile(name: string, text: string): Promise<void> {
    await Bun.write(join(repositoryPath(), name), text)
}

async function readSetupScript(): Promise<string> {
    const manifest: unknown = await Bun.file(`${ROOT}package.json`).json()
    const scripts =
        typeof manifest === 'object' && manifest !== null && 'scripts' in manifest
            ? manifest.scripts
            : undefined
    const setup =
        typeof scripts === 'object' && scripts !== null && 'setup' in scripts
            ? scripts.setup
            : undefined
    if (typeof setup !== 'string') {
        throw new Error('package.json has no setup script')
    }
    return setup
}

beforeAll(async () => {
    const cache = join(ROOT, '.cache')
    await mkdir(cache, { recursive: true })
    repository = await mkdtemp(join(cache, 'commit-hooks-'))

    expect((await git('init', '--quiet')).exitCode).toBe(0)
    await git('config', '--local', 'user.name', 'Test')
    await git('config', '--local', 'user.email', 'test@example.invalid')
    await git('config', '--local', 'commit.gpgsign', 'false')

    for (const file of HOOK_FILES) {
        await cp(join(ROOT, file), join(repository, file))
    }
    // The setup script of the clone activates the hooks, as a contributor does.
    expect((await run(['sh', '-c', await readSetupScript()])).exitCode).toBe(0)
}, 60_000)

afterAll(async () => {
    // Remove only a folder that this test made. Without the check, a failed
    // setup leaves no path here, and the removal would work on another folder.
    if (repository !== undefined) {
        await rm(repository, { recursive: true, force: true })
    }
})

describe('commit-msg hook', () => {
    async function commit(message: string): Promise<number> {
        return (await git('commit', '--allow-empty', '--message', message)).exitCode
    }

    test('accepts a Conventional Commits message', async () => {
        expect(await commit('docs(all): describe the tooling')).toBe(0)
    }, 60_000)

    test('refuses a message without a type', async () => {
        expect(await commit('describe the tooling')).not.toBe(0)
    }, 60_000)

    test('refuses a type that Conventional Commits does not know', async () => {
        expect(await commit('stuff(all): describe the tooling')).not.toBe(0)
    }, 60_000)

    test('refuses a scope that this repository does not know', async () => {
        expect(await commit('docs(unknown-scope): describe the tooling')).not.toBe(0)
    }, 60_000)
})

describe('pre-commit hook', () => {
    test('formats a staged file', async () => {
        await writeFile('whole.ts', 'export const one = {a:1}\n')
        await git('add', 'whole.ts')

        expect((await git('commit', '--message', 'feat(all): add a file')).exitCode).toBe(0)
        expect((await git('show', 'HEAD:whole.ts')).stdout).toBe('export const one = { a: 1 }\n')
    }, 60_000)

    test('keeps a change that is not staged out of the commit', async () => {
        await writeFile('partial.ts', 'export const one = {a:1}\n')
        await git('add', 'partial.ts')
        // The same file gets a second change, which is not staged.
        await writeFile('partial.ts', 'export const one = {a:1}\nexport const two = 2\n')

        expect((await git('commit', '--message', 'feat(all): add a part')).exitCode).toBe(0)
        // The commit holds the staged part only, formatted.
        expect((await git('show', 'HEAD:partial.ts')).stdout).toBe('export const one = { a: 1 }\n')
        // The other change is still in the work tree, and still not staged.
        const workTree = await Bun.file(join(repositoryPath(), 'partial.ts')).text()
        expect(workTree).toContain('export const two = 2')
        expect((await git('diff', '--cached', '--quiet')).exitCode).toBe(0)
        expect((await git('diff', '--quiet')).exitCode).not.toBe(0)
    }, 60_000)

    test('commits a staged file that Prettier does not know', async () => {
        await writeFile('data.unknown', 'a   b\n')
        await git('add', 'data.unknown')

        expect((await git('commit', '--message', 'feat(all): add data')).exitCode).toBe(0)
        expect((await git('show', 'HEAD:data.unknown')).stdout).toBe('a   b\n')
    }, 60_000)
})
