import { describe, expect, test } from 'bun:test'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    copyFixtureVault,
    FIXTURE_NOTE_TYPES,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores
} from '@dsebastien-website/testing'
import type { TestStores } from '@dsebastien-website/testing'
import { NO_CHOICES, toggleRow, markUnpublish } from '../publishing/center.ts'
import { fileNoteTypes, nodeDevice, pullContentStore } from '../publishing/node/device.ts'
import { PublicationCenter } from './center.ts'

// The controller of the publication center (issue 39, R67): what the view
// starts, one activity at a time, with the run log and the report. It runs
// the operations of the logic on a real device: a copy of the fixture vault,
// a copy of the content store and an attachment storage made for the test.
// The view itself is checked by hand in Obsidian (section 18.1 of the spec).

const NOTE = '10 Garden/Frost dates explained.md'
const SECOND = '10 Garden/Compost basics.md'

async function git(...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { env: gitEnvironment(), stdout: 'pipe' })
    const out = await new Response(child.stdout).text()
    if ((await child.exited) !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
    }
    return out.trim()
}

interface Setup {
    readonly vault: string
    readonly copy: string
    readonly center: PublicationCenter
    /** The labels of the "started" messages of the publications. */
    readonly started: string[]
}

async function setUp(stores: TestStores, configured = true): Promise<Setup> {
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    let minute = 0
    const started: string[] = []
    const center = new PublicationCenter({
        device: () => {
            if (!configured) {
                throw new Error('Set the folder of the copy of the content store in the settings')
            }
            return nodeDevice({
                vault,
                contentStore: copy,
                attachmentStorage: stores.attachmentStorage,
                noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES)
            })
        },
        pull: () => pullContentStore({ contentStore: copy }),
        // A clock that the test drives: one minute per question.
        now: () => new Date(Date.UTC(2031, 3, 1, 8, minute++)),
        deviceName: 'garden-shed',
        started: (label) => {
            started.push(label)
        }
    })
    return { vault, copy, center, started }
}

const JOURNAL = join(
    '.obsidian',
    'plugins',
    'dsebastien-vault-publish',
    'renames',
    '00000000000000aa.jsonl'
)

