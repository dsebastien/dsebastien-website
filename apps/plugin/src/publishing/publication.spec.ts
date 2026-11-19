import { describe, expect, test } from 'bun:test'
import { mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    refusePushes,
    rejectionOf,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from './node/device.ts'
import { plan, publish } from './tool.ts'
import type { Device } from './ports.ts'

// The first slice (issue 31): one invented note goes through the plan, the
// guards, the cleaning step and the content store, and its `public_note`
// property is corrected. These tests go through the two operations that every
// face of the tool calls (SEAM-01 and SEAM-02 of the spec), on a copy of the
// fixture vault and on a content store made for the test.
//
// The expected hashes were computed with `sha256sum`, not with this code.

const NOTE = '10 Garden/Frost dates explained.md'
const TIME = '2031-04-01T08:00:00Z'
const RUN = { time: TIME, device: 'garden-shed', face: 'plugin' } as const
const NOTE_ID = '203d446940c02032'
const NOTE_HASH = 'sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b'

// The hash of `fixtures/configuration.json`, and the hash of a manifest without entries.
const CONFIGURATION_HASH = 'sha256:e06bbfc5161c72405ce2776eab77bc0001e63cdfc935e664fe5e8be0d98b9a12'
const EMPTY_MANIFEST_HASH =
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const NOTE_TEXT = `---
tags:
  - type/note
ai_generated: true
created: 2031-03-07T07:00
updated: 2031-03-07T07:02
---

# Frost dates explained

The last frost date is the average day of the last frost in spring. Tender plants go out after it.
`

const MANIFEST_ENTRY = `{
  "attachments": [],
  "cleanedHash": "${NOTE_HASH}",
  "cleaningVersion": 3,
  "firstPublished": "${TIME}",
  "formerPaths": [],
  "id": "${NOTE_ID}",
  "lastPublished": "${TIME}",
  "links": [],
  "path": "${NOTE}",
  "sourceHash": "${NOTE_HASH}",
  "state": "published"
}
`

const PLAN_RECORD = `{
  "plan": {
    "forcedRemove": [],
    "publish": [
      "${NOTE}"
    ],
    "remove": [],
    "update": []
  },
  "selection": {
    "hold": [],
    "include": [
      "${NOTE}"
    ],
    "remove": []
  },
  "state": {
    "configuration": "${CONFIGURATION_HASH}",
    "manifest": "${EMPTY_MANIFEST_HASH}",
    "notes": [
      {
        "attachments": [],
        "cleanedHash": "${NOTE_HASH}",
        "links": [],
        "path": "${NOTE}",
        "sourceHash": "${NOTE_HASH}"
      }
    ]
  }
}
`

interface Setup {
    stores: TestStores
    vault: string
    copy: string
    device: Device
}

async function setUp(stores: TestStores): Promise<Setup> {
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    return {
        stores,
        vault,
        copy,
        device: nodeDevice({
            vault,
            contentStore: copy,
            attachmentStorage: stores.attachmentStorage
        })
    }
}

/**
 * Commits every change of the copy and pushes it, as another device would: the
 * tool reads the files of the last commit of the copy.
 */
async function commitInCopy(copy: string, message: string): Promise<void> {
    await git('-C', copy, 'add', '--all')
    await git('-C', copy, 'commit', '--quiet', '--message', message)
    await git('-C', copy, 'push', '--quiet', 'origin', 'HEAD:main')
}

async function git(...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { env: gitEnvironment(), stdout: 'pipe' })
    const stdout = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return stdout.trimEnd()
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

/** Every file of a folder with a hash of its bytes: a picture to compare before and after. */
async function picture(folder: string): Promise<Record<string, string>> {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true })
    const files: Record<string, string> = {}
    for (const entry of entries) {
        const path = join(entry.parentPath, entry.name)
        if (entry.isFile() && !path.includes(`${folder}/.git/`)) {
            const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(path).bytes())
            files[path.slice(folder.length + 1)] = hash.digest('hex')
        }
    }
    return files
}

