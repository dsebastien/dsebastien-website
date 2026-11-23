import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    crashingStore,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    refusePushes,
    rejectionOf,
    type CrashPoint,
    type TestStores
} from '@dsebastien-website/testing'
import { makeEvent } from './edits.ts'
import { nodeDevice } from './node/device.ts'
import type { Device } from './ports.ts'
import {
    confirmProposal,
    edit,
    guards,
    plan,
    publish,
    rejectProposal,
    status,
    unlock
} from './tool.ts'
import type { Run } from './tool.ts'

// The edits of the guards (issue 42, decisions R69): the operations `guards`,
// `edit`, `confirmProposal` and `rejectProposal` of `tool.ts`, which every
// face calls, on a small invented vault and a content store made for the
// test. The shared scenario "the edits of the guards" of
// `fixtures/canonical/queue.json` states the events and the refusals; these
// tests state the failure cases: the lock, a copy that is behind, a refused
// push, a run that stops halfway, a stale confirmation.

const VAULT: Record<string, string> = {
    'Notes/Public.md': 'Public\n',
    'Notes/Draft.md': 'Draft\n',
    'Notes/Kept.md': '---\npublish_ignore: true\n---\nKept\n',
    'Mixed/Shown.md': 'Shown\n',
    'Private/Diary.md': 'Diary\n',
    'Locked/Secret.md': 'Secret\n'
}

const CONFIGURATION = '{\n  "denyList": [\n    "Locked"\n  ]\n}\n'
const WITH_PRIVATE = '{\n  "denyList": [\n    "Locked",\n    "Private"\n  ]\n}\n'

const AGENT: Run = { time: '2031-06-01T09:00:00Z', device: 'garden-shed', face: 'mcp-server' }
const AUTHOR: Run = { time: '2031-06-01T10:00:00Z', device: 'garden-shed', face: 'plugin' }

interface Setup {
    readonly vault: string
    readonly copy: string
    readonly device: Device
}

async function git(cwd: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], {
        cwd,
        env: gitEnvironment(),
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
    return output.trimEnd()
}

async function writeFiles(folder: string, files: Record<string, string>): Promise<void> {
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(folder, path)), { recursive: true })
        await writeFile(join(folder, path), text)
    }
}

/** Another device: it writes files into the content store and pushes them. */
async function pushFiles(copy: string, files: Record<string, string>): Promise<void> {
    await writeFiles(copy, files)
    await git(copy, 'add', '--', ...Object.keys(files))
    await git(copy, 'commit', '--quiet', '--message', 'A change of another device')
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
}

async function setUp(stores: TestStores, configuration = CONFIGURATION): Promise<Setup> {
    const vault = join(stores.root, 'vault')
    await writeFiles(vault, VAULT)
    const copy = await makeContentStoreCopy(stores)
    await pushFiles(copy, { 'configuration.json': configuration })
    return {
        vault,
        copy,
        device: nodeDevice({
            vault,
            contentStore: copy,
            attachmentStorage: stores.attachmentStorage
        })
    }
}

/** The text of a file, or `null` when it does not exist. */
async function textOf(path: string): Promise<string | null> {
    try {
        return await readFile(path, 'utf8')
    } catch {
        return null
    }
}

/** The text of a file in the branch `main` of the content store. */
async function inStore(stores: TestStores, path: string): Promise<string | null> {
    try {
        return `${await git(stores.contentStore, 'show', `main:${path}`)}\n`
    } catch {
        return null
    }
}

/** Publishes the notes of the paths, as the author would. */
async function publishNotes(device: Device, paths: string[], time: string): Promise<void> {
    const planned = await plan(device, { include: paths })
    await publish(device, planned.id, { ...AUTHOR, time })
}

