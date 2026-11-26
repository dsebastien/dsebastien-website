import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
    FIXTURE_NOTE_TYPES,
    BUDGET_SAMPLE,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    writeBudgetSample
} from '@dsebastien-website/testing'
import { canonicalPath } from '@dsebastien-website/resolver'
import { fileNoteTypes, nodeDevice } from '../apps/plugin/src/publishing/node/device.ts'
import { plan, publish, status, takedown, unpublish } from '../apps/plugin/src/publishing/tool.ts'
import type { Subprocess } from 'bun'
import { startServer, type Server } from '../apps/site/server/serve.ts'
import { releaseImages } from '../apps/site/worker/deployment.ts'
import { writeVariants } from '../apps/site/worker/image-variants.ts'

// The site of the invented fixture vault, to click through on this machine:
// the publishing tool publishes every new note of a copy of the fixture vault
// into a local content store, the site is built from it, and the plain local
// server serves it with its attachments and the variants of its images, made
// as a deploy makes them (issue 87). Everything lives in `.cache/` and is
// removed when the command stops. It never reads the real vault.
//
//     bun run site:fixture [--port 4322] [--sample]
//
// With `--sample`, the vault also holds the budget sample: invented notes as
// large as the large published notes (a long note with a long outline, a media
// note, a hub note with 489 backlinks and its page with all of them).
//
// One invented note that no other note links to is unpublished by a second
// publication, so that the gone page (410) shows at its address. The same
// publication moves one more invented note into another folder, as the
// rename journal of the plugin records it, so that its old address answers
// 301 to its new one. One more
// invented note is taken down, with the sound file that only it uses, so that
// its address answers 404. The server error page (500) is printed as a file
// to open in a browser: a working server never gives it.

const SITE = fileURLToPath(new URL('../apps/site', import.meta.url))

/** The invented note that the second publication unpublishes (URL-27). */
const GONE_NOTE = '10 Garden/Bean trellis.md'

/** The invented note that the second publication moves, and its new path (URL-21, R66). */
const MOVED_NOTE = { from: '10 Garden/Wormery.md', to: '10 Garden/Compost/Wormery.md' }

/** The invented note that a takedown removes, with its sound file (URL-28). */
const TAKEN_DOWN_NOTE = '50 Field guide/Embeds/Embed of a sound.md'

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
const variants = `${outDir}-variants`

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
            await rm(variants, { recursive: true, force: true })
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
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore,
        attachmentStorage: stores.attachmentStorage
    })
    const queue = await status(device)
    const planned = await plan(device, { include: queue.new })
    const run = {
        time: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
        device: 'site-fixture',
        face: 'command-line'
    } as const
    const report = await publish(device, planned.id, run)
    console.error(`Published ${String(queue.new.length)} invented notes of the fixture vault.`)
    for (const warning of report.warnings) {
        console.error(`  warning: ${warning.path}: ${warning.message}`)
    }
    // A move in Obsidian: the file moves, and the plugin writes a line.
    await mkdir(dirname(join(vault, MOVED_NOTE.to)), { recursive: true })
    await rename(join(vault, MOVED_NOTE.from), join(vault, MOVED_NOTE.to))
    const journals = join(vault, '.obsidian', 'plugins', 'dsebastien-vault-publish', 'renames')
    await mkdir(journals, { recursive: true })
    await writeFile(
        join(journals, '0000000000000001.jsonl'),
        `${JSON.stringify({ from: MOVED_NOTE.from, kind: 'note', time: run.time, to: MOVED_NOTE.to })}\n`
    )
    const second = await unpublish(device, [GONE_NOTE], run)
    console.error(
        `Unpublished ${GONE_NOTE}, and moved ${String(second.moved.length)} note(s): ${second.moved.map((move) => `${move.from} to ${move.to}`).join(', ')}.`
    )
    const takenDown = await takedown(device, [TAKEN_DOWN_NOTE], run)
    console.error(
        `Took down ${TAKEN_DOWN_NOTE}, and ${String(takenDown.attachmentsDeleted.length)} file(s) of the attachment storage.`
    )

    // The output of the build shows its warnings, as a build of real notes
    // gives them after a takedown or an unpublish (R65). The notes are
    // invented: a build of real notes keeps its log private (the deploy log).
    build = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir], {
        cwd: SITE,
        env: { ...process.env, CONTENT_STORE: contentStore },
        stdout: 'inherit',
        stderr: 'inherit'
    })
    const built = await build.exited
    build = undefined
    if (built !== 0) {
        throw new Error('the build of the site failed')
    }

    await writeVariants(
        await releaseImages(contentStore),
        async (key) => new Uint8Array(await readFile(join(stores.attachmentStorage, key))),
        variants
    )
    server = await startServer({
        dist: outDir,
        port: Number(values.port),
        attachments: stores.attachmentStorage,
        variants
    })
    console.error(`The site of the fixture vault is on ${server.url} (Ctrl+C stops it).`)
    console.error(`  the gone page (410): ${server.url}${canonicalPath(GONE_NOTE)}`)
    console.error(`  a note taken down (404): ${server.url}${canonicalPath(TAKEN_DOWN_NOTE)}`)
    console.error(
        `  the old address of a note that moved (301): ${server.url}${canonicalPath(MOVED_NOTE.from)}`
    )
    console.error(`  the server error page (500), as a file: ${join(outDir, '500.html')}`)
    if (values.sample) {
        for (const path of Object.values(BUDGET_SAMPLE)) {
            console.error(`  ${server.url}${canonicalPath(path)}`)
        }
    }
} catch (error) {
    console.error(error)
    await stop(1)
}
