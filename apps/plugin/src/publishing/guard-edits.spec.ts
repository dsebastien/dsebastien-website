import { describe, expect, test } from 'bun:test'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    crashingStore,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    refusePushes,
    rejectionOf,
    sealHead,
    sealOfCommit,
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
    reviewProposal,
    status,
    unlock,
    unpublish
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
    await sealHead(copy)
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
        // The commit carries the seal of its state (R104).
        const seal = await sealOfCommit(copy)
        expect(await git(copy, 'log', '-1', '--format=%B')).toBe(
            `Edit: deny (applied)\n\nDevice: garden-shed\nFace: mcp-server\nPlan: ${event.id}\nSeal: ${seal}`
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

/** The journal of another device in the vault: its lines move notes. */
const JOURNAL = '.obsidian/plugins/dsebastien-vault-publish/renames/00000000000000aa.jsonl'

function journalLine(from: string, to: string): string {
    return `${JSON.stringify({ from, kind: 'note', time: '2031-06-01T08:30:00Z', to })}\n`
}

describe('the removes of an edit: two scans, as is and with the edit applied (rule 2)', () => {
    test('a published note that a journal moves into the folder, while this device still has the old file', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await publishNotes(device, ['Notes/Public.md'], '2031-06-01T08:00:00Z')
        const published = (await textOf(join(vault, 'Notes/Public.md'))) ?? ''
        await writeFiles(vault, {
            'Private/Public.md': published,
            [JOURNAL]: journalLine('Notes/Public.md', 'Private/Public.md')
        })
        // As is, the note moves: no forced removal.
        expect((await status(device)).renamed).toEqual([
            { from: 'Notes/Public.md', to: 'Private/Public.md' }
        ])

        const event = await edit(device, { action: 'deny', path: 'Private' }, AGENT)

        expect(event.state).toBe('proposed')
        expect(event.removes).toEqual(['Notes/Public.md'])
    }, 60_000)

    test('a missing published note whose name is in the folder, also in another letter case', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await publishNotes(device, ['Notes/Public.md', 'Notes/Draft.md'], '2031-06-01T08:00:00Z')
        // Moved with no line of a journal: only the names tell.
        await rm(join(vault, 'Notes/Public.md'))
        await rm(join(vault, 'Notes/Draft.md'))
        await writeFiles(vault, { 'Private/Public.md': 'Public\n', 'Private/DRAFT.md': 'Draft\n' })
        expect((await status(device)).missing).toEqual(['Notes/Draft.md', 'Notes/Public.md'])

        const event = await edit(device, { action: 'deny', path: 'Private' }, AGENT)

        expect(event.removes).toEqual(['Notes/Draft.md', 'Notes/Public.md'])
    }, 60_000)

    test('an unpublished entry in the folder, and one whose journal line gives it a new name there', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await writeFiles(vault, { 'Private/Old.md': 'Old\n' })
        await publishNotes(
            device,
            ['Private/Diary.md', 'Private/Old.md', 'Notes/Draft.md'],
            '2031-06-01T08:00:00Z'
        )
        for (const path of ['Private/Diary.md', 'Notes/Draft.md']) {
            await unpublish(device, [path], { ...AUTHOR, time: '2031-06-01T08:10:00Z' })
        }
        // The unpublished draft gets a new name in the folder.
        await rm(join(vault, 'Notes/Draft.md'))
        await writeFiles(vault, {
            'Private/Renamed draft.md': 'Draft\n',
            [JOURNAL]: journalLine('Notes/Draft.md', 'Private/Renamed draft.md')
        })

        const event = await edit(device, { action: 'deny', path: 'Private' }, AGENT)

        expect(event.removes).toEqual(['Notes/Draft.md', 'Private/Diary.md', 'Private/Old.md'])
    }, 120_000)

    test('an ignore of a note that a journal moved names the entry where the publication removes it', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await publishNotes(device, ['Notes/Public.md'], '2031-06-01T08:00:00Z')
        const published = (await textOf(join(vault, 'Notes/Public.md'))) ?? ''
        await rm(join(vault, 'Notes/Public.md'))
        await writeFiles(vault, {
            'Notes/Moved.md': published,
            [JOURNAL]: journalLine('Notes/Public.md', 'Notes/Moved.md')
        })

        const event = await edit(device, { action: 'ignore', path: 'Notes/Moved.md' }, AGENT)

        // The move under the guard does not happen: the entry leaves at its old path.
        expect(event.removes).toEqual(['Notes/Public.md'])
    }, 60_000)

    test('nested deny entries: a folder above an entry counts only the entries that are not under a guard yet', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await writeFiles(vault, { 'Mixed/Sub/Deep.md': 'Deep\n' })
        await publishNotes(device, ['Mixed/Shown.md', 'Mixed/Sub/Deep.md'], '2031-06-01T08:00:00Z')
        const sub = await edit(device, { action: 'deny', path: 'Mixed/Sub' }, AGENT)
        expect(sub.removes).toEqual(['Mixed/Sub/Deep.md'])
        await confirmProposal(
            device,
            { proposal: sub.id, removes: ['Mixed/Sub/Deep.md'], affects: [], opens: [] },
            AUTHOR
        )

        const above = await edit(
            device,
            { action: 'deny', path: 'Mixed' },
            {
                ...AGENT,
                time: '2031-06-01T11:00:00Z'
            }
        )

        expect(above.removes).toEqual(['Mixed/Shown.md'])
        // A folder below an entry takes nothing more away: it applies at once.
        await writeFiles(vault, { 'Locked/Inner/Hidden.md': 'Hidden\n' })
        const below = await edit(device, { action: 'deny', path: 'Locked/Inner' }, AGENT)
        expect(below.state).toBe('applied')
        expect(below.removes).toBeUndefined()
    }, 120_000)

    test('a folder in another letter case or Unicode form is not the folder of the vault', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await writeFiles(vault, { 'Caf\u00e9/Note.md': 'Note\n' })

        for (const path of ['private', 'PRIVATE', 'Cafe\u0301']) {
            expect(await rejectionOf(edit(device, { action: 'deny', path }, AGENT))).toContain(
                'is not a folder of the vault'
            )
        }
        expect((await edit(device, { action: 'deny', path: 'Caf\u00e9' }, AGENT)).state).toBe(
            'applied'
        )
    }, 60_000)
})

