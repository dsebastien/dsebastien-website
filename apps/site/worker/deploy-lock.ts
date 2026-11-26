import { createHash } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MAX_TIMEOUT_MINUTES } from '../../plugin/src/publishing/deploy.ts'

// One deployment at a time per target on a machine (issue 32). The plugin
// and the command line program can both start a deployment in the clone of
// the deploys, and two runs would upload, build and clean at the same time.
// The lock is a file of that clone, `.cache/deploy/<worker>/lock`: both faces
// of a machine must use the same clone of the site code. It holds the
// process and the start of the run. It is written whole into a temporary
// file first, then linked to its name, which fails when the lock exists, so
// a lock is never half written. A lock whose process is dead, or that is
// older than the most time limit of a deployment with a margin (a process
// number used again after a reboot), is taken over with a warning: the runs
// that read one stale lock race for one claim of its takeover, so only one
// run takes it away, and no run moves a lock that another run holds.

/** The age after which a lock is the lock of a run that stopped: the most time limit of the tools, and one hour. */
export const STALE_AFTER_MS = (MAX_TIMEOUT_MINUTES + 60) * 60_000

/** What the lock file holds. */
interface LockHolder {
    readonly pid: number
    readonly startedAt: string
}

/** What taking the lock needs from the machine. */
export interface LockOptions {
    /** The process of this run. */
    readonly pid: number
    readonly now: () => Date
    /** True when the process still runs. */
    readonly isAlive: (pid: number) => boolean
    /** A pause before each step on the files: a test gives random pauses to try many orders of runs at once. */
    readonly pause?: () => Promise<void>
}

/** A lock that this run holds. */
export interface DeployLock {
    /** Why the run took over a lock, when it did. */
    readonly warning?: string
    /** Lets go of the lock, when this run still holds it. */
    release(): Promise<void>
}

function holderFrom(text: string): LockHolder | undefined {
    try {
        const value: unknown = JSON.parse(text)
        if (
            typeof value === 'object' &&
            value !== null &&
            'pid' in value &&
            'startedAt' in value &&
            typeof value.pid === 'number' &&
            Number.isSafeInteger(value.pid) &&
            typeof value.startedAt === 'string'
        ) {
            return { pid: value.pid, startedAt: value.startedAt }
        }
    } catch {
        // Not JSON: a run that stopped while it wrote the file.
    }
    return undefined
}

async function holderOf(file: string): Promise<LockHolder | 'unreadable' | undefined> {
    let text: string
    try {
        text = await readFile(file, 'utf8')
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return undefined
        }
        throw error
    }
    return holderFrom(text) ?? 'unreadable'
}

function codeOf(error: unknown): unknown {
    return error instanceof Error && 'code' in error ? error.code : undefined
}

/** The number of temporary files of this process: each one has a name of its own. */
let temporaries = 0

function temporaryOf(file: string, pid: number, kind: string): string {
    temporaries += 1
    return join(dirname(file), `.${kind}-${String(pid)}-${String(temporaries)}`)
}

/** Makes the lock file whole, or gives `false` when it exists. */
async function create(file: string, holder: LockHolder, options: LockOptions): Promise<boolean> {
    const temporary = temporaryOf(file, holder.pid, 'lock')
    await options.pause?.()
    await writeFile(temporary, `${JSON.stringify(holder)}\n`)
    try {
        await options.pause?.()
        await link(temporary, file)
        return true
    } catch (error) {
        if (codeOf(error) === 'EEXIST') {
            return false
        }
        throw error
    } finally {
        await rm(temporary, { force: true })
    }
}

/** True when the lock is the lock of a run that stopped: its process is dead, or it is too old. */
function isStale(holder: LockHolder, options: LockOptions): boolean {
    const started = Date.parse(holder.startedAt)
    return (
        !options.isAlive(holder.pid) ||
        (Number.isFinite(started) && options.now().getTime() - started > STALE_AFTER_MS)
    )
}

/** The age after which the claim of a takeover is the claim of a run that stopped: a takeover takes a few milliseconds. */
const CLAIM_STALE_AFTER_MS = 60_000

/** True when the claim of a takeover is the claim of a run that stopped during its takeover. */
function isStaleClaim(claimer: LockHolder | 'unreadable', options: LockOptions): boolean {
    if (claimer === 'unreadable') {
        return true
    }
    const started = Date.parse(claimer.startedAt)
    return (
        !options.isAlive(claimer.pid) ||
        (Number.isFinite(started) && options.now().getTime() - started > CLAIM_STALE_AFTER_MS)
    )
}

