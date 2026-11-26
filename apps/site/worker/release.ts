import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MAX_ATTACHMENT_SIZE } from '../../plugin/src/publishing/attachments.ts'
import { DEPLOYMENT_RECORD_FILE, SITE_ORIGIN } from '@dsebastien-website/resolver'
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
import {
    changedUrls,
    INDEXNOW_ENDPOINT,
    indexNowBatches,
    sitemapDates,
    type IndexNowBatch
} from '../src/indexnow.ts'
import { locsOf, SITEMAP_INDEX_PATH } from '../src/sitemaps.ts'

// The run of a deployment (issue 32, BUILD-07, BUILD-08, STORE-08, PUB-42):
//
// 1. the forced files leave the object storage at once (issue 120): the
//    files that the guards withdrew, and the files of the notes of a
//    takedown or of a forced removal that the new release does not use;
// 2. the attachments: each key that the release uses and that the object
//    storage lacks goes up from the attachment folder of the machine; a key
//    in neither place stops the run before the build;
// 3. the build, then its deployment record and its headers file, then the
//    limits of the host;
// 4. the deployment (one new Worker version, one switch);
// 5. the host is read until it gives the record of this build: live;
// 6. the search engines (issue 54): the live `robots.txt` is compared with
//    the build output (AI-06), and IndexNow gets the URLs of the sitemaps
//    that are new, changed or removed since the live sitemaps, which are
//    read right before the deployment (IDX-35);
// 7. the object storage loses each key that neither the new release nor
//    the release before it uses, so one revert keeps its files.
//
// A failure deletes no other file than the ones of step 1 (decision F4 of
// the author on issue 120). The steps that reach a host are ports: the
// command line (`scripts/deploy.ts`) gives the real ones, the tests give
// fakes.

/** The files of the attachment folder of the machine, by their keys. */
export interface AttachmentFolder {
    exists(key: string): Promise<boolean>
    /** The number of bytes of the file of the key, from the file system: no byte is read. */
    size(key: string): Promise<number>
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

/**
 * The keys of the notes that the history of the copy took away (issue 120,
 * review round 2). A removal that the live release does not hold yet beats
 * every release: its files leave at once, unless the new release uses them
 * (business rule 16). A removal that the live release holds follows the
 * kept rule: its files leave when neither the new release nor the live
 * release uses them, so a later note that uses such a file openly keeps it.
 */
export interface RemovedKeys {
    /** The keys of the removals that the live release does not hold. */
    readonly notLive: readonly string[]
    /** The keys of the removals that the live release holds. */
    readonly inLive: readonly string[]
    /** What the read of the history warns about (a file that is no entry), for the result. */
    readonly warnings?: readonly string[]
}

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
    /**
     * The keys of the attachments that the release uses, or the read of
     * them. A read that throws stops the run after the withdrawn files left.
     */
    readonly usedKeys: readonly string[] | (() => Promise<readonly string[]>)
    /**
     * The keys of the attachments of the notes that a takedown or a forced
     * removal took away, in the whole history of the copy (issue 120), apart
     * by whether the live release of this content revision (`null`: none)
     * holds the removal. A read that throws fails closed (decision of the
     * author of 2026-11-26): every file that the new release does not use
     * leaves at once, as on a first deployment, with a warning that names
     * the cause, and the run goes on.
     */
    readonly removedKeys?: (live: string | null) => Promise<RemovedKeys>
    /**
     * Why the copy cannot be built (it has changes, it is behind its content
     * store), found after the fetch (review round 3). The run deletes the
     * withdrawn files when that is safe, then refuses with it.
     */
    readonly copyRefusal?: string
    /** True when the commit of the copy is the `main` of the content store, after the fetch. */
    readonly copyAtMain?: boolean
    /**
     * The keys that the guards withdrew (`withdrawn.json` of the copy, decision of the author R78, after R45,
     * issue 120): they leave the object storage at once, also when the
     * release uses them (unless the copy does not know the live revision),
     * and are never uploaded.
     */
    readonly withdrawnKeys?: readonly string[]
    /**
     * The keys that a release of this content revision uses, from the copy,
     * or `undefined` when the copy cannot read that revision. The cleanup
     * keeps them for the release before (issue 120). Without it, no
     * revision can be read.
     */
    readonly releaseKeys?: (revision: string) => Promise<readonly string[] | undefined>
    /**
     * The subjects of the commits after `from` up to `to` in the copy that
     * deleted a manifest entry (a takedown, a forced removal, any other
     * commit; issue 120), read from their content. When one lies between the
     * live release and this one, the run counts as a takedown. `undefined`
     * when the copy cannot say.
     */
    readonly removalsBetween?: (from: string, to: string) => Promise<string[] | undefined>
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
    /**
     * True when the author moves the host to another content store (issue
     * 127, `--new-content-store`): the live content revision must then be
     * one that the copy does not know. The tools never set it.
     */
    readonly newContentStore?: boolean
    /**
     * True when the content store of the copy has the revision (issue 127).
     * It throws when it cannot say. Without it, a move is refused.
     */
    readonly contentStoreHas?: (revision: string) => Promise<boolean>
    /** Checks right before the deployment that the copy is still what the build read. It throws when not. */
    readonly beforeDeploy?: () => Promise<void>
    /** The whole `_headers` file of the output. */
    readonly headers: string
    /** Builds the site and gives the folder of its output. It throws when the build fails. */
    readonly build: () => Promise<string>
    /** What the build warns about after it succeeded (the store catalog it could not use, issue 56), for the result. */
    readonly buildWarnings?: () => Promise<readonly string[]>
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
    /** The search engines after a release that is seen live (issue 54). Without it, nothing. */
    readonly search?: SearchHost
    /**
     * True for the first deployment of the real host (`--switch`, R85): the
     * build dates the sitemaps for the switch, and IndexNow gets every URL
     * of the sitemaps, whatever the old host listed.
     */
    readonly atSwitch?: boolean
}

