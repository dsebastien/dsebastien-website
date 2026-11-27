import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
    appendFile,
    link,
    lstat,
    mkdir,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    unlink,
    writeFile
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { toCanonicalJson } from '../canonical.ts'
import { compareCodePoints, sortByCodePoint } from '../order.ts'
import type {
    AttachmentStorage,
    ContentStore,
    Device,
    MainSite,
    NoteTypes,
    LocalStore,
    RenameJournals,
    SealSource,
    Vault,
    VaultEntry
} from '../ports.ts'
import { JOURNAL_FOLDER } from '../renames.ts'
import { parseTreeListing, SEAL_KEY_VARIABLE, SEALED_PATHS, withSeal } from '../seal.ts'
import type { Commit } from '../seal.ts'
import { isChangedByWindows, isRefusedByWindows } from '../names.ts'

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
 * Writes a file in two steps: the text goes into a hidden file of the same
 * folder, which is then renamed to the name of the file. A stop of the
 * process during the write never leaves the file empty or half written. A
 * name that starts with a dot is not part of the vault for the scan and for
 * Obsidian.
 */
/** The number of writes of this process: each one has a hidden file of its own. */
let writes = 0

async function writeWhole(path: string, text: string): Promise<void> {
    // A rename would replace a file that the author made read only: no write
    // bit for anyone, as Rust reads it (`Permissions::readonly`).
    const stats = await lstat(path).catch(() => undefined)
    if (stats !== undefined && (stats.mode & 0o222) === 0) {
        throw new Error(`${path} cannot be written: it is read only`)
    }
    await mkdir(dirname(path), { recursive: true })
    writes += 1
    const temporary = join(
        dirname(path),
        `.vault-publish-${String(process.pid)}-${String(writes)}.tmp`
    )
    await writeFile(temporary, text, 'utf8')
    try {
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true })
        throw error
    }
}

/** The files and the folders of one folder, by name. A symbolic link is neither. */
type Listing = ReadonlyMap<string, 'file' | 'folder'>

/**
 * The vault of a folder. A vault for one run (`listings` given) lists each
 * folder one time and keeps the listing until the end of the run (issue 69):
 * a check of the exact path of a note would else list the folder of each note
 * again. A vault with no `listings` lists the folder at each call.
 */
function folderVault(folder: string, listings?: Map<string, Promise<Listing>>): Vault {
    function listing(path: string): Promise<Listing> {
        const kept = listings?.get(path)
        if (kept !== undefined) {
            return kept
        }
        const read = readdir(join(folder, path), { withFileTypes: true }).then((entries) => {
            const listed = new Map<string, 'file' | 'folder'>()
            for (const entry of entries) {
                // A name that Windows changes would open another entry, also
                // a folder of the deny list (issue 79): it is no entry.
                if (isChangedByWindows(entry.name)) {
                    continue
                }
                // `isFile` and `isDirectory` are false for a symbolic link.
                if (entry.isFile()) {
                    listed.set(entry.name, 'file')
                } else if (entry.isDirectory()) {
                    listed.set(entry.name, 'folder')
                }
            }
            return listed
        })
        // A listing that failed is not kept: the next call tries again.
        listings?.set(path, read)
        read.catch(() => listings?.delete(path))
        return read
    }

    /**
     * What the vault holds at exactly this path: a file, a folder, or nothing.
     *
     * Each part of the path must be a name of the folder listing. A file
     * system that ignores letter case would else open `90 locked shed/` for
     * the folder `90 Locked Shed/` of the deny list. A symbolic link is
     * nothing: it can lead to a file that the guards would refuse, or out of
     * the vault. The listing is the one of the run, and the kind of each part
     * is read again now, so a part that became a link since is nothing too.
     */
    async function exactEntry(path: string): Promise<'file' | 'folder' | undefined> {
        let parent = ''
        let kind: 'file' | 'folder' | undefined
        for (const part of path.split('/')) {
            if (kind === 'file') {
                return undefined
            }
            let entries
            try {
                entries = await listing(parent)
            } catch {
                return undefined
            }
            if (!entries.has(part)) {
                return undefined
            }
            parent = parent === '' ? part : `${parent}/${part}`
            let now
            try {
                now = await lstat(join(folder, parent))
            } catch {
                return undefined
            }
            kind = now.isFile() ? 'file' : now.isDirectory() ? 'folder' : undefined
            if (kind === undefined) {
                return undefined
            }
        }
        return kind
    }

    /** The bytes of the file with exactly this vault path, or `undefined` when there is none. */
    async function bytesOf(path: string): Promise<Uint8Array | undefined> {
        if ((await exactEntry(path)) !== 'file') {
            return undefined
        }
        try {
            return await readFile(join(folder, path))
        } catch (error) {
            // A file that went away during the run is no file.
            if (codeOf(error) === 'ENOENT') {
                return undefined
            }
            throw error
        }
    }

    /** The size of the file with exactly this vault path, or `undefined` when there is none. */
    async function sizeOf(path: string): Promise<number | undefined> {
        if ((await exactEntry(path)) !== 'file') {
            return undefined
        }
        try {
            return (await lstat(join(folder, path))).size
        } catch (error) {
            // A file that went away during the run is no file.
            if (codeOf(error) === 'ENOENT') {
                return undefined
            }
            throw error
        }
    }

    return {
        async list(path) {
            return [...(await listing(path))].map(([name, kind]): VaultEntry => ({ name, kind }))
        },
        async listNames(path) {
            // On Windows, the verbatim form of the path: Windows changes no
            // name in it, so a folder `Sub.` is listed, not the folder `Sub`.
            const exact =
                process.platform === 'win32'
                    ? `\\\\?\\${[resolve(folder), ...(path === '' ? [] : path.split('/'))].join('\\')}`
                    : join(folder, path)
            const entries = await readdir(exact, { withFileTypes: true })
            return entries.flatMap((entry): VaultEntry[] =>
                // `isFile` and `isDirectory` are false for a symbolic link.
                entry.isFile()
                    ? [{ name: entry.name, kind: 'file' }]
                    : entry.isDirectory()
                      ? [{ name: entry.name, kind: 'folder' }]
                      : []
            )
        },
        async read(path) {
            const bytes = await bytesOf(path)
            return bytes === undefined ? undefined : decode(bytes)
        },
        readBytes: bytesOf,
        size: sizeOf,
        hasFolder: async (path) => (await exactEntry(path)) === 'folder',
        async write(path, text, before) {
            // The note is read again right before the write: a note that
            // changed since the tool read it is not written.
            const bytes = await bytesOf(path)
            let now: string | undefined
            try {
                now = bytes === undefined ? undefined : decode(bytes)
            } catch {
                now = undefined
            }
            if (now !== before) {
                return false
            }
            await writeWhole(join(folder, path), text)
            return true
        },
        forRun: () => folderVault(folder, new Map())
    }
}

