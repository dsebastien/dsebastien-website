import { cp, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
    checkNotModified,
    checkUrlTable,
    isRealHost,
    readUrlTable,
    type Ask
} from '../apps/site/src/url-table.ts'
import { resolverMapFrom } from '@dsebastien-website/resolver'
import { buildUrlTableSite } from '../apps/site/src/url-table-site.ts'
import {
    checkKnownUrls,
    isPrivatePlace,
    knownUrlsFromLines,
    knownUrlsFromList,
    knownUrlsFromSitemap,
    mergeKnownUrls,
    type KnownUrl
} from '../apps/site/src/url-parity.ts'
import { prepareOutputFolder, type OutputOptions } from './output-folder.ts'

// The URL table on a host (SEAM-04 and HOST-02 of the spec, issue 21): the
// same cases that the tests run on the plain local server and on the Worker,
// against a host by its address (a preview host, a test host).
//
//     bun run urls build [--out <folder>]
//     bun run urls check --base <address> [--notes <folder>]
//     bun run urls parity --base <address> [--list <csv>]... [--sitemap <xml>]...
//         [--urls <text>]... [--concurrency <n>] [--gate] [--report <file>] [--show-paths]
//         [--map <file>]
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
//
// `parity` is the URL parity test (story 161, RES-06; issue 60 runs it before
// the switch): it asks the host for every URL that its sources know, follows
// one redirect at most, compares paths decoded, and prints the count of each
// class by source. A source is a private file of the author, read where it
// is: `--list` the redirect list (CSV), `--sitemap` a sitemap of the current
// site, `--urls` one URL or path per line (a report, a crawl). Each option
// can come several times. It prints counts only. The URLs that do not
// answer as expected go to the file of `--report` (JSON, a new file outside
// the clone or in its `.private/` folder), and to the standard error with
// `--show-paths`. `--map` prints the counts of the redirect list that the
// resolver map of a build holds (numbers only). It ends with the code 1
// when a URL does not answer as expected, and with `--gate` also when a row
// waits for a decision of the author (SW-04).

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
    // The edge of a real host answers some cases before the Worker (R87);
    // nothing stands before a server on this machine.
    const wrong = await checkUrlTable(
        ask,
        { table, markdownOf: (path) => readFile(join(notes, path), 'utf8') },
        { realHost: isRealHost(address) }
    )
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

/** The root of the clone. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

interface ParityOptions {
    readonly lists: readonly string[]
    readonly sitemaps: readonly string[]
    readonly texts: readonly string[]
    readonly concurrency: number
    readonly gate: boolean
    readonly report: string | undefined
    readonly showPaths: boolean
    readonly map: string | undefined
}

async function parity(base: string, options: ParityOptions): Promise<number> {
    if (options.report !== undefined && !(await isPrivatePlace(options.report, ROOT))) {
        console.error(
            'The report names private paths: write it outside the clone or into .private/'
        )
        return 2
    }
    if (options.report !== undefined && (await Bun.file(options.report).exists())) {
        // A file that exists can be a link that someone put there.
        console.error('The report file exists: give a new file')
        return 2
    }
    if (options.map !== undefined) {
        // Numbers only: the map holds no old path.
        const map = resolverMapFrom(JSON.parse(await readFile(options.map, 'utf8')))
        const counts = Object.entries(map.redirects?.counts ?? {}).map(
            ([what, count]) => `${what} ${String(count)}`
        )
        console.error(`the redirect list of the build: ${counts.join(', ')}`)
    }
    const address = base.replace(/\/+$/u, '')
    const read = async (
        files: readonly string[],
        kind: string,
        of: (text: string, source: string) => KnownUrl[]
    ): Promise<KnownUrl[][]> =>
        await Promise.all(
            files.map(async (file) => of(await readFile(file, 'utf8'), `${kind}:${basename(file)}`))
        )
    const urls = mergeKnownUrls([
        ...(await read(options.lists, 'list', knownUrlsFromList)),
        ...(await read(options.sitemaps, 'sitemap', knownUrlsFromSitemap)),
        ...(await read(options.texts, 'urls', knownUrlsFromLines))
    ])
    const ask: Ask = (path, headers = {}) =>
        fetch(`${address}${path}`, { redirect: 'manual', headers })
    const result = await checkKnownUrls(urls, ask, { concurrency: options.concurrency })
    for (const [source, counts] of Object.entries(result.counts)) {
        const parts = Object.entries(counts).map(
            ([verdict, count]) => `${verdict} ${String(count)}`
        )
        console.error(`${source}: ${parts.join(', ')}`)
    }
    const wrong = result.checks.filter((check) => check.verdict !== 'ok')
    if (options.report !== undefined) {
        // `wx`: the file must not exist, so a link put there is never followed.
        await writeFile(options.report, `${JSON.stringify(wrong, null, 2)}\n`, { flag: 'wx' })
    }
    if (options.showPaths) {
        for (const check of wrong) {
            const target = check.location === undefined ? '' : ` -> ${check.location}`
            console.error(
                `    ${check.verdict} ${String(check.status ?? '')} ${check.url.path}${target}`
            )
        }
    }
    console.error(
        `${String(urls.length)} known URLs, ${String(result.failed)} that do not answer as expected, ${String(result.pending)} waiting for a decision`
    )
    return result.failed > 0 || (options.gate && result.pending > 0) ? 1 : 0
}

const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        'base': { type: 'string' },
        'list': { type: 'string', multiple: true, default: [] },
        'sitemap': { type: 'string', multiple: true, default: [] },
        'urls': { type: 'string', multiple: true, default: [] },
        'concurrency': { type: 'string', default: '8' },
        'gate': { type: 'boolean', default: false },
        'report': { type: 'string' },
        'show-paths': { type: 'boolean', default: false },
        'map': { type: 'string' },
        'notes': { type: 'string', default: join(FOLDER, 'notes') },
        'out': { type: 'string', default: FOLDER }
    },
    allowPositionals: true,
    strict: true
})
const [command] = positionals
if (command === 'build' && positionals.length === 1) {
    await build(resolve(values.out))
} else if (command === 'check' && positionals.length === 1 && values.base !== undefined) {
    process.exitCode = await check(values.base, resolve(values.notes))
} else if (
    command === 'parity' &&
    positionals.length === 1 &&
    values.base !== undefined &&
    /^[1-9][0-9]*$/u.test(values.concurrency)
) {
    process.exitCode = await parity(values.base, {
        lists: values.list.map((file) => resolve(file)),
        sitemaps: values.sitemap.map((file) => resolve(file)),
        texts: values.urls.map((file) => resolve(file)),
        concurrency: Number(values.concurrency),
        gate: values.gate,
        report: values.report === undefined ? undefined : resolve(values.report),
        showPaths: values['show-paths'],
        map: values.map === undefined ? undefined : resolve(values.map)
    })
} else {
    console.error(
        'Usage: bun run urls build [--out <folder>] | bun run urls check --base <address> [--notes <folder>] | bun run urls parity --base <address> [--list <csv>]... [--sitemap <xml>]... [--urls <text>]... [--concurrency <n>] [--gate] [--report <file>] [--show-paths] [--map <file>]'
    )
    process.exitCode = 2
}
