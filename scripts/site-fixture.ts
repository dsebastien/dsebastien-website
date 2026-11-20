import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
    BUDGET_SAMPLE,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    writeBudgetSample
} from '@dsebastien-website/testing'
import { canonicalPath } from '@dsebastien-website/resolver'
import { nodeDevice } from '../apps/plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../apps/plugin/src/publishing/tool.ts'
import type { Subprocess } from 'bun'
import { startServer, type Server } from '../apps/site/server/serve.ts'

// The site of the invented fixture vault, to click through on this machine:
// the publishing tool publishes every new note of a copy of the fixture vault
// into a local content store, the site is built from it, and the plain local
// server serves it with its attachments. Everything lives in `.cache/` and is
// removed when the command stops. It never reads the real vault.
//
//     bun run site:fixture [--port 4322] [--sample]
//
// With `--sample`, the vault also holds the budget sample: invented notes as
// large as the large published notes (a long note with a long outline, a media
// note, a hub note with 489 backlinks and its page with all of them).

const SITE = fileURLToPath(new URL('../apps/site', import.meta.url))

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        port: { type: 'string', default: '4322' },
        sample: { type: 'boolean', default: false }
    },
    strict: true
})

const stores = await makeTestStores()
const cache = join(SITE, '.cache')
await mkdir(cache, { recursive: true })
const outDir = await mkdtemp(join(cache, 'site-fixture-'))

let build: Subprocess | undefined
let server: Server | undefined
let stopping = false

/** Stops the build and the server, and removes the folders of this run: one time only, at any step. */
async function stop(code: number): Promise<never> {
    if (!stopping) {
        stopping = true
        build?.kill()
        try {
            await server?.stop()
        } finally {
            await rm(outDir, { recursive: true, force: true })
            await stores.remove()
        }
    }
    process.exit(code)
}

// From the start, so that a stop during the publication or the build cleans up too.
process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))

try {
    const vault = await copyFixtureVault(stores)
    if (values.sample) {
        await writeBudgetSample(vault)
    }
    const contentStore = await makeContentStoreCopy(stores)
    const device = nodeDevice({ vault, contentStore, attachmentStorage: stores.attachmentStorage })
    const queue = await status(device)
    const planned = await plan(device, { include: queue.new })
    const report = await publish(device, planned.id, {
        time: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
        device: 'site-fixture',
        face: 'command-line'
    })
    console.error(`Published ${String(queue.new.length)} invented notes of the fixture vault.`)
    for (const warning of report.warnings) {
        console.error(`  warning: ${warning.path}: ${warning.message}`)
    }

    build = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    const built = await build.exited
    build = undefined
    if (built !== 0) {
        throw new Error('the build of the site failed')
    }

    server = await startServer({
        dist: outDir,
        port: Number(values.port),
        attachments: stores.attachmentStorage
    })
    console.error(`The site of the fixture vault is on ${server.url} (Ctrl+C stops it).`)
    if (values.sample) {
        for (const path of Object.values(BUDGET_SAMPLE)) {
            console.error(`  ${server.url}${canonicalPath(path)}`)
        }
    }
} catch (error) {
    console.error(error)
    await stop(1)
}