describe('an edit of the guards', () => {
    test('writes its event and the configuration in one commit with the message of the spec', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)

        const event = await edit(device, { action: 'deny', path: 'Private' }, AGENT)

        expect(event).toEqual(
            makeEvent({
                action: 'deny',
                device: 'garden-shed',
                face: 'mcp-server',
                path: 'Private',
                state: 'applied',
                time: AGENT.time
            })
        )
        expect(await inStore(stores, 'configuration.json')).toBe(WITH_PRIVATE)
        expect(await git(copy, 'log', '-1', '--format=%B')).toBe(
            `Edit: deny (applied)\n\nDevice: garden-shed\nFace: mcp-server\nPlan: ${event.id}`
        )
        expect(await git(copy, 'show', '--name-only', '--format=', 'HEAD')).toBe(
            'configuration.json\nedits.json'
        )
        // The lock and the run journal are gone.
        expect(await device.local.readLock()).toBeUndefined()
        expect(await device.local.loadJournal()).toBeUndefined()
    }, 60_000)

    test('stops while another run holds the lock of the device, and changes nothing', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        const lock = await device.local.lock({
            command: 'publish',
            device: 'garden-shed',
            face: 'plugin',
            time: AGENT.time
        })
        const head = await git(copy, 'rev-parse', 'HEAD')

        const message = await rejectionOf(edit(device, { action: 'deny', path: 'Private' }, AGENT))

        expect(message).toContain('a publication runs on this device')
        expect(await git(copy, 'rev-parse', 'HEAD')).toBe(head)
        expect(await device.local.readLock()).toBe(lock.text)
    }, 60_000)

    test('stops when the copy is behind the content store, and says to pull', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        // Another device pushes first.
        await makeContentStoreCopy(stores, 'other')

        const message = await rejectionOf(edit(device, { action: 'deny', path: 'Private' }, AGENT))

        expect(message).toContain('behind the content store')
        expect(message).toContain('git pull --ff-only origin main')
        expect(await textOf(join(copy, 'configuration.json'))).toBe(CONFIGURATION)
        expect(await textOf(join(copy, 'edits.json'))).toBeNull()
    }, 60_000)

    test('stops without a network', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        await git(copy, 'remote', 'set-url', 'origin', join(stores.root, 'unreachable'))

        const message = await rejectionOf(edit(device, { action: 'deny', path: 'Private' }, AGENT))

        expect(message).not.toBe('')
        expect(await textOf(join(copy, 'edits.json'))).toBeNull()
    }, 60_000)

    test('a refused push puts the files back and applies nothing', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        const head = await git(copy, 'rev-parse', 'HEAD')
        await refusePushes(stores.contentStore)

        const message = await rejectionOf(edit(device, { action: 'deny', path: 'Private' }, AGENT))

        expect(message).toContain('Nothing is applied')
        expect(message).toContain('the files of the copy are as they were before')
        expect(await textOf(join(copy, 'configuration.json'))).toBe(CONFIGURATION)
        expect(await textOf(join(copy, 'edits.json'))).toBeNull()
        expect(await git(copy, 'rev-parse', 'HEAD')).toBe(head)
        expect(await git(copy, 'status', '--porcelain')).toBe('')
        expect(await device.local.readLock()).toBeUndefined()
        expect(await device.local.loadJournal()).toBeUndefined()
        expect((await guards(device)).denyList).toEqual(['Locked'])
    }, 60_000)

    test('an ignore whose push is refused keeps the property in the note, with no event, and says both', async () => {
        await using stores = await makeTestStores()
        const { vault, copy, device } = await setUp(stores)
        await refusePushes(stores.contentStore)

        const message = await rejectionOf(
            edit(device, { action: 'ignore', path: 'Notes/Draft.md' }, AGENT)
        )

        expect(message).toContain('stays in the note "Notes/Draft.md"')
        expect(message).toContain('the log of the edits has no event for it')
        expect(await textOf(join(vault, 'Notes/Draft.md'))).toBe(
            '---\npublish_ignore: true\n---\nDraft\n'
        )
        expect(await textOf(join(copy, 'edits.json'))).toBeNull()
    }, 60_000)

    test('does not write a note that changed since its check', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        const path = 'Notes/Draft.md'
        // The note changes on the disk right after the check read it.
        let changed = false
        const inner = device.vault.forRun()
        const changing: Device = {
            ...device,
            vault: {
                ...inner,
                forRun: () => ({
                    ...inner,
                    read: async (one: string) => {
                        const text = await inner.read(one)
                        if (one === path && !changed) {
                            changed = true
                            await writeFile(join(vault, path), 'Draft, edited\n')
                        }
                        return text
                    }
                })
            }
        }

        const message = await rejectionOf(edit(changing, { action: 'ignore', path }, AGENT))

        expect(message).toContain('changed since the check')
        expect(await textOf(join(vault, path))).toBe('Draft, edited\n')
        expect((await guards(device)).edits).toEqual([])
    }, 60_000)

    test.each<[CrashPoint]>([['write'], ['commit']])(
        'that stops halfway (%s) holds the lock with the command edit, and the next run puts the copy back',
        async (at) => {
            await using stores = await makeTestStores()
            const { copy, device } = await setUp(stores)
            const head = await git(copy, 'rev-parse', 'HEAD')
            const stopped = crashingStore(device.store, copy, at)
            void edit(
                { ...device, store: stopped.store },
                { action: 'deny', path: 'Private' },
                AGENT
            )
            await stopped.reached

            expect(await device.local.readLock()).toContain('"command": "edit"')
            const journal = JSON.parse((await device.local.loadJournal()) ?? '{}') as {
                paths: string[]
                plan: string
            }
            expect(journal.paths).toEqual(['configuration.json', 'edits.json'])
            expect(journal.plan).toMatch(/^[0-9a-f]{16}$/u)
            expect(await rejectionOf(status(device))).toContain('stopped halfway')

            expect(await unlock(device)).toBe(true)
            const event = await edit(device, { action: 'deny', path: 'Private' }, AGENT)

            expect(event.state).toBe('applied')
            expect(event.id).toBe(journal.plan)
            // One commit of the edit after the head before the stopped run.
            expect(await git(copy, 'rev-list', '--count', `${head}..HEAD`)).toBe('1')
            expect(await inStore(stores, 'configuration.json')).toBe(WITH_PRIVATE)
            expect((await guards(device)).edits).toEqual([event])
            expect(await device.local.loadJournal()).toBeUndefined()
        },
        60_000
    )

    test('a deny list entry that names no folder stops a plan, but not guards and not an edit (PUB-91)', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores, '{"denyList": ["Locked", "Gone"]}')

        expect(await rejectionOf(status(device))).toContain('"Gone", which is not a folder')
        expect((await guards(device)).denyList).toEqual(['Locked', 'Gone'])
        const allow = await edit(device, { action: 'allow', path: 'Gone' }, AGENT)
        expect(allow.state).toBe('proposed')
        const deny = await edit(device, { action: 'deny', path: 'Private' }, AGENT)
        expect(deny.state).toBe('applied')
        expect((await guards(device)).denyList).toEqual(['Locked', 'Gone', 'Private'])
    }, 60_000)

    test('an edits.json that is not valid stops status, plan, guards and an edit, and names the file', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        await pushFiles(copy, { 'edits.json': '{"edits": [], "published": 1}' })

        for (const run of [
            () => status(device),
            () => plan(device, { include: [] }),
            () => guards(device),
            () => edit(device, { action: 'deny', path: 'Private' }, AGENT)
        ]) {
            expect(await rejectionOf(run())).toContain(
                'edits.json of the content store is not valid'
            )
        }
    }, 60_000)
})