/** The environment without the variables that point git to another repository. */
function gitEnvironment(): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    )
}

/** The files and the folders of the content store that the tool reads or writes. */
const STATE_PATHS = [
    'configuration.json',
    'edits.json',
    'manifest',
    'notes',
    'renames.json',
    'withdrawn.json'
]

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
/**
 * The code that says best how `configuration.json` differs: `skipped` first,
 * because no `git add` stages a file that git skips, then the code of git
 * status, then the edit that only the hash shows.
 */
function configurationCode(
    different: readonly { code: string; path: string }[]
): string | undefined {
    const codes = different
        .filter((entry) => entry.path === 'configuration.json')
        .map((entry) => entry.code)
    return (
        codes.find((code) => code === 'skipped') ?? codes.find((code) => code !== ' M') ?? codes[0]
    )
}

/**
 * Why git can fail to write a path of the copy on some system (issue 76), or
 * `undefined`: a name that Windows refuses, or a path longer than the 260
 * characters that Windows allows when git does not use long paths.
 */
function unwritableCause(path: string, folder: string): string | undefined {
    // A content store written before decision R82 can hold such a path.
    if (isRefusedByWindows(path)) {
        return 'a name that Windows refuses'
    }
    if (`${folder}/${path}`.length >= 260) {
        return 'a path longer than Windows allows'
    }
    return undefined
}