/**
 * The live host as a search engine reads it, and IndexNow (issue 54). Only
 * a deployment that is seen live uses it, never a dry run.
 */
export interface SearchHost {
    /** The text of a file of the live host, by its path; `null` when it answers 404. It throws on another failure. */
    read(path: string): Promise<string | null>
    /**
     * Sends one batch to IndexNow. It throws when IndexNow does not take it.
     * Absent for a host marked noindex or that is not the canonical host:
     * then no URL is sent, and no sitemap is read.
     */
    readonly submit?: (batch: IndexNowBatch) => Promise<void>
    /**
     * The URLs that IndexNow did not take yet, kept on this machine between
     * two deployments (review of issue 54): the next deployment sends them
     * first. Without it, they are lost.
     */
    readonly pending?: {
        read(): Promise<readonly string[]>
        write(urls: readonly string[]): Promise<void>
    }
}

/**
 * The URLs of the sitemaps of a host, with their dates: none when it has no
 * `/sitemap.xml`. An old host can give a plain sitemap there (`<urlset>`):
 * it is read as the one sitemap, never as an index.
 */
async function sitemapsOf(
    read: (path: string) => Promise<string | null>
): Promise<Map<string, string>> {
    const index = await read(SITEMAP_INDEX_PATH)
    if (index === null) {
        return new Map()
    }
    if (!/<sitemapindex[\s>]/u.test(index)) {
        return sitemapDates([index])
    }
    const files: string[] = []
    for (const loc of locsOf(index)) {
        const text = await read(new URL(loc).pathname)
        if (text !== null) {
            files.push(text)
        }
    }
    return sitemapDates(files)
}

