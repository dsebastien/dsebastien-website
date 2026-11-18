import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    rejectionOf,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from './node/device.ts'
import type { PublicationPlan, Selection } from './plan.ts'
import type { Device } from './ports.ts'
import type { PublicationQueue } from './queue.ts'
import { plan, publish, status } from './tool.ts'
import type { Run } from './tool.ts'

// The publication queue (issue 33): the four lists, the selection, the plan,
// the publication of updates and removals, and the correction of the state
// property. The scenarios are in `fixtures/canonical/queue.json`. The Rust
// tests run the same file (`cli/tests/queue.rs`), so both implementations must
// give what each step states.
const SCENARIOS = fileURLToPath(
    new URL('../../../../fixtures/canonical/queue.json', import.meta.url)
)

/** The lists of paths of a publication report. */
interface ReportLists {
    failed: readonly string[]
    forcedRemoved: readonly string[]
    propertyRemoved: readonly string[]
    propertySet: readonly string[]
    published: readonly string[]
    removed: readonly string[]
    skipped: readonly string[]
    updated: readonly string[]
    warnings: readonly string[]
}

type Files = Record<string, string | null>

type Step = { why: string } & (
    | { do: 'write'; files: Record<string, string> }
    | { do: 'delete'; paths: string[] }
    | { do: 'store'; files: Record<string, string> }
    | { do: 'status'; queue: PublicationQueue }
    | { do: 'plan'; selection: Selection; plan?: PublicationPlan; refused?: true }
    | { do: 'publish'; selection: Selection; time: string; report: ReportLists }
    | { do: 'expect'; vault: Files; store: Files }
)

interface Scenario {
    name: string
    denyList: string[]
    vault: Record<string, string>
    steps: Step[]
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const { scenarios } = (await Bun.file(SCENARIOS).json()) as { scenarios: Scenario[] }

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

/** Commits every change of the copy and pushes it, as another device would. */
async function commitAll(copy: string): Promise<void> {
    await git(copy, 'add', '--all')
    await git(copy, 'commit', '--quiet', '--message', 'A change of another device')
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
}

/** Another device: it writes files into the content store and pushes them. */
async function pushToStore(copy: string, files: Record<string, string>): Promise<void> {
    await writeFiles(copy, files)
    await git(copy, 'add', '--', ...Object.keys(files))
    await git(copy, 'commit', '--quiet', '--message', 'A change of another device')
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
}

/** The text of a file, or `null` when the file does not exist. */
async function textOf(path: string): Promise<string | null> {
    const file = Bun.file(path)
    if (!(await file.exists())) {
        return null
    }
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await file.bytes())
}

describe.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    'scenario of the publication queue: %s',
    (_name, scenario) => {
        test('every step gives what the shared file states', async () => {
            await using stores = await makeTestStores()
            const vault = join(stores.root, 'vault')
            await mkdir(vault)
            await writeFiles(vault, scenario.vault)
            const copy = await makeContentStoreCopy(stores)
            await pushToStore(copy, {
                'configuration.json': JSON.stringify({ denyList: scenario.denyList })
            })
            const device = nodeDevice({ vault, contentStore: copy })

            for (const [index, step] of scenario.steps.entries()) {
                const label = `step ${String(index + 1)}: ${step.why}`
                if (step.do === 'write') {
                    await writeFiles(vault, step.files)
                } else if (step.do === 'delete') {
                    for (const path of step.paths) {
                        await rm(join(vault, path))
                    }
                } else if (step.do === 'store') {
                    await pushToStore(copy, step.files)
                } else if (step.do === 'status') {
                    expect(await status(device), label).toEqual(step.queue)
                } else if (step.do === 'plan') {
                    if (step.refused === true) {
                        expect(await rejectionOf(plan(device, step.selection)), label).not.toBe('')
                    } else {
                        expect((await plan(device, step.selection)).plan, label).toEqual(
                            step.plan ?? { forcedRemove: [], publish: [], update: [], remove: [] }
                        )
                    }
                } else if (step.do === 'publish') {
                    const planned = await plan(device, step.selection)
                    const report = await publish(device, planned.id, {
                        time: step.time,
                        device: 'garden-shed',
                        face: 'plugin'
                    })
                    const lists: ReportLists = {
                        ...report,
                        failed: report.failed.map((entry) => entry.path),
                        warnings: report.warnings.map((entry) => entry.path)
                    }
                    expect(lists, label).toEqual(step.report)
                } else {
                    for (const [path, text] of Object.entries(step.vault)) {
                        expect(await textOf(join(vault, path)), `${label}: ${path}`).toBe(text)
                    }
                    for (const [path, text] of Object.entries(step.store)) {
                        expect(await textOf(join(copy, path)), `${label}: ${path}`).toBe(text)
                    }
                }
            }
        }, 120_000)
    }
)

describe('shared scenarios of the publication queue', () => {
    test('the file has scenarios with steps of each kind', () => {
        const kinds = new Set(
            scenarios.flatMap((scenario) => scenario.steps.map((step) => step.do))
        )
        expect([...kinds].sort()).toEqual([
            'delete',
            'expect',
            'plan',
            'publish',
            'status',
            'store',
            'write'
        ])
        expect(scenarios.length).toBeGreaterThanOrEqual(3)
    })
})

// The rest goes through the fixture vault. The Rust tests state the same
// expected texts (`cli/tests/queue.rs`). The hashes were computed with
// `sha256sum`, not with this code.

const NOTE = '10 Garden/Frost dates explained.md'
const SECOND = '10 Garden/Compost basics.md'
const TIME = '2031-04-01T08:00:00Z'
const LATER = '2031-04-02T09:00:00Z'
const RUN: Run = { time: TIME, device: 'garden-shed', face: 'plugin' }
const NOTE_ID = '203d446940c02032'
const SECOND_ID = 'd0fd5a0726f54141'

// The note with one more line, and the hash of that text.
const EDIT = '\nA second paragraph.\n'
// The hash of the second note.
const SECOND_HASH = 'sha256:bcd6b6e0fe725e19061691651bd572fa6c592774832ed25732644e51e8114c36'
const EDITED_HASH = 'sha256:ae719597cce4e0bc1f415607af4723afb0a28eb9fa09c45179bc0aca4a53605c'

interface Setup {
    vault: string
    copy: string
    device: Device
}

async function setUp(stores: TestStores): Promise<Setup> {
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    return { vault, copy, device: nodeDevice({ vault, contentStore: copy }) }
}

async function publishNotes(setup: Setup, selection: Selection, run: Run = RUN) {
    const planned = await plan(setup.device, selection)
    return await publish(setup.device, planned.id, run)
}

async function append(path: string, text: string): Promise<void> {
    await writeFile(path, (await Bun.file(path).text()) + text)
}

/** Every file of a folder with a hash of its bytes: a picture to compare before and after. */
async function picture(folder: string): Promise<Record<string, string>> {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true })
    const files: Record<string, string> = {}
    for (const entry of entries) {
        const path = join(entry.parentPath, entry.name)
        if (entry.isFile()) {
            const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(path).bytes())
            files[path.slice(folder.length + 1)] = hash.digest('hex')
        }
    }
    return files
}

