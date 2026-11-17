import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURE_CONFIGURATION, FIXTURE_VAULT, listFixtureVaultFiles } from './fixture-vault.ts'
import { copyFixtureVault, makeContentStoreCopy } from './publication-setup.ts'
import { gitEnvironment, makeTestStores } from './test-stores.ts'

// A test of a publication changes notes and pushes commits. It works on a copy
// of the fixture vault and on a copy of the content store, both inside the
// folder of the test.

async function git(...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { env: gitEnvironment(), stdout: 'pipe' })
    const stdout = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return stdout.trim()
}

describe('copy of the fixture vault', () => {
    test('holds the same files with the same bytes', async () => {
        await using stores = await makeTestStores()

        const vault = await copyFixtureVault(stores)

        const files = await listFixtureVaultFiles()
        const copied = await readdir(vault, { recursive: true, withFileTypes: true })
        expect(copied.filter((entry) => entry.isFile()).length).toBe(files.length)
        for (const file of files) {
            const copy = await Bun.file(join(vault, file)).bytes()
            expect(copy, file).toEqual(await Bun.file(join(FIXTURE_VAULT, file)).bytes())
        }
    })

    test('is inside the folder of the test', async () => {
        await using stores = await makeTestStores()

        expect((await copyFixtureVault(stores)).startsWith(stores.root)).toBe(true)
    })
})

describe('copy of the content store of a test', () => {
    test('holds the configuration of the fixture vault, pushed as the first commit', async () => {
        await using stores = await makeTestStores()

        const copy = await makeContentStoreCopy(stores)

        const expected = await Bun.file(FIXTURE_CONFIGURATION).text()
        expect(await Bun.file(join(copy, 'configuration.json')).text()).toBe(expected)
        expect(await git('--git-dir', stores.contentStore, 'show', 'main:configuration.json')).toBe(
            expected.trim()
        )
        expect(await git('--git-dir', stores.contentStore, 'rev-list', '--count', 'main')).toBe('1')
    })

    test('can commit: it has an invented author', async () => {
        await using stores = await makeTestStores()

        const copy = await makeContentStoreCopy(stores)

        expect(await git('-C', copy, 'config', 'user.email')).toBe('test@example.invalid')
        expect(await git('-C', copy, 'status', '--porcelain')).toBe('')
    })
})