/** The claim of the takeover of the stale lock with this text: one name for each stale lock. */
function claimOf(file: string, text: string): string {
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 16)
    return join(dirname(file), `.takeover-${digest}`)
}

function tookItAtTheSameTime(): Error {
    return new Error('another deployment of this target took the lock at the same time')
}

/**
 * Takes over the stale lock with this text (issue 126). The runs that read
 * it race for one claim, made whole like a lock: only one run makes it, so
 * only one run takes the stale lock away, and no run ever moves a lock that
 * another run holds. The run with the claim gives way when the lock is no
 * longer the stale one, else it takes the stale lock away and makes its own;
 * a run that makes its lock in that moment wins, and this run gives way. The
 * claim of a run that stopped during its takeover goes, and the run that saw
 * it gives way.
 */
async function takeOver(
    file: string,
    text: string,
    holder: LockHolder,
    options: LockOptions
): Promise<void> {
    const claim = claimOf(file, text)
    if (!(await create(claim, holder, options))) {
        await options.pause?.()
        const claimer = await holderOf(claim)
        if (claimer !== undefined && isStaleClaim(claimer, options)) {
            await rm(claim, { force: true })
        }
        throw tookItAtTheSameTime()
    }
    try {
        await options.pause?.()
        const now = await readFile(file, 'utf8').catch(() => undefined)
        if (now !== text) {
            throw tookItAtTheSameTime()
        }
        // Renamed, not removed: on Windows the name of a removed file that
        // a run still reads stays taken until it closes the file.
        const away = temporaryOf(file, holder.pid, 'stale')
        await options.pause?.()
        try {
            await rename(file, away)
        } catch (error) {
            if (codeOf(error) === 'ENOENT') {
                throw tookItAtTheSameTime()
            }
            throw error
        }
        await rm(away, { force: true })
        if (!(await create(file, holder, options))) {
            throw tookItAtTheSameTime()
        }
    } finally {
        await options.pause?.()
        await rm(claim, { force: true })
    }
}

/**
 * Takes the lock of the deployments of a target. It throws when another run
 * that still runs holds it.
 */
export async function takeDeployLock(file: string, options: LockOptions): Promise<DeployLock> {
    await mkdir(dirname(file), { recursive: true })
    const holder: LockHolder = {
        pid: options.pid,
        startedAt: `${options.now().toISOString().slice(0, 19)}Z`
    }
    const lock = (warning?: string): DeployLock => ({
        ...(warning === undefined ? {} : { warning }),
        async release() {
            const now = await holderOf(file)
            if (now !== undefined && now !== 'unreadable' && now.pid === holder.pid) {
                await rm(file, { force: true })
            }
        }
    })
    if (await create(file, holder, options)) {
        return lock()
    }
    await options.pause?.()
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) {
        // The lock went meanwhile: this run makes its lock like a first run.
        if (!(await create(file, holder, options))) {
            throw tookItAtTheSameTime()
        }
        return lock()
    }
    const other = holderFrom(text) ?? 'unreadable'
    if (other !== 'unreadable' && !isStale(other, options)) {
        throw new Error(
            `another deployment of this target runs on this machine (process ${String(other.pid)}, since ${other.startedAt}): wait for it to end`
        )
    }
    await takeOver(file, text, holder, options)
    return lock(
        other === 'unreadable'
            ? `took over a lock of the deployments that cannot be read: ${file}`
            : `took over the lock of a deployment that stopped (process ${String(other.pid)}, since ${other.startedAt})`
    )
}

/** True when this process holds the lock of the deployments of a target. */
export async function lockHeldBy(file: string, pid: number): Promise<boolean> {
    const holder = await holderOf(file)
    return holder !== undefined && holder !== 'unreadable' && holder.pid === pid
}

/** True when a process runs, by its number. A process of another user runs too. */
export function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM'
    }
}

/** The variable that gives the restart of `--from-main` the warning of a lock that its parent took over. */
const INHERITED_WARNING = 'NOTES_DEPLOY_LOCK_TAKEN_OVER'

/** The variables of the restart of `--from-main` for the warning of the lock of its parent. */
export function lockWarningFor(warning: string | undefined): Record<string, string> {
    return warning === undefined ? {} : { [INHERITED_WARNING]: warning }
}

/** The warning of a lock that the parent took over, in a restart of `--from-main`. */
export function inheritedLockWarning(
    environment: Record<string, string | undefined>
): string | undefined {
    const warning = environment[INHERITED_WARNING]
    return warning === undefined || warning === '' ? undefined : warning
}