describe('a deny that takes an attachment away from a published note (R69, review round 2)', () => {
    test('is a proposal with affects, and its confirmation checks both lists again', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await writeFiles(vault, {
            'Notes/Plan.md': '# Plan\n\n[[Images/plan.txt]]\n',
            'Images/plan.txt': 'A plan\n'
        })
        await publishNotes(device, ['Notes/Plan.md'], '2031-06-01T08:00:00Z')

        const proposal = await edit(device, { action: 'deny', path: 'Images' }, AGENT)

        expect(proposal.state).toBe('proposed')
        expect(proposal.affects).toEqual(['Notes/Plan.md'])
        expect(proposal.removes).toBeUndefined()
        const review = await reviewProposal(device, proposal.id)
        expect(review).toEqual({
            proposal,
            removes: [],
            affects: ['Notes/Plan.md'],
            opens: [],
            candidates: 0,
            inside: []
        })
        // A dialog that showed no note that loses an attachment is stale.
        expect(
            await rejectionOf(
                confirmProposal(
                    device,
                    { proposal: proposal.id, removes: [], affects: [], opens: [] },
                    AUTHOR
                )
            )
        ).toContain('changed since the dialog showed them')
        const confirmed = await confirmProposal(
            device,
            {
                proposal: proposal.id,
                removes: review.removes,
                affects: review.affects,
                opens: review.opens
            },
            AUTHOR
        )
        expect(confirmed.affects).toEqual(['Notes/Plan.md'])
        expect((await guards(device)).denyList).toEqual(['Locked', 'Images'])
    }, 120_000)
})

