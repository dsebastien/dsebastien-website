import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeContentStoreCopy, makeTestStores, rejectionOf } from '@dsebastien-website/testing'
import {
    checkContentCopy,
    contentStoreHas,
    descendsFrom,
    releaseAttachmentKeys,
    removalsBetween,
    removedAttachmentKeys,
    withdrawnAttachmentKeys
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

// Issue 120: the files of the notes that a takedown or a forced removal took
// away, and the files of the release before, come from the history of the
// copy.
describe('the attachments in the history of the copy', () => {
    const key = (digit: string): string => digit.repeat(64)

    /** A manifest entry of a note with these keys. */
    function entry(
        id: string,
        path: string,
        keys: string[],
        state = 'published',
        formerPaths: string[] = []
    ): string {
        return `${JSON.stringify({
            aliases: [],
            attachments: keys.map((item, index) => ({
                hash: `sha256:${item}`,
                link: `image ${String(index)}.png`,
                path: `Assets/image ${String(index)}.png`,
                size: 1
            })),
            firstPublished: '2031-01-01T08:00:00Z',
            formerPaths,
            id,
            lastPublished: '2031-01-01T08:00:00Z',
            links: [],
            path,
            state
        })}\n`
    }

    /** Writes these files of the copy (a text) or removes them (`undefined`), and commits. */
    async function change(
        copy: string,
        message: string,
        files: Record<string, string | undefined>
    ): Promise<string> {
        await mkdir(join(copy, 'manifest'), { recursive: true })
        for (const [path, text] of Object.entries(files)) {
            if (text === undefined) {
                await git(copy, 'rm', '--quiet', '--', path)
            } else {
                await writeFile(join(copy, path), text)
                await git(copy, 'add', '--', path)
            }
        }
        await git(copy, 'commit', '--quiet', '--message', message)
        return await git(copy, 'rev-parse', 'HEAD')
    }

    /** Every removed key of the copy, with no live release. */
    async function allKeys(copy: string): Promise<readonly string[]> {
        const keys = await removedAttachmentKeys(copy, null)
        expect(keys.inLive).toEqual([])
        return keys.notLive
    }

    const A = 'a1a1a1a1a1a1a1a1'
    const B = 'b2b2b2b2b2b2b2b2'
    const C = 'c3c3c3c3c3c3c3c3'
    const D = 'd4d4d4d4d4d4d4d4'

    test('gives the keys of the entries that a takedown or a forced removal deleted, in the whole history', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 4 new, 0 updated, 0 removed, 0 forced, 0 skipped, 0 moved', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')]),
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2'), key('3')]),
            [`manifest/${C}.json`]: entry(C, 'C.md', [key('4')]),
            [`manifest/${D}.json`]: entry(D, 'D.md', [key('5')], 'unpublished')
        })
        await change(copy, 'Takedown: 1 note', { [`manifest/${B}.json`]: undefined })
        // A forced removal of a published note, and of an unpublished one.
        await change(copy, 'Publish: 0 new, 0 updated, 0 removed, 2 forced, 0 skipped, 0 moved', {
            [`manifest/${C}.json`]: undefined,
            [`manifest/${D}.json`]: undefined
        })
        expect(await allKeys(copy)).toEqual([key('2'), key('3'), key('4'), key('5')])
    })

    // An unpublished entry whose path a move took leaves the manifest with the
    // move (rule 6 of the moves): that is no forced removal.
    test('leaves out an entry that a move displaced, and counts an unpublished entry that a publication deleted', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 2 new, 0 updated, 0 removed, 0 forced, 0 skipped, 0 moved', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')]),
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2')], 'unpublished'),
            [`manifest/${C}.json`]: entry(C, 'C.md', [key('3')], 'unpublished'),
            [`manifest/${D}.json`]: entry(D, 'D.md', [key('4')])
        })
        // A moves to the path of the unpublished B, and D is a forced removal.
        await change(copy, 'Publish: 0 new, 0 updated, 0 removed, 1 forced, 0 skipped, 1 moved', {
            [`manifest/${A}.json`]: entry(A, 'B.md', [key('1')], 'published', ['A.md']),
            [`manifest/${B}.json`]: undefined,
            [`manifest/${D}.json`]: undefined
        })
        await change(copy, 'Publish: 0 new, 0 updated, 0 removed, 0 forced, 0 skipped, 1 moved', {
            [`manifest/${C}.json`]: undefined
        })
        expect(await allKeys(copy)).toEqual([key('3'), key('4')])
    })

    test('gives no key for a copy with no history', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        expect(await allKeys(copy)).toEqual([])
    })

    test('gives the keys that the published notes of a revision use, and nothing for a revision that the copy does not know', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const first = await change(
            copy,
            'Publish: 2 new, 0 updated, 0 removed, 0 forced, 0 skipped, 0 moved',
            {
                [`manifest/${A}.json`]: entry(A, 'A.md', [key('2'), key('1')]),
                [`manifest/${B}.json`]: entry(B, 'B.md', [key('3')], 'unpublished')
            }
        )
        await change(copy, 'Publish: 0 new, 1 updated, 0 removed, 0 forced, 0 skipped, 0 moved', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('6')])
        })
        expect(await releaseAttachmentKeys(copy, first)).toEqual([key('1'), key('2')])
        expect(await releaseAttachmentKeys(copy, 'f'.repeat(40))).toBeUndefined()
    })

    // Review round 1, A4: a removal is read from the content of the commits,
    // whatever their subjects say.
    test('counts every entry that any commit deleted, whatever its subject, but an entry that a move displaced', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 3 new', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')]),
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2')]),
            [`manifest/${C}.json`]: entry(C, 'C.md', [key('3')], 'unpublished')
        })
        await change(copy, 'A change by hand', { [`manifest/${A}.json`]: undefined })
        // The subject says a forced removal, but the commit deletes no entry.
        await change(copy, 'Publish: 0 new, 0 updated, 0 removed, 1 forced, 0 skipped, 0 moved', {
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('4')])
        })
        // An unpublished entry that no move replaced counts too.
        await change(copy, 'Publish: 0 new', { [`manifest/${C}.json`]: undefined })
        expect(await allKeys(copy)).toEqual([key('1'), key('3')])
    })

    test('gives the subjects of the commits between two revisions that deleted an entry', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const from = await change(copy, 'Publish: 2 new', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')]),
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2')], 'unpublished'),
            [`manifest/${C}.json`]: entry(C, 'C.md', [])
        })
        await change(copy, 'Takedown: 1 note', { [`manifest/${A}.json`]: undefined })
        await change(copy, 'Publish: 0 new, 0 updated, 0 removed, 1 forced, 0 skipped, 0 moved', {
            [`manifest/${C}.json`]: entry(C, 'C.md', [key('3')])
        })
        // A move takes the path of the unpublished B: no removal.
        await change(copy, 'Publish: 0 new, 0 updated, 0 removed, 0 forced, 0 skipped, 1 moved', {
            [`manifest/${C}.json`]: entry(C, 'B.md', [key('3')], 'published', ['C.md']),
            [`manifest/${B}.json`]: undefined
        })
        const to = await change(copy, 'A change by hand', { [`manifest/${C}.json`]: undefined })
        expect(await removalsBetween(copy, from, to)).toEqual([
            'A change by hand',
            'Takedown: 1 note'
        ])
        expect(await removalsBetween(copy, to, to)).toEqual([])
        expect(await removalsBetween(copy, from, 'f'.repeat(40))).toBeUndefined()
    })

    // Review round 1, A5: the manifest of the first publications had no attachments.
    test('gives no key for an entry with no attachments, and names the commit of an entry that it cannot read', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const old = JSON.stringify({ id: A, path: 'A.md', state: 'published' })
        await change(copy, 'Publish: 2 new', {
            [`manifest/${A}.json`]: `${old}\n`,
            [`manifest/${B}.json`]: '{"attachments": [{"hash": "md5:1"}]}\n'
        })
        await change(copy, 'Takedown: 1 note', { [`manifest/${A}.json`]: undefined })
        expect(await allKeys(copy)).toEqual([])
        const broken = await change(copy, 'Takedown: 1 note', { [`manifest/${B}.json`]: undefined })
        const message = await rejectionOf(removedAttachmentKeys(copy, null))
        expect(message).toContain(broken)
        expect(message).toContain(`manifest/${B}.json`)
    })

    // Review round 1, A3: a shallow copy does not have the whole history.
    test('stops on a shallow copy', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 1 new', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')])
        })
        await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
        await change(copy, 'Publish: 0 new', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('2')])
        })
        await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
        const shallow = join(stores.root, 'shallow')
        await git(
            stores.root,
            'clone',
            '--quiet',
            '--depth=1',
            pathToFileURL(stores.contentStore).href,
            shallow
        )
        expect(await rejectionOf(removedAttachmentKeys(shallow, null))).toContain('shallow')
    })

    // Review round 2, R5: only a real move displaces an unpublished entry.
    test.each([
        [
            'an unpublished writer',
            entry('a1a1a1a1a1a1a1a1', 'B.md', ['1'.repeat(64)], 'unpublished', ['A.md'])
        ],
        [
            'a writer that did not move',
            entry('a1a1a1a1a1a1a1a1', 'B.md', ['1'.repeat(64)], 'published', [])
        ],
        [
            'a writer whose old path is not a former path',
            entry('a1a1a1a1a1a1a1a1', 'B.md', ['1'.repeat(64)], 'published', ['Z.md'])
        ]
    ])('counts an unpublished entry whose path %s took', async (_case, writer) => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 2 new', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')]),
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2')], 'unpublished')
        })
        await change(copy, 'Publish: 0 new, 0 updated, 0 removed, 0 forced, 0 skipped, 1 moved', {
            [`manifest/${A}.json`]: writer,
            [`manifest/${B}.json`]: undefined
        })
        expect(await allKeys(copy)).toEqual([key('2')])
    })

    test('counts an unpublished entry that a new entry with its path replaced', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 1 new', {
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2')], 'unpublished')
        })
        await change(copy, 'Publish: 1 new', {
            [`manifest/${A}.json`]: entry(A, 'B.md', [key('1')], 'published', ['A.md']),
            [`manifest/${B}.json`]: undefined
        })
        expect(await allKeys(copy)).toEqual([key('2')])
    })

    // Review round 2, R1: one file that cannot be read never stops every deployment.
    test('takes the keys of every version that can be read of a deleted file that cannot be read', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 1 new', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')])
        })
        await change(copy, 'Publish: 0 new, 1 updated', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('2')])
        })
        await change(copy, 'A broken edit by hand', {
            [`manifest/${A}.json`]: '{"attachments": 1}\n'
        })
        await change(copy, 'Takedown: 1 note', { [`manifest/${A}.json`]: undefined })
        expect(await allKeys(copy)).toEqual([key('1'), key('2')])
    })

    test('never stops on an entry that cannot be read and that a commit wrote', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 1 new', {
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2')], 'unpublished')
        })
        await change(copy, 'A change by hand', {
            [`manifest/${A}.json`]: 'not JSON\n',
            [`manifest/${B}.json`]: undefined
        })
        expect(await allKeys(copy)).toEqual([key('2')])
    })

    // Review round 2, R3: the live release holds some removals.
    test('gives apart the keys of the removals that the live release holds', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await change(copy, 'Publish: 2 new', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')]),
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2')])
        })
        const live = await change(copy, 'Takedown: 1 note', { [`manifest/${A}.json`]: undefined })
        await change(copy, 'Takedown: 1 note', { [`manifest/${B}.json`]: undefined })
        expect(await removedAttachmentKeys(copy, live)).toEqual({
            notLive: [key('2')],
            inLive: [key('1')]
        })
        expect(await removedAttachmentKeys(copy, null)).toEqual({
            notLive: [key('1'), key('2')],
            inLive: []
        })
    })

    // Review round 2, R5: a merge hides what its sides removed.
    test('cannot say when the history has a merge commit', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const base = await change(copy, 'Publish: 1 new', {
            [`manifest/${A}.json`]: entry(A, 'A.md', [key('1')])
        })
        await git(copy, 'checkout', '--quiet', '-b', 'side')
        await change(copy, 'Takedown: 1 note', { [`manifest/${A}.json`]: undefined })
        await git(copy, 'checkout', '--quiet', '-')
        await change(copy, 'Publish: 1 new', {
            [`manifest/${B}.json`]: entry(B, 'B.md', [key('2')])
        })
        await git(copy, 'merge', '--quiet', '--no-edit', 'side')
        const head = await git(copy, 'rev-parse', 'HEAD')
        expect(await rejectionOf(removedAttachmentKeys(copy, null))).toContain('merge')
        expect(await rejectionOf(removalsBetween(copy, base, head))).toContain('merge')
    })

    test('stops on a revision whose manifest the build would refuse', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        const revision = await change(copy, 'Publish: 1 new', {
            [`manifest/${A}.json`]: '{"id": "not an entry"}\n'
        })
        expect(await rejectionOf(releaseAttachmentKeys(copy, revision))).toContain(
            'is not a manifest entry'
        )
    })
})

// Issue 120, decision 2 of the author: the keys that the guards withdrew are
// in the content store, so every machine that deploys reads them.
describe('the withdrawn keys of the copy', () => {
    /** Commits withdrawn.json with this text. */
    async function withdraw(copy: string, text: string): Promise<void> {
        await writeFile(join(copy, 'withdrawn.json'), text)
        await git(copy, 'add', 'withdrawn.json')
        await git(copy, 'commit', '--quiet', '--message', 'Publish: 0 new')
    }

    test('are the keys of withdrawn.json at the commit of the copy, and none without the file', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        expect(await withdrawnAttachmentKeys(copy)).toEqual([])
        await withdraw(copy, `{"keys": ["${'a'.repeat(64)}", "${'b'.repeat(64)}"]}\n`)
        expect(await withdrawnAttachmentKeys(copy)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    })

    test('stop on a file that the tool would refuse', async () => {
        await using stores = await makeTestStores()
        const copy = await makeContentStoreCopy(stores)
        await withdraw(copy, '{"keys": ["Assets/image.png"]}\n')
        expect(await rejectionOf(withdrawnAttachmentKeys(copy))).toContain(
            'withdrawn.json of the content store cannot be read'
        )
    })
})
