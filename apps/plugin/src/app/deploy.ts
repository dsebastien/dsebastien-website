import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type {
    ChildRun,
    DeployCommand,
    DeployProcess,
    DeployRecord,
    DeploySettings,
    TakedownMarker
} from '../publishing/deploy.ts'
import type { DeviceSettings } from './settings.ts'

// The child process of the deploy (issue 32, BUILD-02, R76): the port
// `DeployProcess` of `publishing/deploy.ts` in the plugin. It runs the program
// with a list of arguments, with no shell, in the folder of the site code,
// and keeps the whole output for the author. The output can name the address
// of a removed note: it stays in the view, and goes nowhere else.

/** The options of the child: the length of a minute and the grace before a hard stop (a test makes them short), and the programs of the settings. */
export interface ChildTimes {
    readonly minuteMs?: number
    readonly graceMs?: number
    /**
     * The programs of the settings (git, bun), absolute: their folders come
     * first in the `PATH` of the child, so that the deploy finds the git of
     * the settings.
     */
    readonly programs?: readonly string[]
}

/**
 * The environment of the child: the one of Obsidian, with no `GIT_*`
 * variable (inside a git hook they point git to another repository) and the
 * folders of the programs first in its `PATH`.
 */
export function childEnvironment(
    environment: NodeJS.ProcessEnv,
    programs: readonly string[]
): NodeJS.ProcessEnv {
    const kept = Object.fromEntries(
        Object.entries(environment).filter(([name]) => !name.startsWith('GIT_'))
    )
    const folders = [
        ...new Set(programs.filter((one) => isAbsolute(one)).map((one) => dirname(one)))
    ]
    if (folders.length === 0) {
        return kept
    }
    // On Windows the name of the variable can be Path.
    const name = Object.keys(kept).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const before = kept[name]
    return {
        ...kept,
        [name]: [...folders, ...(before === undefined || before === '' ? [] : [before])].join(
            delimiter
        )
    }
}

/**
 * Stops the deploy with the programs that it started: on Unix its process
 * group (the child leads a group of its own), first with SIGTERM, then with
 * SIGKILL after the grace; on Windows its tree, with `taskkill`.
 */
function stopTree(pid: number, graceMs: number): void {
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
        })
        return
    }
    const signal = (name: NodeJS.Signals): void => {
        try {
            process.kill(-pid, name)
        } catch {
            // The group ended already.
        }
    }
    signal('SIGTERM')
    setTimeout(() => {
        signal('SIGKILL')
    }, graceMs).unref()
}

/** The port that starts the deploy as a child process of Obsidian. */
export function childProcess(times: ChildTimes = {}): DeployProcess {
    const minuteMs = times.minuteMs ?? 60_000
    const graceMs = times.graceMs ?? 5_000
    return {
        run: async (command: DeployCommand, signal?: AbortSignal): Promise<ChildRun> => {
            const folder = await stat(command.folder).catch(() => undefined)
            if (folder?.isDirectory() !== true) {
                throw new Error(`the folder of the site code is not a folder: ${command.folder}`)
            }
            return await new Promise<ChildRun>((resolve, reject) => {
                const child = spawn(command.program, command.args, {
                    cwd: command.folder,
                    env: childEnvironment(process.env, times.programs ?? []),
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    // A group of its own on Unix, so that a stop reaches
                    // the programs that the deploy started.
                    detached: process.platform !== 'win32'
                })
                const stdout: Buffer[] = []
                // The standard output and the errors in the order they came.
                const output: Buffer[] = []
                let stopped: ChildRun['stopped']
                const stop = (why: 'time' | 'author'): void => {
                    if (stopped === undefined && child.pid !== undefined) {
                        stopped = why
                        stopTree(child.pid, graceMs)
                    }
                }
                const timer = setTimeout(() => {
                    stop('time')
                }, command.timeoutMinutes * minuteMs)
                const onAbort = (): void => {
                    stop('author')
                }
                signal?.addEventListener('abort', onAbort, { once: true })
                if (signal?.aborted === true) {
                    onAbort()
                }
                child.stdout.on('data', (chunk: Buffer) => {
                    stdout.push(chunk)
                    output.push(chunk)
                })
                child.stderr.on('data', (chunk: Buffer) => {
                    output.push(chunk)
                })
                child.on('error', (error) => {
                    clearTimeout(timer)
                    signal?.removeEventListener('abort', onAbort)
                    reject(error)
                })
                child.on('close', (code) => {
                    clearTimeout(timer)
                    signal?.removeEventListener('abort', onAbort)
                    resolve({
                        code,
                        stdout: Buffer.concat(stdout).toString('utf8'),
                        output: Buffer.concat(output).toString('utf8'),
                        ...(stopped === undefined ? {} : { stopped })
                    })
                })
            })
        }
    }
}

/** The time limit of the setting: none when it is empty, `NaN` when it is no whole number, which the deploy refuses. */
function timeoutOf(text: string): { readonly timeoutMinutes?: number } {
    const minutes = text.trim()
    if (minutes === '') {
        return {}
    }
    return { timeoutMinutes: /^[0-9]+$/u.test(minutes) ? Number(minutes) : Number.NaN }
}

/** The deploy settings of this device, with the folders of its publication. */
export function deploySettingsOf(settings: DeviceSettings): DeploySettings {
    return {
        siteCode: settings.siteCode.trim(),
        target: settings.deployTarget.trim(),
        envFile: settings.deployEnvFile.trim(),
        bun: settings.bun.trim(),
        contentStore: settings.contentStore.trim(),
        attachments: settings.attachmentStorage.trim(),
        ...timeoutOf(settings.deployTimeout)
    }
}

/**
 * The files of the deploy of this device, in `.git/vault-publish/` of the
 * copy, beside the lock and the run journal, so every face of this device
 * sees them: the marker of a takedown (`takedown-pending`; one that cannot
 * be read counts as set), whether a deploy runs (`deploy-running`) and the
 * last deploy report (`deploy-report.json`). A copy that is not set has none.
 */
export function deployFiles(contentStore: string): TakedownMarker & DeployRecord {
    const folder = contentStore.trim()
    if (!isAbsolute(folder)) {
        return {
            pending: () => Promise.resolve(false),
            set: () => Promise.resolve(),
            remove: () => Promise.resolve(),
            setRunning: () => Promise.resolve(),
            running: () => Promise.resolve(false),
            saveLast: () => Promise.resolve(),
            last: () => Promise.resolve(undefined)
        }
    }
    const local = join(folder, '.git', 'vault-publish')
    const exists = async (file: string, unreadable: boolean): Promise<boolean> => {
        try {
            await access(join(local, file))
            return true
        } catch (error) {
            return error instanceof Error && 'code' in error && error.code === 'ENOENT'
                ? false
                : unreadable
        }
    }
    const write = async (file: string, text: string): Promise<void> => {
        await mkdir(local, { recursive: true })
        await writeFile(join(local, file), text)
    }
    return {
        pending: () => exists('takedown-pending', true),
        set: () =>
            write(
                'takedown-pending',
                'A takedown waits for a deploy with --takedown that succeeds.\n'
            ),
        remove: () => rm(join(local, 'takedown-pending'), { force: true }),
        setRunning: (running) =>
            running
                ? write(
                      'deploy-running',
                      `A deploy of the plugin runs since ${new Date().toISOString()}.\n`
                  )
                : rm(join(local, 'deploy-running'), { force: true }),
        running: () => exists('deploy-running', false),
        saveLast: (text) => write('deploy-report.json', text),
        last: async () =>
            await readFile(join(local, 'deploy-report.json'), 'utf8').catch(() => undefined)
    }
}
