import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { gitEnvironment, makeTestStores, rejectionOf } from '@dsebastien-website/testing'
import { childEnvironment, childProcess, deploySettingsOf, deployFiles } from './deploy.ts'

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

describe('the environment of the deploy', () => {
    test('has no GIT_ variable, and the folders of the programs of the settings first in its PATH', () => {
        expect(
            childEnvironment({ PATH: '/usr/bin', GIT_DIR: '/elsewhere/.git', HOME: '/home/me' }, [
                '/opt/git/bin/git',
                '/opt/bun/bin/bun',
                ''
            ])
        ).toEqual({
            PATH: `/opt/git/bin${delimiter}/opt/bun/bin${delimiter}/usr/bin`,
            HOME: '/home/me'
        })
        expect(childEnvironment({ Path: 'C:\\Windows' }, [])).toEqual({ Path: 'C:\\Windows' })
    })

    test('reaches the child', async () => {
        await using stores = await makeTestStores()
        const file = join(stores.root, 'environment.ts')
        await writeFile(
            file,
            "console.log('DEPLOY-RESULT ' + JSON.stringify([process.env['GIT_DIR'] ?? null, (process.env['PATH'] ?? '').split(require('node:path').delimiter)[0]]))"
        )
        process.env['GIT_DIR'] = join(stores.root, 'other.git')
        try {
            const run = await childProcess({ programs: [join(stores.root, 'tools', 'git')] }).run({
                program: process.execPath,
                args: [file],
                folder: stores.root,
                timeoutMinutes: 1
            })

            expect(run.stdout.trim()).toBe(
                `DEPLOY-RESULT ${JSON.stringify([null, join(stores.root, 'tools')])}`
            )
        } finally {
            delete process.env['GIT_DIR']
        }
    })
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

describe('the files of the deploy (issue 32)', () => {
    test('say whether a deploy runs, and keep the last report', async () => {
        await using stores = await makeTestStores()
        const files = deployFiles(stores.root)

        const before = [await files.running(), await files.last()]
        await files.setRunning(true)
        const during = await files.running()
        await files.saveLast('{"deployment": {}}')
        await files.setRunning(false)

        expect(before).toEqual([false, undefined])
        expect(during).toBe(true)
        expect(await files.running()).toBe(false)
        expect(await files.last()).toBe('{"deployment": {}}')
    })

    test('keep one record of a running deploy per process: a record of a process that ended counts for nothing', async () => {
        await using stores = await makeTestStores()
        const files = deployFiles(stores.root)
        const runs = join(stores.root, '.git', 'vault-publish', 'deploy-running')
        await mkdir(runs, { recursive: true })
        // A process that ended long ago, and the other face of this machine.
        await writeFile(join(runs, '999999999'), 'ended\n')

        const before = await files.running()
        await files.setRunning(true)
        await files.setRunning(false)
        await writeFile(join(runs, String(process.ppid)), 'the other face\n')

        expect(before).toBe(false)
        expect(await files.running()).toBe(true)
    })

    test('keep one file per takedown, by its commit, until it is removed', async () => {
        await using stores = await makeTestStores()
        const marker = deployFiles(stores.root)

        const first = await marker.add({ above: null })
        const second = await marker.add({ above: 'a'.repeat(40) })
        await marker.replace(first, { commit: 'b'.repeat(40) })
        const both = await marker.entries()
        await marker.remove(first)

        expect(both.map((one) => one.entry)).toEqual([
            { commit: 'b'.repeat(40) },
            { above: 'a'.repeat(40) }
        ])
        expect(await marker.entries()).toEqual([{ id: second, entry: { above: 'a'.repeat(40) } }])
        expect(
            await readFile(
                join(stores.root, '.git', 'vault-publish', 'takedowns', `${second}.json`),
                'utf8'
            )
        ).toBe(`{\n  "above": "${'a'.repeat(40)}"\n}\n`)
    })

    test('know which commit of the copy comes before another one', async () => {
        await using stores = await makeTestStores()
        const copy = join(stores.root, 'copy')
        const git = async (...args: string[]): Promise<string> => {
            const child = Bun.spawn(['git', '-C', copy, ...args], {
                env: gitEnvironment(),
                stdout: 'pipe'
            })
            const out = await new Response(child.stdout).text()
            await child.exited
            return out.trim()
        }
        await mkdir(copy)
        await git('init', '--quiet')
        await git('commit', '--allow-empty', '--quiet', '-m', 'one')
        const one = await git('rev-parse', 'HEAD')
        await git('commit', '--allow-empty', '--quiet', '-m', 'two')
        const two = await git('rev-parse', 'HEAD')
        const marker = deployFiles(copy)

        expect(await marker.isAncestor(one, two)).toBe(true)
        expect(await marker.isAncestor(two, one)).toBe(false)
        expect(await marker.isAncestor('c'.repeat(40), two)).toBeUndefined()
    })

    test('are never set for a copy that is not set', async () => {
        const marker = deployFiles('')
        await marker.add({ above: null })

        expect(await marker.entries()).toEqual([])
    })
})
