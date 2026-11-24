import { cp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
    checkNotModified,
    checkUrlTable,
    readUrlTable,
    type Ask
} from '../apps/site/src/url-table.ts'
import { buildUrlTableSite } from '../apps/site/src/url-table-site.ts'
import { prepareOutputFolder, type OutputOptions } from './output-folder.ts'

// The URL table on a host (SEAM-04 and HOST-02 of the spec, issue 21): the
// same cases that the tests run on the plain local server and on the Worker,
// against a host by its address (a preview host, a test host).
//
//     bun run urls build [--out <folder>]
//     bun run urls check --base <address> [--notes <folder>]
//
// `build` publishes the invented notes of the table from a copy of the
// fixture vault and builds their site into `.cache/url-table-site/`, or into
// the folder of `--out` (inside the clone, below a folder that git ignores):
// `dist/` is the output to put on the host, `notes/` holds the cleaned notes
// that `check` compares the Markdown of the host with. It removes an earlier
// output of its own, and refuses a folder with other files. `check` asks the
// host for each case and for two files that did not change (304, URL-18),
// prints what has a finding, and ends with the code 1 when there is one. It
// never reads the real vault.

const FOLDER = fileURLToPath(new URL('../.cache/url-table-site', import.meta.url))

/** The marker of the output folder: the command removes only a folder that it made. */
const OPTIONS: OutputOptions = { marker: 'url-table-site.json', tool: 'urls' }

/** The paths of the table site that a host must answer 304 for when they did not change (URL-18). */
const UNCHANGED = ['/Welcome', '/-/md/Welcome.md']

async function build(out: string): Promise<void> {
    // It refuses a folder that holds files of another origin, and removes nothing then.
    const folder = await prepareOutputFolder(out, OPTIONS)
    const table = await readUrlTable()
    const site = await buildUrlTableSite(table, join(folder, 'dist'))
    try {
        if (site.exitCode !== 0) {
            throw new Error(`the build of the site ended with the code ${String(site.exitCode)}`)
        }
        await cp(join(site.contentStore, 'notes'), join(folder, 'notes'), { recursive: true })
    } finally {
        await site.remove()
    }
    console.error(`The site of the URL table is in ${folder}`)
}

/** The text of a failure of a request, as a finding. */
function noAnswer(error: unknown): string[] {
    return [`no answer: ${error instanceof Error ? error.message : String(error)}`]
}

async function check(base: string, notes: string): Promise<number> {
    // No slash at the end: a case of the table starts with one.
    const address = base.replace(/\/+$/u, '')
    const table = await readUrlTable()
    const ask: Ask = (path, headers = {}) =>
        fetch(`${address}${path}`, { redirect: 'manual', headers })
    const wrong = await checkUrlTable(ask, {
        table,
        markdownOf: (path) => readFile(join(notes, path), 'utf8')
    })
    for (const path of UNCHANGED) {
        const findings = await checkNotModified(path, ask).catch(noAnswer)
        if (findings.length > 0) {
            wrong.push({ name: 'a file that did not change', request: path, findings })
        }
    }
    for (const entry of wrong) {
        console.error(`${entry.name} (${entry.request})`)
        for (const finding of entry.findings) {
            console.error(`    ${finding}`)
        }
    }
    console.error(
        `${String(table.cases.length)} cases and ${String(UNCHANGED.length)} files that did not change, ${String(wrong.length)} with a finding`
    )
    return wrong.length === 0 ? 0 : 1
}

const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        base: { type: 'string' },
        notes: { type: 'string', default: join(FOLDER, 'notes') },
        out: { type: 'string', default: FOLDER }
    },
    allowPositionals: true,
    strict: true
})
const [command] = positionals
if (command === 'build' && positionals.length === 1) {
    await build(resolve(values.out))
} else if (command === 'check' && positionals.length === 1 && values.base !== undefined) {
    process.exitCode = await check(values.base, resolve(values.notes))
} else {
    console.error(
        'Usage: bun run urls build [--out <folder>] | bun run urls check --base <address> [--notes <folder>]'
    )
    process.exitCode = 2
}
