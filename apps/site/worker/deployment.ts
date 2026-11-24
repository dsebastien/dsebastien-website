// The deployment of a release to a host (issue 30, HOST-01, IDX-26): the
// configuration of the Worker that wrangler deploys, and the `_headers` file
// of the static files. The names of a host come from a target file that is
// kept in a private place: no name of an account or of a host is in this
// repository. `scripts/deploy.ts` writes both files and runs wrangler.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RESOLVER_MAP_FILE } from '@dsebastien-website/resolver'

/** Where a release goes. */
export interface DeployTarget {
    /** The account of the host: 32 hexadecimal digits. */
    readonly accountId: string
    /** The name of the Worker. */
    readonly worker: string
    /** The name of the bucket of the attachment storage. */
    readonly bucket: string
    /** The host name that readers ask for. */
    readonly host: string
    /**
     * The zone of the account whose route sends the host to the Worker: a
     * custom hostname of this zone (Cloudflare for SaaS), or a name of the
     * zone that has a proxied DNS record.
     */
    readonly zone: string
    /** True on a preview host: every answer says `noindex` (IDX-26). */
    readonly noindex: boolean
}

const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u

const CHECKS: Record<keyof DeployTarget, (value: unknown) => boolean> = {
    accountId: (value) => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value),
    worker: (value) =>
        typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value),
    bucket: (value) =>
        typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value),
    host: (value) => typeof value === 'string' && HOST_NAME.test(value),
    zone: (value) => typeof value === 'string' && HOST_NAME.test(value),
    noindex: (value) => typeof value === 'boolean'
}

/** Reads a target file. It throws with the name of the first field that is wrong. */
export function targetFrom(value: unknown): DeployTarget {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('the target of a deployment must be an object')
    }
    const fields: Record<string, unknown> = { ...value }
    for (const key of Object.keys(fields)) {
        if (!Object.hasOwn(CHECKS, key)) {
            throw new Error(`the target of a deployment has an unknown field: ${key}`)
        }
    }
    for (const [key, check] of Object.entries(CHECKS)) {
        if (!check(fields[key])) {
            throw new Error(`the target of a deployment has a wrong or missing ${key}`)
        }
    }
    return {
        accountId: String(fields['accountId']),
        worker: String(fields['worker']),
        bucket: String(fields['bucket']),
        host: String(fields['host']),
        zone: String(fields['zone']),
        noindex: fields['noindex'] === true
    }
}

/** A route of the Worker, as wrangler takes it. */
export interface WorkerRoute {
    readonly pattern: string
    readonly zone_name: string
}

/** The configuration of the Worker, as wrangler takes it. */
export interface WorkerConfiguration {
    readonly name: string
    readonly account_id: string
    readonly main: string
    readonly compatibility_date: string
    readonly workers_dev: false
    readonly preview_urls: false
    readonly routes: readonly WorkerRoute[]
    readonly assets: {
        readonly directory: string
        readonly binding: 'ASSETS'
        readonly html_handling: 'none'
        readonly not_found_handling: 'none'
        readonly run_worker_first: readonly string[]
    }
    readonly r2_buckets: readonly [
        { readonly binding: 'ATTACHMENTS'; readonly bucket_name: string }
    ]
    readonly vars: { readonly NOINDEX: 'true' | 'false' }
    readonly observability: { readonly enabled: true }
}

/**
 * The configuration of the Worker of a target. The static files give a file
 * only by its exact name (`html_handling` and `not_found_handling` are
 * `none`): with another value they redirect the `.html` paths and the Worker
 * answers 500 (issue 117). The Worker runs first for every path but the
 * folders of the files that the pages load. The host is always a route of
 * the zone, never a custom domain: wrangler replaces the DNS record of a
 * custom domain without a question when it runs with no terminal, so a wrong
 * host would take over a live name. A route changes no DNS record.
 *
 * @param paths `main`: the entry of the Worker; `dist`: the output of the build.
 */
export function workerConfiguration(
    target: DeployTarget,
    paths: { readonly main: string; readonly dist: string }
): WorkerConfiguration {
    return {
        name: target.worker,
        account_id: target.accountId,
        main: paths.main,
        compatibility_date: '2026-11-01',
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: `${target.host}/*`, zone_name: target.zone }],
        assets: {
            directory: paths.dist,
            binding: 'ASSETS',
            html_handling: 'none',
            not_found_handling: 'none',
            run_worker_first: ['/*', '!/_astro/*', '!/-/search/*']
        },
        r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: target.bucket }],
        vars: { NOINDEX: target.noindex ? 'true' : 'false' },
        observability: { enabled: true }
    }
}

/**
 * The whole `_headers` file of the static files: the deployment writes it
 * into the output, over any file of that name. It marks every static file;
 * that is what covers the files that the host gives without the Worker
 * (`/_astro/`, `/-/search/`), because the Worker marks its own answers.
 */
export function headersFile(target: DeployTarget): string {
    return target.noindex ? '/*\n  X-Robots-Tag: noindex\n' : ''
}

/**
 * Why a folder is not the output of a build, or `undefined` when it is. A
 * deployment puts the whole folder on the host: a wrong folder (an empty
 * `--dist` is the working folder) would publish files that are no release.
 */
export async function checkOutput(folder: string): Promise<string | undefined> {
    const kind = await stat(folder).catch(() => undefined)
    if (kind?.isDirectory() !== true) {
        return `${folder} is not a folder`
    }
    const map = await stat(join(folder, RESOLVER_MAP_FILE)).catch(() => undefined)
    if (map?.isFile() !== true) {
        return `${folder} is not the output of a build: it has no resolver map (${RESOLVER_MAP_FILE})`
    }
    return undefined
}
