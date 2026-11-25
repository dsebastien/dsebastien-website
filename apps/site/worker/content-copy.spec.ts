import { describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeContentStoreCopy, makeTestStores, rejectionOf } from '@dsebastien-website/testing'
import {
    checkContentCopy,
    contentStoreHas,
    descendsFrom,
    takedownsBetween
} from './content-copy.ts'

// The copy of the content store that a deployment builds (issue 32): the
// release must be the commit that the record names, and never older content
// than the live release. These tests use a real content store of the test
// helper and its copy.

async function git(folder: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', '-C', folder, ...args], {
        stdio: ['ignore', 'pipe', 'pipe']
    })
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (code !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
    }
    return text.trim()
}

/** Commits a change of a file of the copy with this message, and gives the commit. */
async function commit(copy: string, message: string, push = true): Promise<string> {
    await writeFile(join(copy, 'notes.txt'), `${message}\n`, { flag: 'a' })
    await git(copy, 'add', 'notes.txt')
    await git(copy, 'commit', '--quiet', '--message', message)
    if (push) {
        await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
    }
    return await git(copy, 'rev-parse', 'HEAD')
}

describe('the copy of the content store of a deployment', () => {
    test('gives its commit when it is clean and at the last main of the content store', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const head = await commit(copy, 'Publish: 1 note')
        expect(await checkContentCopy(copy)).toBe(head)
    })

    test.each([
        ['a change of a tracked file', 'configuration.json'],
        ['a new file', 'draft.md']
    ])('refuses a copy with %s', async (_kind, name) => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await writeFile(join(copy, name), 'changed\n')
        expect(await rejectionOf(checkContentCopy(copy))).toContain('changes')
    })

    test('refuses a copy that is behind the content store, after a fetch', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        // The check before the build fetches.
        await checkContentCopy(copy)
        // Another device publishes.
        const other = join(stores.root, 'other')
        await git(stores.root, 'clone', '--quiet', stores.contentStore, other)
        await git(other, 'config', 'user.name', 'Test')
        await git(other, 'config', 'user.email', 'test@example.invalid')
        await git(other, 'config', 'commit.gpgsign', 'false')
        await commit(other, 'Publish: from another device')
        const head = await git(copy, 'rev-parse', 'HEAD')
        // After the build, the copy must be what the build read: no fetch then.
        expect(await checkContentCopy(copy, false)).toBe(head)
        expect(await rejectionOf(checkContentCopy(copy))).toContain('origin/main')
    })

    test('refuses a copy with a commit that the content store does not have', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await commit(copy, 'Publish: not pushed', false)
        expect(await rejectionOf(checkContentCopy(copy))).toContain('origin/main')
    })
})

describe('the fetch of a deployment', () => {
    // The tool fetches and pushes with refs/remotes/origin/main: the
    // deployment writes nothing there.
    test('writes only a ref of its own, and compares the copy with it', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const tracked = await git(copy, 'rev-parse', 'refs/remotes/origin/main')
        const other = join(stores.root, 'other')
        await git(stores.root, 'clone', '--quiet', stores.contentStore, other)
        await git(other, 'config', 'user.name', 'Test')
        await git(other, 'config', 'user.email', 'test@example.invalid')
        await git(other, 'config', 'commit.gpgsign', 'false')
        const newer = await commit(other, 'Publish: from another device')

        const message = await rejectionOf(checkContentCopy(copy))

        expect(message).toContain(newer)
        expect(await git(copy, 'rev-parse', 'refs/remotes/origin/main')).toBe(tracked)
        expect(await git(copy, 'rev-parse', 'refs/deploy/origin-main')).toBe(newer)
    })
})

describe('the history of the copy', () => {
    test('says whether a revision is in the history of the copy', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const first = await commit(copy, 'Publish: 1 note')
        const second = await commit(copy, 'Publish: 2 notes')
        expect(await descendsFrom(copy, first)).toBe(true)
        expect(await descendsFrom(copy, second)).toBe(true)
        await git(copy, 'reset', '--quiet', '--hard', first)
        expect(await descendsFrom(copy, second)).toBe(false)
        expect(await descendsFrom(copy, 'f'.repeat(40))).toBeUndefined()
    })

    test('gives the takedowns between two revisions', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const from = await commit(copy, 'Publish: 1 note')
        await commit(copy, 'Takedown: 1 note')
        await commit(copy, 'Publish: a takedown is in the text')
        const to = await commit(copy, 'Takedown: 2 notes')
        expect(await takedownsBetween(copy, from, to)).toEqual([
            'Takedown: 2 notes',
            'Takedown: 1 note'
        ])
        expect(await takedownsBetween(copy, to, to)).toEqual([])
        expect(await takedownsBetween(copy, from, 'f'.repeat(40))).toBeUndefined()
    })
})

// Issue 127: a move to another content store needs proof that the live
// revision is not in the content store of the copy. A copy that is only
// behind does not know it either.
describe('the content store of the copy', () => {
    test('has a commit that another device pushed after the last fetch of the copy', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await checkContentCopy(copy)
        const other = join(stores.root, 'other')
        await git(stores.root, 'clone', '--quiet', stores.contentStore, other)
        await git(other, 'config', 'user.name', 'Test')
        await git(other, 'config', 'user.email', 'test@example.invalid')
        await git(other, 'config', 'commit.gpgsign', 'false')
        const pushed = await commit(other, 'Takedown: 1 note')
        expect(await descendsFrom(copy, pushed)).toBeUndefined()
        expect(await contentStoreHas(copy, pushed)).toBe(true)
    })

    test('has no commit of another content store', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        expect(await contentStoreHas(copy, 'f'.repeat(40))).toBe(false)
    })

    test('cannot say when the content store cannot be reached', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await git(copy, 'remote', 'set-url', 'origin', join(stores.root, 'missing'))
        expect(await rejectionOf(contentStoreHas(copy, 'f'.repeat(40)))).toContain('cannot say')
    })

    test('cannot say for a shallow copy', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await commit(copy, 'Publish: 1 note')
        await commit(copy, 'Publish: 2 notes')
        const shallow = join(stores.root, 'shallow')
        await git(
            stores.root,
            'clone',
            '--quiet',
            '--depth=1',
            pathToFileURL(stores.contentStore).href,
            shallow
        )
        expect(await rejectionOf(contentStoreHas(shallow, 'f'.repeat(40)))).toContain('shallow')
    })
})
