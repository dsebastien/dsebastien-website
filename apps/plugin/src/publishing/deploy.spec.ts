import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
    deployCommandOf,
    isAbsolutePath,
    deploymentText,
    reportOfRun,
    reportOfStartError,
    runDeploy
} from './deploy.ts'
import type { DeployCommand, DeployProcess, DeploySettings } from './deploy.ts'

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
    readonly push: 'ok' | 'skipped'
    readonly report: unknown
}

const FILE = fileURLToPath(new URL('../../../../fixtures/canonical/deploy.json', import.meta.url))

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const CASES = (await Bun.file(FILE).json()) as {
    paths: { path: string; windows: boolean; absolute: boolean }[]
    commands: CommandCase[]
    results: ResultCase[]
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
            const report =
                one.startError === undefined
                    ? reportOfRun(one.code ?? null, one.stdout ?? '', one.push)
                    : reportOfStartError(one.startError, one.push)

            expect(JSON.parse(deploymentText(report))).toEqual({ deployment: one.report })
        })
    }

    test('is written in the canonical form, in its own object', () => {
        const report = reportOfStartError('no program', 'ok')

        expect(deploymentText(report)).toBe(
            '{\n  "deployment": {\n    "build": "skipped",\n    "deleted": 0,\n    "deploy": "failed",\n    "error": "the deploy could not start: no program",\n    "live": false,\n    "push": "ok",\n    "uploaded": 0,\n    "warnings": []\n  }\n}\n'
        )
    })
})

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

        const deployment = await runDeploy(child, SETTINGS, true, 'ok', false)

        expect(runs).toEqual([
            {
                program: 'bun',
                folder: '/work/site-code',
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

        const deployment = await runDeploy(child, { ...SETTINGS, target: '' }, false, 'ok', false)

        expect(started).toBe(false)
        expect(deployment.report).toMatchObject({ build: 'skipped', deploy: 'skipped' })
        expect(deployment.report.error).toContain('the target file of the deployment is not set')
        expect(deployment.output).toBe('')
    })

    test('reports a program that cannot start as a failed deploy', async () => {
        const child: DeployProcess = {
            run: () => Promise.reject(new Error('spawn bun ENOENT'))
        }

        const deployment = await runDeploy(child, SETTINGS, false, 'ok', false)

        expect(deployment.report).toMatchObject({
            build: 'skipped',
            deploy: 'failed',
            error: 'the deploy could not start: spawn bun ENOENT'
        })
    })
})
