import { describe, expect, test } from 'bun:test'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTestStores } from './test-stores.ts'

// Acceptance criterion 3 of issue 17: a test helper makes an empty content
// store and an attachment storage for one test and removes them after it.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** The environment without the variables that point git to another repository. */
function cleanEnvironment(): Record<string, string> {
    const entries = Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')
    )
    return Object.fromEntries(entries)
}

async function git(cwd: string, ...args: string[]): Promise<{ exitCode: number; stdout: string }> {
    const child = Bun.spawn(['git', ...args], {
        cwd,
        env: cleanEnvironment(),
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

        const commits = await git(stores.contentStore, 'rev-list', '--all', '--count')
        expect(commits).toEqual({ exitCode: 0, stdout: '0' })
    })

    // The publishing tool works on a copy of the content store and pushes to
    // it, so the store of a test must take a push like the real one.
    test('takes the push of a copy', async () => {
        await using stores = await makeTestStores()
        const copy = join(stores.root, 'copy')

        expect(
            (await git(stores.root, 'clone', '--quiet', stores.contentStore, copy)).exitCode
        ).toBe(0)
        await Bun.write(join(copy, 'note.md'), 'An invented note.\n')
        await git(copy, 'add', 'note.md')
        await git(
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
        expect((await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')).exitCode).toBe(0)

        const pushed = await git(stores.contentStore, 'show', 'main:note.md')
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
        expect((await git(kept.contentStore, 'rev-list', '--all', '--count')).stdout).toBe('0')
    })

    // Nothing that a test writes can enter a commit of this repository.
    test('live in a folder that git ignores', async () => {
        await using stores = await makeTestStores()

        const ignored = await git(ROOT, 'check-ignore', '--quiet', join(stores.root, 'note.md'))
        expect(ignored.exitCode).toBe(0)
    })
})