function hashOf(text: string): string {
    return `sha256:${new Bun.CryptoHasher('sha256').update(text).digest('hex')}`
}

describe('status of the fixture vault', () => {
    test('lists every candidate, and no note under a guard', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)

        const queue = await status(device)

        expect(queue.new).toContain(NOTE)
        expect(queue.new).toContain('Welcome.md')
        expect(queue.counts).toEqual({
            changed: 0,
            new: queue.new.length,
            toRemove: 0,
            unchanged: 0
        })
        // The guards: two folders of the deny list, and the ignore property.
        expect(queue.new.filter((path) => path.startsWith('80 Templates/'))).toEqual([])
        expect(queue.new.filter((path) => path.startsWith('90 Locked Shed/'))).toEqual([])
        expect(queue.new).not.toContain('10 Garden/Neighbour dispute.md')
        // Only notes: no attachment, no canvas.
        expect(queue.new.filter((path) => !path.endsWith('.md'))).toEqual([])
    })

    test('writes nothing into the vault and into the copy of the content store', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE] })
        const before = { vault: await picture(setup.vault), copy: await picture(setup.copy) }

        await status(setup.device)

        expect(await picture(setup.vault)).toEqual(before.vault)
        expect(await picture(setup.copy)).toEqual(before.copy)
    })

    test('stops when a note cannot be read, and names it', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(setup.vault, '10 Garden/Broken.md'), Uint8Array.from([0xff, 0xfe]))

        expect(await rejectionOf(status(setup.device))).toContain('10 Garden/Broken.md')
    })

    test('stops when the deny list names no folder of the vault', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await rm(join(setup.vault, '90 Locked Shed'), { recursive: true })

        expect(await rejectionOf(status(setup.device))).toContain('90 Locked Shed')
    })
})

describe('manifest that cannot be trusted', () => {
    const ENTRY = {
        attachments: [],
        cleanedHash: 'sha256:00',
        cleaningVersion: 2,
        firstPublished: TIME,
        formerPaths: [],
        id: '00000000000000aa',
        lastPublished: TIME,
        links: [],
        path: 'Welcome.md',
        sourceHash: 'sha256:00',
        state: 'published'
    }
    const cases: [string, Record<string, string>][] = [
        [
            'a path that leaves the notes',
            {
                'manifest/00000000000000aa.json': JSON.stringify({
                    ...ENTRY,
                    path: '../Welcome.md'
                })
            }
        ],
        [
            'a path that is not a note',
            { 'manifest/00000000000000aa.json': JSON.stringify({ ...ENTRY, path: 'Welcome' }) }
        ],
        [
            'an id that is not 16 hexadecimal digits',
            { 'manifest/x.json': JSON.stringify({ ...ENTRY, id: '../../x' }) }
        ],
        [
            'a file that does not have the name of its entry',
            { 'manifest/00000000000000bb.json': JSON.stringify(ENTRY) }
        ],
        [
            'two entries with the same path',
            {
                'manifest/00000000000000aa.json': JSON.stringify(ENTRY),
                'manifest/00000000000000bb.json': JSON.stringify({
                    ...ENTRY,
                    id: '00000000000000bb'
                })
            }
        ],
        [
            'a state that the tool does not know',
            { 'manifest/00000000000000aa.json': JSON.stringify({ ...ENTRY, state: 'live' }) }
        ],
        ['a file that is not JSON', { 'manifest/00000000000000aa.json': 'not JSON' }],
        [
            'an entry without its links',
            {
                'manifest/00000000000000aa.json': JSON.stringify({ ...ENTRY, links: undefined })
            }
        ],
        [
            'links that are not a list',
            { 'manifest/00000000000000aa.json': JSON.stringify({ ...ENTRY, links: {} }) }
        ],
        [
            'a link whose target is not the vault path of a note',
            {
                'manifest/00000000000000aa.json': JSON.stringify({
                    ...ENTRY,
                    links: [{ link: 'Up', path: '../Up.md' }]
                })
            }
        ],
        [
            'a link without its link path',
            {
                'manifest/00000000000000aa.json': JSON.stringify({
                    ...ENTRY,
                    links: [{ path: 'Welcome.md' }]
                })
            }
        ],
        [
            'a link with a member that the tool does not know',
            {
                'manifest/00000000000000aa.json': JSON.stringify({
                    ...ENTRY,
                    links: [{ link: 'Welcome', path: 'Welcome.md', title: 'Welcome' }]
                })
            }
        ]
    ]

    test.each(cases)('%s stops the status and the plan', async (_name, files) => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await pushToStore(setup.copy, files)

        expect(await rejectionOf(status(setup.device))).toContain('manifest')
        expect(await rejectionOf(plan(setup.device, { include: [] }))).toContain('manifest')
    })
})

