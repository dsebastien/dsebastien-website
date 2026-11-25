import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    checkOutput,
    checkOutputLimits,
    deploymentRecordFrom,
    deployToken,
    headersFile,
    targetFrom,
    usedAttachmentKeys,
    withoutTokens,
    workerConfiguration
} from './deployment.ts'

// The deployment of a release to a host (issue 30): the configuration of the
// Worker that wrangler deploys, and the `_headers` file of the static files.
// The names of a host come from a private target file, never from this
// repository: these tests use invented ones.

const ACCOUNT = 'ab'.repeat(16)

const PREVIEW = {
    accountId: ACCOUNT,
    worker: 'notes-preview',
    bucket: 'notes-attachments',
    host: 'preview.notes.example',
    zone: 'origin.example',
    noindex: true
}

const PATHS = { main: '/clone/apps/site/worker/worker.ts', dist: '/clone/apps/site/dist' }

describe('the target of a deployment', () => {
    test('reads a target file', () => {
        expect(targetFrom(PREVIEW)).toEqual(PREVIEW)
    })

    test.each([
        ['accountId', 'not an account'],
        ['worker', 'Notes Preview'],
        ['bucket', 'ab'],
        ['host', 'https://preview.notes.example/'],
        ['zone', ''],
        ['noindex', 'true']
    ])('refuses a target whose %s is %p', (key, value) => {
        expect(() => targetFrom({ ...PREVIEW, [key]: value })).toThrow(key)
    })

    test('refuses a target with a field that it does not know', () => {
        expect(() => targetFrom({ ...PREVIEW, token: 'x' })).toThrow('token')
    })

    test.each(['constructor', 'toString', '__proto__'])(
        'refuses a target with the inherited name %s',
        (key) => {
            expect(() =>
                targetFrom(JSON.parse(`{"${key}": 1, ${JSON.stringify(PREVIEW).slice(1)}`))
            ).toThrow(key)
        }
    )

    test('refuses a target that is not an object', () => {
        expect(() => targetFrom([])).toThrow('target')
    })
})

describe('the configuration of the Worker', () => {
    test('serves a host of another zone through a route of the zone that holds the Worker', () => {
        const configuration = workerConfiguration(PREVIEW, PATHS)
        expect(configuration).toMatchObject({
            name: 'notes-preview',
            account_id: ACCOUNT,
            main: PATHS.main,
            workers_dev: false,
            preview_urls: false,
            routes: [{ pattern: 'preview.notes.example/*', zone_name: 'origin.example' }],
            r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'notes-attachments' }],
            vars: { NOINDEX: 'true' }
        })
    })

    // A custom domain lets wrangler replace a DNS record of the zone without a question
    // when it runs with no terminal: a wrong host would take over a live name.
    test('serves a host of its own zone through a route too, never as a custom domain', () => {
        const configuration = workerConfiguration(
            { ...PREVIEW, host: 'notes.origin.example', noindex: false },
            PATHS
        )
        expect(configuration.routes).toEqual([
            { pattern: 'notes.origin.example/*', zone_name: 'origin.example' }
        ])
        expect(configuration.vars).toEqual({ NOINDEX: 'false' })
    })

    // The configuration of the prototype of issue 21 (point 2 of the comment on issue 32).
    test('gives a file only by its exact name, and runs the Worker first but for the files that the pages load', () => {
        expect(workerConfiguration(PREVIEW, PATHS).assets).toEqual({
            directory: PATHS.dist,
            binding: 'ASSETS',
            html_handling: 'none',
            not_found_handling: 'none',
            run_worker_first: ['/*', '!/_astro/*', '!/-/search/*']
        })
    })
})

describe('the headers file of the static files', () => {
    const IMMUTABLE = '/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n'

    // Point 4 of the comment of issue 21 on issue 32: the host gives them
    // `max-age=0, must-revalidate` by default, and their names hold a hash.
    test('keeps the hashed files of the pages for a year on every host', () => {
        expect(headersFile({ ...PREVIEW, noindex: false })).toBe(IMMUTABLE)
    })

    // The files of `/_astro/` and `/-/search/` do not run the Worker.
    test('also marks every file noindex on a preview host', () => {
        expect(headersFile(PREVIEW)).toBe(`${IMMUTABLE}/*\n  X-Robots-Tag: noindex\n`)
    })
})

