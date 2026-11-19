import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { copyFixtureVault, makeContentStoreCopy, makeTestStores } from '@dsebastien-website/testing'
import { nodeDevice } from '../apps/plugin/src/publishing/node/device.ts'
import { plan, publish, status } from '../apps/plugin/src/publishing/tool.ts'
import { startServer } from '../apps/site/server/serve.ts'

// The site of the invented fixture vault, to click through on this machine:
// the publishing tool publishes every new note of a copy of the fixture vault
// into a local content store, the site is built from it, and the plain local
// server serves it with its attachments. Everything lives in `.cache/` and is
// removed when the command stops. It never reads the real vault.
//
//     bun run site:fixture [--port 4322]

const SITE = fileURLToPath(new URL('../apps/site', import.meta.url))

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { port: { type: 'string', default: '4322' } },
    strict: true
})

const stores = await makeTestStores()
const cache = join(SITE, '.cache')
await mkdir(cache, { recursive: true })
const outDir = await mkdtemp(join(cache, 'site-fixture-'))

async function cleanUp(): Promise<void> {
    await rm(outDir, { recursive: true, force: true })
    await stores.remove()
}

try {
    const vault = await copyFixtureVault(stores)
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

    const build = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'ignore',
        stderr: 'inherit'
    })
    if ((await build.exited) !== 0) {
        throw new Error('the build of the site failed')
    }

    const server = await startServer({
        dist: outDir,
        port: Number(values.port),
        attachments: stores.attachmentStorage
    })
    console.error(`The site of the fixture vault is on ${server.url} (Ctrl+C stops it).`)
    const stop = (): void => {
        void server
            .stop()
            .then(cleanUp)
            .finally(() => process.exit(0))
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
} catch (error) {
    await cleanUp()
    throw error
}
