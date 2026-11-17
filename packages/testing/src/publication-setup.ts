import { cp } from 'node:fs/promises'
import { join } from 'node:path'
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
 * the configuration of the tool lives in the content store (GATE-04).
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
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
    return copy
}
