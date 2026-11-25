// The copy of the content store on the machine that deploys (issue 32), as
// git sees it. A release is built from a copy that is clean and at the last
// `main` of the content store, so the deployment record names what the
// build read. The history of the copy says whether a release would put older
// content live than the live release, and which takedowns a revert would
// undo.

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

/**
 * The subjects of the takedown commits (a subject that starts with
 * `Takedown:`) after `from` up to `to`, the newest first. `undefined` when
 * the copy does not know one of the revisions.
 */
export async function takedownsBetween(
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
    return subjects.split('\n').filter((subject) => subject.startsWith('Takedown:'))
}
