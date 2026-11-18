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

/**
 * The options of the comparison of the copy with its last commit: the line
 * ends are converted as the copy converts them, and the stat data is trusted
 * only in full.
 */
const COMPARE_OPTIONS = [
    '--literal-pathspecs',
    '--no-optional-locks',
    '-c',
    'core.checkStat=default',
    '-c',
    'core.trustctime=true',
    '-c',
    'core.fsmonitor=false'
]

/**
 * How the author gets out, for the files of the copy that are not the files of
 * its last commit. A change of the deny list is work of the author: it is
 * committed, never thrown away. Only the tool writes the manifest.
 */
function waysOut(different: readonly { code: string; path: string }[]): string {
    const ways: string[] = []
    const configuration = different.find((entry) => entry.path === 'configuration.json')
    if (configuration !== undefined) {
        ways.push(
            configuration.code.includes('D')
                ? 'Put configuration.json back with git checkout HEAD -- configuration.json: a commit of its removal would empty the deny list'
                : configuration.code === '??' || configuration.code === '!!'
                  ? 'When configuration.json is your deny list, commit it and push it (git add --force configuration.json, git commit, then git push origin HEAD:main). Else remove it'
                  : configuration.code === 'skipped'
                    ? 'Let git compare configuration.json again (git update-index --no-skip-worktree --no-assume-unchanged configuration.json)'
                    : 'When you changed the deny list, commit configuration.json and push it (git add configuration.json, git commit, then git push origin HEAD:main). Else put the file back with git checkout HEAD -- configuration.json'
        )
    }
    const manifest = different.filter((entry) => entry.path !== 'configuration.json')
    if (manifest.some((entry) => entry.code === 'skipped')) {
        ways.push(
            'Let git compare the files of the manifest again (git update-index --no-skip-worktree --no-assume-unchanged on the files that it skips)'
        )
    }
    if (manifest.some((entry) => entry.code === '??' || entry.code === '!!')) {
        ways.push('Remove the files of manifest/ that the last commit does not have')
    }
    if (manifest.some((entry) => !['skipped', '??', '!!'].includes(entry.code))) {
        ways.push('Put the manifest back with git checkout HEAD -- manifest')
    }
    return `${ways.join('. ')}. Only the tool writes the manifest`
}