describe('an agent publication applies a plan only when accept names what it takes away (rule 10)', () => {
    const MCP: Run = { ...AUTHOR, time: '2031-06-01T12:00:00Z', face: 'mcp-server' }
    const CLI: Run = { ...MCP, face: 'command-line' }

    test('a journal line of another device moves a published note into a folder that a deny took alone', async () => {
        await using stores = await makeTestStores()
        const { vault, copy, device } = await setUp(stores)
        await publishNotes(device, ['Notes/Public.md', 'Notes/Draft.md'], '2031-06-01T08:00:00Z')
        expect((await edit(device, { action: 'deny', path: 'Private' }, AGENT)).state).toBe(
            'applied'
        )
        // The vault of another device arrives, with its journal.
        const published = (await textOf(join(vault, 'Notes/Public.md'))) ?? ''
        await rm(join(vault, 'Notes/Public.md'))
        await writeFiles(vault, {
            'Private/Public.md': published,
            [JOURNAL]: journalLine('Notes/Public.md', 'Private/Public.md')
        })

        const plans = join(copy, '.git', 'vault-publish', 'plans')
        for (const run of [MCP, CLI]) {
            const planned = await plan(device, { include: [] })
            expect(planned.plan.forcedRemove).toEqual(['Notes/Public.md'])
            const message = await rejectionOf(publish(device, planned.id, run))
            expect(message).toContain('it takes away "Notes/Public.md"')
            expect(message).toContain('accept')
            expect(message).toContain('publication center')
            const stored = (await readdir(plans)).length
            expect(await rejectionOf(unpublish(device, ['Notes/Draft.md'], run))).toContain(
                'publication center'
            )
            // The refused unpublish stores no plan, as in Rust (issue 112).
            expect((await readdir(plans)).length).toBe(stored)
        }
        expect(await inStore(stores, 'notes/Notes/Public.md')).not.toBeNull()

        // When the request names the forced removal, the agent applies it.
        const accepted = await plan(device, { include: [], accept: ['Notes/Public.md'] })
        const report = await publish(device, accepted.id, MCP)
        expect(report.forcedRemoved).toEqual(['Notes/Public.md'])
    }, 120_000)

    test('an unpublish of an agent applies its forced removals when accept names them', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await publishNotes(device, ['Notes/Public.md', 'Notes/Draft.md'], '2031-06-01T08:00:00Z')
        await writeFile(join(vault, 'Notes/Public.md'), '---\npublish_ignore: true\n---\nPublic\n')

        const report = await unpublish(device, ['Notes/Draft.md'], MCP, ['Notes/Public.md'])

        expect(report.removed).toEqual(['Notes/Draft.md'])
        expect(report.forcedRemoved).toEqual(['Notes/Public.md'])
    }, 120_000)

    test('a published note that would lose a file under a guard is in guardedAttachments, also when its update is held', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await writeFiles(vault, {
            'Notes/Plan.md': '# Plan\n\n[[plan.txt]]\n',
            'Assets/plan.txt': 'A plan\n'
        })
        await publishNotes(device, ['Notes/Plan.md'], '2031-06-01T08:00:00Z')
        // The file moves into a folder of the deny list.
        await rm(join(vault, 'Assets/plan.txt'))
        await writeFiles(vault, { 'Locked/plan.txt': 'A plan\n' })

        const held = await plan(device, { include: [], hold: ['Notes/Plan.md'] })
        expect(held.plan.guardedAttachments).toEqual(['Notes/Plan.md'])
        const planned = await plan(device, { include: [] })
        expect(planned.plan.guardedAttachments).toEqual(['Notes/Plan.md'])
        const message = await rejectionOf(publish(device, planned.id, CLI))
        expect(message).toContain('"Notes/Plan.md" would lose a file under a guard')
        expect(message).toContain('publication center')

        const accepted = await plan(device, { include: [], accept: ['Notes/Plan.md'] })
        const report = await publish(device, accepted.id, CLI)
        expect(report.updated).toEqual(['Notes/Plan.md'])
    }, 120_000)

    test('a path of accept that the plan does not take away stops the plan', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        await publishNotes(device, ['Notes/Public.md'], '2031-06-01T08:00:00Z')

        expect(
            await rejectionOf(plan(device, { include: [], accept: ['Notes/Public.md'] }))
        ).toContain('accept names only those')
        expect(await rejectionOf(plan(device, { include: [], accept: ['Notes'] }))).toContain(
            'does not end in .md'
        )
    }, 60_000)

    test('the face plugin applies a plan with forced removals and no accept', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await publishNotes(device, ['Notes/Public.md'], '2031-06-01T08:00:00Z')
        await writeFile(join(vault, 'Notes/Public.md'), '---\npublish_ignore: true\n---\nPublic\n')

        const planned = await plan(device, { include: [] })
        const report = await publish(device, planned.id, AUTHOR)

        expect(report.forcedRemoved).toEqual(['Notes/Public.md'])
    }, 60_000)
})

