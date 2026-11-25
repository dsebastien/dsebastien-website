import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEPLOYMENT_RECORD_FILE } from '@dsebastien-website/resolver'
import type { AttachmentStorage } from '../../plugin/src/publishing/ports.ts'
import {
    checkOutput,
    ATTACHMENT_KEY,
    checkOutputLimits,
    deploymentRecordFrom,
    HOST_LIMITS,
    type DeploymentRecord,
    type HostLimits,
    type ReleaseBuild
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
// run fails after it (decision 4 of the comment of 2026-11-25 on issue 32).
// Without one, a failure deletes nothing. The steps that reach a host are
// ports: the command line (`scripts/deploy.ts`) gives the real ones, the
// tests give fakes.

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
    /**
     * How many reads in a row must give the record. After a switch, the old
     * and the new release answer in turn for some seconds.
     */
    readonly inARow: number
}

/** The checks of the host after a deployment or a revert: 30 reads, 1 second apart, 3 in a row. */
export const LIVE_CHECKS = { checks: 30, pause: 1000, inARow: 3 } as const

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
    /**
     * True when the revision is the revision of the copy or one of its
     * ancestors, false when it is not, `undefined` when the copy does not
     * know it. Without it, a live release of the content store is refused.
     */
    readonly descendsFrom?: (revision: string) => Promise<boolean | undefined>
    /** Checks right before the deployment that the copy is still what the build read. It throws when not. */
    readonly beforeDeploy?: () => Promise<void>
    /** The whole `_headers` file of the output. */
    readonly headers: string
    /** Builds the site and gives the folder of its output. It throws when the build fails. */
    readonly build: () => Promise<string>
    /** The limits of the host. By default `HOST_LIMITS`. */
    readonly limits?: HostLimits
    /**
     * Puts the output on the host as one new release. It throws when it
     * fails. In a dry run it checks the bundle only.
     */
    readonly deploy: (dist: string) => Promise<void>
    /** True for a dry run: it never counts as a deployment. */
    readonly dryRun?: boolean
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

/**
 * Runs the task on each item, a few at a time. After the first failure it
 * starts no new task, waits for the ones that run, then throws that failure.
 */
