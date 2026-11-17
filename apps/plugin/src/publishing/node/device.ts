import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { compareCodePoints } from '../order.ts'
import type { ContentStore, Device, PlanStore, Vault } from '../ports.ts'

// A device whose vault and whose copy of the content store are folders, with
// the `git` program of the system (TOOL-12 of the spec). The tests and the
// parity harness use it. It uses Node modules only, so that it also runs
// inside Obsidian on a desktop.

const run = promisify(execFile)

async function readText(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8')
    } catch {
        return undefined
    }
}

async function writeText(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
}

function folderVault(folder: string): Vault {
    return {
        read: (path) => readText(join(folder, path)),
        write: (path, text) => writeText(join(folder, path), text)
    }
}

/** The environment without the variables that point git to another repository. */
function gitEnvironment(): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    )
}

function gitContentStore(folder: string): ContentStore {
    const git = async (...args: string[]): Promise<void> => {
        await run('git', args, { cwd: folder, env: gitEnvironment() })
    }
    return {
        read: (path) => readText(join(folder, path)),
        write: (path, text) => writeText(join(folder, path), text),
        async list(below) {
            let entries
            try {
                entries = await readdir(join(folder, below), {
                    recursive: true,
                    withFileTypes: true
                })
            } catch {
                return []
            }
            return entries
                .filter((entry) => entry.isFile())
                .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
                .map((path) => path.split(sep).join('/'))
                .sort(compareCodePoints)
        },
        async commitAndPush(message) {
            await git('add', '--all')
            await git('commit', '--quiet', '--message', message)
            // Never with force: when another device pushed first, git refuses, and nothing is published.
            await git('push', '--quiet', 'origin', 'HEAD:main')
        }
    }
}

/** The plans are in the git folder of the copy: on the device, never in a commit, never in the vault. */
function folderPlanStore(contentStore: string): PlanStore {
    const folder = join(contentStore, '.git', 'vault-publish', 'plans')
    return {
        save: (id, record) => writeText(join(folder, `${id}.json`), record),
        load: (id) => readText(join(folder, `${id}.json`))
    }
}

/**
 * Makes a device from two folders.
 *
 * @param options.vault the folder of the vault
 * @param options.contentStore the folder of the copy of the content store: a git clone whose `origin` is the content store
 */
export function nodeDevice(options: { vault: string; contentStore: string }): Device {
    return {
        vault: folderVault(options.vault),
        store: gitContentStore(options.contentStore),
        plans: folderPlanStore(options.contentStore)
    }
}
