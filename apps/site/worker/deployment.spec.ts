import { describe, expect, test } from 'bun:test'
import { headersFile, targetFrom, workerConfiguration } from './deployment.ts'

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

    test('serves a host of its own zone as a custom domain', () => {
        const configuration = workerConfiguration(
            { ...PREVIEW, host: 'notes.origin.example', noindex: false },
            PATHS
        )
        expect(configuration.routes).toEqual([
            { pattern: 'notes.origin.example', custom_domain: true }
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
    // The files of `/_astro/` and `/-/search/` do not run the Worker.
    test('marks every file noindex on a preview host', () => {
        expect(headersFile(PREVIEW)).toBe('/*\n  X-Robots-Tag: noindex\n')
    })

    test('is empty on a host that is indexed', () => {
        expect(headersFile({ ...PREVIEW, noindex: false })).toBe('')
    })
})