describe('plan of a first publication', () => {
    test('names the note that was included, in the list to publish', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)

        const planned = await plan(device, { include: [NOTE] })

        expect(planned.plan).toEqual({ forcedRemove: [], publish: [NOTE], update: [], remove: [] })
        expect(planned.id).toMatch(/^[0-9a-f]{16}$/)
    })

    test('writes nothing into the vault and into the content store', async () => {
        await using stores = await makeTestStores()
        const { device, vault, copy } = await setUp(stores)
        const before = { vault: await picture(vault), copy: await picture(copy) }
        const head = await git('-C', copy, 'rev-parse', 'HEAD')

        await plan(device, { include: [NOTE] })

        expect(await picture(vault)).toEqual(before.vault)
        expect(await picture(copy)).toEqual(before.copy)
        expect(await git('-C', copy, 'status', '--porcelain')).toBe('')
        expect(await git('-C', copy, 'rev-parse', 'HEAD')).toBe(head)
        expect(await git('--git-dir', stores.contentStore, 'rev-parse', 'main')).toBe(head)
    })

    test('is stored on the device, outside the vault, in the canonical form', async () => {
        await using stores = await makeTestStores()
        const { device, copy } = await setUp(stores)

        const planned = await plan(device, { include: [NOTE] })

        const stored = join(copy, '.git', 'vault-publish', 'plans', `${planned.id}.json`)
        expect(await Bun.file(stored).text()).toBe(PLAN_RECORD)
    })

    test('is empty when no note is included', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)

        expect((await plan(device, { include: [] })).plan).toEqual({
            forcedRemove: [],
            publish: [],
            update: [],
            remove: []
        })
    })

    // The tool never reads the property as an input (PUB-12).
    test('takes a note whose property wrongly says that it is published', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)

        const planned = await plan(device, { include: ['10 Garden/Bean trellis.md'] })

        expect(planned.plan.publish).toEqual(['10 Garden/Bean trellis.md'])
    })

    test.each([
        ['a note in a folder of the deny list', '90 Locked Shed/Shed inventory.md', 'deny list'],
        ['a note with the ignore property', '10 Garden/Neighbour dispute.md', 'publish_ignore'],
        ['a note that does not exist', '10 Garden/No such note.md', 'does not exist'],
        ['a file that is not a note', 'Attachments/garden-plan.png', 'not a note'],
        ['a path that leaves the vault', '../configuration.json', 'vault path']
    ])('refuses %s', async (_case, path, reason) => {
        await using stores = await makeTestStores()
        const { device, copy } = await setUp(stores)

        expect(await rejectionOf(plan(device, { include: [path] }))).toContain(reason)
        expect(await exists(join(copy, '.git', 'vault-publish'))).toBe(false)
    })
})