describe('the cleanups of a run of an agent face keep the guarded files of the entries that accept does not name (rule 10)', () => {
    const MCP: Run = { ...AUTHOR, time: '2031-06-01T12:00:00Z', face: 'mcp-server' }

    /** A published note whose file is under a guard now, and a stored plan that the author made stale. */
    async function staleWithGuardedFile(
        stores: TestStores
    ): Promise<{ device: Device; vault: string; id: string }> {
        const { vault, device } = await setUp(stores)
        await writeFiles(vault, {
            'Notes/Plan.md': '# Plan\n\n[[plan.txt]]\n',
            'Assets/plan.txt': 'A plan\n'
        })
        await publishNotes(device, ['Notes/Plan.md'], '2031-06-01T08:00:00Z')
        await rm(join(vault, 'Assets/plan.txt'))
        await writeFiles(vault, { 'Locked/plan.txt': 'A plan\n' })
        const planned = await plan(device, { include: [] })
        expect(planned.plan.guardedAttachments).toEqual(['Notes/Plan.md'])
        const text = (await textOf(join(vault, 'Notes/Plan.md'))) ?? ''
        await writeFile(join(vault, 'Notes/Plan.md'), `${text}A second line.\n`)
        return { device, vault, id: planned.id }
    }

    test('a stale plan of an agent deletes no file under a guard that a published note uses', async () => {
        await using stores = await makeTestStores()
        const { device, id } = await staleWithGuardedFile(stores)
        const before = await readdir(stores.attachmentStorage)
        expect(before).toHaveLength(1)

        expect(await rejectionOf(publish(device, id, MCP))).toContain('is stale')

        expect(await readdir(stores.attachmentStorage)).toEqual(before)
    }, 120_000)

    test('a stale plan of the face plugin deletes it, as rule 8 of a publication says', async () => {
        await using stores = await makeTestStores()
        const { device, id } = await staleWithGuardedFile(stores)

        expect(await rejectionOf(publish(device, id, AUTHOR))).toContain('is stale')

        expect(await readdir(stores.attachmentStorage)).toEqual([])
    }, 120_000)

    test('an agent publication whose accept names the entry deletes it', async () => {
        await using stores = await makeTestStores()
        const { device } = await staleWithGuardedFile(stores)

        const planned = await plan(device, { include: [], accept: ['Notes/Plan.md'] })
        const report = await publish(device, planned.id, MCP)

        expect(report.attachmentsDeleted).toHaveLength(1)
        expect(await readdir(stores.attachmentStorage)).toEqual([])
    }, 120_000)
})

describe('what a confirmed allow opens (rule 11)', () => {
    test('the review names the published notes that link to a file of the folder, and counts the candidates', async () => {
        await using stores = await makeTestStores()
        const { vault, device } = await setUp(stores)
        await writeFiles(vault, {
            'Notes/Plan.md': '# Plan\n\n[[secret.txt]]\n',
            'Locked/secret.txt': 'A secret\n'
        })
        await publishNotes(device, ['Notes/Plan.md'], '2031-06-01T08:00:00Z')
        const proposal = await edit(device, { action: 'allow', path: 'Locked' }, AGENT)

        const review = await reviewProposal(device, proposal.id)

        expect(review).toEqual({
            proposal,
            removes: [],
            affects: [],
            opens: ['Notes/Plan.md'],
            candidates: 1,
            inside: []
        })
        // A dialog that named no such note is stale.
        expect(
            await rejectionOf(
                confirmProposal(
                    device,
                    { proposal: proposal.id, removes: [], affects: [], opens: [] },
                    AUTHOR
                )
            )
        ).toContain('would link to a file of the folder changed since the dialog showed them')
        await confirmProposal(
            device,
            { proposal: proposal.id, removes: [], affects: [], opens: review.opens },
            AUTHOR
        )
        expect((await guards(device)).denyList).toEqual([])
        // The next plan without paths updates the note, which uploads the file.
        expect((await status(device)).technicalUpdates).toEqual(['Notes/Plan.md'])
    }, 120_000)
})

describe('what a confirmed allow keeps published', () => {
    test('the review names the published entries inside the folder of a deny that no publication applied yet', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        await publishNotes(device, ['Mixed/Shown.md'], '2031-06-01T08:00:00Z')
        const deny = await edit(device, { action: 'deny', path: 'Mixed' }, AGENT)
        await confirmProposal(
            device,
            { proposal: deny.id, removes: ['Mixed/Shown.md'], affects: [], opens: [] },
            AUTHOR
        )
        const allow = await edit(
            device,
            { action: 'allow', path: 'Mixed' },
            {
                ...AGENT,
                time: '2031-06-01T11:00:00Z'
            }
        )

        const review = await reviewProposal(device, allow.id)

        expect(review.inside).toEqual(['Mixed/Shown.md'])
        expect(review.candidates).toBe(0)
    }, 120_000)
})