describe('the publication center', () => {
    test('a check fills the four lists and says when it ran', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)

        await center.check()

        const { state } = center
        expect(state.activity).toBe('idle')
        expect(state.error).toBeUndefined()
        expect(state.queue?.new).toContain(NOTE)
        expect(state.queue?.counts.unchanged).toBe(0)
        expect(state.checkedAt?.toISOString()).toBe('2031-04-01T08:01:00.000Z')
        expect(state.log.map((line) => line.text)).toEqual([
            'Check started',
            `Check done: ${String(state.queue?.counts.new)} new, 0 changed, 0 to remove, 0 unchanged`
        ])
    }, 60_000)

    test('publishes the ticked notes, reports them with their addresses, and checks again', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, toggleRow(queue, choices, NOTE), SECOND))
        expect(center.label()).toBe('Publish: 2 new')

        await center.publish()

        const { state } = center
        expect(state.error).toBeUndefined()
        expect(state.report?.kind).toBe('publication')
        expect(state.report?.kind === 'publication' ? state.report.report.published : []).toEqual([
            SECOND,
            NOTE
        ])
        expect(state.report?.addresses).toEqual([
            {
                path: SECOND,
                url: 'https://notes.dsebastien.net/10+Garden/Compost+basics'
            },
            {
                path: NOTE,
                url: 'https://notes.dsebastien.net/10+Garden/Frost+dates+explained'
            }
        ])
        expect(state.queue?.unchanged).toEqual([SECOND, NOTE])
        expect(state.choices).toEqual(NO_CHOICES)
        expect(center.label()).toBe('Nothing to publish')
    }, 60_000)

    test('stops a publication whose plan is not the plan of the label, and publishes nothing', async () => {
        await using stores = await makeTestStores()
        const { vault, copy, center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()
        center.choose((queue, choices) => toggleRow(queue, choices, SECOND))
        expect(center.label()).toBe('Publish: 1 new')
        const head = await git('-C', copy, 'rev-parse', 'HEAD')
        // The published note is edited after the check.
        await writeFile(join(vault, NOTE), 'An edit after the check.\n')

        await center.publish()

        const { state } = center
        expect(state.report?.kind).toBe('publication')
        expect(state.report?.kind === 'publication' ? state.report.report.published : []).toEqual([
            NOTE
        ])
        expect(state.error).toBe(
            `The plan changed since the check, so nothing was published. The plan is now: Publish: 1 new, 1 update ("${SECOND}", "${NOTE}"). Check the lists and publish again.`
        )
        expect(state.dryRun?.plan).toMatchObject({ publish: [SECOND], update: [NOTE] })
        expect(await git('-C', copy, 'rev-parse', 'HEAD')).toBe(head)
        expect(state.queue?.changed).toEqual([NOTE])
    }, 60_000)

    test('stops a publication whose selection the vault no longer allows, and publishes nothing', async () => {
        await using stores = await makeTestStores()
        const { vault, copy, center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        const head = await git('-C', copy, 'rev-parse', 'HEAD')
        // The note goes away after the check.
        await rm(join(vault, NOTE))

        await center.publish()

        const { state } = center
        expect(state.report).toBeUndefined()
        expect(state.error).toBe(
            `The selection changed since the check, so nothing was published: "${NOTE}" does not exist in the vault as a note. A symbolic link and a name that starts with a dot are not part of the vault. Check the lists and publish again.`
        )
        expect(await git('-C', copy, 'rev-parse', 'HEAD')).toBe(head)
        expect(state.queue?.new).not.toContain(NOTE)
    }, 60_000)

    test('a dry run shows the plan and writes nothing', async () => {
        await using stores = await makeTestStores()
        const { vault, copy, center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        const head = await git('-C', copy, 'rev-parse', 'HEAD')
        const text = await Bun.file(join(vault, NOTE)).text()

        await center.dryRun()

        expect(center.state.dryRun?.plan.publish).toEqual([NOTE])
        expect(await git('-C', copy, 'rev-parse', 'HEAD')).toBe(head)
        expect(await git('-C', copy, 'status', '--porcelain')).toBe('')
        expect(await Bun.file(join(vault, NOTE)).text()).toBe(text)
    }, 60_000)

    test('unpublishes a marked note with the next publication', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()
        center.choose((queue, choices) => markUnpublish(queue, choices, NOTE))
        expect(center.label()).toBe('Publish: 1 removal')

        await center.publish()

        const { state } = center
        expect(state.report?.kind === 'publication' ? state.report.report.removed : []).toEqual([
            NOTE
        ])
        expect(state.queue?.new).toContain(NOTE)
    }, 60_000)

    test('takes a note down at once, and checks again', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()

        await center.takedown([NOTE])

        const { state } = center
        expect(state.error).toBeUndefined()
        expect(state.report?.kind === 'takedown' ? state.report.report.takenDown : []).toEqual([
            NOTE
        ])
        expect(state.queue?.new).toContain(NOTE)
    }, 60_000)

    test('a refused takedown changes nothing and says why', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()

        await center.takedown([NOTE])

        expect(center.state.report).toBeUndefined()
        expect(center.state.error).toContain('is the path of no manifest entry')
    }, 60_000)

    test('runs one activity at a time', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)

        const first = center.check()
        const second = center.check()
        expect(center.state.activity).toBe('checking')
        await Promise.all([first, second])

        expect(center.state.log.map((line) => line.text)).toContain(
            'Check refused: a check runs already'
        )
    }, 60_000)

    test('pulls a copy that is behind, then checks again', async () => {
        await using stores = await makeTestStores()
        const { copy, center } = await setUp(stores)
        const other = `${copy}-other`
        await git('clone', '--quiet', stores.contentStore, other)
        await git('-C', other, 'config', 'user.name', 'Another device')
        await git('-C', other, 'config', 'user.email', 'another@example.invalid')
        await writeFile(join(other, 'renames.json'), '{}\n')
        await git('-C', other, 'add', 'renames.json')
        await git('-C', other, 'commit', '--quiet', '--message', 'Publish')
        await git('-C', other, 'push', '--quiet', 'origin', 'HEAD:main')
        await center.check()
        expect(center.state.queue?.behind).toBe(1)

        await center.pull()

        expect(center.state.error).toBeUndefined()
        expect(center.state.queue?.behind).toBe(0)
    }, 60_000)

    test('a check while a run holds the lock fetches nothing and says why', async () => {
        await using stores = await makeTestStores()
        const { copy, center } = await setUp(stores)
        await mkdir(join(copy, '.git', 'vault-publish'), { recursive: true })
        await writeFile(join(copy, '.git', 'vault-publish', 'lock'), '{"command":"plan"}\n')
        const fetched = join(copy, '.git', 'FETCH_HEAD')

        await center.check()

        expect(center.state.error).toContain('a publication runs on this device')
        expect(await Bun.file(fetched).exists()).toBe(false)
    }, 60_000)

    test('takes a moved note down by its new path, before the move is published', async () => {
        await using stores = await makeTestStores()
        const { vault, center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()
        const moved = '10 Garden/Moved/Frost dates explained.md'
        await mkdir(join(vault, '10 Garden', 'Moved'), { recursive: true })
        await rename(join(vault, NOTE), join(vault, moved))
        await mkdir(join(vault, JOURNAL, '..'), { recursive: true })
        await writeFile(
            join(vault, JOURNAL),
            `{"from":"${NOTE}","kind":"note","time":"2031-04-02T08:00:00Z","to":"${moved}"}\n`
        )
        await center.check()
        expect(center.state.queue?.renamed).toEqual([{ from: NOTE, to: moved }])
        expect(center.storePathOf(moved)).toBe(NOTE)

        await center.takedown([moved])

        const { state } = center
        expect(state.error).toBeUndefined()
        expect(state.report?.kind === 'takedown' ? state.report.report.takenDown : []).toEqual([
            NOTE
        ])
        expect(state.queue?.new).toContain(moved)
    }, 60_000)

    test('a takedown asked during a publication that moves the note finds it at its new path', async () => {
        await using stores = await makeTestStores()
        const { vault, center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()
        const moved = '10 Garden/Moved/Frost dates explained.md'
        await mkdir(join(vault, '10 Garden', 'Moved'), { recursive: true })
        await rename(join(vault, NOTE), join(vault, moved))
        await mkdir(join(vault, JOURNAL, '..'), { recursive: true })
        await writeFile(
            join(vault, JOURNAL),
            `{"from":"${NOTE}","kind":"note","time":"2031-04-02T08:00:00Z","to":"${moved}"}\n`
        )
        await center.check()

        // The publication applies the move; the takedown waits for its end.
        const publishing = center.publish()
        const takingDown = center.takedown([moved])
        await Promise.all([publishing, takingDown])

        const { state } = center
        expect(state.error).toBeUndefined()
        expect(state.report?.kind === 'takedown' ? state.report.report.takenDown : []).toEqual([
            moved
        ])
        expect(state.queue?.new).toContain(moved)
    }, 60_000)

    test('publishes no ticked moved note that changed after the check', async () => {
        await using stores = await makeTestStores()
        const { vault, copy, center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()
        const moved = '10 Garden/Moved/Frost dates explained.md'
        await mkdir(join(vault, '10 Garden', 'Moved'), { recursive: true })
        await rm(join(vault, NOTE))
        await writeFile(join(vault, moved), 'Another text at the new path.\n')
        await mkdir(join(vault, JOURNAL, '..'), { recursive: true })
        await writeFile(
            join(vault, JOURNAL),
            `{"from":"${NOTE}","kind":"note","time":"2031-04-02T08:00:00Z","to":"${moved}"}\n`
        )
        await center.check()
        expect(center.state.queue?.movedEdited).toEqual([moved])
        center.choose((queue, choices) => toggleRow(queue, choices, moved))
        const head = await git('-C', copy, 'rev-parse', 'HEAD')
        center.noteChanged(moved)

        await center.publish()

        expect(center.state.error).toContain('changed after the check')
        expect(center.state.choices.include).toEqual([])
        expect(await git('-C', copy, 'rev-parse', 'HEAD')).toBe(head)
    }, 60_000)

    test('a takedown after a rename with no check finds the note where the content store has it', async () => {
        await using stores = await makeTestStores()
        const { vault, center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()
        const moved = '10 Garden/Moved/Frost dates explained.md'
        await mkdir(join(vault, '10 Garden', 'Moved'), { recursive: true })
        await rename(join(vault, NOTE), join(vault, moved))
        await mkdir(join(vault, JOURNAL, '..'), { recursive: true })
        await writeFile(
            join(vault, JOURNAL),
            `{"from":"${NOTE}","kind":"note","time":"2031-04-02T08:00:00Z","to":"${moved}"}\n`
        )
        // Obsidian reports the rename; no check ran since.
        center.noteChanged(moved)

        await center.takedown([moved])

        expect(center.state.error).toBeUndefined()
        expect(
            center.state.report?.kind === 'takedown' ? center.state.report.report.takenDown : []
        ).toEqual([NOTE])
    }, 60_000)

    test('a takedown asked during a check runs after it', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()

        const checking = center.check()
        const takingDown = center.takedown([NOTE])
        await Promise.all([checking, takingDown])

        expect(center.state.error).toBeUndefined()
        expect(
            center.state.report?.kind === 'takedown' ? center.state.report.report.takenDown : []
        ).toEqual([NOTE])
    }, 60_000)

    test('an activity that another one refuses says why', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()

        const checking = center.check()
        const planning = center.dryRun()
        await Promise.all([checking, planning])

        expect(center.state.error).toBe(
            'Dry run refused: a check runs already. Try again when it ends.'
        )
    }, 60_000)

    test('keeps the choices that the author made while a publication ran', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, SECOND))
        await center.publish()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))

        const publishing = center.publish()
        center.choose((queue, choices) => markUnpublish(queue, choices, SECOND))
        await publishing

        expect(center.state.choices.unpublish).toEqual([SECOND])
        expect(center.label()).toBe('Publish: 1 removal')
    }, 60_000)

    test('publishes no new note that changed after the check, and checks again', async () => {
        await using stores = await makeTestStores()
        const { copy, center, started } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        const head = await git('-C', copy, 'rev-parse', 'HEAD')
        // Another note at the same path, made after the check.
        center.noteChanged(NOTE)

        await center.publish()

        expect(center.state.report).toBeUndefined()
        expect(center.state.error).toBe(
            `A new note changed after the check, so nothing was published and its tick is gone: "${NOTE}". The lists are checked again: check them, tick again and publish.`
        )
        // A second click never publishes the other note unseen.
        expect(center.state.choices.include).toEqual([])
        expect(center.label()).toBe('Nothing to publish')
        expect(started).toEqual([])
        expect(await git('-C', copy, 'rev-parse', 'HEAD')).toBe(head)
        expect(center.stateOf(NOTE).label).toBe('Not published')
    }, 60_000)

    test('says that a publication started only when its plan is the plan of the label', async () => {
        await using stores = await makeTestStores()
        const { center, started } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))

        await center.publish()

        expect(started).toEqual(['Publish: 1 new'])
    }, 60_000)

    test('the corrections of the property after a publication are no edits', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()
        center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
        await center.publish()

        // Obsidian reports the write of the property after the check.
        center.noteChanged(NOTE)
        expect(center.stateOf(NOTE).label).toBe('Live')
        center.noteChanged(NOTE)
        expect(center.stateOf(NOTE).label).toBe('Live (edited since the check)')
    }, 60_000)

    test('a check that fails keeps the marks of the edits', async () => {
        await using stores = await makeTestStores()
        const { copy, center } = await setUp(stores)
        await center.check()
        center.noteChanged(NOTE)
        await mkdir(join(copy, '.git', 'vault-publish'), { recursive: true })
        await writeFile(join(copy, '.git', 'vault-publish', 'lock'), '{"command":"plan"}\n')

        await center.check()

        expect(center.state.error).toContain('a publication runs on this device')
        expect(center.stateOf(NOTE).label).toBe('Not published (edited since the check)')
    }, 60_000)

    test('removes the lock that a stopped run left, then checks again', async () => {
        await using stores = await makeTestStores()
        const { copy, center } = await setUp(stores)
        const lock = join(copy, '.git', 'vault-publish', 'lock')
        await mkdir(join(lock, '..'), { recursive: true })
        await writeFile(lock, '{"command":"publish"}\n')
        await center.check()
        expect(center.state.error).toContain('a publication runs on this device')

        await center.unlock()

        expect(await Bun.file(lock).exists()).toBe(false)
        expect(center.state.error).toBeUndefined()
        expect(center.state.queue?.new).toContain(NOTE)
    }, 60_000)

    test('says what is missing when the device has no settings', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores, false)

        await center.check()

        expect(center.state.activity).toBe('idle')
        expect(center.state.error).toContain('in the settings')
    }, 60_000)

    test('marks a note that changed after the check', async () => {
        await using stores = await makeTestStores()
        const { center } = await setUp(stores)
        await center.check()

        center.noteChanged(NOTE)

        expect(center.stateOf(NOTE).label).toBe('Not published (edited since the check)')
        await center.check()
        expect(center.stateOf(NOTE).label).toBe('Not published')
    }, 60_000)
})
