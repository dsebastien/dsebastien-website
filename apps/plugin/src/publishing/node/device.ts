import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
    /** Runs git in the copy. The input goes to its standard input. */
    const gitWith = async (args: readonly string[], input: string): Promise<string> => {
        // Literal paths: a note name with `[`, `*` or `?` must never be read
        // as a pattern that names other files too. No conversion of line
        // ends: a setting of the machine must never change the bytes of a
        // file of the store.
        const running = run('git', [...GIT_OPTIONS, ...args], {
            cwd: folder,
            env: gitEnvironment(),
            maxBuffer: 1024 * 1024 * 1024
        })
        const stdin = running.child.stdin
        // Git can end before it reads everything: the error of the pipe is
        // not the error of the command.
        stdin?.on('error', () => undefined)
        stdin?.end(input)
        return (await running).stdout
    }
    const gitRaw = (...args: string[]): Promise<string> => gitWith(args, '')
    const git = async (...args: string[]): Promise<string> => (await gitRaw(...args)).trim()
    /**
     * Runs a git command on a list of paths. The paths go to the standard
     * input of git, not in the arguments: a publication can hold more paths
     * than the system takes as arguments of one command. No file holds them,
     * so a relative folder and two publications on one copy work too.
     */
    const gitOnPaths = async (args: readonly string[], paths: readonly string[]): Promise<void> => {
        await gitWith([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], paths.join('\0'))
    }
    /**
     * Throws when a part of the path in the copy is a symbolic link. A link is
     * not a file of the store: it could lead out of the copy, or to nothing,
     * and a configuration that leads nowhere would be read as none.
     */
    const refuseLinks = async (path: string): Promise<void> => {
        const parts = path.split('/')
        for (let count = 1; count <= parts.length; count += 1) {
            const part = parts.slice(0, count).join('/')
            let stats
            try {
                stats = await lstat(join(folder, part))
            } catch (error) {
                if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') {
                    return
                }
                throw new Error(`${part} of the content store cannot be read: ${codeOf(error)}`, {
                    cause: error
                })
            }
            if (stats.isSymbolicLink()) {
                throw new Error(
                    `${part} of the content store is a symbolic link: the tool follows no link in the copy`
                )
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
            // A commit that a failed publication could not take back would be
            // pushed by the next one, also for a note that came under a guard.
            // A commit that a branch of the content store has is not ahead.
            let ahead: string
            try {
                ahead = await git('rev-list', '--count', 'HEAD', '--not', '--remotes=origin')
            } catch (error) {
                // Only a branch with no commit yet has no history to compare.
                let unborn: boolean
                try {
                    await git('symbolic-ref', '--quiet', 'HEAD')
                    unborn = !(await git('rev-parse', '--verify', '--quiet', 'HEAD')
                        .then(() => true)
                        .catch(() => false))
                } catch {
                    unborn = false
                }
                if (!unborn) {
                    throw new Error(
                        `the history of the copy of the content store cannot be read: ${error instanceof Error ? error.message.trim() : 'git failed'}`,
                        { cause: error }
                    )
                }
                ahead = '0'
            }
            if (ahead !== '0') {
                throw new Error(
                    `the copy of the content store has ${ahead} commit(s) that the content store does not have, for example a publication that git could not take back. Nothing can be published until the copy is corrected by hand: ${folder}`
                )
            }
            // The tool reads the state from the files of the copy. A file of
            // the manifest or the configuration that git has and the copy does
            // not would hide a published note or the deny list: a file that
            // was removed, and a file that git skips (git status shows none).
            const listing = await gitRaw(
                'ls-files',
                '-z',
                '-t',
                '--cached',
                '--deleted',
                '--',
                'configuration.json',
                'manifest'
            )
            const missing = listing
                .split('\0')
                .filter((entry) => entry.startsWith('R ') || entry.startsWith('S '))
                .map((entry) => entry.slice(2))
            if (missing.length > 0) {
                throw new Error(
                    `files of the content store are missing from the copy, or git skips them: ${missing.slice(0, 5).join(', ')}. Nothing can be published until the copy is corrected by hand: ${folder}`
                )
            }
        },
        async read(path) {
            await refuseLinks(path)
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
        async list(below) {
            await refuseLinks(below)
            let entries
            try {
                entries = await readdir(join(folder, below), { withFileTypes: true })
            } catch (error) {
                // Only a folder that does not exist is empty. A folder that
                // cannot be listed would else hide the published notes.
                if (codeOf(error) === 'ENOENT') {
                    return []
                }
                throw new Error(
                    `${below} of the content store cannot be listed: ${codeOf(error)}`,
                    {
                        cause: error
                    }
                )
            }
            // One level: a folder below is not read. A symbolic link is not a file.
            return entries
                .filter((entry) => entry.isFile())
                .map((entry) => `${below}/${entry.name}`)
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
            /**
             * Takes the commit back, when there is one, and unstages the paths
             * of the publication: the other staged work of the copy stays. Every
             * step runs, also when one fails. The result is what failed.
             */
            const undo = async (committed: boolean): Promise<string[]> => {
                const failures: string[] = []
                const step = async (action: () => Promise<unknown>): Promise<void> => {
                    try {
                        await action()
                    } catch (error) {
                        failures.push(error instanceof Error ? error.message.trim() : 'git failed')
                    }
                }
                if (committed) {
                    await step(() =>
                        before === undefined
                            ? git('update-ref', '-d', 'HEAD')
                            : git('update-ref', 'HEAD', before)
                    )
                }
                await step(() =>
                    before === undefined
                        ? gitOnPaths(['rm', '--quiet', '--cached', '--ignore-unmatch'], paths)
                        : gitOnPaths(['reset', '--quiet', before], paths)
                )
                return failures
            }
            const failed = (what: string, failures: readonly string[]): Error =>
                new Error(
                    failures.length === 0
                        ? what
                        : `${what}. Git could not take the publication back, so correct the copy by hand before the next publication: ${failures.join('; ')}`
                )
            try {
                // With force: a rule of the store that ignores a path must not
                // leave a note out of its own publication.
                await gitOnPaths(['add', '--force'], paths)
                // Only the files of the publication. Other changes of the copy stay out.
                await gitOnPaths(['commit', '--quiet', '--message', message, '--only'], paths)
            } catch (error) {
                throw failed(
                    `the commit into the copy of the content store failed: ${error instanceof Error ? error.message.trim() : 'git failed'}`,
                    await undo(false)
                )
            }
            try {
                // Never with force: when another device pushed first, git refuses.
                await git('push', '--quiet', 'origin', 'HEAD:main')
            } catch {
                throw failed('the push to the content store was refused', await undo(true))
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