describe('first publication of a note', () => {
    async function publishNote(setup: Setup, note = NOTE): Promise<void> {
        const planned = await plan(setup.device, { include: [note] })
        await publish(setup.device, planned.id, RUN)
    }

    test('adds one commit with the cleaned note and its manifest entry, and pushes it', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)

        await publishNote(setup)

        const remote = ['--git-dir', stores.contentStore]
        expect(await git(...remote, 'rev-list', '--count', 'main')).toBe('2')
        const files = await git(...remote, 'diff', '--name-only', '-z', 'main~1', 'main')
        expect(files.split('\0').filter((file) => file !== '')).toEqual([
            `manifest/${NOTE_ID}.json`,
            `notes/${NOTE}`
        ])
        expect(await git('-C', setup.copy, 'status', '--porcelain')).toBe('')
        expect(await git('-C', setup.copy, 'rev-parse', 'HEAD')).toBe(
            await git(...remote, 'rev-parse', 'main')
        )
    })

    test('writes the cleaned note: the note as it is in the vault', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)

        await publishNote(setup)

        expect(await Bun.file(join(setup.copy, 'notes', NOTE)).text()).toBe(NOTE_TEXT)
    })

    test('writes the manifest entry of the note', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)

        await publishNote(setup)

        const entry = join(setup.copy, 'manifest', `${NOTE_ID}.json`)
        expect(await Bun.file(entry).text()).toBe(MANIFEST_ENTRY)
    })

    // The fixture vault has three notes that carry the property by mistake:
    // one candidate, and two notes in folders of the deny list, which are
    // never written (PUB-13).
    test('sets the property of the note to true, and removes it from the note that is not published', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const before = await picture(setup.vault)

        await publishNote(setup)

        expect(await Bun.file(join(setup.vault, NOTE)).text()).toBe(
            NOTE_TEXT.replace(
                'updated: 2031-03-07T07:02\n',
                'updated: 2031-03-07T07:02\npublic_note: true\n'
            )
        )
        const after = await picture(setup.vault)
        const changed = Object.keys(after).filter((file) => after[file] !== before[file])
        expect(changed.sort()).toEqual(['10 Garden/Bean trellis.md', NOTE])
        expect(await Bun.file(join(setup.vault, '10 Garden/Bean trellis.md')).text()).not.toContain(
            'public_note'
        )
        // No file was added and no file was removed.
        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    })

    // The property is the state in the vault, not content: it never reaches
    // the content store, and it is not part of the hashes (PUB-14).
    test('leaves the property out of the cleaned note', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const note = '10 Garden/Bean trellis.md'
        const source = await Bun.file(join(setup.vault, note)).text()

        await publishNote(setup, note)

        const cleaned = await Bun.file(join(setup.copy, 'notes', note)).text()
        expect(cleaned).toBe(source.replace('public_note: true\n', ''))
        expect(await Bun.file(join(setup.vault, note)).text()).toBe(source)
    })

    test('refuses a plan that it does not know', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)

        expect(await rejectionOf(publish(device, '0000000000000000', RUN))).toContain('plan')
    })

    test('refuses a time that is not in the canonical form', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const planned = await plan(device, { include: [NOTE] })

        expect(
            await rejectionOf(publish(device, planned.id, { ...RUN, time: '2031-04-01 08:00' }))
        ).toContain('time')
    })

    test('a published note that did not change adds nothing to a later plan', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNote(setup)

        const planned = await plan(setup.device, { include: [NOTE] })

        expect(planned.plan).toEqual({ forcedRemove: [], publish: [], update: [], remove: [] })
    })
})

