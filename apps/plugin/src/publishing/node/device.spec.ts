import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    rejectionOf
} from '@dsebastien-website/testing'
import type { TestStores } from '@dsebastien-website/testing'
import type { Device } from '../ports.ts'
import { lockHolderOf, nodeDevice, processRuns, pullContentStore } from './device.ts'

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

describe('the pull of the copy, after a run that stopped halfway', () => {
    test('refuses to run while the run journal of a stopped publication is there', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await pushFromAnotherDevice(stores, copy)
        await mkdir(join(copy, '.git', 'vault-publish'), { recursive: true })
        await writeFile(join(copy, '.git', 'vault-publish', 'journal.json'), '{"step":"write"}\n')

        expect(await rejectionOf(pullContentStore({ contentStore: copy }))).toContain(
            'a publication stopped halfway on this device'
        )
        expect(await Bun.file(join(copy, 'renames.json')).exists()).toBe(false)
    }, 60_000)

    test('runs after a publication that stopped after its push: the copy is clean then', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await pushFromAnotherDevice(stores, copy)
        await mkdir(join(copy, '.git', 'vault-publish'), { recursive: true })
        await writeFile(join(copy, '.git', 'vault-publish', 'journal.json'), '{"step":"correct"}\n')

        await pullContentStore({ contentStore: copy })

        expect(await Bun.file(join(copy, 'renames.json')).text()).toBe('{}\n')
    }, 60_000)

    test('takes the lock of the device while it runs, and gives it back', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await pushFromAnotherDevice(stores, copy)
        // A git program that refuses to run when the lock of the device is not there.
        const program = join(stores.root, 'git-with-lock')
        await writeFile(
            program,
            `#!/bin/sh\n[ -f "${join(copy, '.git', 'vault-publish', 'lock')}" ] || exit 3\nexec git "$@"\n`
        )
        await chmod(program, 0o755)

        await pullContentStore({ contentStore: copy, git: program })

        expect(await Bun.file(join(copy, 'renames.json')).text()).toBe('{}\n')
        expect(await Bun.file(join(copy, '.git', 'vault-publish', 'lock')).exists()).toBe(false)
    }, 60_000)
})

describe('the run that holds the lock, for the confirmation of its removal (issue 106)', () => {
    test('the lock names its command and its process', () => {
        expect(lockHolderOf('{"command":"publish","process":41,"token":"x"}\n')).toEqual({
            command: 'publish',
            process: 41
        })
        expect(lockHolderOf('{"command":"plan"}\n')).toEqual({ command: 'plan' })
        expect(lockHolderOf('{"process":"41"}')).toEqual({})
        expect(lockHolderOf('not a lock')).toEqual({})
    })

    test('a process that runs, and a process that ended', async () => {
        const child = Bun.spawn(['git', '--version'], { stdout: 'ignore' })
        await child.exited

        expect(processRuns(process.pid)).toBe(true)
        expect(processRuns(child.pid)).toBe(false)
    })
})

/** The number of a process that ran and ended: no process has it now. */
async function endedProcess(): Promise<number> {
    const child = Bun.spawn(['git', '--version'], { stdout: 'ignore' })
    await child.exited
    return child.pid
}

// R46 as the author amended it on 2026-11-26 (R79): a lock of a check or a
// pull whose process no longer runs on this computer goes away by itself.
describe('the lock of a check or a pull whose process ended (R79)', () => {
    const SYSTEM =
        { win32: 'windows', darwin: 'macos' }[process.platform as string] ?? process.platform
    const here = `"host":${JSON.stringify(hostname())},"system":${JSON.stringify(SYSTEM)}`

    async function setUpLock(stores: TestStores): Promise<{ copy: string; device: Device }> {
        const copy = await makeContentStoreCopy(stores)
        await mkdir(join(copy, '.git', 'vault-publish'), { recursive: true })
        const device = nodeDevice({
            vault: await copyFixtureVault(stores),
            contentStore: copy,
            attachmentStorage: stores.attachmentStorage
        })
        return { copy, device }
    }
    const lockOf = (copy: string): string => join(copy, '.git', 'vault-publish', 'lock')

    test('a lock names the computer and the system of its run', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUpLock(stores)

        const lock = await device.local.lock({ command: 'plan' })

        expect(lockHolderOf(lock.text)).toEqual({
            command: 'plan',
            process: process.pid,
            host: hostname(),
            system: SYSTEM
        })
        await device.local.release(lock.text)
    }, 60_000)

    test('goes away by itself, also for a pull', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUpLock(stores)
        for (const command of ['check', 'pull']) {
            await writeFile(
                lockOf(copy),
                `{"command":"${command}",${here},"process":${String(await endedProcess())},"token":"x"}\n`
            )

            const lock = await device.local.lock({ command: 'plan' })

            expect(lock.taken, command).toBe(true)
            await device.local.release(lock.text)
        }
    }, 60_000)

    test('stays while its process runs, on another computer or system, with no computer, and for a publication', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUpLock(stores)
        const ended = String(await endedProcess())
        for (const text of [
            `{"command":"check",${here},"process":${String(process.pid)},"token":"x"}\n`,
            `{"command":"check","host":"another-computer","system":${JSON.stringify(SYSTEM)},"process":${ended},"token":"x"}\n`,
            `{"command":"check","host":${JSON.stringify(hostname())},"system":"another-system","process":${ended},"token":"x"}\n`,
            `{"command":"check","process":${ended},"token":"x"}\n`,
            `{"command":"publish","device":"d","face":"plugin",${here},"process":${ended},"time":"2031-04-01T08:00:00Z","token":"x"}\n`
        ]) {
            await writeFile(lockOf(copy), text)

            expect((await device.local.lock({ command: 'plan' })).taken, text).toBe(false)
            expect(await Bun.file(lockOf(copy)).text()).toBe(text)
        }
    }, 60_000)
})
