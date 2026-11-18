import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { compareCodePoints } from '../order.ts'
import type { ContentStore, Device, PlanStore, Vault, VaultEntry } from '../ports.ts'

// A device whose vault and whose copy of the content store are folders, with
// the `git` program of the system (TOOL-12 of the spec). The tests and the
// parity harness use it. It uses Node modules only, so that it also runs
// inside Obsidian on a desktop. The Rust twin is `cli/src/device.rs`.

const run = promisify(execFile)

/** The options of every git command of the tool. */
const GIT_OPTIONS = ['--literal-pathspecs', '-c', 'core.autocrlf=false']

/** Decodes bytes as UTF-8. It throws for bytes that are not UTF-8, and it keeps a byte order mark. */
function decode(bytes: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
        throw new Error('is not valid UTF-8')
    }
}

function codeOf(error: unknown): string {
    return error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown error'
}

async function writeText(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
}

/**
 * What the folder holds at exactly this path: a file, a folder, or nothing.
 *
 * Each part of the path must be a name of the folder listing. A file system
 * that ignores letter case would else open `90 locked shed/` for the folder
 * `90 Locked Shed/` of the deny list. A symbolic link is nothing: it can lead
 * to a file that the guards would refuse, or out of the vault.
 */
async function exactEntry(root: string, path: string): Promise<'file' | 'folder' | undefined> {
    const parts = path.split('/')
    let folder = root
    for (const [index, part] of parts.entries()) {
        let entries
        try {
            entries = await readdir(folder, { withFileTypes: true })
        } catch {
            return undefined
        }
        const entry = entries.find((candidate) => candidate.name === part)
        if (entry === undefined || entry.isSymbolicLink()) {
            return undefined
        }
        if (index === parts.length - 1) {
            return entry.isFile() ? 'file' : entry.isDirectory() ? 'folder' : undefined
        }
        if (!entry.isDirectory()) {
            return undefined
        }
        folder = join(folder, part)
    }
    return undefined
}

