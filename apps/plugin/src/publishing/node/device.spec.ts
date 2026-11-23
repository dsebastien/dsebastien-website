import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    rejectionOf
} from '@dsebastien-website/testing'
import { nodeDevice, pullContentStore } from './device.ts'

// The pull of the copy of the content store (decision R67): the view of the
// plugin offers it when another device published first. It runs exactly
// `git pull --ff-only origin main` in the copy, on a click of the author.

async function git(...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { env: gitEnvironment(), stdout: 'pipe' })
    const out = await new Response(child.stdout).text()
    if ((await child.exited) !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
    }
    return out.trim()
}

/** Another device pushes a commit to the content store. */
async function pushFromAnotherDevice(
    stores: { contentStore: string },
    copy: string
): Promise<void> {
    const other = `${copy}-other`
    await git('clone', '--quiet', stores.contentStore, other)
    await git('-C', other, 'config', 'user.name', 'Another device')
    await git('-C', other, 'config', 'user.email', 'another@example.invalid')
    await writeFile(join(other, 'renames.json'), '{}\n')
    await git('-C', other, 'add', 'renames.json')
    await git('-C', other, 'commit', '--quiet', '--message', 'Publish from another device')
    await git('-C', other, 'push', '--quiet', 'origin', 'HEAD:main')
}

describe('the pull of the copy', () => {
    test('brings the commits of another device, so the copy is no longer behind', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const device = nodeDevice({
            vault: await copyFixtureVault(stores),
            contentStore: copy,
            attachmentStorage: stores.attachmentStorage
        })
        await pushFromAnotherDevice(stores, copy)
        expect((await device.store.verify('must')).behind).toBe(1)

        await pullContentStore({ contentStore: copy })

        expect((await device.store.verify('must')).behind).toBe(0)
        expect(await Bun.file(join(copy, 'renames.json')).text()).toBe('{}\n')
    }, 60_000)

    test('refuses to run while a run of the tool holds the lock of the device', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await pushFromAnotherDevice(stores, copy)
        await mkdir(join(copy, '.git', 'vault-publish'), { recursive: true })
        await writeFile(join(copy, '.git', 'vault-publish', 'lock'), '{}\n')

        expect(await rejectionOf(pullContentStore({ contentStore: copy }))).toContain(
            'a run of the tool holds the lock'
        )
        expect(await Bun.file(join(copy, 'renames.json')).exists()).toBe(false)
    }, 60_000)

    test('uses the git program of the device settings', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)

        expect(
            await rejectionOf(pullContentStore({ contentStore: copy, git: join(copy, 'no-git') }))
        ).toContain('no-git')
    }, 60_000)
})
