import { parseWithdrawn, WITHDRAWN_FILE } from '../../plugin/src/publishing/withdrawn.ts'
import { publishedNotesOf } from '../src/content-store.ts'

// The copy of the content store on the machine that deploys (issue 32), as
// git sees it. A release is built from a copy that is clean and at the last
// `main` of the content store, so the deployment record names what the
// build read. The history of the copy says whether a release would put older
// content live than the live release, which takedowns and forced removals
// a revert would undo, and which files must leave the object storage at
// once (issue 120).

/**
 * The environment of git: a variable of git of the caller (a hook) must not
 * choose another repository. No optional lock: `git status` then never
 * refreshes the index, which the tool writes during a publication.
 */
function gitEnvironment(): Record<string, string> {
    return {
        ...Object.fromEntries(
            Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                    entry[1] !== undefined && !entry[0].startsWith('GIT_')
            )
        ),
        GIT_OPTIONAL_LOCKS: '0'
    }
}

/** The output of git in a folder, with its exit code and what it wrote on its error output. */
async function git(
    folder: string,
    ...args: string[]
): Promise<{ code: number; text: string; errors: string }> {
    const child = Bun.spawn(['git', '-C', folder, ...args], {
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe']
    })
    const [text, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ])
    return { code, text: text.trimEnd(), errors: errors.trim() }
}

/** The output of git, or an error with what git said. */
async function gitText(folder: string, ...args: string[]): Promise<string> {
    const result = await git(folder, ...args)
    if (result.code !== 0) {
        throw new Error(
            `git ${args.join(' ')} failed in the copy of the content store ${folder}: ${result.errors}`
        )
    }
    return result.text
}

/**
 * The ref of the copy that the fetch of a deployment writes: the tool
 * fetches and pushes with `refs/remotes/origin/main`, which the deployment
 * never writes.
 */
export const DEPLOY_REF = 'refs/deploy/origin-main'

/**
 * Fetches the content store into the copy (into `DEPLOY_REF`), and gives the commit of the copy
 * when the copy is clean (no change of a tracked file, no new file) and its
 * `HEAD` is the `main` of the content store. Else it throws: the build would
 * read something else than the commit of the record.
 *
 * @param fetch false after the build: the copy must still be what the build
 * read, also when another device pushed since.
 */
export async function checkContentCopy(store: string, fetch = true): Promise<string> {
    if (fetch) {
        // `--refmap=`: no update of the remote-tracking ref that the
        // configuration of the remote names, only the ref of the refspec.
        await gitText(
            store,
            'fetch',
            '--quiet',
            '--refmap=',
            'origin',
            `+refs/heads/main:${DEPLOY_REF}`
        )
    }
    const changes = await gitText(store, 'status', '--porcelain', '--untracked-files=all')
    if (changes !== '') {
        throw new Error(
            `the copy of the content store has changes, so the build would not be the commit of the record: ${store}\n${changes}`
        )
    }
    const head = await gitText(store, 'rev-parse', 'HEAD')
    const main = await gitText(store, 'rev-parse', DEPLOY_REF)
    if (head !== main) {
        throw new Error(
            `the copy of the content store is at ${head}, not at origin/main (${main}): pull the copy first (${store})`
        )
    }
    return head
}

/**
 * True when the revision is the commit of the copy or one of its ancestors,
 * false when it is not, `undefined` when the copy does not know the revision.
 */
export async function descendsFrom(store: string, revision: string): Promise<boolean | undefined> {
    const known = await git(store, 'cat-file', '-e', `${revision}^{commit}`)
    if (known.code !== 0) {
        return undefined
    }
    const result = await git(store, 'merge-base', '--is-ancestor', revision, 'HEAD')
    if (result.code === 0 || result.code === 1) {
        return result.code === 0
    }
    throw new Error(`git merge-base failed in the copy of the content store: ${result.errors}`)
}

/** What git says when the content store does not have a commit that a fetch asks for. */
const NOT_IN_CONTENT_STORE = /not our ref/u

/**
 * True when the content store (the remote `origin` of the copy) has the
 * revision, false when it answers that it has not (issue 127). A copy that
 * is only behind does not know a revision that another device pushed and
 * deployed, so a move to another content store needs this answer too. It
 * throws when it cannot say: a shallow copy, or a content store that cannot
 * be reached. The fetch writes no ref and no `FETCH_HEAD`.
 */