// The guards never open by accident (business rules 2 to 4). Each case here
// was a way around a guard before it was closed.
describe('guards of a plan', () => {
    const DENIED = '90 Locked Shed/Shed inventory.md'

    async function refuses(setup: Setup, path: string, reason: string): Promise<void> {
        expect(await rejectionOf(plan(setup.device, { include: [path] }))).toContain(reason)
        expect(await exists(join(setup.copy, '.git', 'vault-publish'))).toBe(false)
    }

    test('a symbolic link to a note of a deny list folder is not a note of the vault', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await symlink(join(setup.vault, DENIED), join(setup.vault, '10 Garden', 'Linked.md'))

        await refuses(setup, '10 Garden/Linked.md', 'does not exist')
    })

    test('a folder that is a symbolic link to a deny list folder is not a folder of the vault', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await symlink(join(setup.vault, '90 Locked Shed'), join(setup.vault, 'Open shed'))

        await refuses(setup, 'Open shed/Shed inventory.md', 'does not exist')
    })

    test('a symbolic link to a file outside the vault is not a note of the vault', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const outside = join(stores.root, 'outside.md')
        await writeFile(outside, 'Not a note of the vault.\n')
        await symlink(outside, join(setup.vault, 'Outside.md'))

        await refuses(setup, 'Outside.md', 'does not exist')
        expect(await Bun.file(outside).text()).toBe('Not a note of the vault.\n')
    })

    test('a note that is not valid UTF-8 is refused', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(
            join(setup.vault, 'Latin.md'),
            Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
        )

        await refuses(setup, 'Latin.md', 'UTF-8')
    })

    // The reading of the ignore property fails closed. The shared cases of
    // `frontmatter.spec.ts` hold every form.
    test('a form of the ignore property that is not the plain one still excludes the note', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(
            join(setup.vault, 'Quoted.md'),
            '---\n"publish_ignore": yes # never\n---\nText\n'
        )

        await refuses(setup, 'Quoted.md', 'publish_ignore')
    })

    test.each([
        ['is not valid UTF-8', Uint8Array.from([0x7b, 0xe9, 0x7d]), 'UTF-8'],
        ['is not JSON', '{ "denyList": [', 'JSON'],
        ['is a list', '[[]]', 'deny list'],
        ['has no deny list', '{}', 'deny list'],
        [
            'has an entry with a slash at its end',
            '{ "denyList": ["90 Locked Shed/"] }',
            'vault path'
        ],
        [
            'has an entry with a slash at its start',
            '{ "denyList": ["/90 Locked Shed"] }',
            'vault path'
        ],
        [
            'has an entry in another letter case',
            '{ "denyList": ["90 locked shed"] }',
            'not a folder'
        ],
        [
            'has an entry with a space at its end',
            '{ "denyList": ["90 Locked Shed "] }',
            'not a folder'
        ],
        ['has an entry that names a note', '{ "denyList": ["Welcome.md"] }', 'not a folder']
    ])('a configuration that %s stops the plan', async (_case, configuration, reason) => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(setup.copy, 'configuration.json'), configuration)
        await commitInCopy(setup.copy, 'A configuration that cannot be trusted')

        // An open note: a configuration that cannot be trusted stops everything.
        await refuses(setup, NOTE, reason)
        await refuses(setup, DENIED, reason)
    })

    test('a configuration that is a folder stops the plan', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await git('-C', setup.copy, 'rm', '--quiet', 'configuration.json')
        await mkdir(join(setup.copy, 'configuration.json'))
        await writeFile(join(setup.copy, 'configuration.json', 'inside'), 'A file in a folder\n')
        await commitInCopy(setup.copy, 'A configuration that is a folder')

        await refuses(setup, DENIED, 'cannot be read')
    })

    test('only a content store without a configuration has an empty deny list', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        // Removed from the content store too: a file that git has and the
        // copy does not stops the tool.
        await git('-C', setup.copy, 'rm', '--quiet', 'configuration.json')
        await git('-C', setup.copy, 'commit', '--quiet', '--message', 'No configuration')
        await git('-C', setup.copy, 'push', '--quiet', 'origin', 'HEAD:main')

        const planned = await plan(setup.device, { include: [DENIED] })

        expect(planned.plan.publish).toEqual([DENIED])
    })

    test('a configuration that is missing from the copy stops the plan', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await rm(join(setup.copy, 'configuration.json'))

        expect(await rejectionOf(plan(setup.device, { include: [DENIED] }))).toContain(
            'last commit'
        )
    })

    test('a folder that is not the root of its own git repository is not a content store', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const inside = join(setup.copy, 'inside')
        await mkdir(inside)
        const device = nodeDevice({
            vault: setup.vault,
            contentStore: inside,
            attachmentStorage: stores.attachmentStorage
        })

        expect(await rejectionOf(plan(device, { include: [NOTE] }))).toContain('git repository')
    })
})

