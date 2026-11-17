import { describe, expect, test } from 'bun:test'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitEnvironment, makeTestStores } from './test-stores.ts'

// Acceptance criterion 3 of issue 17: a test helper makes an empty content
// store and an attachment storage for one test and removes them after it.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * Runs git. The repository is named in the arguments (`--git-dir`, `-C`), never
 * through the current folder: git can refuse a bare repository that it finds
 * by itself (`safe.bareRepository`).
 */
async function git(...args: string[]): Promise<{ exitCode: number; stdout: string }> {
    const child = Bun.spawn(['git', ...args], {
        env: gitEnvironment(),
        stdout: 'pipe',
        stderr: 'ignore'
    })
    const stdout = await new Response(child.stdout).text()
    return { exitCode: await child.exited, stdout: stdout.trim() }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

describe('content store of a test', () => {
    test('is a git repository with no commit', async () => {
        await using stores = await makeTestStores()

        const commits = await git('--git-dir', stores.contentStore, 'rev-list', '--all', '--count')
        expect(commits).toEqual({ exitCode: 0, stdout: '0' })
    })

    test('has the branch main', async () => {
        await using stores = await makeTestStores()

        const head = await git('--git-dir', stores.contentStore, 'symbolic-ref', 'HEAD')
        expect(head).toEqual({ exitCode: 0, stdout: 'refs/heads/main' })
    })

    test('holds no file of the git template of the machine', async () => {
        await using stores = await makeTestStores()

        expect(await exists(join(stores.contentStore, 'hooks'))).toBe(false)
    })

    // The publishing tool works on a copy of the content store and pushes to
    // it, so the store of a test must take a push like the real one.
    test('takes the push of a copy', async () => {
        await using stores = await makeTestStores()
        const copy = join(stores.root, 'copy')

        expect((await git('clone', '--quiet', stores.contentStore, copy)).exitCode).toBe(0)
        await Bun.write(join(copy, 'note.md'), 'An invented note.\n')
        await git('-C', copy, 'add', 'note.md')
        await git(
            '-C',
            copy,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '--message',
            'publish one note'
        )
        expect((await git('-C', copy, 'push', '--quiet', 'origin', 'HEAD:main')).exitCode).toBe(0)

        const pushed = await git('--git-dir', stores.contentStore, 'show', 'main:note.md')
        expect(pushed).toEqual({ exitCode: 0, stdout: 'An invented note.' })
    })
})

describe('attachment storage of a test', () => {
    test('is an empty folder', async () => {
        await using stores = await makeTestStores()

        expect(await readdir(stores.attachmentStorage)).toEqual([])
    })
})

describe('stores of a test', () => {
    test('are removed after the test', async () => {
        let root: string
        {
            await using stores = await makeTestStores()
            root = stores.root
            expect(await exists(root)).toBe(true)
        }

        expect(await exists(root)).toBe(false)
    })

    test('belong to one test: a removal leaves the stores of another test', async () => {
        await using kept = await makeTestStores()
        {
            await using removed = await makeTestStores()
            expect(removed.root).not.toBe(kept.root)
        }

        expect(await readdir(kept.attachmentStorage)).toEqual([])
        expect(
            (await git('--git-dir', kept.contentStore, 'rev-list', '--all', '--count')).stdout
        ).toBe('0')
    })

    // Nothing that a test writes can enter a commit of this repository.
    test('live in a folder that git ignores', async () => {
        await using stores = await makeTestStores()

        const ignored = await git(
            '-C',
            ROOT,
            'check-ignore',
            '--quiet',
            join(stores.root, 'note.md')
        )
        expect(ignored.exitCode).toBe(0)
    })
})