export async function contentStoreHas(store: string, revision: string): Promise<boolean> {
    if ((await gitText(store, 'rev-parse', '--is-shallow-repository')) !== 'false') {
        throw new Error(`the copy of the content store is shallow, so it cannot say: ${store}`)
    }
    // Protocol 2: an older server answers "not our ref" also for a commit
    // that it has but that is not the tip of a branch. No automatic
    // maintenance: the tool can use the copy at the same time.
    const result = await git(
        store,
        '-c',
        'protocol.version=2',
        'fetch',
        '--no-auto-maintenance',
        '--quiet',
        '--no-write-fetch-head',
        '--refmap=',
        'origin',
        revision
    )
    if (result.code === 0) {
        return true
    }
    if (NOT_IN_CONTENT_STORE.test(result.errors)) {
        return false
    }
    throw new Error(
        `the content store of the copy cannot say whether it has ${revision}: ${result.errors}`
    )
}

/** The form of the path of a manifest entry in the content store. */
const MANIFEST_PATH = /^manifest\/[^/]+\.json$/u

/** How many objects one request asks `git cat-file` for: the answers are read before the next one. */
const BATCH = 256

/**
 * One `git cat-file --batch` process of the copy for every object that a
 * read needs (review round 2 of issue 120): a deployment reads the whole
 * history, and one process per object is slow.
 */
class Blobs {
    readonly #child: ReturnType<typeof spawnBatch>
    readonly #reader: ReadableStreamDefaultReader<Uint8Array>
    #buffer = new Uint8Array(0)
    #errors: Promise<string>

    constructor(store: string) {
        this.#child = spawnBatch(store)
        this.#reader = this.#child.stdout.getReader()
        this.#errors = new Response(this.#child.stderr).text()
    }

