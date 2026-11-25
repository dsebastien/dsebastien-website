import { describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTestStores, rejectionOf } from '@dsebastien-website/testing'
import { childProcess, deploySettingsOf, fileMarker } from './deploy.ts'

// The port that starts the deploy as a child process (issue 32): a real
// program here, the bun of the tests, never the deploy of the site.

describe('the child process of the deploy', () => {
    test('runs the program with its arguments in the folder, and keeps the whole output', async () => {
        await using stores = await makeTestStores()
        const script = [
            "console.log('to the output')",
            "console.error('to the errors')",
            "console.log('DEPLOY-RESULT ' + JSON.stringify([process.cwd(), process.argv.slice(2)]))",
            'process.exit(3)'
        ].join(';')

        const file = join(stores.root, 'child.ts')
        await writeFile(file, script)

        const run = await childProcess().run({
            program: process.execPath,
            args: [file, 'one argument', "it's"],
            folder: stores.root,
            timeoutMinutes: 1
        })

        expect(run.code).toBe(3)
        const lines = run.stdout.trimEnd().split('\n')
        expect(lines[0]).toBe('to the output')
        expect(lines.at(-1)).toBe(
            `DEPLOY-RESULT ${JSON.stringify([stores.root, ['one argument', "it's"]])}`
        )
        expect(run.stdout).not.toContain('to the errors')
        expect(run.output).toContain('to the output')
        expect(run.output).toContain('to the errors')
    })

    test('refuses a folder that does not exist, and names it', async () => {
        await using stores = await makeTestStores()
        const folder = join(stores.root, 'missing')

        const message = await rejectionOf(
            childProcess().run({
                program: process.execPath,
                args: ['--version'],
                folder,
                timeoutMinutes: 1
            })
        )

        expect(message).toBe(`the folder of the site code is not a folder: ${folder}`)
    })

    test('refuses a program that does not exist', async () => {
        await using stores = await makeTestStores()

        const message = await rejectionOf(
            childProcess().run({
                program: join(stores.root, 'no-bun'),
                args: [],
                folder: stores.root,
                timeoutMinutes: 1
            })
        )

        expect(message).toContain('no-bun')
    })
})

/** True while the process runs. */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

/** A child that starts a grandchild, writes its process id, and waits for it. */
async function waitingChild(folder: string): Promise<{ file: string; pids: string }> {
    const file = join(folder, 'waiting.ts')
    const pids = join(folder, 'pids')
    await writeFile(
        file,
        [
            "import { spawn } from 'node:child_process'",
            "import { writeFileSync } from 'node:fs'",
            "const grandchild = spawn('sleep', ['30'], { stdio: 'ignore' })",
            "writeFileSync(process.argv[2] ?? '', String(grandchild.pid))",
            "console.log('started')",
            'setInterval(() => undefined, 1000)'
        ].join('\n')
    )
    return { file, pids }
}

async function grandchildOf(pids: string): Promise<number> {
    for (;;) {
        const text = await readFile(pids, 'utf8').catch(() => '')
        if (text !== '') {
            return Number(text)
        }
        await Bun.sleep(10)
    }
}

describe.skipIf(process.platform === 'win32')('the stop of the deploy (issue 32)', () => {
    test('stops the deploy and the programs that it started after its time limit', async () => {
        await using stores = await makeTestStores()
        const { file, pids } = await waitingChild(stores.root)

        const running = childProcess({ minuteMs: 300, graceMs: 200 }).run({
            program: process.execPath,
            args: [file, pids],
            folder: stores.root,
            timeoutMinutes: 1
        })
        const grandchild = await grandchildOf(pids)
        const run = await running
        await Bun.sleep(100)

        expect(run.stopped).toBe('time')
        expect(run.output).toContain('started')
        expect(alive(grandchild)).toBe(false)
    }, 20_000)

    test('stops the deploy when the author stops it', async () => {
        await using stores = await makeTestStores()
        const { file, pids } = await waitingChild(stores.root)
        const stop = new AbortController()

        const running = childProcess({ graceMs: 200 }).run(
            {
                program: process.execPath,
                args: [file, pids],
                folder: stores.root,
                timeoutMinutes: 30
            },
            stop.signal
        )
        const grandchild = await grandchildOf(pids)
        stop.abort()
        const run = await running
        await Bun.sleep(100)

        expect(run.stopped).toBe('author')
        expect(alive(grandchild)).toBe(false)
    }, 20_000)
})

describe('the deploy settings of a device', () => {
    test('take the folders of the device and trim every path', () => {
        expect(
            deploySettingsOf({
                contentStore: ' /data/copy ',
                attachmentStorage: '/data/files',
                git: '',
                siteCode: ' /work/site ',
                deployTarget: '/private/target.json',
                deployEnvFile: '',
                bun: ' /opt/bun ',
                deployTimeout: ''
            })
        ).toEqual({
            siteCode: '/work/site',
            target: '/private/target.json',
            envFile: '',
            bun: '/opt/bun',
            contentStore: '/data/copy',
            attachments: '/data/files'
        })
    })

    test('read the time limit in whole minutes, and give a wrong one to the deploy, which refuses it', () => {
        const settings = {
            contentStore: '/data/copy',
            attachmentStorage: '/data/files',
            git: '',
            siteCode: '/work/site',
            deployTarget: '/private/target.json',
            deployEnvFile: '',
            bun: ''
        }

        expect(deploySettingsOf({ ...settings, deployTimeout: ' 45 ' }).timeoutMinutes).toBe(45)
        expect(deploySettingsOf({ ...settings, deployTimeout: 'soon' }).timeoutMinutes).toBeNaN()
        expect('timeoutMinutes' in deploySettingsOf({ ...settings, deployTimeout: '' })).toBe(false)
    })
})

describe('the marker of a takedown (issue 32)', () => {
    test('is a file of the git folder of the copy, until it is removed', async () => {
        await using stores = await makeTestStores()
        const marker = fileMarker(stores.root)

        const before = await marker.pending()
        await marker.set()
        const set = await marker.pending()
        const text = await readFile(
            join(stores.root, '.git', 'vault-publish', 'takedown-pending'),
            'utf8'
        )
        await marker.remove()

        expect([before, set, await marker.pending()]).toEqual([false, true, false])
        expect(text).toContain('takedown')
    })

    test('is never set for a copy that is not set', async () => {
        const marker = fileMarker('')
        await marker.set()

        expect(await marker.pending()).toBe(false)
    })
})
