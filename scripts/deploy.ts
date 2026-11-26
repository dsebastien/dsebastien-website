import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
    ATTACHMENT_KEY,
    deployToken,
    headersFile,
    targetFrom,
    usedAttachmentKeys,
    withoutTokens,
    workerConfiguration,
    type DeployTarget
} from '../apps/site/worker/deployment.ts'
import {
    checkContentCopy,
    contentStoreHas,
    descendsFrom,
    releaseAttachmentKeys,
    removalsBetween,
    removedAttachmentKeys,
    withdrawnAttachmentKeys
} from '../apps/site/worker/content-copy.ts'
import {
    inheritedLockWarning,
    lockHeldBy,
    lockWarningFor,
    processIsAlive,
    takeDeployLock
} from '../apps/site/worker/deploy-lock.ts'
import { r2Storage } from '../apps/site/worker/r2.ts'
import {
    deployRelease,
    LIVE_CHECKS,
    readHostRecord,
    RESULT_MARK,
    resultLine,
    stoppedResult,
    type DeployResult
} from '../apps/site/worker/release.ts'

// The deployment of a release (issues 30 and 32, HOST-01, BUILD-07, PUB-42):
// it puts the output of a build on a host as one new Worker version. It runs
// on the machine that publishes (decision R76): the content build never runs
// in the public CI.
//
//     bun run deploy --target <file> --content-store <folder> --attachments <folder>
//                    [--takedown] [--from-main] [--dry-run]
//                    [--new-content-store <host name>]
//     bun run deploy --target <file> --dist <folder> [--dry-run]
//
// `--target` names a private JSON file with the names of the host (see
// `DeployTarget` in `apps/site/worker/deployment.ts`): it is never in this
// repository. `--content-store` builds the site from the copy of the content
// store, after the attachments of the release went from `--attachments` to
// the object storage; `--dist` deploys an output that is built already, and
// touches no attachment. `--from-main` first brings this clone to the last
// `main` and runs the deployment with that code (the clone of the deploys).
// The logic is `deployRelease()` of `apps/site/worker/release.ts`; this file
// gives it the real steps. The token comes from
// `NOTES_DEPLOY_CLOUDFLARE_API_TOKEN`, else `CLOUDFLARE_API_TOKEN`; `--dry-run`
// checks the bundle with wrangler, reaches no host and needs no token. The
// last line of the standard output is the result (`resultLine()`).
// `--new-content-store` moves the host to another content store, whose copy
// does not know the live content revision (issue 127): the author gives the
// host name of the target again, and the tools never pass it.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'apps', 'site')
const WRANGLER = join(SITE, 'node_modules', '.bin', 'wrangler')

const OPTIONS = {
    'target': { type: 'string' },
    'content-store': { type: 'string' },
    'attachments': { type: 'string' },
    'dist': { type: 'string' },
    'takedown': { type: 'boolean', default: false },
    'from-main': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'new-content-store': { type: 'string' }
} as const

async function isFolder(path: string): Promise<boolean> {
    return (await stat(path).catch(() => undefined))?.isDirectory() === true
}

async function run(
    command: string[],
    options: { cwd?: string; environment?: Record<string, string> } = {}
): Promise<void> {
    const child = Bun.spawn(command, {
        cwd: options.cwd ?? ROOT,
        // A step gets the token only when it names it: never the install or the build.
        env: { ...withoutTokens(process.env), ...options.environment },
        stdio: ['inherit', 'inherit', 'inherit']
    })
    const code = await child.exited
    if (code !== 0) {
        throw new Error(`${command.join(' ')} ended with the code ${String(code)}`)
    }
}

/** The output of a git command in a folder, without its end of line. */
async function git(folder: string, ...command: string[]): Promise<string> {
    const child = Bun.spawn(['git', '-C', folder, ...command], {
        stdio: ['ignore', 'pipe', 'inherit']
    })
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (code !== 0) {
        throw new Error(`git ${command.join(' ')} ended with the code ${String(code)} in ${folder}`)
    }
    return text.trimEnd()
}

/** True when the arguments ask for a takedown: also when they cannot be read, a takedown counts. */
const TAKEDOWN = Bun.argv.slice(2).includes('--takedown')

/** The result of a run that stopped before its first step. */
function stopped(error: unknown, target?: DeployTarget): DeployResult {
    return stoppedResult(error, target === undefined ? '' : `https://${target.host}/`, TAKEDOWN)
}

/** The lock of the deployments of a target in this clone. */
function lockFileOf(target: DeployTarget): string {
    return join(ROOT, '.cache', 'deploy', target.worker, 'lock')
}

/**
 * Runs the task under the lock of the deployments of the target: one at a
 * time per target on this machine. The restart of `--from-main` runs under
 * the lock of its parent. It gives the warning of a lock that it took over.
 */