describe('the copy must hold the edits.json of its last commit', () => {
    test.each([
        ['edited', true, (copy: string) => writeFile(join(copy, 'edits.json'), '{}\n')],
        ['removed', true, (copy: string) => rm(join(copy, 'edits.json'))],
        [
            'added and not committed',
            false,
            (copy: string) => writeFile(join(copy, 'edits.json'), '{"edits": [], "published": 0}\n')
        ]
    ] as const)(
        'an edits.json %s stops status, plan, publish and an edit',
        async (_name, committed, change) => {
            await using stores = await makeTestStores()
            const { copy, device } = await setUp(stores)
            if (committed) {
                await edit(device, { action: 'allow', path: 'Locked' }, AGENT)
            }
            const planned = await plan(device, { include: ['Notes/Public.md'] })
            await change(copy)

            for (const run of [
                () => status(device),
                () => plan(device, { include: [] }),
                () => publish(device, planned.id, AUTHOR),
                () => edit(device, { action: 'deny', path: 'Private' }, AGENT)
            ]) {
                const message = await rejectionOf(run())
                expect(message).toContain('are not the files of its last commit: edits.json')
                expect(message).toContain('edits.json')
            }
        },
        120_000
    )

    test('a content store with no edits.json in its commit and none in the copy is fine', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)

        expect((await status(device)).proposals).toEqual([])
        expect(await textOf(join(copy, 'edits.json'))).toBeNull()
    }, 60_000)
})