const CACHE = fileURLToPath(new URL('../../../.cache', import.meta.url))

/** Runs with a folder of its own in `.cache/`, and removes it after. */
async function withFolder(run: (folder: string) => Promise<void>): Promise<void> {
    await mkdir(CACHE, { recursive: true })
    const folder = await mkdtemp(join(CACHE, 'deployment-spec-'))
    try {
        await run(folder)
    } finally {
        await rm(folder, { recursive: true, force: true })
    }
}

describe('the output that a deployment puts on the host', () => {
    test('accepts the output of a build: a folder with a resolver map', async () => {
        await withFolder(async (folder) => {
            await mkdir(join(folder, '-'))
            await writeFile(join(folder, '-', 'resolver-map.json'), '{}')
            expect(await checkOutput(folder)).toBeUndefined()
        })
    })

    // An empty `--dist` is the working folder: the whole clone would go to the host.
    test('refuses a folder that is not the output of a build', async () => {
        await withFolder(async (folder) => {
            await writeFile(join(folder, 'package.json'), '{}')
            expect(await checkOutput(folder)).toContain('resolver map')
        })
    })

    test('refuses a path that is not a folder', async () => {
        expect(await checkOutput(join(CACHE, 'no-such-folder'))).toContain('not a folder')
    })
})

// BUILD-08: the host takes a number of files per Worker version and a size
// per file. The tests give small limits.
describe('the limits of the host', () => {
    async function output(folder: string): Promise<void> {
        await mkdir(join(folder, '-', 'note'), { recursive: true })
        await mkdir(join(folder, '-', 'search', 'pagefind'), { recursive: true })
        await mkdir(join(folder, '_astro'))
        await writeFile(join(folder, 'index.html'), 'home')
        await writeFile(join(folder, '-', 'note', 'a.html'), 'a')
        await writeFile(join(folder, '-', 'note', 'b.html'), 'b')
        await writeFile(join(folder, '-', 'search', 'pagefind', 'p.json'), 'p')
        await writeFile(join(folder, '_astro', 'site.css'), '0123456789')
    }

    test('pass when the output is under both', async () => {
        await withFolder(async (folder) => {
            await output(folder)
            expect(await checkOutputLimits(folder, { files: 5, fileSize: 10 })).toBeUndefined()
        })
    })

    test('stop a release with more files than the host takes, with the count of each class', async () => {
        await withFolder(async (folder) => {
            await output(folder)
            const problem = await checkOutputLimits(folder, { files: 4, fileSize: 10 })
            expect(problem).toContain('5 files')
            expect(problem).toContain('4')
            expect(problem).toContain('-/note: 2')
            expect(problem).toContain('-/search: 1')
            expect(problem).toContain('_astro: 1')
        })
    })

    test('stop a release with a file larger than the host takes, by its name', async () => {
        await withFolder(async (folder) => {
            await output(folder)
            const problem = await checkOutputLimits(folder, { files: 5, fileSize: 9 })
            expect(problem).toContain('_astro/site.css')
            expect(problem).toContain('9 bytes')
        })
    })
})

