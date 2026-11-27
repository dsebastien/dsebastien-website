import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECURITY_HEADERS } from '@dsebastien-website/resolver'
import {
    ASSETS_IGNORE,
    analyticsVariable,
    checkOutput,
    checkOutputAnalytics,
    checkOutputLimits,
    checkOutputPolicy,
    deploymentRecordFrom,
    deployToken,
    headersFile,
    targetFrom,
    releaseImages,
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

/** The head of a resolver map in two parts. */
const HEAD = JSON.stringify({ version: 1, parts: 2, records: ['pages'], map: {} })
const ANALYTICS = {
    siteId: 'analytics-test.invalid',
    script: 'https://proxy.example/content/script.manual.js',
    event: 'https://proxy.example/api/v1/event'
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

    // AN-01: the site id and the proxy are settings of the target. A target
    // without them deploys a site without analytics.
    test('reads the analytics settings of a target', () => {
        expect(targetFrom({ ...PREVIEW, analytics: ANALYTICS })).toEqual({
            ...PREVIEW,
            analytics: ANALYTICS
        })
        expect(targetFrom(PREVIEW)).not.toHaveProperty('analytics')
    })

    test.each([
        ['siteId', 'Preview Notes'],
        ['script', 'https://proxy.example/content/script.js'],
        ['event', 'https://elsewhere.example/api/v1/event']
    ])('refuses analytics settings whose %s is %p', (key, value) => {
        expect(() => targetFrom({ ...PREVIEW, analytics: { ...ANALYTICS, [key]: value } })).toThrow(
            key
        )
    })

    test('refuses analytics settings that are not an object', () => {
        expect(() => targetFrom({ ...PREVIEW, analytics: null })).toThrow('analytics')
    })
})