describe('publication and what changed since the plan', () => {
    test('a note that was edited after the plan makes the plan stale', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        await writeFile(
            join(setup.vault, NOTE),
            `${NOTE_TEXT}\nA line that the author did not review.\n`
        )

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('stale')

        expect(await git('--git-dir', stores.contentStore, 'rev-list', '--count', 'main')).toBe('1')
    })

    test('another publication after the plan makes the plan stale', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const first = await plan(setup.device, { include: [NOTE] })
        const second = await plan(setup.device, { include: ['Welcome.md'] })
        await publish(setup.device, second.id, RUN)

        expect(await rejectionOf(publish(setup.device, first.id, RUN))).toContain('stale')
    })

    test('a guard that was added after the plan stops the publication', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        await writeFile(
            join(setup.vault, NOTE),
            NOTE_TEXT.replace('tags:', 'publish_ignore: true\ntags:')
        )

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain(
            'publish_ignore'
        )
    })

    test('the same plan cannot be applied two times', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        await publish(setup.device, planned.id, RUN)

        await rejectionOf(publish(setup.device, planned.id, RUN))

        expect(await git('--git-dir', stores.contentStore, 'rev-list', '--count', 'main')).toBe('2')
    })

    test.each([
        ['a path in the place of the id', '../../other/.git/vault-publish/plans/0000000000000000'],
        ['capital letters', 'ABCDEF0123456789'],
        ['an id that is too short', 'abc']
    ])('refuses %s', async (_case, id) => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)

        expect(await rejectionOf(publish(device, id, RUN))).toContain('16 hexadecimal digits')
    })

    test.each(['2031-13-45T99:99:99Z', '2031-02-30T08:00:00Z', '2031-04-01T24:00:00Z'])(
        'refuses the time %s, which is not a real date and time',
        async (time) => {
            await using stores = await makeTestStores()
            const { device } = await setUp(stores)
            const planned = await plan(device, { include: [NOTE] })

            expect(await rejectionOf(publish(device, planned.id, { ...RUN, time }))).toContain(
                'time'
            )
        }
    )
})

describe('commit of a publication', () => {
    test('holds only the files of the publication', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(setup.copy, 'scratch.txt'), 'not for the content store\n')
        await mkdir(join(setup.copy, 'notes'), { recursive: true })
        await writeFile(
            join(setup.copy, 'notes', 'left-over.md'),
            'A file that no publication wrote.\n'
        )

        const planned = await plan(setup.device, { include: [NOTE] })
        await publish(setup.device, planned.id, RUN)

        const files = await git(
            '--git-dir',
            stores.contentStore,
            'ls-tree',
            '-r',
            '--name-only',
            '-z',
            'main'
        )
        expect(
            files
                .split('\0')
                .filter((file) => file !== '')
                .sort()
        ).toEqual(['configuration.json', `manifest/${NOTE_ID}.json`, `notes/${NOTE}`])
        expect(await Bun.file(join(setup.copy, 'scratch.txt')).text()).toBe(
            'not for the content store\n'
        )
    })

    test('holds a note that a rule of the store would ignore', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await mkdir(join(setup.copy, '.git', 'info'), { recursive: true })
        await writeFile(join(setup.copy, '.git', 'info', 'exclude'), 'notes/\n')

        const planned = await plan(setup.device, { include: [NOTE] })
        await publish(setup.device, planned.id, RUN)

        expect(await git('--git-dir', stores.contentStore, 'show', `main:notes/${NOTE}`)).toBe(
            NOTE_TEXT.trimEnd()
        )
    })

    // Another device pushed first. Nothing is published, and nothing is left behind.
    test('a refused push leaves the vault, the copy and the content store as they were', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        await refusePushes(stores.contentStore)
        const before = {
            vault: await picture(setup.vault),
            copy: await picture(setup.copy),
            head: await git('-C', setup.copy, 'rev-parse', 'HEAD'),
            remote: await git('--git-dir', stores.contentStore, 'rev-parse', 'main')
        }

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('refused')

        expect(await picture(setup.vault)).toEqual(before.vault)
        expect(await picture(setup.copy)).toEqual(before.copy)
        expect(await git('-C', setup.copy, 'rev-parse', 'HEAD')).toBe(before.head)
        expect(await git('-C', setup.copy, 'status', '--porcelain')).toBe('')
        expect(await git('--git-dir', stores.contentStore, 'rev-parse', 'main')).toBe(before.remote)
    })
})

