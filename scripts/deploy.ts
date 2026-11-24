import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
    checkOutput,
    headersFile,
    targetFrom,
    workerConfiguration
} from '../apps/site/worker/deployment.ts'

// The deployment of a release (issue 30, HOST-01): it puts the output of a
// build on a host as one new Worker version. It runs on the machine that
// publishes (decision R76): the content build never runs in the public CI.
//
//     bun run deploy --target <file> (--content-store <folder> | --dist <folder>) [--dry-run]
//
// `--target` names a private JSON file with the names of the host (see
// `DeployTarget` in `apps/site/worker/deployment.ts`): it is never in this
// repository. `--content-store` builds the site from the copy of the content
// store first; `--dist` deploys an output that is built already. The command
// writes the `_headers` file into the output and the wrangler configuration
// into `.cache/deploy/<worker>/`, then runs `wrangler deploy`. wrangler reads
// the token from `CLOUDFLARE_API_TOKEN`. `--dry-run` checks the bundle and
// uploads nothing, with no token.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'apps', 'site')
const WRANGLER = join(SITE, 'node_modules', '.bin', 'wrangler')

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        'target': { type: 'string' },
        'content-store': { type: 'string' },
        'dist': { type: 'string' },
        'dry-run': { type: 'boolean', default: false }
    },
    strict: true
})

async function isFolder(path: string): Promise<boolean> {
    return (await stat(path).catch(() => undefined))?.isDirectory() === true
}

async function run(command: string[], environment: Record<string, string> = {}): Promise<void> {
    const child = Bun.spawn(command, {
        cwd: ROOT,
        env: { ...process.env, ...environment },
        stdio: ['inherit', 'inherit', 'inherit']
    })
    const code = await child.exited
    if (code !== 0) {
        throw new Error(`${command.join(' ')} ended with the code ${String(code)}`)
    }
}

async function main(): Promise<void> {
    if (values.target === undefined) {
        throw new Error('--target <file> is required')
    }
    if ((values['content-store'] === undefined) === (values.dist === undefined)) {
        throw new Error('give one of --content-store <folder> and --dist <folder>')
    }
    if (!values['dry-run'] && (process.env['CLOUDFLARE_API_TOKEN'] ?? '') === '') {
        throw new Error('CLOUDFLARE_API_TOKEN is not set')
    }
    const target = targetFrom(JSON.parse(await readFile(resolve(values.target), 'utf8')))

    let dist: string
    if (values['content-store'] === undefined) {
        dist = resolve(values.dist ?? '')
    } else {
        const store = resolve(values['content-store'])
        if (!(await isFolder(store))) {
            throw new Error(`${store} is not a folder`)
        }
        await run(['bun', 'run', 'build:site'], { CONTENT_STORE: store })
        dist = join(SITE, 'dist')
    }
    const problem = await checkOutput(dist)
    if (problem !== undefined) {
        throw new Error(problem)
    }
    // The whole file, over any file of that name in the output.
    await writeFile(join(dist, '_headers'), headersFile(target))

    const folder = join(ROOT, '.cache', 'deploy', target.worker)
    await mkdir(folder, { recursive: true })
    const configuration = join(folder, 'wrangler.json')
    const main = join(SITE, 'worker', 'worker.ts')
    await writeFile(
        configuration,
        `${JSON.stringify(workerConfiguration(target, { main, dist }), null, 4)}\n`
    )
    await run([
        WRANGLER,
        'deploy',
        '--config',
        configuration,
        ...(values['dry-run'] ? ['--dry-run', '--outdir', join(folder, 'bundle')] : [])
    ])
}

await main()