async function underLock<T>(
    target: DeployTarget,
    task: (warning: string | undefined) => Promise<T>
): Promise<T> {
    const file = lockFileOf(target)
    if (await lockHeldBy(file, process.ppid)) {
        // The warning of a lock that the parent took over goes into the result.
        return await task(inheritedLockWarning(process.env))
    }
    const lock = await takeDeployLock(file, {
        pid: process.pid,
        now: () => new Date(),
        isAlive: processIsAlive
    })
    try {
        return await task(lock.warning)
    } finally {
        await lock.release()
    }
}

/** Prints the result as the last line, and gives the exit code. */
function finish(result: DeployResult): number {
    process.stdout.write(`${resultLine(result)}\n`)
    return result.error === null ? 0 : 1
}

/**
 * `--from-main`: brings the clone of the deploys to the last `main`, then
 * runs the deployment again without the flag, so that the new code runs. A
 * clone with changes or on another branch stops it.
 */
async function fromMain(
    args: readonly string[],
    target: DeployTarget,
    warning: string | undefined
): Promise<number> {
    const changes = await git(ROOT, 'status', '--porcelain')
    if (changes !== '') {
        throw new Error(
            `the clone of the deploys has changes; it must be a clean clone of main:\n${changes}`
        )
    }
    const branch = await git(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD')
    if (branch !== 'main') {
        throw new Error(`the clone of the deploys is on the branch ${branch}, not on main`)
    }
    await run(['git', 'fetch', '--quiet', 'origin'])
    await run(['git', 'pull', '--ff-only'])
    const head = await git(ROOT, 'rev-parse', 'HEAD')
    const main = await git(ROOT, 'rev-parse', 'refs/remotes/origin/main')
    if (head !== main) {
        throw new Error(
            `the clone of the deploys is at ${head} after the pull, not at origin/main (${main})`
        )
    }
    await run(['bun', 'install', '--frozen-lockfile'])
    const child = Bun.spawn(
        ['bun', join(ROOT, 'scripts', 'deploy.ts'), ...args.filter((arg) => arg !== '--from-main')],
        {
            cwd: ROOT,
            env: { ...process.env, ...lockWarningFor(warning) },
            stdio: ['inherit', 'pipe', 'inherit']
        }
    )
    // The output goes on as it comes; a run that ends with no result gets one.
    let last = ''
    let pending = ''
    const decoder = new TextDecoder()
    const take = (text: string): void => {
        const lines = `${pending}${text}`.split('\n')
        pending = lines.pop() ?? ''
        last = lines.filter((line) => line.trim() !== '').at(-1) ?? last
    }
    const reader = child.stdout.getReader()
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        process.stdout.write(chunk.value)
        take(decoder.decode(chunk.value, { stream: true }))
    }
    take(`${decoder.decode()}\n`)
    const code = await child.exited
    if (!last.startsWith(`${RESULT_MARK} `)) {
        return finish(
            stopped(
                new Error(`the deployment ended with the code ${String(code)} and no result`),
                target
            )
        )
    }
    return code
}