describe('publication of a note with Windows line ends', () => {
    test('writes Unix line ends to the content store and keeps the line ends of the vault', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const windows = NOTE_TEXT.replaceAll('\n', '\r\n')
        await writeFile(join(setup.vault, NOTE), windows)

        const planned = await plan(setup.device, { include: [NOTE] })
        await publish(setup.device, planned.id, RUN)

        expect(await Bun.file(join(setup.copy, 'notes', NOTE)).text()).toBe(NOTE_TEXT)
        expect(await Bun.file(join(setup.vault, NOTE)).text()).toBe(
            windows.replace(
                'updated: 2031-03-07T07:02\r\n',
                'updated: 2031-03-07T07:02\r\npublic_note: true\r\n'
            )
        )
    })
})

// The attachments (issue 35): only the files that published notes use go to
// the attachment storage, by their content hash, never a file of a deny list
// folder, and a failed run leaves no file there that the manifest does not
// list (SEAM-02 of the spec). The Rust twin is `cli/tests/publication.rs`.
describe('attachments of a publication', () => {
    const PLAN = '10 Garden/Garden plan.md'
    const TOUR = '10 Garden/Tool shed tour.md'
    const IMAGE = 'Attachments/garden-plan.png'
    const IMAGE_KEY = 'a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33'
    const DENIED_KEY = '86571f2b883d23bc5c95dc18aa3cef6077451c6f13a52c6f44373b667503c3a1'
    const PLAN_ID = 'd3bc99e6071c5b92'

    async function publishNotes(
        setup: Setup,
        selection: { include?: string[]; remove?: string[] }
    ): Promise<Awaited<ReturnType<typeof publish>>> {
        const planned = await plan(setup.device, {
            include: selection.include ?? [],
            remove: selection.remove ?? []
        })
        return await publish(setup.device, planned.id, RUN)
    }

    /** The names of the files of the attachment storage, sorted. */
    async function storage(stores: TestStores): Promise<string[]> {
        const entries = await readdir(stores.attachmentStorage, { withFileTypes: true })
        return entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort()
    }

    async function addIgnore(vault: string, note: string): Promise<void> {
        const text = await Bun.file(join(vault, note)).text()
        await writeFile(join(vault, note), text.replace('---\n', '---\npublish_ignore: true\n'))
    }

    test('uploads only the files that the published notes use, under the hash of their bytes', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)

        const report = await publishNotes(setup, { include: [PLAN, TOUR] })

        expect(report.published).toEqual([PLAN, TOUR])
        expect(report.attachmentsUploaded).toEqual([IMAGE_KEY])
        expect(await storage(stores)).toEqual([IMAGE_KEY])
        expect(await Bun.file(join(stores.attachmentStorage, IMAGE_KEY)).bytes()).toEqual(
            await Bun.file(join(setup.vault, IMAGE)).bytes()
        )
    })

    test('lists the attachment in the manifest entry, with its hash, its size and the size of the image', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)

        await publishNotes(setup, { include: [PLAN] })

        const entry: unknown = JSON.parse(
            await Bun.file(join(setup.copy, 'manifest', `${PLAN_ID}.json`)).text()
        )
        expect(entry).toMatchObject({
            path: PLAN,
            attachments: [
                {
                    hash: `sha256:${IMAGE_KEY}`,
                    height: 12,
                    link: 'garden-plan.png',
                    path: IMAGE,
                    size: 78,
                    width: 16
                }
            ]
        })
    })

    // GATE-42: the tour embeds the key of the locked shed.
    test('never uploads a file of a deny list folder, and writes none of its paths', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)

        await publishNotes(setup, { include: [TOUR] })

        expect(await storage(stores)).toEqual([IMAGE_KEY])
        // The cleaned note keeps the embed as the author wrote it. No entry
        // names the file under the guard.
        const files = Object.keys(await picture(setup.copy))
        const entries = files.filter((file) => file.startsWith('manifest/'))
        expect(entries.length).toBe(1)
        for (const file of entries) {
            const text = await Bun.file(join(setup.copy, file)).text()
            expect(text, file).not.toContain('Locked Shed')
            expect(text, file).not.toContain(DENIED_KEY)
        }
        expect(files.filter((file) => file.includes('Locked Shed'))).toEqual([])
    })

    test('a forced removal takes out the files that no other published note uses', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [PLAN, TOUR] })

        await addIgnore(setup.vault, TOUR)
        const first = await publishNotes(setup, {})
        expect(first.forcedRemoved).toEqual([TOUR])
        expect(first.attachmentsDeleted).toEqual([])
        expect(await storage(stores)).toEqual([IMAGE_KEY])

        await addIgnore(setup.vault, PLAN)
        const second = await publishNotes(setup, {})
        expect(second.forcedRemoved).toEqual([PLAN])
        expect(second.attachmentsDeleted).toEqual([IMAGE_KEY])
        expect(await storage(stores)).toEqual([])
    })

    test('an unpublish takes out the files of the note', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [PLAN] })

        const report = await publishNotes(setup, { remove: [PLAN] })

        expect(report.removed).toEqual([PLAN])
        expect(report.attachmentsDeleted).toEqual([IMAGE_KEY])
        expect(await storage(stores)).toEqual([])
    })

    test('after a refused push, the storage holds no file that the manifest does not list', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await refusePushes(stores.contentStore)
        const planned = await plan(setup.device, { include: [PLAN, TOUR] })

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('refused')

        expect(await storage(stores)).toEqual([])
    })

    test('a note whose upload fails is left out, and the other notes are published', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        // A folder in the place of the file: the upload cannot write it.
        await mkdir(join(stores.attachmentStorage, IMAGE_KEY))

        const report = await publishNotes(setup, { include: [NOTE, PLAN] })

        expect(report.published).toEqual([NOTE])
        expect(report.failed.map((entry) => entry.path)).toEqual([PLAN])
        expect(report.attachmentsUploaded).toEqual([])
        expect(await storage(stores)).toEqual([])
        expect(await exists(join(setup.copy, 'notes', PLAN))).toBe(false)

        // The next publication takes the note.
        await rm(join(stores.attachmentStorage, IMAGE_KEY), { recursive: true })
        const next = await publishNotes(setup, { include: [PLAN] })
        expect(next.published).toEqual([PLAN])
        expect(await storage(stores)).toEqual([IMAGE_KEY])
    })

    // A takedown must never wait for the storage (business rules 4 and 16).
    test('a forced removal with no upload needs no attachment storage', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNotes(setup, { include: [NOTE] })
        await addIgnore(setup.vault, NOTE)
        await rm(stores.attachmentStorage, { recursive: true })

        const report = await publishNotes(setup, {})

        expect(report.forcedRemoved).toEqual([NOTE])
        expect(report.warnings.map((warning) => warning.path)).toEqual([''])
        expect(await exists(join(setup.copy, 'notes', NOTE))).toBe(false)
    })

    test('a folder of the storage that holds other files loses none of them', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(stores.attachmentStorage, 'Inbox.md'), 'A note of the author\n')
        await writeFile(join(stores.attachmentStorage, `${IMAGE_KEY}.png`), 'Not a key\n')

        const report = await publishNotes(setup, { include: [NOTE] })

        expect(report.attachmentsDeleted).toEqual([])
        expect(report.warnings.map((warning) => warning.path)).toEqual([
            'Inbox.md',
            `${IMAGE_KEY}.png`
        ])
        expect(await storage(stores)).toEqual(['Inbox.md', `${IMAGE_KEY}.png`])
    })

    test('a file that no published note uses leaves the storage at the next publication', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        // An upload that an earlier run could not delete.
        await writeFile(join(stores.attachmentStorage, DENIED_KEY), 'Left by an earlier run\n')

        const report = await publishNotes(setup, { include: [NOTE] })

        expect(report.attachmentsDeleted).toEqual([DENIED_KEY])
        expect(await storage(stores)).toEqual([])
    })
})
