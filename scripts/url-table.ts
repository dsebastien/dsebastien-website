import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkUrlTable, readUrlTable } from '../apps/site/src/url-table.ts'
import { buildUrlTableSite } from '../apps/site/src/url-table-site.ts'

// The URL table on a host (SEAM-04 and HOST-02 of the spec, issue 21): the
// same cases that the tests run on the plain local server and on the Worker,
// against a host by its address (a preview host, a test host).
//
//     bun run urls build
//     bun run urls check --base <address> [--notes <folder>]
//
// `build` publishes the invented notes of the table from a copy of the
// fixture vault and builds their site into `apps/site/.cache/url-table-site/`:
// `dist/` is the output to put on the host, `notes/` holds the cleaned notes
// that `check` compares the Markdown of the host with. `check` asks the host
// for each case, prints the cases with a finding, and ends with the code 1
// when there is one. It never reads the real vault.

const FOLDER = fileURLToPath(new URL('../apps/site/.cache/url-table-site', import.meta.url))

/** The file that marks the folder as made by this command: only such a folder is ever removed. */
const MARKER = '.url-table-site'

async function build(): Promise<void> {
    const marker = join(FOLDER, MARKER)
    if (await Bun.file(marker).exists()) {
        await rm(FOLDER, { recursive: true, force: true })
    } else if (await Bun.file(FOLDER).exists()) {
        throw new Error(`${FOLDER} exists and this command did not make it`)
    }
    await mkdir(FOLDER, { recursive: true })
    await writeFile(marker, 'bun run urls build\n')
    const table = await readUrlTable()
    const site = await buildUrlTableSite(table, join(FOLDER, 'dist'))
    try {
        if (site.exitCode !== 0) {
            throw new Error(`the build of the site ended with the code ${String(site.exitCode)}`)
        }
        await cp(join(site.contentStore, 'notes'), join(FOLDER, 'notes'), { recursive: true })
    } finally {
        await site.remove()
    }
    console.error(`The site of the URL table is in ${FOLDER}`)
}

async function check(base: string, notes: string): Promise<number> {
    // No slash at the end: a case of the table starts with one.
    const address = base.replace(/\/+$/u, '')
    const table = await readUrlTable()
    const wrong = await checkUrlTable(
        (path, headers = {}) => fetch(`${address}${path}`, { redirect: 'manual', headers }),
        { table, markdownOf: (path) => readFile(join(notes, path), 'utf8') }
    )
    for (const entry of wrong) {
        console.error(`${entry.name} (${entry.request})`)
        for (const finding of entry.findings) {
            console.error(`    ${finding}`)
        }
    }
    console.error(`${String(table.cases.length)} cases, ${String(wrong.length)} with a finding`)
    return wrong.length === 0 ? 0 : 1
}

const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        base: { type: 'string' },
        notes: { type: 'string', default: join(FOLDER, 'notes') }
    },
    allowPositionals: true,
    strict: true
})
const [command] = positionals
if (command === 'build' && positionals.length === 1) {
    await build()
} else if (command === 'check' && positionals.length === 1 && values.base !== undefined) {
    process.exitCode = await check(values.base, resolve(values.notes))
} else {
    console.error(
        'Usage: bun run urls build | bun run urls check --base <address> [--notes <folder>]'
    )
    process.exitCode = 2
}
