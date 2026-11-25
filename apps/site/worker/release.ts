import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEPLOYMENT_RECORD_FILE } from '@dsebastien-website/resolver'
import type { AttachmentStorage } from '../../plugin/src/publishing/ports.ts'
import {
    checkOutput,
    checkOutputLimits,
    deploymentRecordFrom,
    HOST_LIMITS,
    type DeploymentRecord,
    type HostLimits
} from './deployment.ts'

// The run of a deployment (issue 32, BUILD-07, BUILD-08, STORE-08, PUB-42):
//
// 1. the attachments: each key that the release uses and that the object
//    storage lacks goes up from the attachment folder of the machine; a key
//    in neither place stops the run before the build;
// 2. the build, then its deployment record and its headers file, then the
//    limits of the host;
// 3. the deployment (one new Worker version, one switch);
// 4. the host is read until it gives the record of this build: live;
// 5. the object storage loses each key that no published note uses.
//
// With a takedown, step 5 runs also when a step before it fails, and the
// run fails after it (decision of the author 3). Without one, a failure
// deletes nothing. The steps that reach a host are ports: the command line
// (`scripts/deploy.ts`) gives the real ones, the tests give fakes.

/** The files of the attachment folder of the machine, by their keys. */
export interface AttachmentFolder {
    exists(key: string): Promise<boolean>
    read(key: string): Promise<Uint8Array>
}

/** The deployment record that the host gives, read a bounded number of times. */
export interface LiveRecord {
    /** Reads the record that the host gives now. */
    readonly read: () => Promise<unknown>
    /** How many times it reads the host at most. */
    readonly checks: number
    /** The pause between two reads, in milliseconds. */
    readonly pause: number
}

/** The checks of the host after a deployment: 10 reads, 3 seconds apart. */
export const LIVE_CHECKS = { checks: 10, pause: 3000 } as const

/** What a run of a deployment takes. */
export interface DeployRun {
    /** The address of the site on the host, with its slash at the end. */
    readonly url: string
    /** The commit of the copy of the content store that the build reads. `null` for `--dist`. */
    readonly contentRevision: string | null
    /** The commit of the code of the site. */
    readonly siteRevision: string
    /** The clock, for the time of the build. */
    readonly now: () => Date
    /** The keys of the attachments that the release uses. */
    readonly usedKeys: readonly string[]
    /** The object storage of the host. Without it (a dry run), no attachment moves. */
    readonly storage?: AttachmentStorage
    /** The attachment folder of the machine. */
    readonly attachments: AttachmentFolder
    /** True when a takedown started the run. */
    readonly takedown: boolean
    /** The whole `_headers` file of the output. */
    readonly headers: string
    /** Builds the site and gives the folder of its output. It throws when the build fails. */
    readonly build: () => Promise<string>
    /** The limits of the host. By default `HOST_LIMITS`. */
    readonly limits?: HostLimits
    /** Puts the output on the host as one new release. It throws when it fails. */
    readonly deploy: (dist: string) => Promise<void>
    /** Reads the deployment record that the host gives. Without it (a dry run), no wait. */
    readonly live?: LiveRecord
    readonly wait: (milliseconds: number) => Promise<void>
    /** Takes a line of progress for the author. */
    readonly log: (line: string) => void
}

/** The result of a step of a deployment. */
export type StepResult = 'ok' | 'failed' | 'skipped'

/**
 * The result of a deployment, as the publishing tool reads it (PUB-42): the
 * last line of the standard output is `DEPLOY-RESULT ` and this, as one line
 * of JSON. `documentation/Configuration.md` states it.
 */
export interface DeployResult {
    readonly build: StepResult
    readonly deploy: StepResult
    /** True when the host gives the deployment record of this build. */
    readonly live: boolean
    readonly url: string
    /** The commit of the copy of the content store of the release. `null` for `--dist`. */
    readonly contentRevision: string | null
    /** The files uploaded to the object storage. */
    readonly uploaded: number
    /** The files deleted from the object storage. */
    readonly deleted: number
    readonly warnings: readonly string[]
    /** Why the run failed. `null` when it succeeded. */
    readonly error: string | null
}

/** The mark of the result line. */
export const RESULT_MARK = 'DEPLOY-RESULT'

/** The last line of the standard output of a deployment. */
export function resultLine(result: DeployResult): string {
    return `${RESULT_MARK} ${JSON.stringify(result)}`
}

/** How many uploads or deletions run at the same time. */
const PARALLEL = 8

/** The form of a key of the attachment storage. */
const ATTACHMENT_KEY = /^[0-9a-f]{64}$/u