async function deploy(
    target: DeployTarget,
    values: {
        'content-store'?: string | undefined
        'attachments'?: string | undefined
        'dist'?: string | undefined
        'takedown': boolean
        'dry-run': boolean
        'new-content-store'?: string | undefined
        'target': string
    }
): Promise<DeployResult> {
    try {
        const dryRun = values['dry-run']
        const move = values['new-content-store']
        if (move !== undefined) {
            // The host stays out of the message: the author types it, and never copies it.
            if (move !== target.host) {
                throw new Error(
                    `--new-content-store does not match the host of the target file ${values.target}`
                )
            }
            if (values.dist !== undefined) {
                throw new Error('--dist cannot move the host to another content store')
            }
            if (values.takedown) {
                throw new Error('a takedown cannot move the host to another content store')
            }
        }
        if ((values['content-store'] === undefined) === (values.dist === undefined)) {
            throw new Error('give one of --content-store <folder> and --dist <folder>')
        }
        const token = deployToken(process.env)
        if (!dryRun && token === undefined) {
            throw new Error(
                'NOTES_DEPLOY_CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN are not set'
            )
        }
        const store =
            values['content-store'] === undefined ? undefined : resolve(values['content-store'])
        if (store !== undefined && !(await isFolder(store))) {
            throw new Error(`${store} is not a folder`)
        }
        const attachments =
            values.attachments === undefined ? undefined : resolve(values.attachments)
        if (store !== undefined && attachments === undefined && !dryRun) {
            throw new Error('--attachments <folder> is required with --content-store')
        }
        if (attachments !== undefined && !(await isFolder(attachments))) {
            throw new Error(`${attachments} is not a folder`)
        }
        if (values.takedown && store === undefined) {
            throw new Error('--takedown needs --content-store')
        }
        const url = `https://${target.host}/`
        const folder = join(ROOT, '.cache', 'deploy', target.worker)
        const keyPath = (key: string): string => {
            if (attachments === undefined || !ATTACHMENT_KEY.test(key)) {
                throw new Error(`"${key}" is not a key of the attachment storage`)
            }
            return join(attachments, key)
        }
        // The record names this commit, so the keys and the build come from it.
        const contentRevision = store === undefined ? null : await checkContentCopy(store)
        // The files that the guards withdrew are read first: when a later
        // read of the copy fails, the run still deletes them before it stops
        // (issue 120, decision of the author R78, after R45). The keys of the
        // release and the history are read inside the run.
        const withdrawnKeys = store === undefined ? [] : await withdrawnAttachmentKeys(store)
        const result = await deployRelease({
            url,
            contentRevision,
            siteRevision: await git(ROOT, 'rev-parse', 'HEAD'),
            now: () => new Date(),
            usedKeys: () => (store === undefined ? Promise.resolve([]) : usedAttachmentKeys(store)),
            // The files of the takedowns and of the forced removals leave at once (issue 120).
            ...(store === undefined
                ? {}
                : { removedKeys: (live: string | null) => removedAttachmentKeys(store, live) }),
            withdrawnKeys,
            // A dry run reaches no host. `--dist` has no manifest: the
            // storage must not be cleaned by it.
            ...(dryRun || token === undefined || store === undefined
                ? {}
                : {
                      storage: r2Storage({
                          accountId: target.accountId,
                          bucket: target.bucket,
                          token
                      })
                  }),
            attachments: {
                exists: async (key) =>
                    (await stat(keyPath(key)).catch(() => undefined))?.isFile() === true,
                read: async (key) => new Uint8Array(await readFile(keyPath(key)))
            },
            takedown: values.takedown,
            newContentStore: move !== undefined,
            dryRun,
            ...(store === undefined
                ? {}
                : {
                      descendsFrom: (revision: string) => descendsFrom(store, revision),
                      releaseKeys: (revision: string) => releaseAttachmentKeys(store, revision),
                      removalsBetween: (from: string, to: string) =>
                          removalsBetween(store, from, to),
                      contentStoreHas: (revision: string) => contentStoreHas(store, revision),
                      beforeDeploy: async () => {
                          // No fetch: the copy must still be what the build read.
                          if ((await checkContentCopy(store, false)) !== contentRevision) {
                              throw new Error(
                                  'the copy of the content store moved during the build'
                              )
                          }
                      }
                  }),
            headers: headersFile(target),
            build: async () => {
                if (store === undefined) {
                    return resolve(values.dist ?? '')
                }
                await run(['bun', 'run', 'build:site'], { environment: { CONTENT_STORE: store } })
                return join(SITE, 'dist')
            },
            deploy: async (dist) => {
                await mkdir(folder, { recursive: true })
                const configuration = join(folder, 'wrangler.json')
                const main = join(SITE, 'worker', 'worker.ts')
                await writeFile(
                    configuration,
                    `${JSON.stringify(workerConfiguration(target, { main, dist }), null, 4)}\n`
                )
                await run(
                    [
                        WRANGLER,
                        'deploy',
                        '--config',
                        configuration,
                        ...(dryRun ? ['--dry-run', '--outdir', join(folder, 'bundle')] : [])
                    ],
                    token === undefined ? {} : { environment: { CLOUDFLARE_API_TOKEN: token } }
                )
            },
            ...(dryRun
                ? {}
                : {
                      live: { ...LIVE_CHECKS, read: () => readHostRecord(url) }
                  }),
            wait: (milliseconds) => Bun.sleep(milliseconds),
            log: (line) => {
                process.stdout.write(`${line}\n`)
            }
        })
        return {
            ...result,
            warnings: [
                ...result.warnings,
                ...(dryRun ? ['a dry run: nothing went to the host'] : []),
                ...(store === undefined && !dryRun
                    ? ['--dist: the attachment storage was not touched']
                    : [])
            ]
        }
    } catch (error) {
        return stopped(error, target)
    }
}

async function main(): Promise<number> {
    const args = Bun.argv.slice(2)
    let values: ReturnType<
        typeof parseArgs<{ args: string[]; options: typeof OPTIONS; strict: true }>
    >['values']
    try {
        values = parseArgs({ args, options: OPTIONS, strict: true }).values
    } catch (error) {
        return finish(stopped(error))
    }
    // The host is known as soon as the target file can be read.
    let target: DeployTarget
    try {
        if (values.target === undefined) {
            throw new Error('--target <file> is required')
        }
        target = targetFrom(JSON.parse(await readFile(resolve(values.target), 'utf8')))
    } catch (error) {
        return finish(stopped(error))
    }
    try {
        return await underLock(target, async (warning) => {
            if (warning !== undefined) {
                console.warn(warning)
            }
            if (values['from-main']) {
                try {
                    return await fromMain(args, target, warning)
                } catch (error) {
                    return finish(stopped(error, target))
                }
            }
            const result = await deploy(target, { ...values, target: values.target ?? '' })
            return finish(
                warning === undefined
                    ? result
                    : { ...result, warnings: [warning, ...result.warnings] }
            )
        })
    } catch (error) {
        // The lock is held by another run.
        return finish(stopped(error, target))
    }
}

process.exitCode = await main()