/** A file of the output of a build, or `null` when it has none. */
async function outputFile(dist: string, path: string): Promise<string | null> {
    return await readFile(join(dist, ...path.slice(1).split('/')), 'utf8').catch(() => null)
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

/**
 * The result of a deployment that stopped before its first step (wrong
 * arguments, a target file that cannot be read, the lock, a copy with
 * changes or behind its content store, keys that cannot be read). After a
 * takedown it warns that a file can still be public, as the takedown of the
 * tool does: no file of the takedown was deleted.
 *
 * @param url the address of the site, or `''` when the target is not known
 */
export function stoppedResult(error: unknown, url: string, takedown: boolean): DeployResult {
    return {
        build: 'skipped',
        deploy: 'skipped',
        live: false,
        url,
        contentRevision: null,
        uploaded: 0,
        deleted: 0,
        warnings: takedown
            ? [
                  'a file can still be public: the deployment stopped before its first step, so no file of the takedown was deleted'
              ]
            : [],
        error: error instanceof Error ? error.message : String(error)
    }
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
 * of the content store. With `run.newContentStore`, `checkMove()` decides
 * instead.
 */
async function checkOver(run: DeployRun, live: DeploymentRecord | null): Promise<void> {
    if (run.newContentStore === true) {
        await checkMove(run, live)
        return
    }
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

/**
 * Refuses a move to another content store (issue 127) that is no move: the
 * host has no release of a content store, the copy knows the live content
 * revision or its content store has it (the same store), the command
 * cannot ask the content store, or the run is `--dist` or a takedown.
 */
async function checkMove(run: DeployRun, live: DeploymentRecord | null): Promise<void> {
    if (run.contentRevision === null) {
        throw new Refusal('--dist cannot move the host to another content store')
    }
    if (run.takedown) {
        throw new Refusal(
            'a takedown cannot move the host to another content store: deploy the takedown from the content store of the live release first'
        )
    }
    if (live === null || live.contentRevision === null) {
        throw new Refusal(
            'the host has no release of a content store, so there is nothing to move: deploy without --new-content-store'
        )
    }
    const descends = await run.descendsFrom?.(live.contentRevision)
    if (descends === true) {
        throw new Refusal(
            `the copy knows the live content revision ${live.contentRevision}, so it is the same content store: deploy without --new-content-store`
        )
    }
    if (descends === false) {
        throw new Refusal(
            `the live content revision ${live.contentRevision} is not in the history of this copy (${run.contentRevision}), but the copy knows it: older or other content of the same content store would go live`
        )
    }
    // A copy that is only behind does not know the live revision either.
    let has: boolean
    try {
        if (run.contentStoreHas === undefined) {
            throw new Error('nothing can ask the content store of the copy')
        }
        has = await run.contentStoreHas(live.contentRevision)
    } catch (error) {
        throw new Refusal(
            `the command cannot know that the live content revision ${live.contentRevision} is in another content store: ${messageOf(error)}`
        )
    }
    if (has) {
        throw new Refusal(
            `the content store of the copy has the live content revision ${live.contentRevision}, so it is the same content store: fetch the copy and deploy without --new-content-store`
        )
    }
    run.log(
        `moving the host to another content store: this release replaces the live content revision ${live.contentRevision}`
    )
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

/**
 * After a release that is seen live: the check of `robots.txt` (AI-06), then
 * the URLs that changed since the sitemaps of `before` go to IndexNow, only
 * the URLs of the host of the release. A failure is a warning: the release
 * is live, and the next deployment sends its own changes.
 */
async function tellSearchEngines(
    run: DeployRun,
    search: SearchHost,
    dist: string,
    before: Map<string, string>,
    warnings: string[]
): Promise<void> {
    try {
        const robots = await search.read('/robots.txt')
        if (robots !== (await outputFile(dist, '/robots.txt'))) {
            warnings.push(
                'the live robots.txt is not the one of the build: check that the managed robots.txt of the host is off (AI-06)'
            )
        }
    } catch (failure) {
        warnings.push(`the live robots.txt cannot be read (${messageOf(failure)})`)
    }
    if (search.submit === undefined) {
        return
    }
    const origin = new URL(run.url).origin
    const after = await sitemapsOf((path) => outputFile(dist, path))
    // The URLs that a deployment before kept come first, once each.
    let kept: readonly string[] = []
    try {
        kept = (await search.pending?.read()) ?? []
    } catch (failure) {
        warnings.push(`the URLs kept for IndexNow cannot be read (${messageOf(failure)})`)
    }
    const urls = [
        ...new Set(
            [...kept, ...changedUrls(before, after)].filter((url) => new URL(url).origin === origin)
        )
    ]
    let sent = 0
    try {
        for (const batch of indexNowBatches(origin, urls)) {
            await search.submit(batch)
            sent += batch.urlList.length
        }
        run.log(`IndexNow: ${String(sent)} URL(s) sent`)
    } catch (failure) {
        run.log(`IndexNow: ${messageOf(failure)}`)
        warnings.push(
            `IndexNow did not take ${String(urls.length - sent)} URL(s): they wait for the next deployment`
        )
    }
    try {
        await search.pending?.write(urls.slice(sent))
    } catch (failure) {
        warnings.push(`the URLs that IndexNow did not take cannot be kept (${messageOf(failure)})`)
    }
}

/** Runs a deployment. It never throws: a failure is in the result. */
export async function deployRelease(run: DeployRun): Promise<DeployResult> {
    const withdrawn = new Set(run.withdrawnKeys ?? [])
    // The keys of the copy, once read (`readKeys()`).
    let used = new Set<string>()
    let forced = new Set<string>(withdrawn)
    /** The keys of the removals that the live release holds, that the new release does not use. */
    let earlier: string[] = []
    /** The cause, when the history of the copy cannot be read: then every file that the new release does not use is forced. */
    let unknownHistory: string | undefined
    /** The step that stopped the run before the list of the storage, for the warning of a takedown. */
    let stoppedAt: string | undefined
    const warnings: string[] = []
    // A takedown, or a run whose copy holds a takedown or a forced removal
    // that the live release does not have yet: its pages must go.
    let takedown = run.takedown
    /** The failures that come after the error of the run, when there is one. */
    const failures: string[] = []
    let build: StepResult = 'skipped'
    let deploy: StepResult = 'skipped'
    let live = false
    let uploaded = 0
    let deleted = 0
    let stored: string[] | undefined

    /** Deletes these keys. It gives the failures, one text per key. */
    async function remove(storage: AttachmentStorage, keys: readonly string[]): Promise<string[]> {
        const failed: string[] = []
        await eachItem(keys, async (key) => {
            try {
                if (await storage.remove(key)) {
                    deleted += 1
                }
            } catch (error) {
                failed.push(`${key}: ${messageOf(error)}`)
            }
        })
        return failed.sort()
    }

    /**
     * Reads the keys of the copy. A withdrawn file counts for no note: the
     * page shows it as missing (R45). The files that leave at once (issue
     * 120): the files that the guards withdrew, and the files of the notes
     * of a takedown or of a forced removal that the live release does not
     * hold and that the new release does not use. Business rule 16 wins over
     * a release that still uses such a file for another note.
     */
    async function readKeys(): Promise<void> {
        let keys: readonly string[]
        try {
            keys = typeof run.usedKeys === 'function' ? await run.usedKeys() : run.usedKeys
        } catch (failure) {
            await removeWithoutRelease(messageOf(failure))
            throw failure
        }
        used = new Set(keys.filter((key) => !withdrawn.has(key)))
        let removed: RemovedKeys
        try {
            removed = (await run.removedKeys?.(
                replaced?.contentRevision === undefined || run.newContentStore === true
                    ? null
                    : replaced.contentRevision
            )) ?? { notLive: [], inLive: [] }
        } catch (error) {
            // Decision of the author of 2026-11-26: fail closed.
            unknownHistory = messageOf(error)
            warnings.push(
                `the history of the copy cannot be read (${unknownHistory}), so every file that the new release does not use was deleted from the attachment storage, as on a first deployment`
            )
            removed = { notLive: [], inLive: [] }
        }
        warnings.push(...(removed.warnings ?? []))
        forced = new Set([...withdrawn, ...removed.notLive.filter((key) => !used.has(key))])
        earlier = removed.inLive.filter((key) => !used.has(key) && !forced.has(key))
    }

    /**
     * When the keys of the new release cannot be read (last look, L1), the
     * files of every removal of the history leave all the same, with no
     * filter of a release; when the history cannot be read either, every
     * file that the live release does not use leaves (a reading, easy to
     * change). The run then stops, with a warning that a file can still be
     * public.
     */
    async function removeWithoutRelease(cause: string): Promise<void> {
        const storage = run.storage
        if (storage === undefined) {
            return
        }
        let keys: string[]
        let how: string
        try {
            const removed = (await run.removedKeys?.(
                replaced?.contentRevision === undefined || run.newContentStore === true
                    ? null
                    : replaced.contentRevision
            )) ?? { notLive: [], inLive: [] }
            warnings.push(...(removed.warnings ?? []))
            keys = [...removed.notLive, ...removed.inLive]
            how = 'the files of every takedown and forced removal were deleted'
        } catch (history) {
            const live = await keysOfLive()
            if (live === undefined) {
                warnings.push(
                    `a file can still be public: the keys of the new release cannot be read (${cause}), and neither the history of the copy (${messageOf(history)}) nor the files of the live release can be read, so no file of a takedown was deleted`
                )
                return
            }
            const inLive = new Set(live)
            let names: string[]
            try {
                names = await storage.list()
            } catch (listing) {
                warnings.push(
                    `a file can still be public: the keys of the new release cannot be read (${cause}), nor the history of the copy (${messageOf(history)}), and the attachment storage could not be listed (${messageOf(listing)}), so no file of a takedown was deleted`
                )
                return
            }
            keys = names.filter((name) => ATTACHMENT_KEY.test(name) && !inLive.has(name))
            how = `the history of the copy cannot be read either (${messageOf(history)}), so every file that the live release does not use was deleted`
        }
        const failed = await remove(
            storage,
            [...new Set(keys)].filter((key) => !withdrawn.has(key)).sort()
        )
        if (failed.length > 0) {
            failures.push(
                `the attachment storage kept files that must leave it: ${failed.join('; ')}`
            )
        }
        warnings.push(
            `a file can still be public: the keys of the new release cannot be read (${cause}); ${how}, and the run stops`
        )
    }

    /** The keys of the live release, read one time: `undefined` when they cannot be known. */
    let liveKeys: Promise<readonly string[] | undefined> | undefined
    function keysOfLive(): Promise<readonly string[] | undefined> {
        const revision = replaced?.contentRevision
        liveKeys ??=
            revision === undefined || revision === null
                ? Promise.resolve(undefined)
                : Promise.resolve(run.releaseKeys?.(revision)).catch((error: unknown) => {
                      run.log(`the keys of ${revision} cannot be read: ${messageOf(error)}`)
                      return undefined
                  })
        return liveKeys
    }

    /**
     * True when the withdrawn files may leave before the check of the live
     * release (review round 2): the host has no release or no record that
     * can be read, or the copy knows the live revision. When the copy does
     * not know it, a newer release of another machine can be live, and the
     * run is refused with no deletion. A move deletes them after its check.
     */
    async function withdrawnGoFirst(unread: boolean): Promise<boolean> {
        if (withdrawn.size === 0 || unread || replaced === undefined || replaced === null) {
            return true
        }
        if (run.newContentStore === true) {
            return false
        }
        const revision = replaced.contentRevision
        if (revision === null) {
            return true
        }
        try {
            return (await run.descendsFrom?.(revision)) !== undefined
        } catch {
            return false
        }
    }

    /** How many names of the storage are not keys. Such a name can be a path of the vault. */
    function othersOf(names: readonly string[]): number {
        return names.filter((name) => !ATTACHMENT_KEY.test(name)).length
    }

    /**
     * Deletes the forced files that the storage has, right after its list:
     * they leave at once, also when a later step fails. A failure goes on
     * with the release and fails the run at its end: the file can still be
     * public. It gives the names that stay.
     */
    async function removeForced(
        storage: AttachmentStorage,
        names: readonly string[]
    ): Promise<string[]> {
        // The withdrawn files left before the check of the live release. A
        // history that cannot be read forces every file that the new release
        // does not use.
        const keys = names.filter(
            (name) =>
                !withdrawn.has(name) &&
                (forced.has(name) ||
                    (unknownHistory !== undefined && ATTACHMENT_KEY.test(name) && !used.has(name)))
        )
        // The files of a removal that the live release holds go when the
        // live release does not use them either: a takedown whose cleanup
        // failed before, also when this run fails.
        const named = new Set(names)
        const waiting = earlier.filter((key) => named.has(key))
        if (waiting.length > 0) {
            const live = await keysOfLive()
            if (live === undefined) {
                warnings.push(
                    'a file can still be public: the copy cannot read the files of the live release, so the files of earlier takedowns and forced removals stay until a deployment that can'
                )
            } else {
                const inLive = new Set(live)
                keys.push(...waiting.filter((key) => !inLive.has(key)))
            }
        }
        keys.sort()
        const failed = await remove(storage, keys)
        if (failed.length > 0) {
            warnings.push(
                'a file can still be public: the attachment storage kept files of a takedown, of a forced removal or under a guard'
            )
            failures.push(
                `the attachment storage kept files that must leave it: ${failed.join('; ')}`
            )
        }
        // As the takedown of the tool: such a name can be a file of the takedown.
        const others = othersOf(names)
        if (takedown && others > 0) {
            warnings.push(
                `a file can still be public: the attachment storage has ${String(others)} file(s) that are not keys, left as they are`
            )
            failures.push(
                `after a takedown, the attachment storage has ${String(others)} file(s) that are not keys`
            )
        }
        const gone = new Set(keys)
        return names.filter((name) => !gone.has(name))
    }

    /**
     * Deletes the withdrawn files before the check of the live release (a
     * refused run still deletes them; review rounds 1 to 3 of issue 120). A
     * failure goes on as in `removeForced()`.
     */
    async function removeWithdrawn(storage: AttachmentStorage): Promise<void> {
        const failed = await remove(storage, [...withdrawn].sort())
        if (failed.length > 0) {
            warnings.push(
                'a file can still be public: the attachment storage kept files under a guard'
            )
            failures.push(
                `the attachment storage kept files that must leave it: ${failed.join('; ')}`
            )
        }
    }

    /**
     * True when a takedown or a forced removal lies between the live release
     * and this one, or when the copy cannot say: it gives its warning.
     */
    async function removalsSinceLive(live: DeploymentRecord | null | undefined): Promise<boolean> {
        const from = live?.contentRevision
        if (
            from === undefined ||
            from === null ||
            run.contentRevision === null ||
            run.newContentStore === true ||
            run.removalsBetween === undefined
        ) {
            return false
        }
        let between: string[] | undefined
        try {
            between = await run.removalsBetween(from, run.contentRevision)
        } catch (error) {
            run.log(`the removals since ${from} cannot be read: ${messageOf(error)}`)
            between = undefined
        }
        if (between === undefined) {
            warnings.push(
                `the copy cannot say whether a takedown or a forced removal lies between the live release (${from}) and this one, so the deployment counts as a takedown`
            )
            return true
        }
        if (between.length === 0) {
            return false
        }
        warnings.push(
            `a takedown or a forced removal lies between the live release and this one (${between.join('; ')}), so the deployment counts as a takedown: its pages can still be live until a deployment is seen live`
        )
        return true
    }

    /**
     * The keys that the cleanup after a release that is live keeps: the
     * keys of the new release and of the release before it, without the
     * forced keys. `undefined` when the files of the release before cannot
     * be known: then only the forced files leave.
     */
    async function keptKeys(): Promise<Set<string> | undefined> {
        // A first deployment has no release before, and a revert across a
        // move to another content store is refused. With a history that
        // cannot be read, only the new release stays.
        if (
            replaced === null ||
            replaced === undefined ||
            run.newContentStore === true ||
            unknownHistory !== undefined
        ) {
            return new Set(used)
        }
        const revision = replaced.contentRevision
        const keys = await keysOfLive()
        if (keys === undefined) {
            warnings.push(
                revision === null
                    ? 'the release before was built from an output (--dist), so its files are not known: only the files of takedowns, of forced removals and under a guard were deleted from the attachment storage'
                    : `the copy cannot read the files of the release before (${revision}): only the files of takedowns, of forced removals and under a guard were deleted from the attachment storage`
            )
            return undefined
        }
        return new Set([...used, ...keys.filter((key) => !forced.has(key))])
    }

    /** Deletes each key of the storage that neither the new release nor the release before uses. */
    async function cleanUp(storage: AttachmentStorage, names: readonly string[]): Promise<void> {
        const kept = await keptKeys()
        if (kept === undefined) {
            return
        }
        const others = othersOf(names)
        // Only their count goes into the result, which the tools show and an
        // agent reads. After a takedown, the forced step warned already.
        if (others > 0 && !takedown) {
            warnings.push(
                `the attachment storage has ${String(others)} file(s) that are not keys, left as they are`
            )
        }
        const unused = names.filter((name) => ATTACHMENT_KEY.test(name) && !kept.has(name)).sort()
        const failed = await remove(storage, unused)
        if (failed.length > 0) {
            throw new Error(
                `the attachment storage kept files that no release uses: ${failed.join('; ')}`
            )
        }
        run.log(`deleted ${String(deleted)} files that no release uses from the attachment storage`)
    }

    let error: string | null = null
    // The release that this one replaces: `undefined` in a dry run, or
    // before it was read.
    let replaced: DeploymentRecord | null | undefined
    try {
        // The live release first: the withdrawn files leave before its
        // check (a refused run still deletes them), unless the copy does
        // not know the live revision (review round 2).
        let unread: Error | undefined
        try {
            replaced = run.live === undefined ? undefined : await liveRecordOf(run.live)
        } catch (failure) {
            unread = failure instanceof Error ? failure : new Error(messageOf(failure))
        }
        const storage = run.storage
        if (run.copyRefusal !== undefined) {
            // Review round 3: the copy cannot be built. The withdrawn files
            // leave when the copy is the main of the content store, or knows
            // the live revision; then the run is refused.
            // Last look, L2: the copy must hold the live revision; a newer
            // release whose commit the fetch brought is no such revision.
            const known =
                replaced?.contentRevision === undefined || replaced.contentRevision === null
                    ? false
                    : (await run
                          .descendsFrom?.(replaced.contentRevision)
                          .catch(() => undefined)) === true
            if (storage !== undefined && (run.copyAtMain === true || known)) {
                await removeWithdrawn(storage)
            }
            stoppedAt = 'the copy of the content store cannot be built'
            throw new Refusal(run.copyRefusal)
        }
        const first = storage !== undefined && (await withdrawnGoFirst(unread !== undefined))
        if (first) {
            await removeWithdrawn(storage)
        }
        if (unread !== undefined) {
            throw unread
        }
        if (replaced !== undefined) {
            await checkOver(run, replaced)
        }
        if (!first && storage !== undefined) {
            await removeWithdrawn(storage)
        }
        // A read of the keys of the release that fails stops the run here:
        // the withdrawn files are gone already. A history that cannot be
        // read fails closed and goes on.
        try {
            await readKeys()
        } catch (failure) {
            stoppedAt = `the keys of the release cannot be read (${messageOf(failure)})`
            throw failure
        }
        if (!takedown && (await removalsSinceLive(replaced))) {
            takedown = true
        }
        if (run.storage !== undefined) {
            let names: string[]
            try {
                names = await run.storage.list()
            } catch (failure) {
                stoppedAt = 'the attachment storage could not be listed'
                throw failure
            }
            stored = await removeForced(run.storage, names)
            await upload(run, [...used], run.storage, new Set(stored), () => {
                uploaded += 1
            })
        }

        let dist: string
        let record: DeploymentRecord
        try {
            dist = await run.build()
            warnings.push(...((await run.buildWarnings?.()) ?? []))
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
                    : { previous: replaced === null ? null : buildOf(replaced) }),
                ...(replaced !== undefined && run.newContentStore === true
                    ? { newContentStore: true as const }
                    : {})
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
        // The live sitemaps, right before the deployment: what IndexNow
        // knows. At the switch, and when they cannot be read, none: every
        // URL of the sitemaps goes (R85, review of issue 54).
        let before = new Map<string, string>()
        if (
            run.search?.submit !== undefined &&
            run.dryRun !== true &&
            run.live !== undefined &&
            run.atSwitch !== true
        ) {
            try {
                before = await sitemapsOf((path) => run.search?.read(path) ?? Promise.resolve(null))
            } catch (failure) {
                warnings.push(
                    `the live sitemaps cannot be read (${messageOf(failure)}), so every URL of the sitemaps went to IndexNow`
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

        if (run.storage !== undefined && stored !== undefined && !live) {
            // The release before can still be live, with files that the new
            // one does not use: only the forced files left (F4).
            warnings.push(
                'the release was not seen live, so no file that a release uses was deleted from the attachment storage'
            )
        } else if (run.storage !== undefined && stored !== undefined) {
            try {
                await cleanUp(run.storage, stored)
            } catch (failure) {
                // A file that stays costs nothing, but the files of a takedown must go.
                if (takedown) {
                    throw failure
                }
                warnings.push(messageOf(failure))
            }
        }
        // The pages of a takedown must go: a release that was not seen live
        // is no success, and the tools keep the takedown waiting.
        if (takedown && run.live !== undefined && !live) {
            throw new Error(
                run.takedown
                    ? 'the release of the takedown was not seen live, so the takedown waits for a deploy that is seen live'
                    : 'the release was not seen live, and it holds a takedown or a forced removal that the live release does not have: deploy again until a release is seen live'
            )
        }
        // The search engines come last: a slow one never holds back the
        // cleanup of a takedown (review of issue 54).
        if (live && run.search !== undefined) {
            await tellSearchEngines(run, run.search, dist, before, warnings)
        }
    } catch (failure) {
        error = messageOf(failure)
        // A failure deletes no other file than the forced ones (F4), which
        // left right after the list of the storage.
        if (takedown && stored === undefined && failure instanceof Refusal) {
            warnings.push(
                'a file can still be public: the deployment was refused, so no file of the takedown was deleted'
            )
        } else if (takedown && stored === undefined && run.storage !== undefined) {
            // Review round 3, T7: the warning names the step that stopped the run.
            warnings.push(
                `a file can still be public: ${stoppedAt ?? `the deployment stopped (${messageOf(failure)})`}, so no file of the takedown was deleted`
            )
        }
    }
    if (failures.length > 0) {
        error = [...(error === null ? [] : [error]), ...failures].join('; ')
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
    usedKeys: readonly string[],
    storage: AttachmentStorage,
    stored: ReadonlySet<string>,
    uploaded: () => void
): Promise<void> {
    const wanted = [...new Set(usedKeys)].filter((key) => !stored.has(key)).sort()
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
    // A file above the size limit is never read and never uploaded (issue 72).
    const tooLarge: string[] = []
    for (const key of wanted) {
        const size = await run.attachments.size(key)
        if (size > MAX_ATTACHMENT_SIZE) {
            tooLarge.push(`${key} (${String(size)} bytes)`)
        }
    }
    if (tooLarge.length > 0) {
        throw new Error(
            `the attachments of these keys are above the size limit of ${String(MAX_ATTACHMENT_SIZE)} bytes, and none is uploaded: ${tooLarge.join(', ')}`
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
     * The subjects of the commits after `from` up to `to` in the copy of the
     * content store that deleted a manifest entry (a takedown, a forced
     * removal, any other commit; issue 120), read from their content, or
     * `undefined` when the copy does not know them.
     */
    readonly removalsBetween: (from: string, to: string) => Promise<string[] | undefined>
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
 * takedown or a forced removal took away in between is refused (a commit
 * that deleted a manifest entry, whatever its subject says, issue 120), and
 * so is a live release that names no release before it,
 * and a live release that moved the host to another content store.
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
    if (before.newContentStore === true) {
        throw new Error(
            'the live release moved the host to another content store, so the release before has other content: deploy a new release instead'
        )
    }
    if (before.contentRevision !== null && target.contentRevision !== null) {
        const removals = await run.removalsBetween(target.contentRevision, before.contentRevision)
        if (removals === undefined) {
            throw new Error(
                `the copy of the content store does not know ${target.contentRevision} and ${before.contentRevision}: fetch the copy`
            )
        }
        if (removals.length > 0) {
            throw new Error(
                `a takedown or a forced removal lies between the release before and the live one (${removals.join('; ')}): deploy a new release instead`
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

/** The time limit of each call to the host or to IndexNow, in milliseconds (review of issue 54). */
export const SEARCH_TIME_LIMIT = 10_000

/**
 * The URLs that IndexNow did not take, in a JSON file of this machine (a
 * list of texts). A file that does not exist holds none; a file that is not
 * such a list fails, so it is never lost by a write over it.
 */
export function pendingUrls(file: string): NonNullable<SearchHost['pending']> {
    return {
        read: async () => {
            let text: string
            try {
                text = await readFile(file, 'utf8')
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                    return []
                }
                throw error
            }
            const value: unknown = JSON.parse(text)
            if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
                throw new Error(`${file} is not a list of URLs`)
            }
            return value
        },
        write: async (urls) => {
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, `${JSON.stringify(urls, null, 4)}\n`)
        }
    }
}

/**
 * The search engines of a deployment target (issue 54), with `fetch` as a
 * port: the live files are read from the host of the target, and IndexNow
 * gets batches only for the canonical host of the site, when the target is
 * not marked noindex (IDX-26): never from a preview host.
 */
export function searchHostOf(
    target: { readonly host: string; readonly noindex: boolean },
    fetch: (url: URL, init: RequestInit) => Promise<Response> = (address, init) =>
        globalThis.fetch(address, init),
    pendingFile?: string
): SearchHost {
    const url = `https://${target.host}/`
    const read = async (path: string): Promise<string | null> => {
        const response = await fetch(new URL(path, url), {
            cache: 'no-store',
            signal: AbortSignal.timeout(SEARCH_TIME_LIMIT)
        })
        if (response.status === 404) {
            await response.body?.cancel()
            return null
        }
        if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`the host answers ${String(response.status)} for ${path}`)
        }
        return await response.text()
    }
    if (target.noindex || target.host !== new URL(SITE_ORIGIN).host) {
        return { read }
    }
    return {
        read,
        ...(pendingFile === undefined ? {} : { pending: pendingUrls(pendingFile) }),
        submit: async (batch) => {
            const response = await fetch(new URL(INDEXNOW_ENDPOINT), {
                method: 'POST',
                signal: AbortSignal.timeout(SEARCH_TIME_LIMIT),
                headers: { 'content-type': 'application/json; charset=utf-8' },
                body: JSON.stringify(batch)
            })
            await response.body?.cancel()
            if (response.status !== 200 && response.status !== 202) {
                throw new Error(`IndexNow answers ${String(response.status)}`)
            }
        }
    }
}