/** Runs the task on each item, a few at a time. */
async function eachItem<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const item = items[next]
            next += 1
            if (item !== undefined) {
                await task(item)
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** The time of a build, in UTC, to the second. */
function timeOf(date: Date): string {
    return `${date.toISOString().slice(0, 19)}Z`
}

/** True when the record that the host gives is the record of this build. */
function isRecordOf(value: unknown, record: DeploymentRecord): boolean {
    return sameRecord(record, deploymentRecordFrom(value))
}

/** Runs a deployment. It never throws: a failure is in the result. */
export async function deployRelease(run: DeployRun): Promise<DeployResult> {
    const used = new Set(run.usedKeys)
    const warnings: string[] = []
    let build: StepResult = 'skipped'
    let deploy: StepResult = 'skipped'
    let live = false
    let uploaded = 0
    let deleted = 0
    let stored: string[] | undefined

    /** Deletes each key of the storage that no published note uses. */
    async function cleanUp(storage: AttachmentStorage, names: readonly string[]): Promise<void> {
        const unused: string[] = []
        for (const name of [...names].sort()) {
            if (used.has(name)) {
                continue
            }
            if (ATTACHMENT_KEY.test(name)) {
                unused.push(name)
            } else {
                warnings.push(
                    `the attachment storage has a file that is not a key, left as it is: ${name}`
                )
            }
        }
        const failures: string[] = []
        await eachItem(unused, async (key) => {
            try {
                await storage.remove(key)
                deleted += 1
            } catch (error) {
                failures.push(`${key}: ${messageOf(error)}`)
            }
        })
        if (failures.length > 0) {
            throw new Error(
                `the attachment storage kept files that no note uses: ${failures.sort().join('; ')}`
            )
        }
        run.log(`deleted ${String(deleted)} files that no note uses from the attachment storage`)
    }

    const record: DeploymentRecord = {
        contentRevision: run.contentRevision,
        siteRevision: run.siteRevision,
        builtAt: timeOf(run.now())
    }
    let error: string | null = null
    try {
        if (run.storage !== undefined) {
            stored = await run.storage.list()
            uploaded = await upload(run, run.storage, new Set(stored))
        }

        let dist: string
        try {
            dist = await run.build()
            // A wrong folder gets no file: the check comes before the writes.
            const output = await checkOutput(dist)
            if (output !== undefined) {
                throw new Error(output)
            }
            await writeFile(join(dist, '_headers'), run.headers)
            await writeFile(
                join(dist, DEPLOYMENT_RECORD_FILE),
                `${JSON.stringify(record, null, 4)}\n`
            )
            // The files that the deployment writes count too.
            const limits = await checkOutputLimits(dist, run.limits ?? HOST_LIMITS)
            if (limits !== undefined) {
                throw new Error(limits)
            }
            build = 'ok'
        } catch (failure) {
            build = 'failed'
            throw failure
        }

        try {
            await run.deploy(dist)
            deploy = 'ok'
        } catch (failure) {
            deploy = 'failed'
            throw failure
        }

        if (run.live !== undefined) {
            live = await waitUntilLive(run, run.live, record)
            if (!live) {
                warnings.push(
                    `the host did not give the record of this build yet: check ${new URL(DEPLOYMENT_RECORD_FILE, run.url).href}`
                )
            }
        }

        if (run.storage !== undefined && stored !== undefined) {
            try {
                await cleanUp(run.storage, stored)
            } catch (failure) {
                // A file that stays costs nothing, but the files of a takedown must go.
                if (run.takedown) {
                    throw failure
                }
                warnings.push(messageOf(failure))
            }
        }
    } catch (failure) {
        error = messageOf(failure)
        if (run.takedown && deploy !== 'ok' && run.storage !== undefined && stored !== undefined) {
            try {
                await cleanUp(run.storage, stored)
            } catch (cleanup) {
                error = `${error}; ${messageOf(cleanup)}`
            }
        }
    }
    return {
        build,
        deploy,
        live,
        url: run.url,
        contentRevision: run.contentRevision,
        uploaded,
        deleted,
        warnings,
        error
    }
}

/**
 * Uploads each used key that the storage lacks, from the attachment folder.
 * It first checks every key: a key in neither place, or a file of the folder
 * that is not the file of its key, stops it before any upload. It gives the
 * number of uploads.
 */
async function upload(
    run: DeployRun,
    storage: AttachmentStorage,
    stored: ReadonlySet<string>
): Promise<number> {
    const wanted = [...new Set(run.usedKeys)].filter((key) => !stored.has(key)).sort()
    const missing: string[] = []
    for (const key of wanted) {
        if (!(await run.attachments.exists(key))) {
            missing.push(key)
        }
    }
    if (missing.length > 0) {
        throw new Error(
            `the attachments of these keys are neither in the attachment folder nor in the attachment storage: ${missing.join(', ')}`
        )
    }
    let count = 0
    await eachItem(wanted, async (key) => {
        const bytes = await run.attachments.read(key)
        if (createHash('sha256').update(bytes).digest('hex') !== key) {
            throw new Error(`the file ${key} of the attachment folder is not the file of its key`)
        }
        await storage.put(key, bytes)
        count += 1
    })
    run.log(`uploaded ${String(count)} attachments to the attachment storage`)
    return count
}

/** Reads the record that the host gives until it is the record of this build. */
async function waitUntilLive(
    run: DeployRun,
    live: LiveRecord,
    record: DeploymentRecord
): Promise<boolean> {
    for (let check = 1; check <= live.checks; check += 1) {
        const value = await live.read().catch(() => undefined)
        if (isRecordOf(value, record)) {
            run.log(`live: ${run.url}`)
            return true
        }
        if (check < live.checks) {
            await run.wait(live.pause)
        }
    }
    return false
}

/** True when two records name the same build. */
function sameRecord(one: DeploymentRecord, two: DeploymentRecord | undefined): boolean {
    return (
        two !== undefined &&
        one.contentRevision === two.contentRevision &&
        one.siteRevision === two.siteRevision &&
        one.builtAt === two.builtAt
    )
}