describe('the plan and the edits', () => {
    test('a new event makes a stored plan stale, and the new plan shows it', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const before = await plan(device, { include: ['Notes/Public.md'] })
        expect(before.plan.edits).toEqual([])

        const event = await edit(device, { action: 'deny', path: 'Private' }, AGENT)

        expect(await rejectionOf(publish(device, before.id, AUTHOR))).toContain('is stale')
        const after = await plan(device, { include: ['Notes/Public.md'] })
        expect(after.plan.edits).toEqual([event])
        await publish(device, after.id, AUTHOR)
        expect(await inStore(stores, 'edits.json')).toContain('"published": 1')
        expect((await plan(device, { include: [] })).plan.edits).toEqual([])
    }, 120_000)

    test('a publication with no edit never makes edits.json', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)

        await publishNotes(device, ['Notes/Public.md'], AUTHOR.time)

        expect(await textOf(join(copy, 'edits.json'))).toBeNull()
    }, 60_000)
})

describe('the decisions of the author', () => {
    test('only the face plugin confirms or rejects a proposal', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const proposal = await edit(device, { action: 'allow', path: 'Locked' }, AGENT)

        for (const face of ['mcp-server', 'command-line'] as const) {
            const run = { ...AUTHOR, face }
            expect(await rejectionOf(rejectProposal(device, proposal.id, run))).toContain(
                'only the author'
            )
            expect(
                await rejectionOf(
                    confirmProposal(device, { proposal: proposal.id, removes: [] }, run)
                )
            ).toContain('only the author')
        }
        expect((await guards(device)).proposals).toEqual([proposal])
    }, 60_000)

    test('a rejection writes its event only, and closes the proposal', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const proposal = await edit(device, { action: 'allow', path: 'Locked' }, AGENT)

        const rejected = await rejectProposal(device, proposal.id, AUTHOR)

        expect(rejected).toEqual(
            makeEvent({
                action: 'allow',
                device: 'garden-shed',
                face: 'plugin',
                path: 'Locked',
                proposal: proposal.id,
                state: 'rejected',
                time: AUTHOR.time
            })
        )
        expect(await guards(device)).toEqual({
            denyList: ['Locked'],
            edits: [proposal, rejected],
            proposals: []
        })
        // A decided proposal cannot be decided again.
        expect(await rejectionOf(rejectProposal(device, proposal.id, AUTHOR))).toContain(
            'is not an open proposal'
        )
    }, 60_000)

    test('a confirmed allow removes the folder from the deny list', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores, WITH_PRIVATE)
        const proposal = await edit(device, { action: 'allow', path: 'Private' }, AGENT)

        const confirmed = await confirmProposal(
            device,
            { proposal: proposal.id, removes: [] },
            AUTHOR
        )

        expect(confirmed.state).toBe('confirmed')
        expect(await inStore(stores, 'configuration.json')).toBe(CONFIGURATION)
        // A looser guard publishes nothing alone: the note is a candidate.
        expect((await status(device)).new).toContain('Private/Diary.md')
    }, 60_000)

    test('a confirmation stops when the notes that would leave are not the ones that the view showed', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await publishNotes(device, ['Mixed/Shown.md'], '2031-06-01T08:00:00Z')
        const proposal = await edit(device, { action: 'deny', path: 'Mixed' }, AGENT)
        expect(proposal.removes).toEqual(['Mixed/Shown.md'])
        // Another note of the folder goes live after the view showed the proposal.
        await writeFiles(vault, { 'Mixed/Other.md': 'Other\n' })
        await publishNotes(device, ['Mixed/Other.md'], '2031-06-01T09:30:00Z')

        const message = await rejectionOf(
            confirmProposal(device, { proposal: proposal.id, removes: ['Mixed/Shown.md'] }, AUTHOR)
        )

        expect(message).toContain('changed since the view showed them')
        expect(message).toContain('"Mixed/Other.md", "Mixed/Shown.md"')
        expect(await inStore(stores, 'configuration.json')).toBe(CONFIGURATION)
        const confirmed = await confirmProposal(
            device,
            { proposal: proposal.id, removes: ['Mixed/Shown.md', 'Mixed/Other.md'] },
            AUTHOR
        )
        expect(confirmed.removes).toEqual(['Mixed/Other.md', 'Mixed/Shown.md'])
        expect((await status(device)).toRemove).toEqual(['Mixed/Other.md', 'Mixed/Shown.md'])
    }, 120_000)

    test('a confirmed ignore writes the property, and the note becomes a forced removal', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await publishNotes(device, ['Notes/Public.md'], '2031-06-01T08:00:00Z')
        const proposal = await edit(device, { action: 'ignore', path: 'Notes/Public.md' }, AGENT)
        expect(proposal.removes).toEqual(['Notes/Public.md'])

        await confirmProposal(
            device,
            { proposal: proposal.id, removes: ['Notes/Public.md'] },
            AUTHOR
        )

        expect(await textOf(join(vault, 'Notes/Public.md'))).toBe(
            '---\npublic_note: true\npublish_ignore: true\n---\nPublic\n'
        )
        expect((await status(device)).toRemove).toEqual(['Notes/Public.md'])
    }, 120_000)

    test('a confirmed unignore commits its event first, then removes the property', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        const proposal = await edit(device, { action: 'unignore', path: 'Notes/Kept.md' }, AGENT)
        expect(await textOf(join(vault, 'Notes/Kept.md'))).toBe(VAULT['Notes/Kept.md'] ?? '')

        const confirmed = await confirmProposal(
            device,
            { proposal: proposal.id, removes: [] },
            AUTHOR
        )

        expect(confirmed.state).toBe('confirmed')
        expect(await textOf(join(vault, 'Notes/Kept.md'))).toBe('Kept\n')
        expect((await status(device)).new).toContain('Notes/Kept.md')
        expect((await guards(device)).proposals).toEqual([])
    }, 60_000)

    test('a confirmation checks the edit again', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        const proposal = await edit(device, { action: 'unignore', path: 'Notes/Kept.md' }, AGENT)
        // The author removed the property by hand.
        await writeFile(join(vault, 'Notes/Kept.md'), 'Kept\n')

        expect(
            await rejectionOf(
                confirmProposal(device, { proposal: proposal.id, removes: [] }, AUTHOR)
            )
        ).toContain('does not exclude')
        expect((await guards(device)).proposals).toEqual([proposal])
    }, 60_000)
})
