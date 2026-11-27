import { chmod, cp, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    parseTreeListing,
    SEALED_PATHS,
    sealOf,
    withSeal
} from '../../../apps/plugin/src/publishing/seal.ts'
import { FIXTURE_CONFIGURATION, FIXTURE_VAULT } from './fixture-vault.ts'
import { gitEnvironment, type TestStores } from './test-stores.ts'

// What a test of a publication needs next to the stores: a vault that it can
// change, and the copy of the content store on which the tool works.

async function git(cwd: string, ...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', ...args], {
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

/** Runs git and gives its output. The input goes to its standard input. */
async function gitOutput(cwd: string, args: readonly string[], input = ''): Promise<string> {
    const child = Bun.spawn(['git', ...args], {
        cwd,
        env: gitEnvironment(),
        stdin: new TextEncoder().encode(input),
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [output, errors] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
    ])
    if ((await child.exited) !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${errors.trim()}`)
    }
    return output
}

/**
 * The seal key of the tests (R104): 32 bytes of 0x5e, built at run time. The
 * preload of the tests gives it to every device in the environment, and the
 * Rust tests use the same one, so that the parity runs agree.
 */
export function testSealKey(): string {
    return '5e'.repeat(32)
}

/** The first parent of a commit of a repository, or `undefined` for a first commit. */
async function parentOf(repository: string, commit: string): Promise<string | undefined> {
    return (await gitOutput(repository, ['rev-list', '--parents', '--max-count=1', commit]))
        .trim()
        .split(' ')[1]
}

/**
 * The valid seal of a commit of a repository (a copy, or the content store
 * itself) with the key of the tests (R104): a test compares it with the
 * last line of the message of the commit.
 */
export async function sealOfCommit(
    repository: string,
    commit = 'HEAD',
    key = testSealKey()
): Promise<string> {
    const files = parseTreeListing(
        await gitOutput(repository, [
            'ls-tree',
            '-r',
            '-z',
            '--full-tree',
            commit,
            '--',
            ...SEALED_PATHS
        ])
    )
    return sealOf(
        Uint8Array.from(Buffer.from(key, 'hex')),
        await parentOf(repository, commit),
        files
    )
}

/**
 * Makes the last commit of the copy again with a valid seal, as a commit of
 * the tool has (R104): for a commit that a test makes by hand in the place
 * of the tool of another device. The commit must not be pushed yet.
 */
export async function sealHead(copy: string, key = testSealKey()): Promise<void> {
    const head = (await gitOutput(copy, ['rev-parse', 'HEAD'])).trim()
    const parent = await parentOf(copy, 'HEAD')
    const message = await gitOutput(copy, ['log', '-1', '--format=%B', 'HEAD'])
    const seal = await sealOfCommit(copy, 'HEAD', key)
    const tree = (await gitOutput(copy, ['rev-parse', 'HEAD^{tree}'])).trim()
    const sealed = (
        await gitOutput(
            copy,
            ['commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-F', '-'],
            withSeal(message, seal)
        )
    ).trim()
    await gitOutput(copy, ['update-ref', 'HEAD', sealed, head])
}

/**
 * Copies the fixture vault into the folder of the test and returns the path
 * of the copy. A test never writes into the fixture vault itself.
 */
export async function copyFixtureVault(stores: TestStores, name = 'vault'): Promise<string> {
    const vault = join(stores.root, name)
    await cp(FIXTURE_VAULT, vault, { recursive: true, errorOnExist: true, force: false })
    return vault
}

/**
 * Makes the copy of the content store on which the publishing tool works: a
 * clone of the content store of the test, with an invented author. Its first
 * commit holds the configuration of the fixture vault and is pushed, because
 * the configuration of the tool lives in the content store (GATE-04). It is
 * sealed with the key of the tests (R104).
 */
export async function makeContentStoreCopy(stores: TestStores, name = 'copy'): Promise<string> {
    const copy = join(stores.root, name)
    await git(stores.root, 'clone', '--quiet', stores.contentStore, copy)
    await git(copy, 'config', 'user.name', 'Test')
    await git(copy, 'config', 'user.email', 'test@example.invalid')
    await git(copy, 'config', 'commit.gpgsign', 'false')
    await git(copy, 'checkout', '--quiet', '-B', 'main')
    await Bun.write(join(copy, 'configuration.json'), Bun.file(FIXTURE_CONFIGURATION))
    await git(copy, 'add', 'configuration.json')
    await git(copy, 'commit', '--quiet', '--message', 'Add the configuration of the fixture vault')
    // Sealed, as after the first confirmation of the author (R104).
    await sealHead(copy)
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
    return copy
}

/**
 * Makes the content store refuse every push, as when another device pushes
 * between the fetch of a publication and its push. A test of a refused push
 * cannot let another device push first: the fetch of the publication would
 * see it, and stop the run before the push.
 */
export async function refusePushes(contentStore: string): Promise<void> {
    const hook = join(contentStore, 'hooks', 'pre-receive')
    await mkdir(dirname(hook), { recursive: true })
    await writeFile(hook, '#!/bin/sh\necho "another device pushed first" >&2\nexit 1\n')
    await chmod(hook, 0o755)
}