    /** Reads more bytes of the output. False at its end. */
    async #fill(): Promise<boolean> {
        const { value, done } = await this.#reader.read()
        if (done) {
            return false
        }
        const joined = new Uint8Array(this.#buffer.length + value.length)
        joined.set(this.#buffer)
        joined.set(value, this.#buffer.length)
        this.#buffer = joined
        return true
    }

    async #fail(): Promise<never> {
        throw new Error(
            `git cat-file stopped in the copy of the content store: ${(await this.#errors).trim()}`
        )
    }

    /** The next line of the output, without its line feed. */
    async #line(): Promise<string> {
        let end = this.#buffer.indexOf(0x0a)
        while (end < 0) {
            if (!(await this.#fill())) {
                return await this.#fail()
            }
            end = this.#buffer.indexOf(0x0a)
        }
        const line = new TextDecoder().decode(this.#buffer.subarray(0, end))
        this.#buffer = this.#buffer.subarray(end + 1)
        return line
    }

    /** The next bytes of the output, and the line feed after them. */
    async #bytes(size: number): Promise<Uint8Array> {
        while (this.#buffer.length < size + 1) {
            if (!(await this.#fill())) {
                return await this.#fail()
            }
        }
        const bytes = this.#buffer.slice(0, size)
        this.#buffer = this.#buffer.subarray(size + 1)
        return bytes
    }

    /**
     * The texts of these objects (`<revision>:<path>`), in their order:
     * `undefined` for an object that the copy does not have or that is no
     * file, or whose bytes are not UTF-8.
     */
    async read(names: readonly string[]): Promise<(string | undefined)[]> {
        const texts: (string | undefined)[] = []
        const decoder = new TextDecoder('utf-8', { fatal: true })
        for (let start = 0; start < names.length; start += BATCH) {
            const part = names.slice(start, start + BATCH)
            void this.#child.stdin.write(`${part.join('\n')}\n`)
            await this.#child.stdin.flush()
            for (const _name of part) {
                const header = (await this.#line()).split(' ')
                if (header.length !== 3) {
                    texts.push(undefined)
                    continue
                }
                const bytes = await this.#bytes(Number(header[2]))
                let text: string | undefined
                try {
                    text = header[1] === 'blob' ? decoder.decode(bytes) : undefined
                } catch {
                    text = undefined
                }
                texts.push(text)
            }
        }
        return texts
    }

    async close(): Promise<void> {
        void this.#child.stdin.end()
        this.#reader.releaseLock()
        await this.#child.stdout.cancel()
        await this.#child.exited
    }
}

/** The process of `git cat-file --batch` in the copy, with the environment of `git()`. */
function spawnBatch(store: string) {
    return Bun.spawn(['git', '-C', store, 'cat-file', '--batch'], {
        env: gitEnvironment(),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
    })
}

/** Runs the read with one process of `git cat-file`, and ends the process after it. */
async function withBlobs<T>(store: string, read: (blobs: Blobs) => Promise<T>): Promise<T> {
    const blobs = new Blobs(store)
    try {
        return await read(blobs)
    } finally {
        await blobs.close()
    }
}

/**
 * The texts of these objects of the copy (`<revision>:<path>`). A missing
 * object stops it.
 */
async function objectTexts(store: string, names: readonly string[]): Promise<string[]> {
    const texts = await withBlobs(store, (blobs) => blobs.read(names))
    return texts.map((text, index) => {
        if (text === undefined) {
            throw new Error(`the copy of the content store has no file ${names[index] ?? ''}`)
        }
        return text
    })
}

/** The fields of a manifest entry that the history reader needs, of any version of the entry. */
interface OldEntry {
    readonly path: string | undefined
    readonly state: string | undefined
    readonly formerPaths: readonly string[]
    readonly keys: readonly string[]
}

/**
 * Reads a manifest entry of the history, of any version: an entry of the
 * first publications has no `attachments`, so it uses no file. The keys are
 * the hashes of its attachments without `sha256:`. `undefined` for a text
 * that is no entry.
 */
function oldEntryOf(text: string | undefined): OldEntry | undefined {
    if (text === undefined) {
        return undefined
    }
    let entry: unknown
    try {
        entry = JSON.parse(text)
    } catch {
        return undefined
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return undefined
    }
    const fields = entry as Record<string, unknown>
    const textOf = (value: unknown): string | undefined =>
        typeof value === 'string' ? value : undefined
    const former = fields['formerPaths']
    const formerPaths = Array.isArray(former)
        ? former.filter((item): item is string => typeof item === 'string')
        : []
    const attachments = fields['attachments'] ?? []
    if (!Array.isArray(attachments)) {
        return undefined
    }
    const keys: string[] = []
    for (const attachment of attachments as unknown[]) {
        const hash =
            typeof attachment === 'object' && attachment !== null && 'hash' in attachment
                ? attachment.hash
                : undefined
        if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(hash)) {
            return undefined
        }
        keys.push(hash.slice('sha256:'.length))
    }
    return { path: textOf(fields['path']), state: textOf(fields['state']), formerPaths, keys }
}

/** A commit of the copy that took notes away. */
interface Removal {
    readonly commit: string
    readonly subject: string
    readonly keys: readonly string[]
}

/** The commits of `git log -z --name-status --format=%x01%H%x09%s`, with their manifest files by status. */
function commitsOf(log: string): { commit: string; subject: string; files: [string, string][] }[] {
    return log
        .split('\x01')
        .slice(1)
        .map((record) => {
            const end = record.indexOf('\0')
            const header = end < 0 ? record : record.slice(0, end)
            const tab = header.indexOf('\t')
            const parts = (end < 0 ? '' : record.slice(end + 1))
                .replace(/^\n/u, '')
                .split('\0')
                .filter((part) => part !== '')
            const files: [string, string][] = []
            for (let index = 0; index + 1 < parts.length; index += 2) {
                const path = parts[index + 1] ?? ''
                if (MANIFEST_PATH.test(path)) {
                    files.push([parts[index] ?? '', path])
                }
            }
            return {
                commit: tab < 0 ? header : header.slice(0, tab),
                subject: tab < 0 ? '' : header.slice(tab + 1),
                files
            }
        })
}

/**
 * The entry of a deleted file of the history (review round 2): its version
 * at the parent of the commit, or, when that version is no entry (an edit
 * by hand), every older version of that file that is one, with all their
 * keys. It throws, with the commit and the file, only when no version can be
 * read: the files of that note are not known.
 */
async function deletedEntry(
    store: string,
    blobs: Blobs,
    commit: string,
    path: string,
    text: string | undefined
): Promise<OldEntry> {
    const entry = oldEntryOf(text)
    if (entry !== undefined) {
        return entry
    }
    const versions = (
        await gitText(store, 'log', '--full-history', '--format=%H', `${commit}^`, '--', path)
    )
        .split('\n')
        .filter((line) => line !== '')
    const read = (await blobs.read(versions.map((version) => `${version}:${path}`)))
        .map(oldEntryOf)
        .filter((item) => item !== undefined)
    const newest = read[0]
    if (newest === undefined) {
        throw new Error(
            `${path} of the commit ${commit} of the copy of the content store is not a manifest entry, and no older version of it is one, so the files of its note are not known`
        )
    }
    return { ...newest, keys: [...new Set(read.flatMap((item) => item.keys))] }
}

/**
 * The commits of the copy in this range that took notes away, the newest
 * first (issue 120, review rounds 1 and 2): each commit that deleted a
 * manifest entry, whatever its subject says, with the keys of the
 * attachments of those entries, read at its parent. An unpublished entry is
 * left out when a move of the same commit displaced it (rule 6 of the
 * moves): a published entry of the commit holds its path now, held another
 * path at the parent, and names that path in `formerPaths`. A merge commit
 * in the range stops it: its sides can remove entries that no diff shows.
 * One `git log` and one `git cat-file` read the history.
 */
async function removalsIn(store: string, range: string): Promise<Removal[]> {
    if ((await gitText(store, 'rev-list', '--merges', '--count', range)) !== '0') {
        throw new Error(
            `the history of the copy of the content store has a merge commit, so the deployment cannot say which notes its commits took away: ${store}`
        )
    }
    const commits = commitsOf(
        await gitText(
            store,
            'log',
            '-z',
            '--full-history',
            '--no-renames',
            '--diff-filter=D',
            '--name-status',
            '--format=%x01%H%x09%s',
            range,
            '--',
            'manifest'
        )
    ).filter((commit) => commit.files.some(([status]) => status === 'D'))
    if (commits.length === 0) {
        return []
    }
    return await withBlobs(store, async (blobs) => {
        const deleted = commits.flatMap(({ commit, files }) =>
            files.filter(([status]) => status === 'D').map(([, path]) => ({ commit, path }))
        )
        const texts = await blobs.read(deleted.map(({ commit, path }) => `${commit}^:${path}`))
        const entries = new Map<string, OldEntry[]>()
        for (const [index, { commit, path }] of deleted.entries()) {
            const entry = await deletedEntry(store, blobs, commit, path, texts[index])
            entries.set(commit, [...(entries.get(commit) ?? []), entry])
        }
        // The moves of the commits that deleted an unpublished entry.
        const moving = commits
            .map(({ commit }) => commit)
            .filter((commit) =>
                (entries.get(commit) ?? []).some((entry) => entry.state === 'unpublished')
            )
        const taken = await movedPaths(store, blobs, moving)
        return commits.flatMap(({ commit, subject }) => {
            const removed = (entries.get(commit) ?? []).filter(
                (entry) =>
                    entry.state !== 'unpublished' ||
                    entry.path === undefined ||
                    !(taken.get(commit)?.has(entry.path) ?? false)
            )
            return removed.length === 0
                ? []
                : [{ commit, subject, keys: removed.flatMap((entry) => entry.keys) }]
        })
    })
}

/**
 * The paths that a move of each of these commits took (rule 6 of the moves):
 * the path of each published entry that the commit wrote and that held
 * another path at the parent, named in its `formerPaths`. A written entry
 * that cannot be read takes no path, so the entry that it would displace
 * counts as removed.
 */
async function movedPaths(
    store: string,
    blobs: Blobs,
    commits: readonly string[]
): Promise<Map<string, Set<string>>> {
    const taken = new Map<string, Set<string>>()
    if (commits.length === 0) {
        return taken
    }
    const written = commitsOf(
        await gitText(
            store,
            'log',
            '-z',
            '--no-walk=unsorted',
            '--no-renames',
            '--name-status',
            '--format=%x01%H%x09%s',
            ...commits,
            '--',
            'manifest'
        )
    ).flatMap(({ commit, files }) =>
        files.filter(([status]) => status === 'M').map(([, path]) => ({ commit, path }))
    )
    const after = await blobs.read(written.map(({ commit, path }) => `${commit}:${path}`))
    const before = await blobs.read(written.map(({ commit, path }) => `${commit}^:${path}`))
    for (const [index, { commit }] of written.entries()) {
        const now = oldEntryOf(after[index])
        const then = oldEntryOf(before[index])
        if (
            now?.state === 'published' &&
            now.path !== undefined &&
            then?.path !== undefined &&
            then.path !== now.path &&
            now.formerPaths.includes(then.path)
        ) {
            taken.set(commit, (taken.get(commit) ?? new Set()).add(now.path))
        }
    }
    return taken
}

/**
 * The subjects of the commits after `from` up to `to` that deleted a
 * manifest entry (see `removalsIn()`: a takedown, a forced removal, any
 * other commit), read from their content, the newest first. `undefined`
 * when the copy does not know one of the revisions. It throws when a merge
 * commit lies between.
 */
export async function removalsBetween(
    store: string,
    from: string,
    to: string
): Promise<string[] | undefined> {
    for (const revision of [from, to]) {
        if ((await git(store, 'cat-file', '-e', `${revision}^{commit}`)).code !== 0) {
            return undefined
        }
    }
    return (await removalsIn(store, `${from}..${to}`)).map((removal) => removal.subject)
}

/**
 * The keys of the attachments of the notes that commits of the whole history
 * of the copy up to `HEAD` took away (see `removalsIn()`), each one time,
 * sorted, apart by whether the live release of the content revision `live`
 * holds the removal (review round 2, R3): the keys of a removal after it
 * beat every release, the others follow the kept rule. A copy with no commit
 * gives none. It throws for a shallow copy: its history is not whole, so a
 * file of a takedown could stay public.
 */
export async function removedAttachmentKeys(
    store: string,
    live: string | null
): Promise<{ notLive: string[]; inLive: string[] }> {
    if ((await git(store, 'rev-parse', '--verify', '--quiet', 'HEAD')).code !== 0) {
        return { notLive: [], inLive: [] }
    }
    if ((await gitText(store, 'rev-parse', '--is-shallow-repository')) !== 'false') {
        throw new Error(
            `the copy of the content store is shallow, so the deployment cannot know the files of its takedowns and forced removals: fetch its whole history (git fetch --unshallow) in ${store}`
        )
    }
    const removals = await removalsIn(store, 'HEAD')
    // The commits that the live release does not hold. A live revision that
    // the copy does not know holds none of them.
    let after: Set<string> | undefined
    if (live !== null && (await git(store, 'cat-file', '-e', `${live}^{commit}`)).code === 0) {
        after = new Set(
            (await gitText(store, 'rev-list', `${live}..HEAD`)).split('\n').filter(Boolean)
        )
    }
    const notLive = new Set(
        removals
            .filter((removal) => after === undefined || after.has(removal.commit))
            .flatMap((removal) => removal.keys)
    )
    const inLive = new Set(
        removals
            .filter((removal) => after !== undefined && !after.has(removal.commit))
            .flatMap((removal) => removal.keys)
            .filter((key) => !notLive.has(key))
    )
    return { notLive: [...notLive].sort(), inLive: [...inLive].sort() }
}

/**
 * The keys of the attachments that the published notes of a revision of the
 * copy use, each one time, sorted, read with the reader of the build (issue
 * 120): the files of the release before. `undefined` when the copy does not
 * know the revision. It throws when the build would refuse that manifest.
 */
export async function releaseAttachmentKeys(
    store: string,
    revision: string
): Promise<string[] | undefined> {
    if ((await git(store, 'cat-file', '-e', `${revision}^{commit}`)).code !== 0) {
        return undefined
    }
    const paths = (
        await gitText(store, 'ls-tree', '-r', '-z', '--name-only', revision, '--', 'manifest')
    )
        .split('\0')
        .filter((path) => MANIFEST_PATH.test(path))
    const texts = await objectTexts(
        store,
        paths.map((path) => `${revision}:${path}`)
    )
    const notes = publishedNotesOf(
        paths.map((path, index) => ({
            file: path.slice('manifest/'.length),
            text: texts[index] ?? ''
        }))
    )
    return [...new Set(notes.flatMap((note) => note.attachments.map((item) => item.key)))].sort()
}

/**
 * The keys that the guards withdrew (`withdrawn.json` of the copy at its
 * commit, issue 120), read as the tool reads them: none without the file. It
 * throws for a file that the tool would refuse, so the deployment stops
 * before its first step: it could put a file under a guard back on the host.
 */
export async function withdrawnAttachmentKeys(store: string): Promise<string[]> {
    const name = `HEAD:${WITHDRAWN_FILE}`
    if ((await git(store, 'cat-file', '-e', name)).code !== 0) {
        return []
    }
    const [text] = await objectTexts(store, [name])
    return parseWithdrawn(text)
}
