import { parseWithdrawn, WITHDRAWN_FILE } from '../../plugin/src/publishing/withdrawn.ts'
import { publishedNotesOf } from '../src/content-store.ts'

// The copy of the content store on the machine that deploys (issue 32), as
// git sees it. A release is built from a copy that is clean and at the last
// `main` of the content store, so the deployment record names what the
// build read. The history of the copy says whether a release would put older
// content live than the live release, which takedowns and forced removals
// a revert would undo, and which files must leave the object storage at
// once (issue 120).

/** The output of git in a folder, with its exit code and what it wrote on its error output. */
async function git(
    folder: string,
    ...args: string[]
): Promise<{ code: number; text: string; errors: string }> {
    // A variable of git of the caller (a hook) must not choose another
    // repository. No optional lock: `git status` then never refreshes the
    // index, which the tool writes during a publication.
    const env = {
        ...Object.fromEntries(
            Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                    entry[1] !== undefined && !entry[0].startsWith('GIT_')
            )
        ),
        GIT_OPTIONAL_LOCKS: '0'
    }
    const child = Bun.spawn(['git', '-C', folder, ...args], {
        env,
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

/** The start of the subject of the commit of a takedown. */
const TAKEDOWN_SUBJECT = 'Takedown:'

/** The subject of the commit of a publication with at least one forced removal (PUB-84). */
const FORCED_SUBJECT = /^Publish: .*, [1-9]\d* forced,/u

/** True when the subject is the one of a takedown or of a publication with a forced removal. */
function removes(subject: string): boolean {
    return subject.startsWith(TAKEDOWN_SUBJECT) || FORCED_SUBJECT.test(subject)
}

/**
 * The subjects of the commits after `from` up to `to` that take notes away
 * at once: a takedown (a subject that starts with `Takedown:`) or a
 * publication with a forced removal (`, <n> forced,` with n above 0, issue
 * 120), the newest first. `undefined` when the copy does not know one of
 * the revisions.
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
    const subjects = await gitText(store, 'log', '--format=%s', `${from}..${to}`)
    return subjects.split('\n').filter(removes)
}

/** The form of the path of a manifest entry in the content store. */
const MANIFEST_PATH = /^manifest\/[^/]+\.json$/u

/**
 * The texts of these objects of the copy (`<revision>:<path>`), with one
 * call of git. A missing object stops it.
 */
async function objectTexts(store: string, names: readonly string[]): Promise<string[]> {
    if (names.length === 0) {
        return []
    }
    const env = {
        ...Object.fromEntries(
            Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                    entry[1] !== undefined && !entry[0].startsWith('GIT_')
            )
        ),
        GIT_OPTIONAL_LOCKS: '0'
    }
    const child = Bun.spawn(['git', '-C', store, 'cat-file', '--batch'], {
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
    })
    void child.stdin.write(`${names.join('\n')}\n`)
    void child.stdin.end()
    const [bytes, errors, code] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text(),
        child.exited
    ])
    if (code !== 0) {
        throw new Error(`git cat-file failed in the copy of the content store: ${errors.trim()}`)
    }
    const texts: string[] = []
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let at = 0
    for (const name of names) {
        const end = bytes.indexOf(0x0a, at)
        const header = decoder.decode(bytes.subarray(at, end))
        const size = /^[0-9a-f]+ blob (\d+)$/u.exec(header)?.[1]
        if (size === undefined) {
            throw new Error(`the copy of the content store has no file ${name}`)
        }
        const start = end + 1
        texts.push(decoder.decode(bytes.subarray(start, start + Number(size))))
        at = start + Number(size) + 1
    }
    return texts
}

/** The keys of the attachments that a manifest entry lists, from its text. */
function keysOfEntry(name: string, text: string): string[] {
    let entry: unknown
    try {
        entry = JSON.parse(text)
    } catch {
        throw new Error(`${name} of the copy of the content store is not a manifest entry`)
    }
    const attachments =
        typeof entry === 'object' && entry !== null && 'attachments' in entry
            ? entry.attachments
            : undefined
    if (!Array.isArray(attachments)) {
        throw new Error(`${name} of the copy of the content store is not a manifest entry`)
    }
    return attachments.map((attachment: unknown) => {
        const hash =
            typeof attachment === 'object' && attachment !== null && 'hash' in attachment
                ? attachment.hash
                : undefined
        if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(hash)) {
            throw new Error(`${name} of the copy of the content store is not a manifest entry`)
        }
        return hash.slice('sha256:'.length)
    })
}

/** The path of the note of a manifest entry, from its text, or `undefined`. */
function pathOfEntry(text: string): string | undefined {
    return fieldOfEntry(text, 'path')
}

/** A text field of a manifest entry, from its text, or `undefined`. */
function fieldOfEntry(text: string, field: 'path' | 'state'): string | undefined {
    try {
        const entry: unknown = JSON.parse(text)
        if (typeof entry !== 'object' || entry === null || !(field in entry)) {
            return undefined
        }
        const value: unknown = (entry as Record<string, unknown>)[field]
        return typeof value === 'string' ? value : undefined
    } catch {
        return undefined
    }
}

/**
 * The keys of the attachments of the notes that a takedown or a forced
 * removal took away, in the whole history of the copy up to `HEAD`, each one
 * time, sorted (issue 120): the manifest entries that such a commit deleted,
 * read at its parent. In a publication, an unpublished entry whose path a
 * move of the same commit took is no forced removal (rule 6 of the moves),
 * so it is left out. Business rule 16: these files leave the object storage
 * at once, unless the new release uses them. A copy with no commit gives
 * none.
 */
export async function removedAttachmentKeys(store: string): Promise<string[]> {
    if ((await git(store, 'rev-parse', '--verify', '--quiet', 'HEAD')).code !== 0) {
        return []
    }
    const log = await gitText(store, 'log', '--format=%H %s', 'HEAD')
    const keys = new Set<string>()
    for (const line of log.split('\n')) {
        const space = line.indexOf(' ')
        const commit = line.slice(0, space)
        const subject = line.slice(space + 1)
        if (space < 0 || !removes(subject)) {
            continue
        }
        const changes = (
            await gitText(
                store,
                'diff-tree',
                '-r',
                '-z',
                '--no-commit-id',
                '--no-renames',
                '--name-status',
                commit,
                '--',
                'manifest'
            )
        )
            .split('\0')
            .filter((part) => part !== '')
        const deleted: string[] = []
        const written: string[] = []
        for (let index = 0; index + 1 < changes.length; index += 2) {
            const status = changes[index] ?? ''
            const path = changes[index + 1] ?? ''
            if (!MANIFEST_PATH.test(path)) {
                continue
            }
            if (status === 'D') {
                deleted.push(path)
            } else {
                written.push(path)
            }
        }
        const before = await objectTexts(
            store,
            deleted.map((path) => `${commit}^:${path}`)
        )
        // The paths that the entries of the commit hold now: a move took them.
        const taken = subject.startsWith(TAKEDOWN_SUBJECT)
            ? new Set<string>()
            : new Set(
                  (
                      await objectTexts(
                          store,
                          written.map((path) => `${commit}:${path}`)
                      )
                  )
                      .map(pathOfEntry)
                      .filter((path) => path !== undefined)
              )
        deleted.forEach((path, index) => {
            const text = before[index] ?? ''
            const notePath = pathOfEntry(text)
            const unpublished = fieldOfEntry(text, 'state') === 'unpublished'
            if (unpublished && notePath !== undefined && taken.has(notePath)) {
                return
            }
            for (const key of keysOfEntry(path, text)) {
                keys.add(key)
            }
        })
    }
    return [...keys].sort()
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
