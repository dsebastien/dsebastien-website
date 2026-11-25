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
    workerConfiguration,
    type DeployTarget
} from '../apps/site/worker/deployment.ts'
import { r2Storage } from '../apps/site/worker/r2.ts'
import {
    deployRelease,
    LIVE_CHECKS,
    readHostRecord,
    RESULT_MARK,
    resultLine,
    type DeployResult
} from '../apps/site/worker/release.ts'

// The deployment of a release (issues 30 and 32, HOST-01, BUILD-07, PUB-42):
// it puts the output of a build on a host as one new Worker version. It runs
// on the machine that publishes (decision R76): the content build never runs
// in the public CI.
//
//     bun run deploy --target <file> --content-store <folder> --attachments <folder>
//                    [--takedown] [--from-main] [--dry-run]
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
    'dry-run': { type: 'boolean', default: false }
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
        env: { ...process.env, ...options.environment },
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

/** The result of a run that stopped before its first step. */
function stopped(error: unknown, target?: DeployTarget): DeployResult {
    return {
        build: 'skipped',
        deploy: 'skipped',
        live: false,
        url: target === undefined ? '' : `https://${target.host}/`,
        contentRevision: null,
        uploaded: 0,
        deleted: 0,
        warnings: [],
        error: error instanceof Error ? error.message : String(error)
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
async function fromMain(args: readonly string[]): Promise<number> {
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
    await run(['git', 'pull', '--ff-only'])
    await run(['bun', 'install', '--frozen-lockfile'])
    const child = Bun.spawn(
        ['bun', join(ROOT, 'scripts', 'deploy.ts'), ...args.filter((arg) => arg !== '--from-main')],
        { cwd: ROOT, env: process.env, stdio: ['inherit', 'pipe', 'inherit'] }
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
            stopped(new Error(`the deployment ended with the code ${String(code)} and no result`))
        )
    }
    return code
}

async function deploy(values: {
    'target'?: string | undefined
    'content-store'?: string | undefined
    'attachments'?: string | undefined
    'dist'?: string | undefined
    'takedown': boolean
    'dry-run': boolean
}): Promise<DeployResult> {
    if (values.target === undefined) {
        return stopped(new Error('--target <file> is required'))
    }
    let target: DeployTarget
    try {
        target = targetFrom(JSON.parse(await readFile(resolve(values.target), 'utf8')))
    } catch (error) {
        return stopped(error)
    }
    try {
        const dryRun = values['dry-run']
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
        const result = await deployRelease({
            url,
            contentRevision: store === undefined ? null : await git(store, 'rev-parse', 'HEAD'),
            siteRevision: await git(ROOT, 'rev-parse', 'HEAD'),
            now: () => new Date(),
            usedKeys: store === undefined ? [] : await usedAttachmentKeys(store),
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
            dryRun,
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
    if (values['from-main']) {
        try {
            return await fromMain(args)
        } catch (error) {
            return finish(stopped(error))
        }
    }
    return finish(await deploy(values))
}

process.exitCode = await main()
