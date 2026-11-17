import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Acceptance criterion of issue 16: a commit with a message that breaks
// Conventional Commits is refused by a hook.
//
// The hooks are config-based (Git 2.54 or later): `.gitconfig` at the root
// declares them, and `bun run setup` includes that file in the clone. The test
// uses a git directory of its own with this repository as its work tree, so
// that the real hooks run and no commit reaches the real history.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

let gitDir = ''

async function git(...args: string[]): Promise<number> {
    const child = Bun.spawn(
        [
            'git',
            `--git-dir=${gitDir}`,
            `--work-tree=${ROOT}`,
            '-c',
            `include.path=${ROOT}.gitconfig`,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            '-c',
            'commit.gpgsign=false',
            ...args
        ],
        { cwd: ROOT, stdout: 'ignore', stderr: 'ignore' }
    )
    return await child.exited
}

async function commit(message: string): Promise<number> {
    return await git('commit', '--allow-empty', '--message', message)
}

beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commit-hooks-'))
    gitDir = join(directory, 'repository.git')
    const init = Bun.spawn(['git', 'init', '--bare', '--quiet', gitDir], {
        stdout: 'ignore',
        stderr: 'ignore'
    })
    expect(await init.exited).toBe(0)
})

afterAll(async () => {
    await rm(join(gitDir, '..'), { recursive: true, force: true })
})

describe('commit-msg hook', () => {
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
