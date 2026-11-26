import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rejectionOf } from '@dsebastien-website/testing'
import {
    inheritedLockWarning,
    lockHeldBy,
    lockWarningFor,
    STALE_AFTER_MS,
    takeDeployLock
} from './deploy-lock.ts'

// One deployment at a time per target on a machine (issue 32): the plugin
// and the command line program can both start one in the clone of the
// deploys. The lock is a file of that clone.

const CACHE = fileURLToPath(new URL('../../../.cache', import.meta.url))
const NOW = new Date('2031-04-01T08:00:00Z')

let folders: string[] = []

afterEach(async () => {
    // Remove only the folders that this test made.
    for (const folder of folders) {
        await rm(folder, { recursive: true, force: true })
    }
    folders = []
})

async function lockFile(): Promise<string> {
    await mkdir(CACHE, { recursive: true })
    const folder = await mkdtemp(join(CACHE, 'deploy-lock-spec-'))
    folders.push(folder)
    return join(folder, 'notes-preview', 'lock')
}

describe('the lock of the deployments of a target', () => {
    test('holds the process and the start of the run, and goes at the end', async () => {
        const file = await lockFile()
        const lock = await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        expect(lock.warning).toBeUndefined()
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
            pid: 41,
            startedAt: '2031-04-01T08:00:00Z'
        })
        await lock.release()
        expect(await readFile(file, 'utf8').catch(() => 'gone')).toBe('gone')
    })

    test('refuses a second run while the first one runs', async () => {
        const file = await lockFile()
        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        const message = await rejectionOf(
            takeDeployLock(file, { pid: 42, now: () => NOW, isAlive: (pid) => pid === 41 })
        )
        expect(message).toContain('41')
        expect(message).toContain('another deployment')
    })

    test('takes over the lock of a run that stopped, with a warning', async () => {
        const file = await lockFile()
        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        const lock = await takeDeployLock(file, {
            pid: 42,
            now: () => NOW,
            isAlive: (pid) => pid === 42
        })
        expect(lock.warning).toContain('41')
        expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: 42 })
    })

    test('takes over a lock file that cannot be read, with a warning', async () => {
        const file = await lockFile()
        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        await writeFile(file, 'half a')
        const lock = await takeDeployLock(file, { pid: 42, now: () => NOW, isAlive: () => true })
        expect(lock.warning).toContain('cannot be read')
    })

    test('lets go of a lock that another run took over', async () => {
        const file = await lockFile()
        const first = await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        await writeFile(file, JSON.stringify({ pid: 42, startedAt: '2031-04-01T08:01:00Z' }))
        await first.release()
        expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: 42 })
    })

    // The restart of `--from-main` runs under the lock of its parent.
    test('says whether a process holds the lock', async () => {
        const file = await lockFile()
        expect(await lockHeldBy(file, 41)).toBe(false)
        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        expect(await lockHeldBy(file, 41)).toBe(true)
        expect(await lockHeldBy(file, 42)).toBe(false)
    })

    // A process number is used again after a reboot: a lock older than the
    // most time limit of a deployment, with a margin, is the lock of a run
    // that stopped.
    test('takes over a lock older than the most time limit of a deployment, also when its process runs', async () => {
        const file = await lockFile()
        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        const later = new Date(NOW.getTime() + STALE_AFTER_MS + 1000)

        const lock = await takeDeployLock(file, { pid: 42, now: () => later, isAlive: () => true })

        expect(lock.warning).toContain('41')
        expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: 42 })
    })

    test('keeps a lock younger than that while its process runs', async () => {
        const file = await lockFile()
        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        const later = new Date(NOW.getTime() + STALE_AFTER_MS - 1000)

        const message = await rejectionOf(
            takeDeployLock(file, { pid: 42, now: () => later, isAlive: () => true })
        )

        expect(message).toContain('another deployment')
    })

    test('lets one run only take over a stale lock when two try at once', async () => {
        const file = await lockFile()
        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        const alive = (pid: number): boolean => pid !== 41

        const results = await Promise.allSettled(
            [42, 43, 44, 45].map((pid) =>
                takeDeployLock(file, { pid, now: () => NOW, isAlive: alive })
            )
        )

        const won = results.filter((one) => one.status === 'fulfilled')
        expect(won).toHaveLength(1)
        const holder = JSON.parse(await readFile(file, 'utf8')) as { pid: number }
        expect([42, 43, 44, 45]).toContain(holder.pid)
        // No temporary file and no stale lock stay beside the lock.
        expect(await readdir(dirname(file))).toEqual(['lock'])
    })

    // Three runs at once (issue 126): a run that gives way must never drop
    // the lock of the run that won. Random pauses before each step on the
    // files try many orders of the three runs.
    test('lets one run only hold the lock when three take over a stale lock at once, in any order', async () => {
        let seed = 126
        const random = (): number => {
            // A small generator with a seed: the same pauses at each run.
            seed = (seed * 16_807) % 2_147_483_647
            return seed / 2_147_483_647
        }
        const pause = (): Promise<void> =>
            new Promise((resolve) => {
                setTimeout(resolve, Math.floor(random() ** 3 * 10))
            })
        const alive = (pid: number): boolean => pid !== 41
        for (let round = 0; round < 100; round += 1) {
            const file = await lockFile()
            await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })

            const results = await Promise.allSettled(
                [42, 43, 44].map((pid) =>
                    takeDeployLock(file, { pid, now: () => NOW, isAlive: alive, pause })
                )
            )

            const won = results.flatMap((one, index) =>
                one.status === 'fulfilled' ? [[42, 43, 44][index]] : []
            )
            // One run won, and the lock is its lock.
            const holder = JSON.parse(await readFile(file, 'utf8')) as { pid: number }
            expect({ round, won }).toEqual({ round, won: [holder.pid] })
            expect(await readdir(dirname(file))).toEqual(['lock'])
        }
    }, 60_000)

    test('clears the claim of a run that stopped during its takeover, and takes over at the next run', async () => {
        const file = await lockFile()
        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })
        const digest = createHash('sha256')
            .update(await readFile(file, 'utf8'))
            .digest('hex')
            .slice(0, 16)
        const claim = join(dirname(file), `.takeover-${digest}`)
        await writeFile(claim, JSON.stringify({ pid: 40, startedAt: '2031-04-01T08:00:00Z' }))
        const alive = (pid: number): boolean => pid > 41

        const message = await rejectionOf(
            takeDeployLock(file, { pid: 42, now: () => NOW, isAlive: alive })
        )
        const lock = await takeDeployLock(file, { pid: 42, now: () => NOW, isAlive: alive })

        expect(message).toContain('at the same time')
        expect(lock.warning).toContain('41')
        expect(await readdir(dirname(file))).toEqual(['lock'])
    })

    test('never leaves a lock that is half written: the file is complete when it exists', async () => {
        const file = await lockFile()

        await takeDeployLock(file, { pid: 41, now: () => NOW, isAlive: () => true })

        expect(await readdir(dirname(file))).toEqual(['lock'])
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
            pid: 41,
            startedAt: '2031-04-01T08:00:00Z'
        })
    })

    // The restart of `--from-main` runs under the lock of its parent: the
    // warning of a lock that the parent took over reaches its result.
    test('gives the warning of a lock that the parent took over to the restart', () => {
        const environment = lockWarningFor(
            'took over the lock of a deployment that stopped (process 41)'
        )

        expect(inheritedLockWarning({ HOME: '/home/test', ...environment })).toBe(
            'took over the lock of a deployment that stopped (process 41)'
        )
        expect(lockWarningFor(undefined)).toEqual({})
        expect(inheritedLockWarning({ HOME: '/home/test' })).toBeUndefined()
    })
})
