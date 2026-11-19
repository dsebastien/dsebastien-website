import { gitEnvironment } from './test-stores.ts'

// A run of the TypeScript logic that stops halfway, as after a power cut
// (issue 36). The Rust program has a switch of its debug build for it
// (`DSEBASTIEN_VAULT_PUBLISH_TEST_CRASH`). The TypeScript logic has none: the
// test gives it a copy of the content store whose commit and push never
// return, so the run halts there with its lock and its journal.

/** Where the run halts: after its writes into the copy, after its commit, or after its push. */
export type CrashPoint = 'write' | 'commit' | 'push'

/** The part of the copy of the content store that the crash changes. */
interface Committing {
    commitAndPush(message: string, paths: readonly string[]): Promise<void>
}

async function git(cwd: string, ...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', '-c', 'core.autocrlf=false', ...args], {
        cwd,
        env: gitEnvironment(),
        stdout: 'ignore',
        stderr: 'pipe'
    })
    const errors = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${errors.trim()}`)
    }
}

/**
 * The copy of the content store of a run that halts at a point. At `commit`,
 * the files of the run are committed first, as `commitAndPush` commits them;
 * at `push`, they are committed and pushed first. `reached` settles when the
 * run is at the point.
 *
 * @param store the copy of the content store of the device
 * @param copy the folder of that copy
 */
export function crashingStore<Store extends Committing>(
    store: Store,
    copy: string,
    at: CrashPoint
): { store: Store; reached: Promise<void> } {
    const { promise, resolve } = Promise.withResolvers<undefined>()
    return {
        store: {
            ...store,
            async commitAndPush(message: string, paths: readonly string[]): Promise<void> {
                if (at === 'commit') {
                    await git(copy, 'add', '--force', '--', ...paths)
                    await git(
                        copy,
                        'commit',
                        '--quiet',
                        '--message',
                        message,
                        '--only',
                        '--',
                        ...paths
                    )
                } else if (at === 'push') {
                    await store.commitAndPush(message, paths)
                }
                resolve(undefined)
                return await new Promise<never>(() => undefined)
            }
        },
        reached: promise.then(() => undefined)
    }
}