async function eachItem<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    let failure: { error: unknown } | undefined
    const worker = async (): Promise<void> => {
        while (failure === undefined && next < items.length) {
            const item = items[next]
            next += 1
            if (item === undefined) {
                continue
            }
            try {
                await task(item)
            } catch (error) {
                failure ??= { error }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
    if (failure !== undefined) {
        throw failure.error
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * A refusal: the release must not replace the live one. It deletes nothing,
 * also after a takedown, because a newer release can be live.
 */
class Refusal extends Error {}

/**
 * The record of the live release: `null` when the host has none (404, a
 * first deployment). It throws a refusal when the record cannot be read.
 */
async function liveRecordOf(live: LiveRecord): Promise<DeploymentRecord | null> {
    let value: unknown
    try {
        value = await live.read()
    } catch (error) {
        throw new Refusal(
            `the record of the live release cannot be read, so the command cannot know that this release is not older: ${messageOf(error)}`
        )
    }
    if (value === undefined) {
        return null
    }
    const record = deploymentRecordFrom(value)
    if (record === undefined) {
        throw new Refusal('the host gives a deployment record that cannot be read')
    }
    return record
}

/**
 * Refuses a release that must not replace the live release (issue 32): its
 * content must descend from the live content, so a takedown never comes
 * back with older content. A host with no record (a first deployment) takes
 * any release; an output built elsewhere (`--dist`) never replaces a release
 * of the content store.
 */
async function checkOver(run: DeployRun, live: DeploymentRecord | null): Promise<void> {
    if (live === null || live.contentRevision === null) {
        return
    }
    if (run.contentRevision === null) {
        throw new Refusal(
            `--dist would replace the live release of the content store ${live.contentRevision}`
        )
    }
    const descends = await run.descendsFrom?.(live.contentRevision)
    if (descends === undefined) {
        throw new Refusal(
            `the copy of the content store does not know the live content revision ${live.contentRevision}: fetch the copy, or check the target`
        )
    }
    if (!descends) {
        throw new Refusal(
            `the live content revision ${live.contentRevision} is not in the history of this copy (${run.contentRevision}): older or other content would go live`
        )
    }
}

/** The three fields of the build of a record. */
function buildOf(record: DeploymentRecord): ReleaseBuild {
    return {
        contentRevision: record.contentRevision,
        siteRevision: record.siteRevision,
        builtAt: record.builtAt
    }
}

/** The time of a build, in UTC, to the second. */
function timeOf(date: Date): string {
    return `${date.toISOString().slice(0, 19)}Z`
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
        const others: string[] = []
        for (const name of [...names].sort()) {
            if (used.has(name)) {
                continue
            }
            if (ATTACHMENT_KEY.test(name)) {
                unused.push(name)
            } else {
                others.push(name)
                warnings.push(
                    run.takedown
                        ? `a file can still be public: the attachment storage has a file that is not a key, left as it is: ${name}`
                        : `the attachment storage has a file that is not a key, left as it is: ${name}`
                )
            }
        }
        const failures: string[] = []
        await eachItem(unused, async (key) => {
            try {
                if (await storage.remove(key)) {
                    deleted += 1
                }
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
        // As the takedown of the tool: such a name can be a file of the takedown.
        if (run.takedown && others.length > 0) {
            throw new Error(
                `after a takedown, the attachment storage has files that are not keys: ${others.join(', ')}`
            )
        }
    }

    let error: string | null = null
    try {
        // The release that this one replaces: `undefined` in a dry run.
        const replaced = run.live === undefined ? undefined : await liveRecordOf(run.live)
        if (replaced !== undefined) {
            await checkOver(run, replaced)
        }
        if (run.storage !== undefined) {
            stored = await run.storage.list()
            await upload(run, run.storage, new Set(stored), () => {
                uploaded += 1
            })
        }

        let dist: string
        let record: DeploymentRecord
        try {
            dist = await run.build()
            // A wrong folder gets no file: the check comes before the writes.
            const output = await checkOutput(dist)
            if (output !== undefined) {
                throw new Error(output)
            }
            record = {
                contentRevision: run.contentRevision,
                siteRevision: run.siteRevision,
                builtAt: timeOf(run.now()),
                ...(replaced === undefined
                    ? {}
                    : { previous: replaced === null ? null : buildOf(replaced) })
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
            await run.beforeDeploy?.()
        } catch (failure) {
            throw new Refusal(messageOf(failure))
        }
        if (run.live !== undefined && replaced !== undefined) {
            const now = await liveRecordOf(run.live)
            const same =
                now === null || replaced === null
                    ? now === replaced
                    : sameRecord(buildOf(now), replaced)
            if (!same) {
                throw new Refusal(
                    `another release went live during the build (content ${now?.contentRevision ?? 'none'}): deploy again`
                )
            }
        }
        try {
            await run.deploy(dist)
            deploy = run.dryRun === true ? 'skipped' : 'ok'
        } catch (failure) {
            deploy = 'failed'
            throw failure
        }

        if (run.live !== undefined) {
            live = (await waitForRecord(run.live, run.wait, (seen) => sameRecord(record, seen)))
                .accepted
            if (live) {
                run.log(`live: ${run.url}`)
            } else {
                warnings.push(
                    `the host did not give the record of this build yet: check ${new URL(DEPLOYMENT_RECORD_FILE, run.url).href}`
                )
            }
        }

        if (run.storage !== undefined && stored !== undefined && !live && !run.takedown) {
            // The release before can still be live, with files that the new one does not use.
            warnings.push(
                'the release was not seen live, so no file was deleted from the attachment storage'
            )
        } else if (run.storage !== undefined && stored !== undefined) {
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
        const refused = failure instanceof Refusal
        if (run.takedown && refused) {
            warnings.push(
                'a file can still be public: the deployment was refused, so no file of the takedown was deleted'
            )
        } else if (run.takedown && run.storage !== undefined && stored === undefined) {
            warnings.push(
                'a file can still be public: the attachment storage could not be listed, so no file of the takedown was deleted'
            )
        }
        if (
            run.takedown &&
            !refused &&
            deploy !== 'ok' &&
            run.storage !== undefined &&
            stored !== undefined
        ) {
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
 * It first checks every key: a key in neither place stops it before any
 * upload. A file of the folder that is not the file of its key stops it
 * before it is uploaded, after the uploads that run end. It calls `uploaded`
 * after each upload.
 */
async function upload(
    run: DeployRun,
    storage: AttachmentStorage,
    stored: ReadonlySet<string>,
    uploaded: () => void
): Promise<void> {
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
    await eachItem(wanted, async (key) => {
        const bytes = await run.attachments.read(key)
        if (createHash('sha256').update(bytes).digest('hex') !== key) {
            throw new Error(`the file ${key} of the attachment folder is not the file of its key`)
        }
        await storage.put(key, bytes)
        uploaded()
    })
    run.log(`uploaded ${String(wanted.length)} attachments to the attachment storage`)
}

/**
 * Reads the record that the host gives until `accept` takes it on
 * `inARow` reads in a row, at most `checks` times. It gives that record, or
 * `undefined` and the last record that it read.
 */
async function waitForRecord(
    live: LiveRecord,
    wait: (milliseconds: number) => Promise<void>,
    accept: (record: DeploymentRecord | undefined) => boolean
): Promise<{ accepted: boolean; last: DeploymentRecord | undefined }> {
    let row = 0
    let last: DeploymentRecord | undefined
    for (let check = 1; check <= live.checks; check += 1) {
        last = deploymentRecordFrom(await live.read().catch(() => undefined))
        row = accept(last) ? row + 1 : 0
        if (row >= live.inARow) {
            return { accepted: true, last }
        }
        if (check < live.checks) {
            await wait(live.pause)
        }
    }
    return { accepted: false, last }
}

/** What a revert takes (BUILD-07). */
export interface RevertRun {
    /** Makes the release before the live one live again. It throws when it fails. */
    readonly rollback: () => Promise<void>
    /**
     * The subjects of the takedown commits after `from` up to `to` in the copy
     * of the content store, or `undefined` when the copy does not know them.
     */
    readonly takedownsBetween: (from: string, to: string) => Promise<string[] | undefined>
    readonly live: LiveRecord
    readonly wait: (milliseconds: number) => Promise<void>
}

/** What a revert did: the records that the host gave before and after it. */
export interface RevertResult {
    readonly before: DeploymentRecord
    readonly after: DeploymentRecord | undefined
    /** True when the host gave the record of the release before on reads in a row. */
    readonly changed: boolean
}

/**
 * Goes back to the release before (BUILD-07). The live record names the
 * release that it replaced; a revert that would bring back a note that a
 * takedown removed in between is refused (a commit whose subject starts with
 * `Takedown:`), and so is a live release that names no release before it.
 * Then it rolls back and reads the host until it gives the record of the
 * release before on reads in a row, a bounded number of times. It throws
 * when it refuses.
 */
export async function revertRelease(run: RevertRun): Promise<RevertResult> {
    const value = await run.live.read()
    const before = value === undefined ? undefined : deploymentRecordFrom(value)
    const target = before?.previous
    if (before === undefined || target === undefined || target === null) {
        throw new Error(
            'the live release names no release before it with a record: deploy a new release instead'
        )
    }
    if (before.contentRevision !== null && target.contentRevision !== null) {
        const takedowns = await run.takedownsBetween(target.contentRevision, before.contentRevision)
        if (takedowns === undefined) {
            throw new Error(
                `the copy of the content store does not know ${target.contentRevision} and ${before.contentRevision}: fetch the copy`
            )
        }
        if (takedowns.length > 0) {
            throw new Error(
                `a takedown lies between the release before and the live one (${takedowns.join('; ')}): deploy a new release instead`
            )
        }
    }
    await run.rollback()
    const { accepted, last } = await waitForRecord(run.live, run.wait, (seen) =>
        sameRecord(target, seen)
    )
    return { before, after: last, changed: accepted }
}

/** True when two records name the same build. */
function sameRecord(one: ReleaseBuild, two: ReleaseBuild | undefined): boolean {
    return (
        two !== undefined &&
        one.contentRevision === two.contentRevision &&
        one.siteRevision === two.siteRevision &&
        one.builtAt === two.builtAt
    )
}

/**
 * The deployment record that a host gives (STORE-08), as JSON, or
 * `undefined` when it answers "not found" (no record). Any other failure
 * throws. The record is never kept, so each
 * read asks the host.
 */
export async function readHostRecord(
    url: string,
    fetch: (url: URL, init: RequestInit) => Promise<Response> = (address, init) =>
        globalThis.fetch(address, init)
): Promise<unknown> {
    const response = await fetch(new URL(DEPLOYMENT_RECORD_FILE, url), { cache: 'no-store' })
    if (response.status === 404) {
        await response.body?.cancel()
        return undefined
    }
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`the host answers ${String(response.status)} for ${DEPLOYMENT_RECORD_FILE}`)
    }
    return (await response.json()) as unknown
}