describe('the analytics of the build of a target', () => {
    test('gives the settings of the target to the build', () => {
        expect(analyticsVariable({ ...PREVIEW, analytics: ANALYTICS })).toEqual({
            SITE_ANALYTICS: JSON.stringify(ANALYTICS)
        })
    })

    // An empty value, so that a variable of the shell of the author never reaches the build.
    test('gives an empty value without settings: the build has no analytics', () => {
        expect(analyticsVariable(PREVIEW)).toEqual({ SITE_ANALYTICS: '' })
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

    // Issue 121: the Worker reads the part of the first path while it reads the head.
    test('gives the Worker the count of the parts of the resolver map of the release', () => {
        expect(workerConfiguration(PREVIEW, PATHS, 1024).vars).toEqual({
            NOINDEX: 'true',
            MAP_PARTS: '1024'
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
    const SECURED = [
        '/*',
        ...Object.entries(SECURITY_HEADERS).map(([name, value]) => `  ${name}: ${value}`)
    ].join('\n')

    // Point 4 of the comment of issue 21 on issue 32: the host gives them
    // `max-age=0, must-revalidate` by default, and their names hold a hash.
    test('keeps the hashed files of the pages for a year on every host', () => {
        expect(headersFile({ ...PREVIEW, noindex: false })).toBe(`${IMMUTABLE}${SECURED}\n`)
    })

    // SEC-01 (issue 79): the files that the host gives without the Worker
    // (`/_astro/`, `/-/search/`) have the security headers of its answers.
    test('gives every static file the security headers', () => {
        expect(headersFile({ ...PREVIEW, noindex: false })).toContain(
            '/*\n  x-content-type-options: nosniff\n'
        )
    })

    // The files of `/_astro/` and `/-/search/` do not run the Worker.
    test('also marks every file noindex on a preview host', () => {
        expect(headersFile(PREVIEW)).toBe(`${IMMUTABLE}${SECURED}\n  X-Robots-Tag: noindex\n`)
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

/** The home page of a build, with or without the analytics tag of settings. */
function homePage(analytics?: typeof ANALYTICS): string {
    const tag =
        analytics === undefined
            ? ''
            : `<script defer src="${analytics.script}" data-domain="${analytics.siteId}" data-api="${analytics.event}"></script>`
    return `<!doctype html><html><head><title>Home</title>${tag}</head><body></body></html>`
}

// A deployment of a built output (`--dist`) cannot set the analytics of its
// build: it refuses an output whose analytics are not the ones of the target.
describe('the analytics of a built output', () => {
    test.each([
        ['the target has none and the output none', undefined, undefined],
        ['both have the same', ANALYTICS, ANALYTICS]
    ])('accepts an output when %s', async (_case, built, target) => {
        await withFolder(async (folder) => {
            await writeFile(join(folder, 'index.html'), homePage(built))
            const of = target === undefined ? PREVIEW : { ...PREVIEW, analytics: target }
            expect(await checkOutputAnalytics(folder, of)).toBeUndefined()
        })
    })

    test.each([
        ['another site id', { ...ANALYTICS, siteId: 'notes.example' }, ANALYTICS],
        ['another proxy', { ...ANALYTICS, event: 'https://proxy.example/e' }, ANALYTICS],
        ['analytics that the target does not have', ANALYTICS, undefined],
        ['no analytics, and the target has them', undefined, ANALYTICS]
    ])('refuses an output with %s', async (_case, built, target) => {
        await withFolder(async (folder) => {
            await writeFile(join(folder, 'index.html'), homePage(built))
            const of = target === undefined ? PREVIEW : { ...PREVIEW, analytics: target }
            expect(await checkOutputAnalytics(folder, of)).toContain('analytics')
        })
    })
})

// SEC-01 (issue 79): a new output has the policy of its pages. Only a
// rollback to an older build gives its pages the fallback policy.
describe('the page policy of an output', () => {
    test('accepts an output with a policy that refuses frames', async () => {
        await withFolder(async (folder) => {
            await mkdir(join(folder, '-'), { recursive: true })
            await writeFile(
                join(folder, '-', 'page-policy.txt'),
                "default-src 'self'; frame-ancestors 'none'"
            )
            expect(await checkOutputPolicy(folder)).toBeUndefined()
        })
    })

    test('refuses an output without a policy file', async () => {
        await withFolder(async (folder) => {
            expect(await checkOutputPolicy(folder)).toContain('-/page-policy.txt')
        })
    })

    test('refuses an output whose policy does not refuse frames', async () => {
        await withFolder(async (folder) => {
            await mkdir(join(folder, '-'), { recursive: true })
            await writeFile(join(folder, '-', 'page-policy.txt'), "default-src 'self'")
            expect(await checkOutputPolicy(folder)).toContain('does not refuse frames')
        })
    })
})

describe('the output that a deployment puts on the host', () => {
    /** Writes a head of a map in two parts, and the parts given. */
    async function mapParts(folder: string, parts: readonly number[]): Promise<void> {
        await mkdir(join(folder, '-', 'resolver-map'), { recursive: true })
        await writeFile(join(folder, '-', 'resolver-map', 'head.json'), HEAD)
        for (const part of parts) {
            await writeFile(join(folder, '-', 'resolver-map', `${String(part)}.json`), '{}')
        }
    }

    test('accepts the output of a build: a folder with the head of its resolver map and every part', async () => {
        await withFolder(async (folder) => {
            await mapParts(folder, [0, 1])
            expect(await checkOutput(folder)).toBeUndefined()
        })
    })

    test('refuses an output that lacks a part of its resolver map', async () => {
        await withFolder(async (folder) => {
            await mapParts(folder, [0])
            expect(await checkOutput(folder)).toContain('-/resolver-map/1.json')
        })
    })

    test('refuses an output with a part that is not a part of its map', async () => {
        await withFolder(async (folder) => {
            await mapParts(folder, [0, 1])
            await writeFile(join(folder, '-', 'resolver-map', '1.json'), '{"pages":{"/x":1}}')
            expect(await checkOutput(folder)).toBe(
                '-/resolver-map/1.json is not a part of the resolver map'
            )
        })
    })

    test('refuses an output with a part that is not JSON', async () => {
        await withFolder(async (folder) => {
            await mapParts(folder, [0, 1])
            await writeFile(join(folder, '-', 'resolver-map', '0.json'), '{')
            expect(await checkOutput(folder)).toContain('-/resolver-map/0.json')
        })
    })

    test('refuses an output whose head is not a head', async () => {
        await withFolder(async (folder) => {
            await mkdir(join(folder, '-', 'resolver-map'), { recursive: true })
            await writeFile(join(folder, '-', 'resolver-map', 'head.json'), '{}')
            expect(await checkOutput(folder)).toContain('is not the head')
        })
    })

    // Issue 121: the hosts read the map in parts; the whole map alone is an old output.
    test('refuses an output with the whole resolver map and no head', async () => {
        await withFolder(async (folder) => {
            await mkdir(join(folder, '-'))
            await writeFile(join(folder, '-', 'resolver-map.json'), '{}')
            expect(await checkOutput(folder)).toContain('-/resolver-map/head.json')
        })
    })

    // Issue 121: the whole map is read by the checks of the build only, and it
    // can pass the size limit of a static file.
    test('the whole resolver map does not go to the host', () => {
        expect(ASSETS_IGNORE).toBe('/-/resolver-map.json\n')
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

    test('do not count the files that the host does not take: the whole resolver map, the ignore file', async () => {
        await withFolder(async (folder) => {
            await output(folder)
            await writeFile(join(folder, '-', 'resolver-map.json'), '0123456789abc')
            await writeFile(join(folder, '.assetsignore'), ASSETS_IGNORE)
            expect(await checkOutputLimits(folder, { files: 5, fileSize: 10 })).toBeUndefined()
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

    // Issue 127: the record of a move to another content store says so.
    test('reads the move to another content store, and nothing else in its place', () => {
        expect(deploymentRecordFrom({ ...RECORD, newContentStore: true })).toEqual({
            ...RECORD,
            newContentStore: true
        })
        expect(deploymentRecordFrom({ ...RECORD, newContentStore: false })).toBeUndefined()
        expect(deploymentRecordFrom({ ...RECORD, newContentStore: 'yes' })).toBeUndefined()
    })

    // Issue 87, R92: the cleanup keeps the variants of the generation of the release before.
    test('reads the generation of the variants of the release', () => {
        expect(deploymentRecordFrom({ ...RECORD, variants: 2 })).toEqual({ ...RECORD, variants: 2 })
        expect(deploymentRecordFrom({ ...RECORD, variants: 0 })).toBeUndefined()
        expect(deploymentRecordFrom({ ...RECORD, variants: 1.5 })).toBeUndefined()
        expect(deploymentRecordFrom({ ...RECORD, variants: '1' })).toBeUndefined()
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
    test('leaves out every variable whose name holds a secret, in any letter case', () => {
        expect(
            withoutTokens({
                GITHUB_TOKEN: 'one',
                npm_config__authToken: 'two',
                AWS_SECRET_ACCESS_KEY: 'three',
                OPENAI_API_KEY: 'four',
                Db_Password: 'five',
                PATH: '/usr/bin',
                SSH_AUTH_SOCK: '/run/agent',
                HOME: '/home/test'
            })
        ).toEqual({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/run/agent', HOME: '/home/test' })
    })

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
    const FOUR = 'd4'.repeat(32)

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
            expect(await releaseImages(store)).toEqual([])
        })
    })

    // Issue 87: the images whose variants the pages of the release offer.
    test('give the images of the release that get variants, each key one time, with their variants', async () => {
        await withFolder(async (store) => {
            await mkdir(join(store, 'manifest'))
            const sized = (key: string, path: string, width: number, height: number) => ({
                ...attachment(key, path),
                width,
                height
            })
            const entries = {
                'a.json': {
                    ...ENTRY,
                    id: 'aaaaaaaaaaaaaaaa',
                    path: 'A.md',
                    state: 'published',
                    attachments: [
                        sized(TWO, 'cover.jpg', 1000, 1500),
                        sized(ONE, 'icon.png', 64, 64),
                        sized(FOUR, 'huge.jpg', 10_000, 6_000),
                        attachment(THREE, 'plan.pdf')
                    ]
                },
                'b.json': {
                    ...ENTRY,
                    id: 'bbbbbbbbbbbbbbbb',
                    path: 'B.md',
                    state: 'published',
                    attachments: [sized(TWO, 'copy of cover.jpg', 1000, 1500)]
                },
                'c.json': {
                    ...ENTRY,
                    id: 'cccccccccccccccc',
                    path: 'C.md',
                    state: 'unpublished',
                    attachments: [sized(THREE, 'w.png', 2000, 1000)]
                }
            }
            for (const [name, entry] of Object.entries(entries)) {
                await writeFile(join(store, 'manifest', name), JSON.stringify(entry))
            }
            expect(await releaseImages(store)).toEqual([
                {
                    key: TWO,
                    name: 'cover.jpg',
                    width: 1000,
                    height: 1500,
                    variants: [
                        { step: 480, width: 480, height: 720 },
                        { step: 800, width: 800, height: 1200 },
                        { step: 1200, width: 1000, height: 1500 }
                    ]
                },
                // Above 50 megapixels: no variant, and the deploy says so.
                { key: FOUR, name: 'huge.jpg', width: 10_000, height: 6_000, variants: [] }
            ])
        })
    })
})