function gitContentStore(folder: string): ContentStore {
    /** Runs git in the copy. The input goes to its standard input. */
    const gitWith = async (
        args: readonly string[],
        input: string,
        options: readonly string[] = GIT_OPTIONS
    ): Promise<string> => {
        // Literal paths: a note name with `[`, `*` or `?` must never be read
        // as a pattern that names other files too. No conversion of line
        // ends: a setting of the machine must never change the bytes of a
        // file of the store.
        const running = run('git', [...options, ...args], {
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
                // Only a copy of a content store with no branch yet, whose own
                // branch has no commit yet, has no history to compare.
                let unborn: boolean
                try {
                    await git('symbolic-ref', '--quiet', 'HEAD')
                    unborn =
                        !(await git('rev-parse', '--verify', '--quiet', 'HEAD')
                            .then(() => true)
                            .catch(() => false)) &&
                        (await git('for-each-ref', '--count=1', 'refs/remotes/origin')) === ''
                } catch {
                    unborn = false
                }
                if (!unborn) {
                    throw new Error(
                        `the history of the copy of the content store cannot be read: ${error instanceof Error ? error.message.trim() : 'git failed'}. Correct the copy by hand, for example with git fetch origin: ${folder}`,
                        { cause: error }
                    )
                }
                ahead = '0'
            }
            if (ahead !== '0') {
                // A push is safe only for a change of the configuration alone:
                // a commit of a publication that git could not take back would
                // publish an older state, also for a note under a guard.
                const files = [
                    ...new Set(
                        (
                            await gitRaw(
                                'log',
                                '--format=',
                                '--name-only',
                                '-z',
                                'HEAD',
                                '--not',
                                '--remotes=origin'
                            )
                        )
                            .split('\0')
                            .map((file) => file.trim())
                            .filter((file) => file !== '')
                    )
                ]
                const way =
                    files.length === 1 && files[0] === 'configuration.json'
                        ? 'the commits change configuration.json only: when that is your change of the deny list, push it (git push origin HEAD:main)'
                        : `the commits change other files of the store too (${files.slice(0, 5).join(', ')}), so they can hold a publication that git could not take back, and a push would publish it. Keep a copy of configuration.json when it holds a change of yours, take the commits back (git fetch origin, then git reset --hard origin/main when the copy holds no other work), put your configuration.json back, then commit and push it`
                throw new Error(
                    `the copy of the content store has ${ahead} commit(s) that the content store does not have. Nothing can be published until the copy is corrected: ${way}: ${folder}`
                )
            }
            // The tool reads the state from the files of the copy, so they must
            // be the files of its last commit: a file removed, edited, added or
            // replaced could hide a published note under a guard, or empty the
            // deny list. A file that git skips or assumes unchanged is not
            // compared by git status, so it stops the run too.
            // The line ends are converted as the copy converts them: a file
            // that differs only in its line ends is the same file. The stat
            // data is trusted only in full.
            const changes = await gitWith(
                [
                    'status',
                    '--no-renames',
                    '--porcelain=v1',
                    '-z',
                    '--untracked-files=all',
                    '--ignored',
                    '--',
                    'configuration.json',
                    'manifest'
                ],
                '',
                COMPARE_OPTIONS
            )
            const flags = await gitRaw(
                'ls-files',
                '-v',
                '-z',
                '--',
                'configuration.json',
                'manifest'
            )
            // Git status trusts the stat data of a file: an edit of the same
            // size in the same second can look unchanged. So the text of each
            // file is compared with the commit too, by its hash, with the line
            // ends converted as the copy converts them. A link is compared by
            // git status alone.
            const edited: string[] = []
            if (
                await git('rev-parse', '--verify', '--quiet', 'HEAD').then(
                    () => true,
                    () => false
                )
            ) {
                const tree = await gitRaw(
                    'ls-tree',
                    '-r',
                    '-z',
                    '--full-tree',
                    'HEAD',
                    '--',
                    'configuration.json',
                    'manifest'
                )
                const committed = tree
                    .split('\0')
                    .filter((entry) => entry !== '')
                    .map((entry) => {
                        const tab = entry.indexOf('\t')
                        const [mode, , hash] = entry.slice(0, tab).split(' ')
                        return { mode, hash, path: entry.slice(tab + 1) }
                    })
                    .filter((entry) => entry.mode !== '120000')
                const present: typeof committed = []
                for (const entry of committed) {
                    const kind = await lstat(join(folder, entry.path)).catch(() => undefined)
                    if (kind?.isFile() === true) {
                        present.push(entry)
                    }
                }
                if (present.length > 0) {
                    const hashes = (
                        await gitWith(
                            ['hash-object', '--stdin-paths'],
                            present.map((entry) => entry.path).join('\n') + '\n',
                            COMPARE_OPTIONS
                        )
                    ).split('\n')
                    for (const [index, entry] of present.entries()) {
                        if (hashes[index] !== entry.hash) {
                            edited.push(entry.path)
                        }
                    }
                }
            }
            const different = [
                ...edited.map((path) => ({ code: ' M', path })),
                ...changes
                    .split('\0')
                    .filter((entry) => entry.length > 3)
                    .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) })),
                ...flags
                    .split('\0')
                    .filter((entry) => entry !== '' && !entry.startsWith('H '))
                    .map((entry) => ({ code: 'skipped', path: entry.slice(2) }))
            ]
            if (different.length > 0) {
                throw new Error(
                    `files of the content store in the copy are not the files of its last commit: ${different
                        .slice(0, 5)
                        .map((entry) => entry.path)
                        .join(
                            ', '
                        )}. Nothing can be published until the copy is corrected. ${waysOut(different)}: ${folder}`
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
                if (before === undefined) {
                    // A fresh clone of an empty content store has no index. An
                    // index with no entry would stop a later pull.
                    await step(async () => {
                        if ((await gitRaw('ls-files', '-z')) === '') {
                            await rm(join(folder, '.git', 'index'), { force: true })
                        }
                    })
                }
                return failures
            }
            const failed = (what: string, failures: readonly string[]): Error =>
                new Error(
                    failures.length === 0
                        ? what
                        : `${what}. Git could not take the publication back, so correct the copy by hand before the next publication (${before === undefined ? 'git update-ref -d HEAD' : `git reset --soft ${before}`}): ${failures.join('; ')}`
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
