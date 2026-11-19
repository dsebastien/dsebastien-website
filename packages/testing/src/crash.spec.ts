import { describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crashingStore } from './crash.ts'
import { makeContentStoreCopy } from './publication-setup.ts'
import { gitEnvironment, makeTestStores } from './test-stores.ts'

/** The part of a copy of the content store that the helper wraps. */
interface Copy {
    commitAndPush(message: string, paths: readonly string[]): Promise<void>
}

async function git(cwd: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { cwd, env: gitEnvironment(), stdout: 'pipe' })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return output.trim()
}

describe('a copy of the content store whose run stops halfway', () => {
    test('at commit, commits the files of the run, pushes nothing and never returns', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const before = await git(copy, 'rev-parse', 'HEAD')
        await writeFile(join(copy, 'note.md'), 'A note\n')
        let pushed = 0
        const real: Copy = {
            commitAndPush: async () => {
                pushed += 1
                await Promise.resolve()
            }
        }
        const stopped = crashingStore(real, copy, 'commit')

        let returned = false
        void stopped.store.commitAndPush('Publish', ['note.md']).then(() => {
            returned = true
        })
        await stopped.reached

        expect(await git(copy, 'rev-parse', 'HEAD^')).toBe(before)
        expect(await git(copy, 'show', '--format=%s', '--no-patch', 'HEAD')).toBe('Publish')
        expect(pushed).toBe(0)
        expect(returned).toBe(false)
    })

    test('at write, commits nothing; at push, commits and pushes through the real copy', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const before = await git(copy, 'rev-parse', 'HEAD')
        const calls: string[] = []
        const real: Copy = {
            commitAndPush: async (message) => {
                calls.push(message)
                await Promise.resolve()
            }
        }

        const atWrite = crashingStore(real, copy, 'write')
        void atWrite.store.commitAndPush('First', [])
        await atWrite.reached
        const atPush = crashingStore(real, copy, 'push')
        void atPush.store.commitAndPush('Second', [])
        await atPush.reached

        expect(await git(copy, 'rev-parse', 'HEAD')).toBe(before)
        expect(calls).toEqual(['Second'])
    })
})
