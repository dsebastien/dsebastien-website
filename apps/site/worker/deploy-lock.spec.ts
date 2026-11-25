import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rejectionOf } from '@dsebastien-website/testing'
import { lockHeldBy, takeDeployLock } from './deploy-lock.ts'

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
})
