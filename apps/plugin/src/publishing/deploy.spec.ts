import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
    deployCommandOf,
    isAbsolutePath,
    lastText,
    startedText,
    deploymentText,
    reportOfRun,
    reportOfStartError,
    reportOfStop,
    runDeploy
} from './deploy.ts'
import type {
    DeployCommand,
    DeployKind,
    DeployProcess,
    DeployRecord,
    DeploySettings,
    TakedownMarker
} from './deploy.ts'

// The deploy that the tool starts after a push (issue 32, BUILD-02, PUB-42):
// the command that it runs and the report that it reads from the result line
// of the deploy. The cases are shared with the Rust face (`cli/src/deploy.rs`).

interface CommandCase {
    readonly name: string
    readonly settings: DeploySettings
    readonly takedown: boolean
    readonly windows?: boolean
    readonly command?: DeployCommand
    readonly error?: string
}

interface ResultCase {
    readonly name: string
    readonly code?: number | null
    readonly stdout?: string
    readonly startError?: string
    readonly stopped?: 'time' | 'author'
    readonly timeoutMinutes?: number
    readonly push: 'ok' | 'skipped'
    readonly takedown?: boolean
    readonly report: unknown
}

const FILE = fileURLToPath(new URL('../../../../fixtures/canonical/deploy.json', import.meta.url))

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const CASES = (await Bun.file(FILE).json()) as {
    paths: { path: string; windows: boolean; absolute: boolean }[]
    commands: CommandCase[]
    results: ResultCase[]
    started: { name: string; kind: DeployKind; text: string }[]
    last: { name: string; stored: string | null; running: boolean; text: string }[]
}

describe('an absolute path', () => {
    for (const one of CASES.paths) {
        test(`${one.path} on ${one.windows ? 'Windows' : 'Unix'}`, () => {
            expect(isAbsolutePath(one.path, one.windows)).toBe(one.absolute)
        })
    }
})

describe('the command of the deploy', () => {
    for (const one of CASES.commands) {
        test(one.name, () => {
            const result = deployCommandOf(one.settings, one.takedown, one.windows === true)

            expect(result).toEqual(
                one.command === undefined ? { error: one.error ?? '' } : { command: one.command }
            )
        })
    }
})

describe('the report of a deploy', () => {
    for (const one of CASES.results) {
        test(one.name, () => {
            const kind = { push: one.push, takedown: one.takedown === true }
            const report =
                one.stopped !== undefined
                    ? reportOfStop(one.stopped, one.timeoutMinutes ?? 30, kind)
                    : one.startError === undefined
                      ? reportOfRun(one.code ?? null, one.stdout ?? '', kind)
                      : reportOfStartError(one.startError, kind)

            expect(JSON.parse(deploymentText(report))).toEqual({ deployment: one.report })
        })
    }

    test('is written in the canonical form, in its own object', () => {
        const report = reportOfStartError('no program', { push: 'ok', takedown: false })

        expect(deploymentText(report)).toBe(
            '{\n  "deployment": {\n    "build": "skipped",\n    "deleted": 0,\n    "deploy": "failed",\n    "error": "the deploy could not start: no program",\n    "live": false,\n    "push": "ok",\n    "state": "done",\n    "takedown": false,\n    "uploaded": 0,\n    "warnings": []\n  }\n}\n'
        )
    })
})

describe('the report of a deploy that starts in the background, and the last report', () => {
    for (const one of CASES.started) {
        test(one.name, () => {
            expect(startedText(one.kind)).toBe(one.text)
        })
    }
    for (const one of CASES.last) {
        test(one.name, () => {
            expect(lastText(one.stored ?? undefined, one.running)).toBe(one.text)
        })
    }
})

/** A marker of a takedown and a record in memory. */
function marker(
    pending = false
): TakedownMarker & DeployRecord & { is: () => boolean; runs: boolean[]; saved: string[] } {
    let on = pending
    const runs: boolean[] = []
    const saved: string[] = []
    return {
        runs,
        saved,
        setRunning: (running) => {
            runs.push(running)
            return Promise.resolve()
        },
        running: () => Promise.resolve(runs.at(-1) === true),
        saveLast: (text) => {
            saved.push(text)
            return Promise.resolve()
        },
        last: () => Promise.resolve(saved.at(-1)),
        pending: () => Promise.resolve(on),
        set: () => {
            on = true
            return Promise.resolve()
        },
        remove: () => {
            on = false
            return Promise.resolve()
        },
        is: () => on
    }
}

