import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type {
    ChildRun,
    DeployCommand,
    DeployProcess,
    DeploySettings
} from '../publishing/deploy.ts'
import type { DeviceSettings } from './settings.ts'

// The child process of the deploy (issue 32, BUILD-02, R76): the port
// `DeployProcess` of `publishing/deploy.ts` in the plugin. It runs the program
// with a list of arguments, with no shell, in the folder of the site code,
// and keeps the whole output for the author. The output can name the address
// of a removed note: it stays in the view, and goes nowhere else.

/** The port that starts the deploy as a child process of Obsidian. */
export function childProcess(): DeployProcess {
    return {
        run: async (command: DeployCommand): Promise<ChildRun> => {
            const folder = await stat(command.folder).catch(() => undefined)
            if (folder?.isDirectory() !== true) {
                throw new Error(`the folder of the site code is not a folder: ${command.folder}`)
            }
            return await new Promise<ChildRun>((resolve, reject) => {
                const child = spawn(command.program, command.args, {
                    cwd: command.folder,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                })
                const stdout: Buffer[] = []
                // The standard output and the errors in the order they came.
                const output: Buffer[] = []
                child.stdout.on('data', (chunk: Buffer) => {
                    stdout.push(chunk)
                    output.push(chunk)
                })
                child.stderr.on('data', (chunk: Buffer) => {
                    output.push(chunk)
                })
                child.on('error', reject)
                child.on('close', (code) => {
                    resolve({
                        code,
                        stdout: Buffer.concat(stdout).toString('utf8'),
                        output: Buffer.concat(output).toString('utf8')
                    })
                })
            })
        }
    }
}

/** The deploy settings of this device, with the folders of its publication. */
export function deploySettingsOf(settings: DeviceSettings): DeploySettings {
    return {
        siteCode: settings.siteCode.trim(),
        target: settings.deployTarget.trim(),
        envFile: settings.deployEnvFile.trim(),
        bun: settings.bun.trim(),
        contentStore: settings.contentStore.trim(),
        attachments: settings.attachmentStorage.trim()
    }
}