describe('manifest in a form that only one reader of JSON would take', () => {
    const entry = (version: string, formerPaths = '[]'): string =>
        `{"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":${version},"firstPublished":"${TIME}","formerPaths":${formerPaths},"id":"00000000000000aa","lastPublished":"${TIME}","links":[],"path":"Welcome.md","sourceHash":"sha256:00","state":"published"}`

    // A whole number in another form is the same number for both implementations.
    test.each(['1.0', '1e0', '-0'])('a version that is written as %s is read', async (version) => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await pushToStore(setup.copy, { 'manifest/00000000000000aa.json': entry(version) })

        expect((await status(setup.device)).changed).toEqual(['Welcome.md'])
    })

    test.each([
        ['a version with a fraction', entry('1.5')],
        ['a negative version', entry('-1')],
        ['half of a surrogate pair in a text', entry('1', String.raw`["\ud800"]`)]
    ])('%s stops the status', async (_name, text) => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await pushToStore(setup.copy, { 'manifest/00000000000000aa.json': text })

        expect(await rejectionOf(status(setup.device))).toContain('manifest')
    })

    test('a configuration with a number that is too large stops the status', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await pushToStore(setup.copy, { 'configuration.json': '{"denyList":[],"x":1e999}' })

        expect(await rejectionOf(status(setup.device))).toContain('configuration.json')
    })

    test.skipIf(process.platform === 'win32')(
        'a symbolic link in the manifest is not a file of the store',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            await mkdir(join(setup.copy, 'manifest'))
            await symlink(join(setup.vault, 'Welcome.md'), join(setup.copy, 'manifest/link.json'))
            await commitAll(setup.copy)

            expect((await status(setup.device)).counts.unchanged).toBe(0)
        }
    )

    // The manifest has one level: a folder below it is not read.
    test.skipIf(process.platform === 'win32')(
        'a symbolic link to a folder in the manifest is not read',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            const elsewhere = join(stores.root, 'elsewhere')
            await mkdir(elsewhere)
            await writeFile(join(elsewhere, 'x.json'), '{}\n')
            await mkdir(join(setup.copy, 'manifest'))
            await symlink(elsewhere, join(setup.copy, 'manifest/sub'))
            await commitAll(setup.copy)

            expect((await status(setup.device)).counts.unchanged).toBe(0)
        }
    )

    // A configuration that is a link could lead to nothing, and be read as no
    // configuration: the deny list would be empty.
    test.skipIf(process.platform === 'win32')(
        'a configuration that is a symbolic link stops the status, also when it leads nowhere',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            const file = join(setup.copy, 'configuration.json')
            const elsewhere = join(stores.root, 'configuration.json')
            await writeFile(elsewhere, await Bun.file(file).text())
            await rm(file)
            await symlink(elsewhere, file)
            await commitAll(setup.copy)

            expect(await rejectionOf(status(setup.device))).toContain('symbolic link')

            await rm(elsewhere)

            expect(await rejectionOf(status(setup.device))).toContain('symbolic link')
        }
    )

    // A manifest that is missing from the copy would let a published note
    // under a guard stay live: also a file that git skips, which git status
    // does not show, and a configuration that is missing.
    test('a file of the manifest or the configuration that is missing from the copy stops the status', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE] })
        await git(setup.copy, 'update-index', '--skip-worktree', `manifest/${NOTE_ID}.json`)
        await rm(join(setup.copy, 'manifest'), { recursive: true })
        expect(await git(setup.copy, 'status', '--porcelain')).toBe('')

        expect(await rejectionOf(status(setup.device))).toContain('last commit')

        await git(setup.copy, 'update-index', '--no-skip-worktree', `manifest/${NOTE_ID}.json`)
        await git(setup.copy, 'checkout', '--', 'manifest')
        await rm(join(setup.copy, 'configuration.json'))

        expect(await rejectionOf(status(setup.device))).toContain('last commit')
    })

    /** A valid entry of a note that is not published: only a check of the files of the copy refuses it. */
    const UNPUBLISHED_ENTRY = (id: string): string =>
        `{"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":2,"firstPublished":"2031-04-01T08:00:00Z","formerPaths":[],"id":"${id}","lastPublished":"2031-04-01T08:00:00Z","links":[],"path":"Welcome.md","sourceHash":"sha256:00","state":"unpublished"}`

    // Git for Windows converts line ends by default (`core.autocrlf`). A file
    // that differs from the commit only in its line ends is the same file.
    test('a copy that converts line ends is the copy of its last commit', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE] })
        await git(setup.copy, 'config', 'core.autocrlf', 'true')
        await rm(join(setup.copy, 'manifest'), { recursive: true })
        await rm(join(setup.copy, 'configuration.json'))
        await git(setup.copy, 'checkout', '--', 'configuration.json', 'manifest')
        expect(await Bun.file(join(setup.copy, 'configuration.json')).text()).toContain('\r\n')
        const later = new Date(Date.now() + 5000)
        for (const file of ['configuration.json', `manifest/${NOTE_ID}.json`]) {
            await utimes(join(setup.copy, file), later, later)
        }

        expect((await status(setup.device)).unchanged).toEqual([NOTE])
    })

    // The tool reads the state from the files of the copy. Every way that
    // they can differ from the last commit could hide a published note under
    // a guard or empty the deny list, so each one stops the run.
    test.each([
        [
            'an entry removed with git',
            (copy: string) => git(copy, 'rm', '--quiet', `manifest/${NOTE_ID}.json`)
        ],
        [
            'an entry whose text says another state',
            async (copy: string) => {
                const file = join(copy, 'manifest', `${NOTE_ID}.json`)
                await writeFile(
                    file,
                    (await Bun.file(file).text()).replace('"published"', '"unpublished"')
                )
            }
        ],
        [
            'a folder in the place of an entry',
            async (copy: string) => {
                await rm(join(copy, 'manifest', `${NOTE_ID}.json`))
                await mkdir(join(copy, 'manifest', `${NOTE_ID}.json`))
            }
        ],
        [
            'no index, and an entry removed',
            async (copy: string) => {
                await rm(join(copy, '.git', 'index'))
                await rm(join(copy, 'manifest', `${NOTE_ID}.json`))
            }
        ],
        [
            'an entry that git assumes unchanged, and that is removed',
            async (copy: string) => {
                await git(copy, 'update-index', '--assume-unchanged', `manifest/${NOTE_ID}.json`)
                await rm(join(copy, 'manifest', `${NOTE_ID}.json`))
            }
        ],
        [
            'an entry that is not in the last commit',
            (copy: string) =>
                writeFile(
                    join(copy, 'manifest', '00000000000000aa.json'),
                    `${UNPUBLISHED_ENTRY('00000000000000aa')}\n`
                )
        ],
        [
            'an entry that git ignores',
            async (copy: string) => {
                await writeFile(
                    join(copy, '.git', 'info', 'exclude'),
                    'manifest/00000000000000ab.json\n'
                )
                await writeFile(
                    join(copy, 'manifest', '00000000000000ab.json'),
                    `${UNPUBLISHED_ENTRY('00000000000000ab')}\n`
                )
            }
        ],
        [
            'the configuration removed with git',
            (copy: string) => git(copy, 'rm', '--quiet', 'configuration.json')
        ],
        [
            'a branch that leads to no commit',
            (copy: string) =>
                writeFile(join(copy, '.git', 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`)
        ],
        [
            'a new branch with no commit and no files',
            async (copy: string) => {
                await git(copy, 'checkout', '--quiet', '--orphan', 'fresh')
                await git(copy, 'rm', '-r', '--quiet', '--cached', '.')
                for (const path of ['manifest', 'notes', 'configuration.json']) {
                    await rm(join(copy, path), { recursive: true })
                }
            }
        ]
    ] as const)(
        'a copy that differs from its last commit stops the status: %s',
        async (_name, change) => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            await publishNotes(setup, { include: [NOTE] })
            await writeFile(
                join(setup.vault, NOTE),
                '---\npublish_ignore: true\n---\nA text that must never go out\n'
            )

            await change(setup.copy)

            expect(await rejectionOf(status(setup.device))).not.toBe('')
        }
    )

    // A change of the deny list is work of the author. The message must not
    // propose a command that throws it away.
    test('a deny list that is changed and not committed stops the status, and the message says to commit it', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(setup.copy, 'configuration.json'), '{"denyList":["80 Templates"]}\n')

        const message = await rejectionOf(status(setup.device))

        expect(message).toContain('commit configuration.json')
        expect(message).not.toContain('checkout HEAD -- manifest')
    })

    // An empty manifest would let a published note under a guard stay live.
    test('a manifest that cannot be listed stops the status', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(setup.copy, 'manifest'), 'A file in the place of the folder\n')

        expect(await rejectionOf(status(setup.device))).toContain('manifest')
    })

    test.skipIf(process.platform === 'win32')(
        'a manifest folder that is a symbolic link stops the status',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            const elsewhere = join(stores.root, 'elsewhere')
            await mkdir(elsewhere)
            await writeFile(join(elsewhere, 'x.json'), '{}\n')
            await symlink(elsewhere, join(setup.copy, 'manifest'))
            await commitAll(setup.copy)

            expect(await rejectionOf(status(setup.device))).toContain('symbolic link')
        }
    )
})

describe('plan and what it shows', () => {
    // TEST-22: the review holds. The record of the plan holds the hash of each
    // cleaned note, and the publication writes exactly that text.
    test('the cleaned notes after a publication equal the text that the plan showed', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE] })
        await append(join(setup.vault, NOTE), EDIT)

        const planned = await plan(setup.device, { include: [SECOND] })
        const record = (await Bun.file(
            join(setup.copy, '.git', 'vault-publish', 'plans', `${planned.id}.json`)
        ).json()) as { state: { notes: { path: string; cleanedHash: string }[] } }
        await publish(setup.device, planned.id, { ...RUN, time: LATER })

        expect(record.state.notes.map((note) => note.path)).toEqual([SECOND, NOTE])
        for (const note of record.state.notes) {
            const cleaned = await Bun.file(join(setup.copy, 'notes', note.path)).text()
            expect(hashOf(cleaned), note.path).toBe(note.cleanedHash)
        }
        expect(record.state.notes[0]?.cleanedHash).toBe(SECOND_HASH)
        expect(record.state.notes[1]?.cleanedHash).toBe(EDITED_HASH)
    })

    test('a published note that is edited after a plan without paths makes the plan stale', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE, SECOND] })
        await append(join(setup.vault, NOTE), EDIT)
        const planned = await plan(setup.device, { include: [] })
        // The plan did not show this change, so it cannot publish it (PUB-53).
        await append(join(setup.vault, SECOND), EDIT)

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('stale')
        expect(await Bun.file(join(setup.copy, 'notes', NOTE)).text()).not.toContain(
            'A second paragraph.'
        )
    })

    test('a new candidate after the plan does not make the plan stale', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        await writeFile(join(setup.vault, '10 Garden/A new idea.md'), 'An idea\n')

        const report = await publish(setup.device, planned.id, RUN)

        expect(report.published).toEqual([NOTE])
    })
})

describe('commit of a publication of the queue', () => {
    // PUB-29: the counts, the device, the face and the number of skipped entries.
    test('has a message with the counts, the device and the face', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE, SECOND, 'Welcome.md'] })
        await append(join(setup.vault, NOTE), EDIT)
        await append(join(setup.vault, SECOND), EDIT)

        await publishNotes(
            setup,
            { include: ['10 Garden/Bean trellis.md'], hold: [SECOND], remove: ['Welcome.md'] },
            { time: LATER, device: 'garden-shed', face: 'mcp-server' }
        )

        expect(await git(setup.copy, 'log', '-1', '--format=%B')).toBe(
            'Publish: 1 new, 1 updated, 1 removed, 0 forced, 1 skipped\n\nDevice: garden-shed\nFace: mcp-server'
        )
        // One commit, and the content store has it.
        expect(await git(setup.copy, 'rev-list', '--count', 'HEAD')).toBe('3')
        expect(await git(stores.contentStore, 'rev-parse', 'main')).toBe(
            await git(setup.copy, 'rev-parse', 'HEAD')
        )
        expect(await git(setup.copy, 'status', '--porcelain')).toBe('')
    })

    test('refuses a device name that is not one line, and a face that the tool does not have', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        const attempt = async (run: Run): Promise<string> =>
            await rejectionOf(publish(setup.device, planned.id, run))

        expect(await attempt({ ...RUN, device: 'shed\nFace: plugin' })).toContain('device')
        expect(await attempt({ ...RUN, device: ' ' })).toContain('device')
        // A face comes from outside the types when a face of the tool passes a text.
        expect(await attempt({ ...RUN, face: 'robot' as Run['face'] })).toContain('face')
        expect(await git(setup.copy, 'rev-list', '--count', 'HEAD')).toBe('1')
    })

    // One line with something to read: the old rules of the two
    // implementations differed on these names, and both take them now.
    test.each([String.fromCharCode(0xfeff), String.fromCharCode(0xa0)])(
        'takes a device name of one character that is not a space: %p',
        async (name) => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)

            await publishNotes(setup, { include: [NOTE] }, { ...RUN, device: name })

            expect(await git(setup.copy, 'log', '-1', '--format=%B')).toContain(
                `\nDevice: ${name}\n`
            )
        }
    )

    // A note name can hold the characters of a git pattern.
    test('holds only the files of the publication when a note name is a pattern for git', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const pattern = '10 Garden/Beds [ab].md'
        await writeFile(join(setup.vault, pattern), 'Beds\n')
        // A file of the copy that the pattern would name, and that no publication wrote.
        await mkdir(join(setup.copy, 'notes/10 Garden'), { recursive: true })
        await writeFile(join(setup.copy, 'notes/10 Garden/Beds a.md'), 'Not of this publication\n')

        await publishNotes(setup, { include: [pattern] })

        const files = await git(setup.copy, 'show', '--name-only', '--format=', 'HEAD')
        expect(files.split('\n').filter((file) => file.startsWith('notes/'))).toEqual([
            'notes/10 Garden/Beds [ab].md'
        ])
    })
})

describe('git commands of a publication', () => {
    // The paths go to git on standard input. A file for them was relative to
    // the folder of the process, but git runs inside the copy.
    test('a copy of the content store in a relative folder takes new notes and updates', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const device = nodeDevice({
            vault: setup.vault,
            contentStore: relative(process.cwd(), setup.copy)
        })
        let planned = await plan(device, { include: [NOTE, 'Welcome.md'] })
        await publish(device, planned.id, RUN)
        await append(join(setup.vault, 'Welcome.md'), EDIT)
        planned = await plan(device, { include: [SECOND] })

        const report = await publish(device, planned.id, { ...RUN, time: LATER })

        expect(report.published).toEqual([SECOND])
        expect(report.updated).toEqual(['Welcome.md'])
        expect(await git(setup.copy, 'status', '--porcelain')).toBe('')
        expect(await git(stores.contentStore, 'rev-list', '--count', 'main')).toBe('3')
        expect((await status(device)).unchanged).toEqual([SECOND, NOTE, 'Welcome.md'])
    })

    // The paths of this commit are more than the system takes as arguments
    // of one command (about 2 MB on Linux). The Rust test goes through a whole
    // publication of that size.
    test.skipIf(process.platform === 'win32')(
        'a commit larger than the limit of the system for arguments is possible',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            const long = 'x'.repeat(230)
            const paths = Array.from(
                { length: 9000 },
                (_, index) =>
                    `notes/Big ${String(Math.floor(index / 100)).padStart(2, '0')}/${String(index).padStart(4, '0')} ${long}.md`
            )
            expect(paths.reduce((sum, path) => sum + path.length, 0)).toBeGreaterThan(
                2 * 1024 * 1024
            )
            await writeFiles(setup.copy, Object.fromEntries(paths.map((path) => [path, 'Text\n'])))

            await setup.device.store.commitAndPush('A large commit', paths)

            expect(await git(setup.copy, 'status', '--porcelain')).toBe('')
            const files = await git(stores.contentStore, 'ls-tree', '-r', '--name-only', 'main')
            expect(files.split('\n').filter((file) => file.startsWith('notes/Big')).length).toBe(
                9000
            )
        },
        120_000
    )

    // Two publications on one copy must not share a file of paths.
    test('needs no file of paths in the git folder', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await mkdir(join(setup.copy, '.git', 'vault-publish', 'paths'), { recursive: true })

        const report = await publishNotes(setup, { include: [NOTE] })

        expect(report.published).toEqual([NOTE])
        expect(await git(setup.copy, 'status', '--porcelain')).toBe('')
    })
})

describe('commit that fails', () => {
    /** A hook of the copy that refuses every commit. */
    async function refuseCommits(copy: string): Promise<void> {
        const hook = join(copy, '.git', 'hooks', 'pre-commit')
        await mkdir(join(copy, '.git', 'hooks'), { recursive: true })
        await writeFile(hook, '#!/bin/sh\nexit 1\n')
        await chmod(hook, 0o755)
    }

    // Files that stay in the copy would be read as published at the next run.
    test('leaves nothing in the copy, and the note is not read as published', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: ['Welcome.md'] })
        await append(join(setup.vault, 'Welcome.md'), EDIT)
        await refuseCommits(setup.copy)
        const before = {
            vault: await picture(setup.vault),
            store: await git(setup.copy, 'ls-files', '--stage')
        }
        const planned = await plan(setup.device, { include: [NOTE] })

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('commit')

        expect(await git(setup.copy, 'status', '--porcelain')).toBe('')
        expect(await git(setup.copy, 'ls-files', '--stage')).toBe(before.store)
        expect(await Bun.file(join(setup.copy, 'notes', NOTE)).exists()).toBe(false)
        expect(await Bun.file(join(setup.copy, 'notes/Welcome.md')).text()).not.toContain(
            'A second paragraph.'
        )
        expect(await picture(setup.vault)).toEqual(before.vault)
        const queue = await status(setup.device)
        expect(queue.new).toContain(NOTE)
        expect(queue.changed).toEqual(['Welcome.md'])
        expect(queue.unchanged).toEqual([])
    })

    test('leaves nothing in a copy that has no commit', async () => {
        await using stores = await makeTestStores()
        const vault = await copyFixtureVault(stores)
        // A clone of a content store that has no commit and no configuration.
        const copy = await makeContentStoreCopyOf(stores, 'copy')
        await refuseCommits(copy)
        const device = nodeDevice({ vault, contentStore: copy })
        const planned = await plan(device, { include: ['Welcome.md'] })

        expect(await rejectionOf(publish(device, planned.id, RUN))).toContain('commit')

        expect(await git(copy, 'status', '--porcelain')).toBe('')
        expect((await status(device)).unchanged).toEqual([])
    })

    /** Every file of the copy but its git folder, with a hash of its bytes. */
    async function filesOf(copy: string): Promise<Record<string, string>> {
        return Object.fromEntries(
            Object.entries(await picture(copy)).filter(([path]) => !path.startsWith('.git/'))
        )
    }

    // A step of the undo that fails must not stop the later steps. Here git
    // cannot write its index, so neither the commit nor its undo can use it.
    test('puts every file back when git cannot write its index', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: ['Welcome.md'] })
        await append(join(setup.vault, 'Welcome.md'), EDIT)
        const planned = await plan(setup.device, { include: [NOTE] })
        await writeFile(join(setup.copy, '.git', 'index.lock'), '')
        const before = await filesOf(setup.copy)

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('commit')

        expect(await filesOf(setup.copy)).toEqual(before)
        await rm(join(setup.copy, '.git', 'index.lock'))
        expect(await git(setup.copy, 'status', '--porcelain')).toBe('')
        const queue = await status(setup.device)
        expect(queue.new).toContain(NOTE)
        expect(queue.changed).toEqual(['Welcome.md'])
    })

    // With no commit, a file of the copy is not new for the publication only
    // because no commit holds it. A copy whose manifest or configuration is
    // in no commit stops before (see "a copy that differs from its last
    // commit"), so here it is a cleaned note that waits in the copy.
    test('keeps the files that a copy with no commit held before', async () => {
        await using stores = await makeTestStores()
        const vault = await copyFixtureVault(stores)
        const copy = await makeContentStoreCopyOf(stores, 'copy')
        await mkdir(join(copy, 'notes'))
        await writeFile(join(copy, 'notes', 'Welcome.md'), 'A text that was here before\n')
        await refuseCommits(copy)
        const device = nodeDevice({ vault, contentStore: copy })
        const before = await filesOf(copy)
        const planned = await plan(device, { include: ['Welcome.md'] })

        expect(await rejectionOf(publish(device, planned.id, RUN))).toContain('commit')

        expect(await filesOf(copy)).toEqual(before)
    })

    // The undo takes back the paths of the publication only.
    test('keeps the other staged work of the copy', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(setup.copy, 'README.md'), 'Staged\n')
        await git(setup.copy, 'add', 'README.md')
        await writeFile(join(setup.copy, 'README.md'), 'Staged, then edited\n')
        await refuseCommits(setup.copy)
        const planned = await plan(setup.device, { include: [NOTE] })

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('commit')

        expect(await git(setup.copy, 'status', '--porcelain')).toBe('AM README.md')
        expect(await git(setup.copy, 'show', ':README.md')).toBe('Staged')
    })

    test('keeps the other staged work of the copy after a refused push', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        const other = await makeContentStoreCopyOf(stores, 'other-device')
        await pushToStore(other, { 'other.txt': 'Pushed first\n' })
        await writeFile(join(setup.copy, 'README.md'), 'Staged\n')
        await git(setup.copy, 'add', 'README.md')
        const head = await git(setup.copy, 'rev-parse', 'HEAD')

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('refused')

        expect(await git(setup.copy, 'rev-parse', 'HEAD')).toBe(head)
        expect(await git(setup.copy, 'status', '--porcelain')).toBe('A  README.md')
        expect(await Bun.file(join(setup.copy, 'notes', NOTE)).exists()).toBe(false)
    })

    // A push that fails, and an undo whose first step fails: git cannot move
    // the branch back (a hook stands for a lock of the reference). The second
    // step still runs, and the commit that stayed stops the next run: it
    // would else be pushed later, also for a note that came under a guard.
    test.skipIf(process.platform === 'win32')(
        'a commit that git cannot take back stops the next run',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            await publishNotes(setup, { include: ['Welcome.md'] })
            const before = await git(setup.copy, 'rev-parse', 'HEAD')
            const hooks = join(setup.copy, '.git', 'hooks')
            await mkdir(hooks, { recursive: true })
            await writeFile(join(hooks, 'post-commit'), '#!/bin/sh\ntouch .git/committed\n')
            await writeFile(
                join(hooks, 'reference-transaction'),
                '#!/bin/sh\nif [ "$1" = prepared ] && [ -f .git/committed ]; then exit 1; fi\nexit 0\n'
            )
            await chmod(join(hooks, 'post-commit'), 0o755)
            await chmod(join(hooks, 'reference-transaction'), 0o755)
            await git(
                setup.copy,
                'remote',
                'set-url',
                '--push',
                'origin',
                join(stores.root, 'nowhere')
            )
            const planned = await plan(setup.device, { include: [NOTE] })

            const message = await rejectionOf(publish(setup.device, planned.id, RUN))

            expect(message).toContain('refused')
            expect(message).toContain('could not take the publication back')
            expect(await git(setup.copy, 'rev-parse', 'HEAD')).not.toBe(before)
            // The second step ran: the index holds the files of before.
            expect(await git(setup.copy, 'diff', '--cached', '--name-only', before)).toBe('')
            expect(await Bun.file(join(setup.copy, 'notes', NOTE)).exists()).toBe(false)
            await rm(join(hooks, 'reference-transaction'))
            expect(await rejectionOf(status(setup.device))).toContain('does not have')
            expect(await rejectionOf(plan(setup.device, { include: [] }))).toContain(
                'does not have'
            )
        }
    )

    // The same on a first publication: git cannot remove the branch that
    // the failed publication made, and the content store has no branch yet.
    test.skipIf(process.platform === 'win32')(
        'a first commit that git cannot take back stops the next run',
        async () => {
            await using stores = await makeTestStores()
            const vault = await copyFixtureVault(stores)
            const copy = await makeContentStoreCopyOf(stores, 'copy')
            const hooks = join(copy, '.git', 'hooks')
            await mkdir(hooks, { recursive: true })
            await writeFile(join(hooks, 'post-commit'), '#!/bin/sh\ntouch .git/committed\n')
            await writeFile(
                join(hooks, 'reference-transaction'),
                '#!/bin/sh\nif [ "$1" = prepared ] && [ -f .git/committed ]; then exit 1; fi\nexit 0\n'
            )
            await chmod(join(hooks, 'post-commit'), 0o755)
            await chmod(join(hooks, 'reference-transaction'), 0o755)
            await git(copy, 'remote', 'set-url', '--push', 'origin', join(stores.root, 'nowhere'))
            const device = nodeDevice({ vault, contentStore: copy })
            const planned = await plan(device, { include: ['Welcome.md'] })

            expect(await rejectionOf(publish(device, planned.id, RUN))).toContain('refused')

            await rm(join(hooks, 'reference-transaction'))
            expect(await rejectionOf(status(device))).toContain('does not have')
        }
    )

    // A commit of the copy that the content store has on another branch is
    // not ahead of the content store.
    test('a copy whose commits the content store has on another branch can publish', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await pushToStore(setup.copy, { 'README.md': 'A file of another branch\n' })
        await writeFile(join(setup.copy, 'README.md'), 'A newer text\n')
        await git(setup.copy, 'commit', '--quiet', '--all', '--message', 'On another branch')
        await git(setup.copy, 'push', '--quiet', 'origin', 'HEAD:other')

        expect((await status(setup.device)).new).toContain(NOTE)
    })

    // Another device published first into an empty content store: the push
    // is refused, and the copy must then take the publication of the other
    // device with a plain pull.
    test('a refused first publication leaves a copy that can pull', async () => {
        await using stores = await makeTestStores()
        const vault = await copyFixtureVault(stores)
        const first = await makeContentStoreCopyOf(stores, 'first')
        const second = await makeContentStoreCopyOf(stores, 'second')
        const firstDevice = nodeDevice({ vault, contentStore: first })
        const secondDevice = nodeDevice({ vault, contentStore: second })
        const planned = await plan(secondDevice, { include: ['Welcome.md'] })
        await publish(firstDevice, (await plan(firstDevice, { include: ['Welcome.md'] })).id, RUN)

        // Another time: else both commits are the same bytes, and git has nothing to refuse.
        expect(
            await rejectionOf(publish(secondDevice, planned.id, { ...RUN, time: LATER }))
        ).toContain('refused')

        await git(second, 'pull', '--quiet', '--ff-only', 'origin', 'main')
        expect((await status(secondDevice)).unchanged).toEqual(['Welcome.md'])
    })

    test('a copy that has no commit takes its first publication', async () => {
        await using stores = await makeTestStores()
        const vault = await copyFixtureVault(stores)
        const copy = await makeContentStoreCopyOf(stores, 'copy')
        const device = nodeDevice({ vault, contentStore: copy })
        const planned = await plan(device, { include: ['Welcome.md'] })

        const report = await publish(device, planned.id, RUN)

        expect(report.published).toEqual(['Welcome.md'])
        expect(await git(stores.contentStore, 'rev-list', '--count', 'main')).toBe('1')
        expect(await git(copy, 'status', '--porcelain')).toBe('')
    })
})

describe('publication with a note that fails', () => {
    // PUB-26: a failure of one note before the commit leaves that note out and
    // reports it. Here a file of the copy is in the place of the folder of the
    // note, so the cleaned note cannot be written.
    test('leaves the note out, reports it, and publishes the other notes', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const blocked = '30 People/Ada Quillfeather.md'
        await mkdir(join(setup.copy, 'notes'), { recursive: true })
        await writeFile(join(setup.copy, 'notes/30 People'), 'A file in the place of a folder\n')

        const report = await publishNotes(setup, { include: [NOTE, blocked] })

        expect(report.published).toEqual([NOTE])
        expect(report.failed.map((entry) => entry.path)).toEqual([blocked])
        expect(report.failed[0]?.reason).not.toBe('')
        // The note that failed is not published: no entry, no property.
        expect(await readdir(join(setup.copy, 'manifest'))).toEqual([`${NOTE_ID}.json`])
        expect(await Bun.file(join(setup.vault, blocked)).text()).not.toContain('public_note')
        expect(report.propertySet).toEqual([NOTE])
        expect(await status(setup.device).then((queue) => queue.new)).toContain(blocked)
    })

    // The two files of a note are one unit: the cleaned note is not left
    // behind when its manifest entry cannot be written.
    test('puts the cleaned note back when the manifest entry cannot be written', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        // A folder in the place of the manifest entry of the note.
        await mkdir(join(setup.copy, 'manifest', `${SECOND_ID}.json`), { recursive: true })

        const report = await publishNotes(setup, { include: [NOTE, SECOND] })

        expect(report.published).toEqual([NOTE])
        expect(report.failed.map((entry) => entry.path)).toEqual([SECOND])
        expect(await Bun.file(join(setup.copy, 'notes', SECOND)).exists()).toBe(false)
        expect(await Bun.file(join(setup.copy, 'notes', NOTE)).exists()).toBe(true)
    })

    // A file of a note that cannot be put back would be read as published at
    // the next run: the whole publication stops, and the other files go back.
    test('stops the whole publication when the files of a note cannot be put back', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const store = setup.device.store
        const device: Device = {
            ...setup.device,
            store: {
                ...store,
                async write(path, text) {
                    if (path === `manifest/${SECOND_ID}.json`) {
                        throw new Error('the disk is full')
                    }
                    await store.write(path, text)
                },
                async remove(path) {
                    if (path === `notes/${SECOND}`) {
                        throw new Error('the file is locked')
                    }
                    return await store.remove(path)
                }
            }
        }
        const planned = await plan(device, { include: [NOTE, SECOND] })

        const message = await rejectionOf(publish(device, planned.id, RUN))

        expect(message).toContain('could not be put back')
        expect(message).toContain(`notes/${SECOND}`)
        expect(await git(setup.copy, 'rev-list', '--count', 'HEAD')).toBe('1')
        expect(await Bun.file(join(setup.copy, 'notes', NOTE)).exists()).toBe(false)
        expect(await Bun.file(join(setup.copy, 'manifest', `${NOTE_ID}.json`)).exists()).toBe(false)
    })

    test('publishes nothing and corrects nothing when every note fails', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const blocked = '30 People/Ada Quillfeather.md'
        await mkdir(join(setup.copy, 'notes'), { recursive: true })
        await writeFile(join(setup.copy, 'notes/30 People'), 'A file in the place of a folder\n')
        const before = await picture(setup.vault)

        const report = await publishNotes(setup, { include: [blocked] })

        expect(report.published).toEqual([])
        expect(report.failed.map((entry) => entry.path)).toEqual([blocked])
        expect(await git(setup.copy, 'rev-list', '--count', 'HEAD')).toBe('1')
        expect(await picture(setup.vault)).toEqual(before)
    })
})

describe('correction of the state property', () => {
    // PUB-13: a file that changed during the run is skipped and reported. The
    // device of this test edits a note at the moment of the push.
    test('skips a note that changed during the publication, and reports it', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const wrong = '10 Garden/Bean trellis.md'
        const store = setup.device.store
        const device: Device = {
            ...setup.device,
            store: {
                ...store,
                async commitAndPush(message, paths) {
                    await store.commitAndPush(message, paths)
                    await append(join(setup.vault, wrong), 'A line that the author adds now.\n')
                }
            }
        }
        const planned = await plan(device, { include: [NOTE] })

        const report = await publish(device, planned.id, RUN)

        expect(report.propertySet).toEqual([NOTE])
        expect(report.propertyRemoved).toEqual([])
        expect(report.warnings.map((warning) => warning.path)).toEqual([wrong])
        const text = await Bun.file(join(setup.vault, wrong)).text()
        expect(text).toContain('public_note: true')
        expect(text).toContain('A line that the author adds now.')

        // The next publication corrects it.
        const next = await publishNotes(setup, { include: [SECOND] }, { ...RUN, time: LATER })
        expect(next.propertyRemoved).toEqual([wrong])
        expect(next.warnings).toEqual([])
    })

    test.skipIf(process.platform === 'win32')(
        'reports a note that cannot be written, and the publication stays done',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            const wrong = '10 Garden/Bean trellis.md'
            await chmod(join(setup.vault, wrong), 0o444)

            const report = await publishNotes(setup, { include: [NOTE] })

            expect(report.published).toEqual([NOTE])
            expect(report.warnings.map((warning) => warning.path)).toEqual([wrong])
            expect(await git(stores.contentStore, 'rev-list', '--count', 'main')).toBe('2')
        }
    )

    // TEST-20: no correction when the push fails.
    test('a refused push of an update puts the copy back and corrects nothing', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        // A setting of the machine that converts line ends must not change a file that is put back.
        await git(setup.copy, 'config', 'core.autocrlf', 'true')
        await publishNotes(setup, { include: [NOTE, 'Welcome.md'] })
        const published = await Bun.file(join(setup.copy, 'notes', NOTE)).text()
        await append(join(setup.vault, NOTE), EDIT)
        const planned = await plan(setup.device, { include: [SECOND], remove: ['Welcome.md'] })
        // Another device pushes first. The copy of this device does not know it.
        const other = await makeContentStoreCopyOf(stores, 'other')
        await pushToStore(other, { 'elsewhere.txt': 'A change of another device\n' })
        const before = {
            vault: await picture(setup.vault),
            head: await git(setup.copy, 'rev-parse', 'HEAD')
        }

        expect(
            await rejectionOf(publish(setup.device, planned.id, { ...RUN, time: LATER }))
        ).toContain('refused')

        expect(await git(setup.copy, 'rev-parse', 'HEAD')).toBe(before.head)
        expect(await git(setup.copy, 'status', '--porcelain')).toBe('')
        // The file of the update has its committed text again, and the file of the removal is back.
        expect(await Bun.file(join(setup.copy, 'notes', NOTE)).text()).toBe(published)
        expect(await Bun.file(join(setup.copy, 'notes/Welcome.md')).exists()).toBe(true)
        expect(await Bun.file(join(setup.copy, 'notes', SECOND)).exists()).toBe(false)
        expect(await picture(setup.vault)).toEqual(before.vault)
    })
})

/** A second clone of the content store: the copy of another device. */
async function makeContentStoreCopyOf(stores: TestStores, name: string): Promise<string> {
    const copy = join(stores.root, name)
    await git(stores.root, 'clone', '--quiet', stores.contentStore, copy)
    await git(copy, 'config', 'user.name', 'Other')
    await git(copy, 'config', 'user.email', 'other@example.invalid')
    await git(copy, 'config', 'commit.gpgsign', 'false')
    return copy
}

/** The manifest entry of a note in the copy of the content store, as data. */
async function entryOf(copy: string, path: string): Promise<Record<string, unknown>> {
    for (const file of await readdir(join(copy, 'manifest'))) {
        const entry = (await Bun.file(join(copy, 'manifest', file)).json()) as Record<
            string,
            unknown
        >
        if (entry['path'] === path) {
            return entry
        }
    }
    throw new Error(`the manifest has no entry for "${path}"`)
}

describe('links of the notes of the fixture vault', () => {
    const BARREL = '10 Garden/Rain barrel.md'

    // TEST-18, on the side of the tool: a wikilink, a link with a link text, a
    // link to a heading, an embed, a link with the full path, a Markdown link
    // and a link in a property lead to the same note. A name that no note has
    // gives no item.
    test('a note with a link of each form names the target of each link path', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const note = '10 Garden/Drip irrigation.md'

        await publishNotes(setup, { include: [note] })

        expect((await entryOf(setup.copy, note))['links']).toEqual([
            { link: '10 Garden/Rain barrel', path: BARREL },
            { link: 'Rain barrel', path: BARREL },
            { link: 'Rain barrel.md', path: BARREL }
        ])
        // The text is published as the author wrote it.
        const cleaned = await Bun.file(join(setup.copy, 'notes', note)).text()
        expect(cleaned).toContain('[[Rain barrel|the barrel]] or the [[Water butt]]')
        expect(cleaned).toContain('[the barrel](Rain%20barrel.md)')
        expect(cleaned).toContain('source: "[[Rain barrel]]"')
    })

    test('a link to a note in a folder of the deny list gives no item', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const note = '10 Garden/Watering schedule.md'

        await publishNotes(setup, { include: [note] })

        expect((await entryOf(setup.copy, note))['links']).toEqual([])
        const store = await git(
            setup.copy,
            'grep',
            '-l',
            '90 Locked Shed',
            'HEAD',
            '--',
            'manifest'
        ).catch(() => '')
        expect(store).toBe('')
    })

    test('a name that two notes have leads to the note below the folder of the link', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const note = '10 Garden/Herb bed/Thyme.md'

        await publishNotes(setup, { include: [note] })

        expect((await entryOf(setup.copy, note))['links']).toEqual([
            {
                link: '20 Library/20.02 Recipes/Mint',
                path: '20 Library/20.02 Recipes/Mint.md'
            },
            { link: 'Mint', path: '10 Garden/Herb bed/Mint.md' }
        ])
    })

    // BUILD-05: the entry of the note that links does not depend on the state of the target.
    test('the publication of a target changes nothing in the note that links to it', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const note = '10 Garden/Drip irrigation.md'
        await publishNotes(setup, { include: [note] })
        const before = await entryOf(setup.copy, note)

        await publishNotes(setup, { include: [BARREL] }, { ...RUN, time: LATER })

        expect(await entryOf(setup.copy, note)).toEqual(before)
        expect((await status(setup.device)).unchanged).toEqual([note, BARREL])
    })
})

describe('plan that a guard or a link makes stale', () => {
    test('a published note that comes under a guard after the plan makes the plan stale', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE, SECOND] })
        const planned = await plan(setup.device, { include: ['Welcome.md'] })
        await writeFile(join(setup.vault, SECOND), '---\npublish_ignore: true\n---\nText\n')

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('stale')
        expect(await Bun.file(join(setup.copy, 'notes/Welcome.md')).exists()).toBe(false)
    })

    test('a link of a note of the plan that leads to another note makes the plan stale', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        // The note links to "Water butt", which no note has.
        const planned = await plan(setup.device, { include: ['10 Garden/Drip irrigation.md'] })
        await writeFile(join(setup.vault, '10 Garden/Water butt.md'), 'Another name\n')

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('stale')
    })
})

describe('forced removal', () => {
    const IGNORED = '---\npublish_ignore: true\n---\nA text that must never go out\n'

    // TEST-13, PUB-29: whatever is selected, and the commit says it.
    test('goes with a publication of another note, and the commit counts it', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE, SECOND] })
        await writeFile(join(setup.vault, SECOND), IGNORED)

        const report = await publishNotes(
            setup,
            { include: ['Welcome.md'] },
            { ...RUN, time: LATER }
        )

        expect(report.forcedRemoved).toEqual([SECOND])
        expect(report.removed).toEqual([])
        expect(report.published).toEqual(['Welcome.md'])
        expect(await git(setup.copy, 'log', '-1', '--format=%s')).toBe(
            'Publish: 1 new, 0 updated, 0 removed, 1 forced, 0 skipped'
        )
        expect(await Bun.file(join(setup.copy, 'notes', SECOND)).exists()).toBe(false)
        expect(await Bun.file(join(setup.copy, 'manifest', `${SECOND_ID}.json`)).exists()).toBe(
            false
        )
        expect(await git(setup.copy, 'status', '--porcelain')).toBe('')
        // The text under the guard is nowhere in the last commit.
        expect(
            await git(setup.copy, 'grep', '-l', 'must never go out', 'HEAD').catch(() => '')
        ).toBe('')
        // The write into the note under the guard changed nothing: it had no state property.
        expect(await Bun.file(join(setup.vault, SECOND)).text()).toBe(IGNORED)
    })

    // Story 80: a move into a private folder is enough. The tool does not scan
    // a folder of the deny list, so it knows the move by the name of the note.
    test('takes a published note that was moved into a folder of the deny list', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE, SECOND] })
        const moved = join(setup.vault, '90 Locked Shed/Attachments/Compost basics.md')
        await rename(join(setup.vault, SECOND), moved)
        // A file that cannot be read as text: the tool lists the folder and reads no file of it.
        await writeFile(
            join(setup.vault, '90 Locked Shed/Not a text.md'),
            new Uint8Array([0xff, 0xfe, 0xfd])
        )
        const before = await picture(join(setup.vault, '90 Locked Shed'))

        const planned = await plan(setup.device, { include: [] })
        const report = await publish(setup.device, planned.id, { ...RUN, time: LATER })

        expect(planned.plan).toEqual({
            forcedRemove: [SECOND],
            publish: [],
            remove: [],
            update: []
        })
        expect(report.forcedRemoved).toEqual([SECOND])
        expect(await Bun.file(join(setup.copy, 'notes', SECOND)).exists()).toBe(false)
        expect(await readdir(join(setup.copy, 'manifest'))).toEqual([`${NOTE_ID}.json`])
        // No file of the folder of the deny list is written: the note keeps its state property there.
        expect(await picture(join(setup.vault, '90 Locked Shed'))).toEqual(before)
        expect(await Bun.file(moved).text()).toContain('public_note: true')
    })

    // PUB-95: a file that is missing on this device is never removed without a selection.
    test('does not take a published note whose file is only missing', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE, SECOND] })
        await rm(join(setup.vault, SECOND))

        const planned = await plan(setup.device, { include: [] })

        expect((await status(setup.device)).toRemove).toEqual([SECOND])
        expect(planned.plan).toEqual({ forcedRemove: [], publish: [], remove: [], update: [] })
        expect(
            (await plan(setup.device, { include: [], hold: [SECOND] })).plan.forcedRemove
        ).toEqual([])
    })

    // PUB-21: if a forced removal fails, the whole publication stops. Here a
    // folder is in the place of the cleaned note of the second removal.
    test('that fails stops the whole publication, and every file is put back', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE, SECOND] })
        await writeFile(join(setup.vault, NOTE), IGNORED)
        await writeFile(join(setup.vault, SECOND), IGNORED)
        const blocked = join(setup.copy, 'notes', NOTE)
        await rm(blocked)
        await mkdir(blocked)
        await writeFile(
            join(blocked, 'in the way'),
            'A file in a folder that stands for the note\n'
        )
        const planned = await plan(setup.device, { include: ['Welcome.md'] })
        expect(planned.plan.forcedRemove).toEqual([SECOND, NOTE])
        const before = {
            vault: await picture(setup.vault),
            commit: await git(setup.copy, 'rev-parse', 'HEAD'),
            manifest: (await readdir(join(setup.copy, 'manifest'))).sort()
        }

        const message = await rejectionOf(
            publish(setup.device, planned.id, { ...RUN, time: LATER })
        )

        expect(message).toContain(NOTE)
        expect(message).toContain('guard')
        expect(message).toContain('Nothing is published')
        expect(await git(setup.copy, 'rev-parse', 'HEAD')).toBe(before.commit)
        expect(await git(stores.contentStore, 'rev-parse', 'main')).toBe(before.commit)
        // The first removal was put back, and no other note was published.
        expect(await Bun.file(join(setup.copy, 'notes', SECOND)).exists()).toBe(true)
        expect((await readdir(join(setup.copy, 'manifest'))).sort()).toEqual(before.manifest)
        expect(await git(setup.copy, 'status', '--porcelain', '--', 'manifest')).toBe('')
        expect(await Bun.file(join(setup.copy, 'notes/Welcome.md')).exists()).toBe(false)
        // Without a push, no property is corrected.
        expect(await picture(setup.vault)).toEqual(before.vault)
        // Both notes still wait for their removal.
        expect((await status(setup.device)).toRemove).toEqual([SECOND, NOTE])
    })
})
