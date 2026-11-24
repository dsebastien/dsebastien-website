import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// PROTOTYPE (issue 21, hosting). Throwaway code.
//
// Writes the wrangler configuration of a test Worker into `.cache/`, so that
// no name of the hosting account is in a file of this repository. The names
// come from the command line or from the environment.
//
//     bun prototype/hosting/config.ts --name <worker> --dist <folder> \
//         [--entry <file>] [--host <name>] [--bucket <name>] [--worker-first all|pages]
//         [--search-in-storage]
//
// It prints the path of the configuration file.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        'name': { type: 'string' },
        'dist': { type: 'string' },
        'entry': { type: 'string', default: join(ROOT, 'prototype/hosting/entry.ts') },
        'host': { type: 'string' },
        'bucket': { type: 'string' },
        'worker-first': { type: 'string', default: 'pages' },
        'search-in-storage': { type: 'boolean', default: false }
    },
    strict: true
})
if (values.name === undefined || values.dist === undefined) {
    throw new Error('--name and --dist are required')
}

const configuration = {
    name: values.name,
    main: resolve(values.entry),
    compatibility_date: '2026-11-01',
    assets: {
        directory: resolve(values.dist),
        binding: 'ASSETS',
        // A file is given by the exact path of its name, and by nothing else.
        html_handling: 'none',
        not_found_handling: 'none',
        // `pages`: the files that the pages load are given without the Worker.
        run_worker_first:
            values['worker-first'] === 'all'
                ? true
                : values['search-in-storage']
                  ? ['/*', '!/_astro/*', '!/-/search/titles/*']
                  : ['/*', '!/_astro/*', '!/-/search/*']
    },
    ...(values['search-in-storage'] ? { vars: { SEARCH_IN_STORAGE: '1' } } : {}),
    ...(values.bucket === undefined
        ? {}
        : { r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: values.bucket }] }),
    ...(values.host === undefined
        ? { workers_dev: true }
        : { workers_dev: false, routes: [{ pattern: values.host, custom_domain: true }] }),
    observability: { enabled: true }
}

const folder = join(ROOT, '.cache', 'hosting-prototype', values.name)
await mkdir(folder, { recursive: true })
const file = join(folder, 'wrangler.jsonc')
await writeFile(file, `${JSON.stringify(configuration, null, 4)}\n`)
process.stdout.write(`${file}\n`)