describe('the deployment record', () => {
    const RECORD = {
        contentRevision: 'a'.repeat(40),
        siteRevision: 'b'.repeat(40),
        builtAt: '2031-04-01T08:00:00Z'
    }

    test('reads a record', () => {
        expect(deploymentRecordFrom(RECORD)).toEqual(RECORD)
    })

    test.each([
        ['contentRevision', 'main'],
        ['siteRevision', 7],
        ['builtAt', 'yesterday']
    ])('is no record when its %s is %p', (key, value) => {
        expect(deploymentRecordFrom({ ...RECORD, [key]: value })).toBeUndefined()
    })

    test('reads the record of an output that was built elsewhere: no content revision', () => {
        expect(deploymentRecordFrom({ ...RECORD, contentRevision: null })).toEqual({
            ...RECORD,
            contentRevision: null
        })
    })

    test('is no record when the answer is not an object', () => {
        expect(deploymentRecordFrom('live')).toBeUndefined()
    })

    // A revert goes back to the release before: the record names it.
    test('reads the record of the release that it replaced, or none', () => {
        const previous = { ...RECORD, contentRevision: 'c'.repeat(40) }
        expect(deploymentRecordFrom({ ...RECORD, previous })).toEqual({ ...RECORD, previous })
        expect(deploymentRecordFrom({ ...RECORD, previous: null })).toEqual({
            ...RECORD,
            previous: null
        })
    })

    test('keeps only the three fields of the record that it replaced', () => {
        const previous = { ...RECORD, previous: { ...RECORD } }
        expect(deploymentRecordFrom({ ...RECORD, previous })).toEqual({
            ...RECORD,
            previous: RECORD
        })
    })

    test('is no record when the record that it replaced is not one', () => {
        expect(deploymentRecordFrom({ ...RECORD, previous: { builtAt: 'x' } })).toBeUndefined()
    })
})

describe('the token of a deployment', () => {
    test('is the token of the notes first', () => {
        expect(
            deployToken({ NOTES_DEPLOY_CLOUDFLARE_API_TOKEN: 'notes', CLOUDFLARE_API_TOKEN: 'any' })
        ).toBe('notes')
    })

    test('is the token of wrangler when the notes have none', () => {
        expect(
            deployToken({ NOTES_DEPLOY_CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_TOKEN: 'any' })
        ).toBe('any')
    })

    test('is missing when neither is set', () => {
        expect(deployToken({})).toBeUndefined()
    })

    // The install and the build run code of packages: they get no token.
    test('leaves an environment for the steps that need no token', () => {
        expect(
            withoutTokens({
                NOTES_DEPLOY_CLOUDFLARE_API_TOKEN: 'notes',
                CLOUDFLARE_API_TOKEN: 'any',
                HOME: '/home/test'
            })
        ).toEqual({ HOME: '/home/test' })
    })
})

describe('the attachments that a release uses', () => {
    const ENTRY = {
        aliases: [],
        cleanedHash: 'sha256:0',
        cleaningVersion: 2,
        firstPublished: '2031-04-01T08:00:00Z',
        formerPaths: [],
        lastPublished: '2031-04-01T08:00:00Z',
        links: [],
        sourceHash: 'sha256:0'
    }
    const ONE = 'a1'.repeat(32)
    const TWO = 'b2'.repeat(32)
    const THREE = 'c3'.repeat(32)

    function attachment(key: string, path: string): Record<string, unknown> {
        return { hash: `sha256:${key}`, link: path, path, size: 1 }
    }

    test('are the keys of the attachments of the published entries, each one time', async () => {
        await withFolder(async (store) => {
            await mkdir(join(store, 'manifest'))
            const entries = {
                'a.json': {
                    ...ENTRY,
                    id: 'aaaaaaaaaaaaaaaa',
                    path: 'A.md',
                    state: 'published',
                    attachments: [attachment(TWO, 'x.png'), attachment(ONE, 'y.png')]
                },
                'b.json': {
                    ...ENTRY,
                    id: 'bbbbbbbbbbbbbbbb',
                    path: 'B.md',
                    state: 'published',
                    attachments: [attachment(TWO, 'z.png')]
                },
                'c.json': {
                    ...ENTRY,
                    id: 'cccccccccccccccc',
                    path: 'C.md',
                    state: 'unpublished',
                    attachments: [attachment(THREE, 'w.png')]
                }
            }
            for (const [name, entry] of Object.entries(entries)) {
                await writeFile(join(store, 'manifest', name), JSON.stringify(entry))
            }
            expect(await usedAttachmentKeys(store)).toEqual([ONE, TWO])
        })
    })

    test('are none for a content store with no publication', async () => {
        await withFolder(async (store) => {
            expect(await usedAttachmentKeys(store)).toEqual([])
        })
    })
})