const SETTINGS: DeploySettings = {
    siteCode: '/work/site-code',
    target: '/private/target.json',
    envFile: '',
    bun: '',
    contentStore: '/data/copy',
    attachments: '/data/files'
}

const LINE =
    'DEPLOY-RESULT {"build":"ok","deploy":"ok","live":true,"url":"https://preview.example.org/","contentRevision":"0123456789abcdef0123456789abcdef01234567","uploaded":0,"deleted":0,"warnings":[],"error":null}'

describe('a deploy', () => {
    test('runs the command in the folder of the site code and keeps its whole output', async () => {
        const runs: DeployCommand[] = []
        const child: DeployProcess = {
            run: (command) => {
                runs.push(command)
                return Promise.resolve({
                    code: 0,
                    stdout: `Building\n${LINE}\n`,
                    output: `Building\nwarning of the build\n${LINE}\n`
                })
            }
        }

        const deployment = await runDeploy(
            child,
            marker(),
            SETTINGS,
            { push: 'ok', takedown: true },
            false
        )

        expect(runs).toEqual([
            {
                program: 'bun',
                folder: '/work/site-code',
                timeoutMinutes: 30,
                args: [
                    'run',
                    'deploy',
                    '--from-main',
                    '--target',
                    '/private/target.json',
                    '--content-store',
                    '/data/copy',
                    '--attachments',
                    '/data/files',
                    '--takedown'
                ]
            }
        ])
        expect(deployment.report.live).toBe(true)
        expect(deployment.report.url).toBe('https://preview.example.org/')
        expect(deployment.output).toBe(`Building\nwarning of the build\n${LINE}\n`)
    })

    test('starts nothing when a setting is missing, and says which one', async () => {
        let started = false
        const child: DeployProcess = {
            run: () => {
                started = true
                return Promise.reject(new Error('never'))
            }
        }

        const pending = marker(true)

        const deployment = await runDeploy(
            child,
            pending,
            { ...SETTINGS, target: '' },
            { push: 'ok', takedown: false },
            false
        )

        expect(started).toBe(false)
        expect(deployment.report).toMatchObject({ build: 'skipped', deploy: 'skipped' })
        expect(deployment.report.error).toContain('the target file of the deployment is not set')
        expect(deployment.report.takedown).toBe(true)
        expect(deployment.output).toBe('')
        expect(pending.is()).toBe(true)
    })

    test('reports a program that cannot start as a failed deploy', async () => {
        const child: DeployProcess = {
            run: () => Promise.reject(new Error('spawn bun ENOENT'))
        }

        const deployment = await runDeploy(
            child,
            marker(),
            SETTINGS,
            { push: 'ok', takedown: false },
            false
        )

        expect(deployment.report).toMatchObject({
            build: 'skipped',
            deploy: 'failed',
            error: 'the deploy could not start: spawn bun ENOENT'
        })
    })

    test('runs with --takedown while the marker of a takedown is set, and removes it when it succeeded', async () => {
        const runs: DeployCommand[] = []
        const crashed = { code: 1, stdout: 'crash\n', output: 'crash\n' }
        const done = { code: 0, stdout: `${LINE}\n`, output: `${LINE}\n` }
        const child: DeployProcess = {
            run: (command) => {
                runs.push(command)
                return Promise.resolve(runs.length === 1 ? crashed : done)
            }
        }
        const pending = marker(true)
        const again = { push: 'skipped', takedown: false } as const

        const first = await runDeploy(child, pending, SETTINGS, again, false)
        const kept = pending.is()
        const second = await runDeploy(child, pending, SETTINGS, again, false)
        const third = await runDeploy(child, pending, SETTINGS, again, false)

        expect(runs.map((one) => one.args.at(-1))).toEqual([
            '--takedown',
            '--takedown',
            '/data/files'
        ])
        expect(first.report.takedown).toBe(true)
        expect(kept).toBe(true)
        expect(second.report.takedown).toBe(true)
        expect(pending.is()).toBe(false)
        expect(third.report.takedown).toBe(false)
    })

    test('says in the record that it runs, then keeps its report', async () => {
        const child: DeployProcess = {
            run: () => Promise.resolve({ code: 0, stdout: `${LINE}\n`, output: '' })
        }
        const files = marker()

        const deployment = await runDeploy(
            child,
            files,
            SETTINGS,
            { push: 'ok', takedown: false },
            false
        )

        expect(files.runs).toEqual([true, false])
        expect(files.saved).toEqual([deploymentText(deployment.report)])
    })
})