describe('the reads and the configuration of an edit', () => {
    test('guards stops while the lock of the device is taken, as status does', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const lock = await device.local.lock({ command: 'plan' })

        expect(await rejectionOf(guards(device))).toContain('a publication runs on this device')
        await device.local.release(lock.text)
        expect((await guards(device)).denyList).toEqual(['Locked'])
    }, 60_000)

    test.each([['1.0'], ['1e3'], ['-2.5E-1'], ['-0'], ['-0.0'], ['9007199254740992']])(
        'a configuration with the number %s stops a deny, and writes nothing',
        async (number) => {
            await using stores = await makeTestStores()
            const { copy, device } = await setUp(
                stores,
                `{"denyList": ["Locked"], "version": ${number}}`
            )

            expect(
                await rejectionOf(edit(device, { action: 'deny', path: 'Private' }, AGENT))
            ).toContain('is not a whole number')
            expect(await textOf(join(copy, 'edits.json'))).toBeNull()
        },
        60_000
    )

    test('a deny keeps every other key of the configuration, in the canonical form', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores, '{"version": 2, "denyList": ["Locked"], "a": "b"}')

        await edit(device, { action: 'deny', path: 'Private' }, AGENT)

        expect(await inStore(stores, 'configuration.json')).toBe(
            '{\n  "a": "b",\n  "denyList": [\n    "Locked",\n    "Private"\n  ],\n  "version": 2\n}\n'
        )
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
                    confirmProposal(
                        device,
                        { proposal: proposal.id, removes: [], affects: [], opens: [] },
                        run
                    )
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
            { proposal: proposal.id, removes: [], affects: [], opens: [] },
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
            confirmProposal(
                device,
                { proposal: proposal.id, removes: ['Mixed/Shown.md'], affects: [], opens: [] },
                AUTHOR
            )
        )

        expect(message).toContain('changed since the dialog showed them')
        expect(message).toContain('"Mixed/Other.md", "Mixed/Shown.md"')
        expect(await inStore(stores, 'configuration.json')).toBe(CONFIGURATION)
        // A new dialog shows the entries of now, and confirms with them.
        const review = await reviewProposal(device, proposal.id)
        expect(review).toEqual({
            proposal,
            removes: ['Mixed/Other.md', 'Mixed/Shown.md'],
            affects: [],
            opens: [],
            candidates: 0,
            inside: []
        })
        const confirmed = await confirmProposal(
            device,
            { proposal: proposal.id, removes: review.removes, affects: [], opens: [] },
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
            { proposal: proposal.id, removes: ['Notes/Public.md'], affects: [], opens: [] },
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
            { proposal: proposal.id, removes: [], affects: [], opens: [] },
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
                confirmProposal(
                    device,
                    { proposal: proposal.id, removes: [], affects: [], opens: [] },
                    AUTHOR
                )
            )
        ).toContain('does not exclude')
        expect((await guards(device)).proposals).toEqual([proposal])
    }, 60_000)
})

// Issue 120: the keys that the guards withdrew live in the content store, in
// `withdrawn.json`, so every deployment deletes them from the object storage.
describe('the withdrawn keys of the content store', () => {
    test('a withdrawn.json that is not valid stops status and plan, and names the file', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        await pushFiles(copy, { 'withdrawn.json': '{"keys": []}' })

        for (const run of [() => status(device), () => plan(device, { include: [] })]) {
            expect(await rejectionOf(run())).toContain(
                'withdrawn.json of the content store cannot be read'
            )
        }
    }, 60_000)

    test.each([
        ['edited', (copy: string) => writeFile(join(copy, 'withdrawn.json'), '{}\n')],
        ['removed', (copy: string) => rm(join(copy, 'withdrawn.json'))]
    ] as const)(
        'a withdrawn.json %s in the copy stops status, plan and publish',
        async (_name, change) => {
            await using stores = await makeTestStores()
            const { copy, device } = await setUp(stores)
            await pushFiles(copy, { 'withdrawn.json': `{"keys": ["${'a'.repeat(64)}"]}` })
            const planned = await plan(device, { include: ['Notes/Public.md'] })
            await change(copy)

            for (const run of [
                () => status(device),
                () => plan(device, { include: [] }),
                () => publish(device, planned.id, AUTHOR)
            ]) {
                expect(await rejectionOf(run())).toContain(
                    'are not the files of its last commit: withdrawn.json'
                )
            }
        },
        120_000
    )

    test('a withdrawn.json added to the copy and not committed stops status', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        await writeFile(join(copy, 'withdrawn.json'), `{"keys": ["${'a'.repeat(64)}"]}`)

        expect(await rejectionOf(status(device))).toContain(
            'are not the files of its last commit: withdrawn.json'
        )
    }, 60_000)
})
