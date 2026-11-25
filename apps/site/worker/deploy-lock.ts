import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

// One deployment at a time per target on a machine (issue 32). The plugin
// and the command line program can both start a deployment in the clone of
// the deploys, and two runs would upload, build and clean at the same time.
// The lock is a file of that clone, `.cache/deploy/<worker>/lock`, made with
// an exclusive create. It holds the process and the start of the run; a
// lock whose process is dead is taken over with a warning.

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

/** Makes the lock file, or `false` when it exists. */
async function create(file: string, holder: LockHolder): Promise<boolean> {
    try {
        const handle = await open(file, 'wx')
        try {
            await handle.writeFile(`${JSON.stringify(holder)}\n`)
        } finally {
            await handle.close()
        }
        return true
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            return false
        }
        throw error
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
    if (await create(file, holder)) {
        return lock()
    }
    const other = await holderOf(file)
    if (other !== undefined && other !== 'unreadable' && options.isAlive(other.pid)) {
        throw new Error(
            `another deployment of this target runs on this machine (process ${String(other.pid)}, since ${other.startedAt}): wait for it to end`
        )
    }
    const warning =
        other === 'unreadable'
            ? `took over a lock of the deployments that cannot be read: ${file}`
            : other === undefined
              ? undefined
              : `took over the lock of a deployment that stopped (process ${String(other.pid)}, since ${other.startedAt})`
    await rm(file, { force: true })
    if (!(await create(file, holder))) {
        throw new Error('another deployment of this target took the lock at the same time')
    }
    return lock(warning)
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