function waysOut(different: readonly { code: string; path: string }[], folder: string): string {
    const ways: string[] = []
    const configuration = configurationCode(different)
    if (configuration !== undefined) {
        ways.push(
            configuration === 'skipped'
                ? 'Let git compare configuration.json again (git update-index --no-skip-worktree --no-assume-unchanged configuration.json)'
                : configuration.startsWith('A') && configuration.includes('D')
                  ? 'Take configuration.json out of the index (git rm --cached --quiet configuration.json): the last commit has no such file'
                  : configuration.includes('D')
                    ? 'Put configuration.json back with git checkout HEAD -- configuration.json: a commit of its removal would empty the deny list'
                    : configuration.includes('T')
                      ? 'Put configuration.json back with git checkout HEAD -- configuration.json: a link or a folder is not a file of the store'
                      : configuration === '??' || configuration === '!!'
                        ? 'When configuration.json is your deny list, commit it and push it (git add --force configuration.json, git commit, then git push origin HEAD:main), then confirm the new state (confirm-state). Else remove it'
                        : 'When you changed the deny list, commit configuration.json and push it (git add configuration.json, git commit, then git push origin HEAD:main), then confirm the new state (confirm-state). Else put the file back with git checkout HEAD -- configuration.json'
        )
    }
    // The log of the edits of the guards (R69): only the tool writes it.
    const edits = different.filter((entry) => entry.path === 'edits.json')
    if (edits.some((entry) => entry.code === 'skipped')) {
        ways.push(
            'Let git compare edits.json again (git update-index --no-skip-worktree --no-assume-unchanged edits.json)'
        )
    } else if (edits.some((entry) => entry.code.startsWith('A') && entry.code.includes('D'))) {
        ways.push(
            'Take edits.json out of the index (git rm --cached --quiet edits.json): the last commit has no such file'
        )
    } else if (edits.some((entry) => entry.code === '??' || entry.code === '!!')) {
        ways.push('Remove edits.json: the last commit has no such file')
    } else if (edits.length > 0) {
        ways.push(
            'Put edits.json back with git checkout HEAD -- edits.json: only the tool writes the log of the edits of the guards'
        )
    }
    // The keys that the guards withdrew (issue 120): only the tool writes them.
    const withdrawn = different.filter((entry) => entry.path === 'withdrawn.json')
    if (withdrawn.some((entry) => entry.code === 'skipped')) {
        ways.push(
            'Let git compare withdrawn.json again (git update-index --no-skip-worktree --no-assume-unchanged withdrawn.json)'
        )
    } else if (withdrawn.some((entry) => entry.code.startsWith('A') && entry.code.includes('D'))) {
        ways.push(
            'Take withdrawn.json out of the index (git rm --cached --quiet withdrawn.json): the last commit has no such file'
        )
    } else if (withdrawn.some((entry) => entry.code === '??' || entry.code === '!!')) {
        ways.push('Remove withdrawn.json: the last commit has no such file')
    } else if (withdrawn.length > 0) {
        ways.push(
            'Put withdrawn.json back with git checkout HEAD -- withdrawn.json: only the tool writes the keys that the guards withdrew'
        )
    }
    const manifest = different.filter(
        (entry) =>
            !['configuration.json', 'edits.json', 'withdrawn.json'].includes(entry.path) &&
            !entry.path.startsWith('notes/')
    )
    const notes = different.filter((entry) => entry.path.startsWith('notes/'))
    if (notes.some((entry) => entry.code === 'skipped')) {
        ways.push(
            'Let git compare the cleaned notes again (git update-index --no-skip-worktree --no-assume-unchanged on the files that it skips)'
        )
    }
    if (notes.some((entry) => entry.code !== 'skipped')) {
        ways.push(
            'Put the cleaned notes back with git checkout HEAD -- notes: a cleaned note that the copy lost would stay in the content store after its removal'
        )
        const unwritable = notes
            .filter((entry) => entry.code.includes('D'))
            .flatMap((entry) => {
                const cause = unwritableCause(entry.path, folder)
                return cause === undefined ? [] : [`${entry.path} (${cause})`]
            })
        const named = unwritable.length === 0 ? '' : ` Such paths here: ${unwritable.join(', ')}.`
        ways.push(
            `When git checkout fails, git cannot write that path on this system, so the file looks deleted:${named} For a long path on Windows, run git config core.longpaths true in the copy, then git checkout again. For a name that Windows refuses, or two notes whose names differ only in letter case on a system that ignores letter case, rename the note in the vault and publish the rename from a device that can write the path`
        )
    }
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

/** The content store cannot be reached: no network, or no such repository. */
class Unreachable extends Error {}

function gitContentStore(folder: string, program = 'git'): ContentStore {
    /** Runs git in the copy. The input goes to its standard input. */
    const gitWith = async (
        args: readonly string[],
        input: string | Uint8Array,
        options: readonly string[] = GIT_OPTIONS
    ): Promise<string> => {
        // Literal paths: a note name with `[`, `*` or `?` must never be read
        // as a pattern that names other files too. No conversion of line
        // ends: a setting of the machine must never change the bytes of a
        // file of the store.
        const running = run(program, [...options, ...args], {
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
    /** Throws when the folder is not the root of its own git repository: git would else work on the repository that holds it. */
    const checkRoot = async (): Promise<void> => {
        let top: string
        try {
            top = await git('rev-parse', '--show-toplevel')
        } catch {
            top = ''
        }
        if (top === '' || (await realpath(top)) !== (await realpath(folder))) {
            throw new Error(
                `the copy of the content store is not the root of a git repository: ${folder}`
            )
        }
    }
    /** The commit of the copy, or `undefined` when it has none. */
    const headOf = (): Promise<string | undefined> =>
        git('rev-parse', '--verify', '--quiet', 'HEAD').then(
            (head) => head,
            () => undefined
        )
    /**
     * Fetches the branch `main` of the content store. The fetch names the
     * branch: the fetch setting of the copy could else leave origin/main as it
     * was (a setting removed or changed by hand), and a copy that is behind
     * would look up to date. A content store with no branch yet has nothing to
     * fetch. It throws `Unreachable` when the content store cannot be reached.
     */
    const fetchMain = async (): Promise<void> => {
        let remote: string
        try {
            remote = await git('ls-remote', '--quiet', 'origin', 'refs/heads/main')
            if (remote !== '') {
                await gitRaw(
                    'fetch',
                    '--quiet',
                    'origin',
                    '+refs/heads/main:refs/remotes/origin/main'
                )
            }
        } catch (error) {
            throw new Unreachable(
                `the content store cannot be reached (git fetch origin failed: ${error instanceof Error ? error.message.trim() : 'git failed'}). A publication fetches it first, so that a copy that is behind is never used: ${folder}`,
                { cause: error }
            )
        }
        const known = await git(
            'rev-parse',
            '--verify',
            '--quiet',
            'refs/remotes/origin/main'
        ).then(
            () => true,
            () => false
        )
        if (remote === '' && known) {
            throw new Error(
                `the content store has no branch main, but the copy knows one (refs/remotes/origin/main). Nothing can be published until the copy is corrected by hand: ${folder}`
            )
        }
    }
    /**
     * What a push of the copy would change in the content store: each file
     * with its code (`A`, `M`, `D`, `T`), sorted by path. The commits alone do
     * not say it: a commit that removes the configuration names only that
     * file, and a merge commit names no file.
     */
    const pushedChanges = async (): Promise<{ code: string; path: string }[]> => {
        const hasBranch = await git(
            'rev-parse',
            '--verify',
            '--quiet',
            'refs/remotes/origin/main'
        ).then(
            () => true,
            () => false
        )
        const fields = hasBranch
            ? (
                  await gitRaw(
                      'diff',
                      '--no-renames',
                      '--name-status',
                      '-z',
                      'refs/remotes/origin/main',
                      'HEAD'
                  )
              )
                  .split('\0')
                  .filter((field) => field !== '')
            : // The content store has no branch yet: a push adds every file.
              (await gitRaw('ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD'))
                  .split('\0')
                  .filter((path) => path !== '')
                  .flatMap((path) => ['A', path])
        const files: { code: string; path: string }[] = []
        for (let index = 0; index + 1 < fields.length; index += 2) {
            files.push({ code: fields[index] ?? '', path: fields[index + 1] ?? '' })
        }
        return files.sort((left, right) => compareCodePoints(left.path, right.path))
    }
    /**
     * True when the file, with each carriage return and line feed made a line
     * feed, has this hash. A copy that converts line ends writes the files of
     * its commit with Windows line ends. In a valid JSON text a line end is
     * only white space, so both texts say the same.
     */
    const sameWithUnixLineEnds = async (path: string, hash: string): Promise<boolean> => {
        const bytes = await readFile(join(folder, path))
        const unix: number[] = []
        let converted = false
        for (const [index, byte] of bytes.entries()) {
            if (byte === 0x0d && bytes[index + 1] === 0x0a) {
                converted = true
                continue
            }
            unix.push(byte)
        }
        return (
            converted &&
            (
                await gitWith(['hash-object', '--no-filters', '--stdin'], Uint8Array.from(unix))
            ).trim() === hash
        )
    }
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
        async verify(fetch) {
            let reached = true
            await checkRoot()
            // A folder with no origin is no clone of the content store (R67).
            const origin = await git('remote', 'get-url', 'origin').then(
                (url) => url,
                () => ''
            )
            if (origin === '') {
                throw new Error(
                    `the copy of the content store has no origin: it is not a clone of the content store: ${folder}`
                )
            }
            const exists = (ref: string): Promise<boolean> =>
                git('rev-parse', '--verify', '--quiet', ref).then(
                    () => true,
                    () => false
                )
            if (fetch !== 'none') {
                try {
                    await fetchMain()
                } catch (error) {
                    // Without a network a plan uses the last fetch (PERF-16):
                    // its publication fetches again.
                    if (fetch === 'must' || !(error instanceof Unreachable)) {
                        throw error
                    }
                    reached = false
                }
            }
            // How far the copy is behind the content store, at the last fetch.
            const hasMain = await exists('refs/remotes/origin/main')
            const hasHead = await exists('HEAD')
            // A copy with no branch of its own that leads to a commit (a clone
            // of a content store that had no branch yet, or a copy made with
            // git init) has no commit ahead. An orphan branch in a copy with
            // commits is not such a copy.
            const noCommit =
                !hasHead &&
                (await git('for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads')) === ''
            const behind = hasMain
                ? Number(
                      await git(
                          'rev-list',
                          '--count',
                          hasHead ? 'HEAD..refs/remotes/origin/main' : 'refs/remotes/origin/main'
                      )
                  )
                : 0
            // A commit that a failed publication could not take back would be
            // pushed by the next one, also for a note that came under a guard.
            // A commit that a branch of the content store has is not ahead.
            // A copy with no commit, of a content store with a branch, has no
            // commit ahead: it is behind.
            let ahead: string
            try {
                if (noCommit && hasMain) {
                    throw new Error('no commit')
                }
                ahead = await git('rev-list', '--count', 'HEAD', '--not', '--remotes=origin')
            } catch (error) {
                // Only a copy of a content store with no branch yet, whose own
                // branch has no commit yet, has no history to compare.
                let unborn: boolean
                try {
                    await git('symbolic-ref', '--quiet', 'HEAD')
                    unborn =
                        noCommit &&
                        (hasMain ||
                            (await git('for-each-ref', '--count=1', 'refs/remotes/origin')) === '')
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
                const files = await pushedChanges()
                const safe =
                    files.length === 0 ||
                    (files.length === 1 &&
                        files[0]?.path === 'configuration.json' &&
                        (files[0].code === 'M' || files[0].code === 'A'))
                const way = safe
                    ? 'a push changes configuration.json only, and does not remove it: when that is your change of the deny list, push it (git push origin HEAD:main), then confirm the new state (confirm-state)'
                    : `a push would change other files of the store too, or remove the configuration (${files
                          .slice(0, 5)
                          .map((file) => file.path)
                          .join(
                              ', '
                          )}), so the commits can hold a publication that git could not take back, or take back a publication of another device. Keep a copy of configuration.json when it holds a change of yours, take the commits back (git fetch origin, then git reset --hard origin/main when the copy holds no other work), put your configuration.json back, then commit and push it, then confirm the new state (confirm-state)`
                throw new Error(
                    `the copy of the content store has ${ahead} commit(s) that the content store does not have. Nothing can be published until the copy is corrected: ${way}: ${folder}`
                )
            }
            // A link in the last commit is no file of the store: git writes it
            // as a link where it can, and a removal or a write through it would
            // leave the copy (issue 79). The check stops on it, on every system.
            if (hasHead) {
                const linked = (
                    await gitRaw('ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', ...STATE_PATHS)
                )
                    .split('\0')
                    .filter((entry) => entry.startsWith('120000 '))
                    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
                if (linked.length > 0) {
                    throw new Error(
                        `${linked.slice(0, 5).join(', ')} of the last commit of the content store is a symbolic link: the tool follows no link in the copy. Nothing can be published until the link is removed from the content store by hand: ${folder}`
                    )
                }
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
                    'edits.json',
                    'manifest',
                    'renames.json',
                    'withdrawn.json'
                ],
                '',
                COMPARE_OPTIONS
            )
            // The cleaned notes that the last commit has: one that the copy
            // removed or edited would stay in the content store, because a
            // removal stages only what it removes. A file that the commit
            // does not have is never committed, so it is not compared.
            const notes = await gitWith(
                [
                    'status',
                    '--no-renames',
                    '--porcelain=v1',
                    '-z',
                    '--untracked-files=no',
                    '--',
                    'notes'
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
                'edits.json',
                'manifest',
                'renames.json',
                'withdrawn.json',
                'notes'
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
                    'edits.json',
                    'manifest',
                    'renames.json',
                    'withdrawn.json'
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
                    // The bytes that the tool reads, with no filter and no
                    // attribute of git: a filter could make other bytes look
                    // like the commit.
                    const hashes = (
                        await gitWith(
                            ['hash-object', '--no-filters', '--stdin-paths'],
                            present.map((entry) => entry.path).join('\n') + '\n'
                        )
                    ).split('\n')
                    for (const [index, entry] of present.entries()) {
                        if (
                            hashes[index] !== entry.hash &&
                            !(await sameWithUnixLineEnds(entry.path, entry.hash ?? ''))
                        ) {
                            edited.push(entry.path)
                        }
                    }
                }
            }
            const different = [
                ...edited.map((path) => ({ code: ' M', path })),
                ...`${changes}${notes}`
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
                    `files of the content store in the copy are not the files of its last commit: ${[
                        ...new Set(different.map((entry) => entry.path))
                    ]
                        .slice(0, 5)
                        .join(
                            ', '
                        )}. Nothing can be published until the copy is corrected. ${waysOut(different, folder)}: ${folder}`
                )
            }
            return { behind, reached }
        },
        async head() {
            return await headOf()
        },
        async recover(head, paths, plan, ownLock) {
            await checkRoot()
            const now = await headOf()
            const journal = new Set(paths)
            /** Puts each path of the journal back as this commit has it, in the work tree and in the index. */
            const putBack = async (commit: string | undefined): Promise<void> => {
                const inCommit = new Set(
                    commit === undefined
                        ? []
                        : (
                              await gitRaw(
                                  'ls-tree',
                                  '-r',
                                  '-z',
                                  '--name-only',
                                  '--full-tree',
                                  commit
                              )
                          )
                              .split('\0')
                              .filter((path) => path !== '')
                )
                const back = paths.filter((path) => inCommit.has(path))
                const gone = paths.filter((path) => !inCommit.has(path))
                if (commit !== undefined && back.length > 0) {
                    await gitOnPaths(['checkout', commit], back)
                }
                for (const path of gone) {
                    await refuseLinks(path)
                    await rm(join(folder, path), { force: true })
                }
                if (gone.length > 0) {
                    await gitOnPaths(['rm', '--quiet', '--cached', '--ignore-unmatch'], gone)
                }
                if (commit === undefined && (await gitRaw('ls-files', '-z')) === '') {
                    // A fresh clone of an empty content store has no index. An
                    // index with no entry would stop a later pull.
                    await rm(join(folder, '.git', 'index'), { force: true })
                }
            }
            if (now === head) {
                // Another run can have taken the copy (issue 75): nothing more is written.
                await ownLock()
                await putBack(head)
                return 'undone'
            }
            const byHand = `a publication stopped halfway, and the history of the copy of the content store cannot be put back by the tool. Correct the copy by hand (git fetch origin, then git reset --hard origin/main when the copy holds no other work), then remove .git/vault-publish/journal.json: ${folder}`
            if (now === undefined) {
                throw new Error(byHand)
            }
            if (head !== undefined) {
                const known = await git('merge-base', '--is-ancestor', head, now).then(
                    () => true,
                    () => false
                )
                if (!known) {
                    throw new Error(byHand)
                }
            }
            // The commit of the run: the first commit after head on the line
            // of first parents, when it names the plan and changes only paths
            // of the journal. A commit of another device is never taken for it.
            const line = (
                await git(
                    'rev-list',
                    '--first-parent',
                    '--reverse',
                    head === undefined ? now : `${head}..${now}`
                )
            )
                .split('\n')
                .filter((commit) => commit !== '')
            const first = line[0]
            let ofTheRun = false
            if (first !== undefined) {
                const message = await git('log', '-1', '--format=%B', first)
                const changed = (
                    await gitRaw(
                        'diff-tree',
                        '--no-commit-id',
                        '--name-only',
                        '-r',
                        '-z',
                        '--root',
                        '--no-renames',
                        first
                    )
                )
                    .split('\0')
                    .filter((path) => path !== '')
                ofTheRun =
                    message.split('\n').includes(`Plan: ${plan}`) &&
                    changed.every((path) => journal.has(path))
            }
            if (!ofTheRun || first === undefined) {
                // The run made no commit, and other commits came after head.
                await ownLock()
                await putBack(now)
                return 'undone'
            }
            // The fetch can be slow: another run can take the copy meanwhile.
            await ownLock()
            try {
                await fetchMain()
            } catch (error) {
                throw new Error(
                    `a publication stopped halfway after its commit, and the tool must reach the content store to know whether its push arrived: ${error instanceof Error ? error.message : 'git failed'}`,
                    { cause: error }
                )
            }
            const pushed = await git(
                'merge-base',
                '--is-ancestor',
                first,
                'refs/remotes/origin/main'
            ).then(
                () => true,
                () => false
            )
            if (pushed) {
                return 'pushed'
            }
            if (first !== now) {
                throw new Error(byHand)
            }
            // The tool never pushes an old commit: it can be older than a
            // guard that the author added since.
            await ownLock()
            await (head === undefined
                ? git('update-ref', '-d', 'HEAD')
                : git('update-ref', 'HEAD', head))
            await putBack(head)
            return 'undone'
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
        async write(path, text) {
            // A link in a parent folder would take the write out of the copy.
            await refuseLinks(path)
            await writeText(join(folder, path), text)
        },
        async remove(path) {
            // A link as the file itself leaves the store, but a link in a
            // parent folder would take the removal out of the copy.
            const parent = path.split('/').slice(0, -1).join('/')
            if (parent !== '') {
                await refuseLinks(parent)
            }
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
        async commits(limit) {
            if ((await headOf()) === undefined) {
                return []
            }
            // Each commit: its id, its parents and its message, each ended by a NUL.
            const fields = (
                await gitRaw(
                    'log',
                    '--first-parent',
                    '-z',
                    `--max-count=${String(limit)}`,
                    '--format=%H%x00%P%x00%B',
                    'HEAD'
                )
            ).split('\0')
            const commits: Commit[] = []
            for (let index = 0; index + 2 < fields.length; index += 3) {
                const parent = (fields[index + 1] ?? '').split(' ')[0] ?? ''
                commits.push({
                    id: (fields[index] ?? '').trim(),
                    parent: parent === '' ? undefined : parent,
                    message: fields[index + 2] ?? ''
                })
            }
            return commits
        },
        async files(commit, paths) {
            return parseTreeListing(
                await gitRaw('ls-tree', '-r', '-z', '--full-tree', commit, '--', ...paths)
            )
        },
        async readAt(commit, path) {
            const spec = `${commit}:${path}`
            const exists = await git('cat-file', '-e', spec).then(
                () => true,
                () => false
            )
            return exists ? await gitRaw('cat-file', 'blob', spec) : undefined
        },
        async commitAndPush(message, paths, seal) {
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
            // The commit that this publication made, once it exists.
            let made: string | undefined = undefined
            const undo = async (committed: boolean): Promise<string[]> => {
                const failures: string[] = []
                const step = async (action: () => Promise<unknown>): Promise<void> => {
                    try {
                        await action()
                    } catch (error) {
                        failures.push(error instanceof Error ? error.message.trim() : 'git failed')
                    }
                }
                // The branch goes back only when it is still at the commit of
                // this publication: another run can have moved it.
                if (committed && made !== undefined) {
                    const commit = made
                    await step(() =>
                        before === undefined
                            ? git('update-ref', '-d', 'HEAD', commit)
                            : git('update-ref', 'HEAD', before, commit)
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
            /** Makes a commit of this tree on top of the commit before the run, with the sealed message. */
            const sealedCommit = async (
                tree: string,
                sealer: NonNullable<typeof seal>
            ): Promise<string> => {
                const files = parseTreeListing(
                    await gitRaw('ls-tree', '-r', '-z', '--full-tree', tree, '--', ...SEALED_PATHS)
                )
                const text = withSeal(message, sealer(before, files))
                const parent = before === undefined ? [] : ['-p', before]
                return (await gitWith(['commit-tree', tree, ...parent, '-F', '-'], text)).trim()
            }
            if (paths.length === 0) {
                // A commit with no change of a file (the confirmation of the
                // state, R104): on top of the last commit, with its tree.
                if (seal === undefined || before === undefined) {
                    throw new Error('a commit with no file needs a seal and a commit before it')
                }
                const last = before
                try {
                    const commit = await sealedCommit(
                        await git('rev-parse', `${last}^{tree}`),
                        seal
                    )
                    await git('update-ref', 'HEAD', commit, last)
                    made = commit
                } catch (error) {
                    throw failed(
                        `the commit into the copy of the content store failed: ${error instanceof Error ? error.message.trim() : 'git failed'}`,
                        []
                    )
                }
                try {
                    await git('push', '--quiet', 'origin', `${made}:refs/heads/main`)
                } catch {
                    // No path to unstage: only the branch goes back.
                    const commit = made
                    const failures = await git('update-ref', 'HEAD', last, commit).then(
                        () => [],
                        (error: unknown) => [
                            error instanceof Error ? error.message.trim() : 'git failed'
                        ]
                    )
                    throw failed('the push to the content store was refused', failures)
                }
                return
            }
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
            made = await headOf()
            // The commit holds exactly the files that changed, on top of the
            // commit before the run: another run that changed the copy in the
            // middle (after an unlock) can never get a commit through that
            // misses a forced removal.
            const parents =
                made === undefined
                    ? []
                    : (await git('rev-list', '--parents', '--max-count=1', made))
                          .split(' ')
                          .slice(1)
            const changed =
                made === undefined
                    ? []
                    : (
                          await gitRaw(
                              'diff-tree',
                              '--no-commit-id',
                              '--name-only',
                              '-r',
                              '-z',
                              '--root',
                              '--no-renames',
                              made
                          )
                      )
                          .split('\0')
                          .filter((path) => path !== '')
                          .sort(compareCodePoints)
            const wanted = [...new Set(paths)].sort(compareCodePoints)
            const onTop =
                before === undefined
                    ? parents.length === 0
                    : parents.length === 1 && parents[0] === before
            if (made === undefined || !onTop || changed.join('\0') !== wanted.join('\0')) {
                throw failed(
                    'the commit of this publication does not hold exactly its files on top of the commit before it: another run changed the copy during the publication. Nothing is pushed',
                    await undo(true)
                )
            }
            if (seal !== undefined) {
                // The same tree and parent, with the seal as the last line of
                // the message (R104): the branch moves from one to the other.
                const unsealed = made
                try {
                    const sealed = await sealedCommit(
                        await git('rev-parse', `${unsealed}^{tree}`),
                        seal
                    )
                    await git('update-ref', 'HEAD', sealed, unsealed)
                    made = sealed
                } catch (error) {
                    throw failed(
                        `the seal of the commit failed: ${error instanceof Error ? error.message.trim() : 'git failed'}`,
                        await undo(true)
                    )
                }
            }
            try {
                // Never with force: when another device pushed first, git
                // refuses. The commit of this run, by its hash: another run can
                // have moved the branch of the copy.
                await git('push', '--quiet', 'origin', `${made}:refs/heads/main`)
            } catch {
                throw failed('the push to the content store was refused', await undo(true))
            }
        }
    }
}

/** The form of a key of the attachment storage: the SHA-256 of the bytes of a file. */
const ATTACHMENT_KEY = /^[0-9a-f]{64}$/

/**
 * The attachment storage of a folder. Its files are directly in the folder,
 * named by their keys. A file is written under another name first and then
 * renamed, so a key never names a part of a file.
 */
function folderAttachmentStorage(folder: string): AttachmentStorage {
    /** The path of a file of the storage. A name never leaves the folder. */
    function pathOf(name: string): string {
        if (
            name === '' ||
            name === '.' ||
            name === '..' ||
            name.includes('/') ||
            name.includes('\\')
        ) {
            throw new Error(`"${name}" is not the name of a file of the attachment storage`)
        }
        return join(folder, name)
    }
    return {
        async list() {
            const entries = await readdir(folder, { withFileTypes: true })
            // `isFile` is false for a symbolic link and for a folder.
            return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
        },
        async put(key, bytes) {
            if (!ATTACHMENT_KEY.test(key)) {
                throw new Error(`"${key}" is not a key of the attachment storage`)
            }
            const part = pathOf(`.${key}.part`)
            await writeFile(part, bytes)
            try {
                await rename(part, pathOf(key))
            } catch (error) {
                await rm(part, { force: true })
                throw error
            }
        },
        async remove(name) {
            try {
                await unlink(pathOf(name))
                return true
            } catch (error) {
                if (codeOf(error) === 'ENOENT') {
                    return false
                }
                throw error
            }
        }
    }
}

/** The text of a file, or `undefined` when it does not exist. */
async function textOrNothing(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8')
    } catch (error) {
        if (codeOf(error) === 'ENOENT') {
            return undefined
        }
        throw error
    }
}

/**
 * True when a process with this number runs on this computer. A number that
 * the system gave again to another process counts as running: the lock then
 * stays, the safe way.
 */
export function processRuns(id: number): boolean {
    try {
        process.kill(id, 0)
        return true
    } catch (error) {
        // EPERM: the process runs, as another user.
        return codeOf(error) === 'EPERM'
    }
}

/** The system of this computer, as the Rust program names it (`std::env::consts::OS`). */
export const SYSTEM: string =
    ({ win32: 'windows', darwin: 'macos' } as Record<string, string>)[process.platform] ??
    process.platform

/** What the text of a lock says of its run. */
export interface LockHolder {
    readonly command?: string
    /** The number of the process of the run. */
    readonly process?: number
    /** The name of the computer of the run. */
    readonly host?: string
    /** The system of the run: `windows`, `linux` (WSL too) or `macos`. */
    readonly system?: string
}

/** What the text of a lock says of its run: what it names of these, when it names them. */
export function lockHolderOf(text: string): LockHolder {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return {}
    }
    if (typeof value !== 'object' || value === null) {
        return {}
    }
    const {
        command,
        host,
        process: id,
        system
    } = value as { command?: unknown; host?: unknown; process?: unknown; system?: unknown }
    return {
        ...(typeof command === 'string' ? { command } : {}),
        ...(typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? { process: id } : {}),
        ...(typeof host === 'string' ? { host } : {}),
        ...(typeof system === 'string' ? { system } : {})
    }
}

/** True when the lock names this computer and this system: a process of another one cannot be seen. */
export function isLockOfThisComputer(holder: LockHolder): boolean {
    return holder.host?.toLowerCase() === hostname().toLowerCase() && holder.system === SYSTEM
}

/**
 * True for the lock of a check or a pull of this computer whose process no
 * longer runs: such a run writes nothing that a later run must put back, so
 * its lock goes away by itself (R46 as the author amended it, R81), unless
 * git left a lock file in the copy (`gitLeftLock`). The lock
 * of a publication, a takedown, an edit or a plan always waits for the
 * author, and so does a lock of another computer or of WSL.
 */
function isStaleLock(text: string): boolean {
    const holder = lockHolderOf(text)
    return (
        (holder.command === 'check' || holder.command === 'pull') &&
        holder.process !== undefined &&
        isLockOfThisComputer(holder) &&
        !processRuns(holder.process)
    )
}

/**
 * The age after which an empty lock is the lock of a run that stopped between
 * the create of the file and the write of its text: both take a few
 * milliseconds.
 */
export const EMPTY_LOCK_STALE_AFTER_MS = 60_000

/**
 * True when the lock is empty and older than `EMPTY_LOCK_STALE_AFTER_MS`:
 * no run holds it, and every face removes it (the Rust twin is
 * `is_stale_empty_lock` of `cli/src/device.rs`).
 */
export function isStaleEmptyLock(text: string, ageMilliseconds: number): boolean {
    return text === '' && ageMilliseconds > EMPTY_LOCK_STALE_AFTER_MS
}

/** How long ago the file was last written, in milliseconds; 0 when it cannot be read. */
async function ageOf(path: string): Promise<number> {
    const stats = await lstat(path).catch(() => undefined)
    return stats === undefined ? 0 : Date.now() - stats.mtimeMs
}

/**
 * True when git left a lock file in the copy (`.git/index.lock`, or a
 * `*.lock` file below `.git/refs`): a git that was stopped in the middle of
 * a check or a pull leaves one, so the lock of the device waits for the
 * author then. A folder that cannot be read counts as a lock.
 */
async function gitLeftLock(contentStore: string): Promise<boolean> {
    const git = join(contentStore, '.git')
    if ((await lstat(join(git, 'index.lock')).catch(() => undefined)) !== undefined) {
        return true
    }
    try {
        const entries = await readdir(join(git, 'refs'), { recursive: true, withFileTypes: true })
        return entries.some((entry) => entry.name.endsWith('.lock'))
    } catch (error) {
        return codeOf(error) !== 'ENOENT'
    }
}

/**
 * The plans, the lock and the run journal are in the git folder of the copy:
 * on the device, never in a commit, never in the vault.
 */
function folderLocalStore(contentStore: string): LocalStore {
    const folder = join(contentStore, '.git', 'vault-publish')
    const plans = join(folder, 'plans')
    const lockFile = join(folder, 'lock')
    const journalFile = join(folder, 'journal.json')
    /**
     * Removes the lock when it still holds this text. It is renamed first, so
     * that a lock that another run took meanwhile is never removed: that one
     * is put back. True when the stale lock is gone.
     */
    const removeStale = async (held: string): Promise<boolean> => {
        const aside = join(folder, `lock.${randomUUID()}.stale`)
        try {
            await rename(lockFile, aside)
        } catch {
            return false
        }
        if ((await textOrNothing(aside)) === held) {
            await rm(aside, { force: true })
            return true
        }
        // The lock of another run goes back, unless a third run took the lock
        // meanwhile: the other run then stops at its next check of its lock.
        await link(aside, lockFile).catch(() => undefined)
        await rm(aside, { force: true })
        return false
    }
    return {
        save: (id, record) => writeText(join(plans, `${id}.json`), record),
        async load(id) {
            try {
                return await readFile(join(plans, `${id}.json`), 'utf8')
            } catch {
                return undefined
            }
        },
        async lock(holder) {
            // A folder that is not a copy gets no `.git` folder.
            const git = await lstat(join(contentStore, '.git')).catch(() => undefined)
            if (git?.isDirectory() !== true) {
                throw new Error(
                    `the copy of the content store is not the root of a git repository: ${contentStore}`
                )
            }
            await mkdir(folder, { recursive: true })
            // A token that no other run has: two runs of one process, in the
            // same second, never hold the same text.
            const text = toCanonicalJson({
                ...holder,
                host: hostname(),
                process: process.pid,
                system: SYSTEM,
                token: randomUUID()
            })
            // A stale lock of a check or a pull, and a lock that a run left
            // empty, go away by themselves, one time.
            for (let tries = 0; ; tries += 1) {
                try {
                    // One create, never a test and then a write: two runs that
                    // start at the same moment cannot both take the lock.
                    await writeFile(lockFile, text, { encoding: 'utf8', flag: 'wx' })
                    return { taken: true, text }
                } catch (error) {
                    if (codeOf(error) !== 'EEXIST') {
                        throw error
                    }
                }
                const held = await textOrNothing(lockFile)
                const stale =
                    held !== undefined &&
                    (isStaleEmptyLock(held, await ageOf(lockFile)) ||
                        (isStaleLock(held) && !(await gitLeftLock(contentStore))))
                if (held === undefined || tries > 0 || !stale || !(await removeStale(held))) {
                    return { taken: false, text: held ?? 'a lock that went away' }
                }
            }
        },
        async release(text) {
            if ((await textOrNothing(lockFile)) === text) {
                await rm(lockFile, { force: true })
            }
        },
        async readLock() {
            // A lock that a run left empty holds no run: it is no lock.
            const text = await textOrNothing(lockFile)
            return text !== undefined && isStaleEmptyLock(text, await ageOf(lockFile))
                ? undefined
                : text
        },
        async unlock() {
            try {
                await unlink(lockFile)
                return true
            } catch (error) {
                if (codeOf(error) === 'ENOENT') {
                    return false
                }
                throw error
            }
        },
        saveJournal: (text) => writeWhole(journalFile, text),
        loadJournal: () => textOrNothing(journalFile),
        async removeJournal() {
            await rm(journalFile, { force: true })
        }
    }
}

/**
 * The rename journals of a folder: its files, as they are. A folder that does
 * not exist has none. A folder below it and a symbolic link are no journal.
 */
export function folderRenameJournals(folder: string): RenameJournals {
    const missing = (error: unknown): boolean =>
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    return {
        async list() {
            try {
                return (await readdir(folder, { withFileTypes: true }))
                    .filter((entry) => entry.isFile())
                    .map((entry) => entry.name)
            } catch (error) {
                if (missing(error)) {
                    return []
                }
                throw new Error(
                    `the folder of the rename journals "${folder}" cannot be listed: ${error instanceof Error ? error.message : 'it failed'}`,
                    { cause: error }
                )
            }
        },
        async read(name) {
            const path = join(folder, name)
            try {
                if (!(await lstat(path)).isFile()) {
                    return undefined
                }
                return new Uint8Array(await readFile(path))
            } catch (error) {
                if (missing(error)) {
                    return undefined
                }
                throw new Error(
                    `the rename journal "${name}" cannot be read: ${error instanceof Error ? error.message : 'it failed'}`,
                    { cause: error }
                )
            }
        }
    }
}

/**
 * The rename journals of every configuration folder of a vault (decision of
 * the author R82): each folder at the root of the vault whose name starts
 * with a dot, with `plugins/dsebastien-vault-publish/renames` in it, so a
 * device whose configuration folder of Obsidian has another name is read too.
 * A name in more than one folder is the file with the most bytes, then the
 * one of the first folder in the order of the code points: a copy of a
 * configuration folder holds an older journal of the same device.
 */
export function vaultRenameJournals(vault: string): RenameJournals {
    const folders = async (): Promise<RenameJournals[]> => {
        let entries
        try {
            entries = await readdir(vault, { withFileTypes: true })
        } catch (error) {
            throw new Error(
                `the vault "${vault}" cannot be listed for the rename journals: ${error instanceof Error ? error.message : 'it failed'}`,
                { cause: error }
            )
        }
        return sortByCodePoint(
            entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('.'))
                .map((entry) => entry.name)
        ).map((name) => folderRenameJournals(join(vault, name, JOURNAL_FOLDER)))
    }
    return {
        async list() {
            const names = new Set<string>()
            for (const folder of await folders()) {
                for (const name of await folder.list()) {
                    names.add(name)
                }
            }
            return [...names]
        },
        async read(name) {
            let best: Uint8Array | undefined
            for (const folder of await folders()) {
                const bytes = await folder.read(name)
                if (bytes !== undefined && (best === undefined || bytes.length > best.length)) {
                    best = bytes
                }
            }
            return best
        }
    }
}

/** No note has a type: the answer of a Starter Kit with no note type. */
export const NO_NOTE_TYPES: NoteTypes = {
    recognize: (paths) =>
        Promise.resolve({
            noteTypes: [],
            notes: paths.map((path) => ({ path, noteType: null }))
        })
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The Starter Kit of the tests: it answers from a file in place of the
 * plugin (`documentation/Canonical Form.md`, "The note type of a note"). The
 * file is an object with `noteTypes`, the list of the types as the Starter
 * Kit gives them, and `notes`, the `name` of the type of each vault path; a
 * path that the file does not name has no type. The file is read again at
 * each question, so a test can change it between two runs. A missing file is
 * a missing Starter Kit. With `asked`, each question is added to that file,
 * one line of JSON per question, before the answers are read. The Rust twin is the switch
 * `DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES` of its debug build.
 */
export function fileNoteTypes(file: string, asked?: string): NoteTypes {
    return {
        async recognize(paths) {
            // The question is kept first, when the test names a file for the
            // questions, so that it sees which notes were asked, also of a
            // missing Starter Kit.
            if (asked !== undefined) {
                await appendFile(asked, `${JSON.stringify(paths)}\n`)
            }
            const data: unknown = JSON.parse(await readFile(file, 'utf8'))
            const types =
                isRecord(data) && Array.isArray(data['noteTypes']) ? data['noteTypes'] : []
            const named = isRecord(data) && isRecord(data['notes']) ? data['notes'] : {}
            const notes = paths.map((path) => {
                const name = named[path]
                return { path, noteType: typeof name === 'string' ? name : null }
            })
            const used = new Set(notes.map((note) => note.noteType))
            return {
                noteTypes: types.filter(
                    (type) =>
                        isRecord(type) && typeof type['name'] === 'string' && used.has(type['name'])
                ),
                notes
            }
        }
    }
}

/**
 * The main site of the tests: it answers from a file in place of the network
 * (PUB-100). The file is an object with `answers`: for each URL that the
 * check asks for, a page (`status`, `url`, `body`) or `{ "failure": <text> }`.
 * A URL that the file does not name has no answer. The file is read again at
 * each request. The Rust twin is the switch
 * `DSEBASTIEN_VAULT_PUBLISH_TEST_MAIN_SITE` of its debug build.
 */
export function fileMainSite(file: string): MainSite {
    return {
        async page(url) {
            const data: unknown = JSON.parse(await readFile(file, 'utf8'))
            const answers = isRecord(data) && isRecord(data['answers']) ? data['answers'] : {}
            const answer = answers[url]
            if (!isRecord(answer)) {
                throw new Error('the main site gave no answer')
            }
            if (typeof answer['failure'] === 'string') {
                throw new Error(answer['failure'])
            }
            const { status, url: last, body } = answer
            if (
                typeof status !== 'number' ||
                typeof last !== 'string' ||
                typeof body !== 'string'
            ) {
                throw new Error(`the answer for ${url} in ${file} is not a page`)
            }
            return { status, url: last, body }
        }
    }
}

/**
 * Makes a device from three folders.
 *
 * @param options.vault the folder of the vault
 * @param options.contentStore the folder of the copy of the content store: a git clone whose `origin` is the content store
 * @param options.attachmentStorage the folder of the attachment storage
 * @param options.noteTypes the Starter Kit of the device; by default no note has a type
 * @param options.renames the folder of the rename journals; by default those of every configuration folder of the vault
 * @param options.git the git program; by default `git` of the path of the system
 * @param options.mainSite the main site, for the check of the originals; by default none: no post is checked
 */
/**
 * The source of the seal key of a vault (R104): the variable of the
 * environment of the process, else the `.env` file at the root of the vault.
 * Both are read at each check, never kept.
 */
export function vaultSealSource(vault: string): SealSource {
    return {
        environment: () => process.env[SEAL_KEY_VARIABLE],
        envFile: () => textOrNothing(join(vault, '.env'))
    }
}

export function nodeDevice(options: {
    vault: string
    contentStore: string
    attachmentStorage: string
    noteTypes?: NoteTypes
    renames?: string
    git?: string
    mainSite?: MainSite
}): Device {
    return {
        vault: folderVault(options.vault),
        renames:
            options.renames === undefined
                ? vaultRenameJournals(options.vault)
                : folderRenameJournals(options.renames),
        store: gitContentStore(options.contentStore, options.git),
        attachments: folderAttachmentStorage(options.attachmentStorage),
        local: folderLocalStore(options.contentStore),
        noteTypes: options.noteTypes ?? NO_NOTE_TYPES,
        seal: vaultSealSource(options.vault),
        ...(options.mainSite === undefined ? {} : { mainSite: options.mainSite })
    }
}

/**
 * Pulls the content store into the copy: exactly `git pull --ff-only origin
 * main`, on a click of the author when another device published first
 * (decision R67). The tool never pulls by itself (R46). It takes the lock of
 * the device for the pull, refuses while another run holds it or while the
 * run journal of a publication that stopped halfway is there, and a pull that
 * is not a fast-forward stops with the message of git.
 *
 * @param options.contentStore the folder of the copy of the content store
 * @param options.git the git program; by default `git` of the path of the system
 */
export async function pullContentStore(options: {
    contentStore: string
    git?: string
}): Promise<void> {
    const local = folderLocalStore(options.contentStore)
    // The lock of the device holds the copy for the pull: no run of another
    // face can start in the middle of it (PUB-27).
    const lock = await local.lock({ command: 'pull' })
    if (!lock.taken) {
        throw new Error(
            `a run of the tool holds the lock of this device: pull when it ends (${options.contentStore})`
        )
    }
    try {
        // A journal at its step `correct` left a clean copy, which the push
        // reached: a pull is safe then. Any other journal waits for the dry
        // run that puts the copy back.
        const journal = await local.loadJournal()
        let step: unknown
        try {
            step =
                journal === undefined ? undefined : (JSON.parse(journal) as { step?: unknown }).step
        } catch {
            step = undefined
        }
        if (journal !== undefined && step !== 'correct') {
            throw new Error(
                `a publication stopped halfway on this device: make a dry run first, it puts the copy back (${options.contentStore})`
            )
        }
        const program = options.git ?? 'git'
        try {
            await run(program, [...GIT_OPTIONS, 'pull', '--quiet', '--ff-only', 'origin', 'main'], {
                cwd: options.contentStore,
                env: gitEnvironment()
            })
        } catch (error) {
            const stderr =
                error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
                    ? error.stderr.trim()
                    : ''
            throw new Error(
                `git pull --ff-only origin main failed in ${options.contentStore} (${program}): ${stderr === '' ? codeOf(error) : stderr}`,
                { cause: error }
            )
        }
    } finally {
        await local.release(lock.text)
    }
}