function folderVault(folder: string): Vault {
    return {
        async list(path) {
            const entries = await readdir(join(folder, path), { withFileTypes: true })
            const listed: VaultEntry[] = []
            for (const entry of entries) {
                // A symbolic link is neither: `isFile` and `isDirectory` are false for it.
                if (entry.isFile()) {
                    listed.push({ name: entry.name, kind: 'file' })
                } else if (entry.isDirectory()) {
                    listed.push({ name: entry.name, kind: 'folder' })
                }
            }
            return listed
        },
        async read(path) {
            if ((await exactEntry(folder, path)) !== 'file') {
                return undefined
            }
            return decode(await readFile(join(folder, path)))
        },
        hasFolder: async (path) => (await exactEntry(folder, path)) === 'folder',
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
    const gitRaw = async (...args: string[]): Promise<string> => {
        // Literal paths: a note name with `[`, `*` or `?` must never be read
        // as a pattern that names other files too. No conversion of line
        // ends: a setting of the machine must never change the bytes of a
        // file of the store.
        const { stdout } = await run('git', [...GIT_OPTIONS, ...args], {
            cwd: folder,
            env: gitEnvironment(),
            maxBuffer: 1024 * 1024 * 1024
        })
        return stdout
    }
    const git = async (...args: string[]): Promise<string> => (await gitRaw(...args)).trim()
    /**
     * Runs a git command on a list of paths. The paths go in a file of the git
     * folder, not in the arguments: a publication can hold more paths than
     * the system takes as arguments of one command.
     */
    const gitOnPaths = async (args: readonly string[], paths: readonly string[]): Promise<void> => {
        const file = join(folder, '.git', 'vault-publish', 'paths')
        await writeText(file, paths.join('\0'))
        try {
            await git(...args, `--pathspec-from-file=${file}`, '--pathspec-file-nul')
        } finally {
            await rm(file, { force: true })
        }
    }
    const discard = async (paths: readonly string[]): Promise<void> => {
        let listing: string
        try {
            listing = await gitRaw('ls-tree', '-r', '-z', '--name-only', 'HEAD')
        } catch {
            // A copy with no commit has no file to put back.
            listing = ''
        }
        const committed = new Set(listing.split('\0'))
        const toRestore = paths.filter((path) => committed.has(path))
        if (toRestore.length > 0) {
            await gitOnPaths(['checkout', '--quiet', 'HEAD'], toRestore)
        }
        for (const path of paths) {
            if (!committed.has(path)) {
                await rm(join(folder, path), { force: true })
            }
        }
    }
    return {
        async verify() {
            let top: string
            try {
                top = await git('rev-parse', '--show-toplevel')
            } catch {
                top = ''
            }
            // Git would else work on the repository that holds the folder.
            if (top === '' || (await realpath(top)) !== (await realpath(folder))) {
                throw new Error(
                    `the copy of the content store is not the root of a git repository: ${folder}`
                )
            }
        },
        async read(path) {
            let bytes
            try {
                bytes = await readFile(join(folder, path))
            } catch (error) {
                if (codeOf(error) === 'ENOENT') {
                    return undefined
                }
                throw new Error(`${path} of the content store cannot be read: ${codeOf(error)}`, {
                    cause: error
                })
            }
            try {
                return decode(bytes)
            } catch {
                throw new Error(`${path} of the content store is not valid UTF-8`)
            }
        },
        write: (path, text) => writeText(join(folder, path), text),
        async remove(path) {
            try {
                await rm(join(folder, path))
                return true
            } catch (error) {
                if (codeOf(error) === 'ENOENT') {
                    return false
                }
                throw new Error(
                    `${path} of the content store cannot be removed: ${codeOf(error)}`,
                    { cause: error }
                )
            }
        },
        discard,
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
        async commitAndPush(message, paths) {
            // A copy with no commit has no commit to go back to.
            let before: string | undefined
            try {
                before = await git('rev-parse', '--verify', '--quiet', 'HEAD')
            } catch {
                before = undefined
            }
            // Takes back everything that this publication did to the copy.
            const undo = async (): Promise<void> => {
                if (before === undefined) {
                    await git('update-ref', '-d', 'HEAD').catch(() => undefined)
                    await gitOnPaths(
                        ['rm', '--quiet', '--cached', '--ignore-unmatch'],
                        paths
                    ).catch(() => undefined)
                } else {
                    await git('reset', '--quiet', before)
                }
                await discard(paths)
            }
            try {
                // With force: a rule of the store that ignores a path must not
                // leave a note out of its own publication.
                await gitOnPaths(['add', '--force'], paths)
                // Only the files of the publication. Other changes of the copy stay out.
                await gitOnPaths(['commit', '--quiet', '--message', message, '--only'], paths)
            } catch (error) {
                // Files that stay in the copy would be read as published at the next run.
                await undo()
                throw new Error(
                    `the commit into the copy of the content store failed. Nothing is published, and the copy is as it was before: ${error instanceof Error ? error.message : 'git failed'}`,
                    { cause: error }
                )
            }
            try {
                // Never with force: when another device pushed first, git refuses.
                await git('push', '--quiet', 'origin', 'HEAD:main')
            } catch {
                await undo()
                throw new Error(
                    'the push to the content store was refused. Nothing is published, and the copy is as it was before'
                )
            }
        }
    }
}

/** The plans are in the git folder of the copy: on the device, never in a commit, never in the vault. */
function folderPlanStore(contentStore: string): PlanStore {
    const folder = join(contentStore, '.git', 'vault-publish', 'plans')
    return {
        save: (id, record) => writeText(join(folder, `${id}.json`), record),
        async load(id) {
            try {
                return await readFile(join(folder, `${id}.json`), 'utf8')
            } catch {
                return undefined
            }
        }
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
