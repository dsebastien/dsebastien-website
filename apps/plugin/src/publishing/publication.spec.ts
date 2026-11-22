import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    copyFixtureVault,
    crashingStore,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    refusePushes,
    rejectionOf,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from './node/device.ts'
import { plan, publish, status, takedown, unlock } from './tool.ts'
import type { Device } from './ports.ts'

// The first slice (issue 31): one invented note goes through the plan, the
// guards, the cleaning step and the content store, and its `public_note`
// property is corrected. These tests go through the two operations that every
// face of the tool calls (SEAM-01 and SEAM-02 of the spec), on a copy of the
// fixture vault and on a content store made for the test.
//
// The expected hashes were computed with `sha256sum`, not with this code.

const NOTE = '10 Garden/Frost dates explained.md'
const SECOND = '10 Garden/Compost basics.md'
const TIME = '2031-04-01T08:00:00Z'
const RUN = { time: TIME, device: 'garden-shed', face: 'plugin' } as const
const NOTE_ID = '203d446940c02032'
const NOTE_HASH = 'sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b'

// The hash of `fixtures/configuration.json`, and the hash of a manifest without entries.
const CONFIGURATION_HASH = 'sha256:e06bbfc5161c72405ce2776eab77bc0001e63cdfc935e664fe5e8be0d98b9a12'
const EMPTY_MANIFEST_HASH =
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** The note with the ignore property: a guard now excludes it. */
const IGNORED_NOTE = '---\npublish_ignore: true\n---\nPrivate now.\n'

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
  "aliases": [],
  "attachments": [],
  "cleanedHash": "${NOTE_HASH}",
  "cleaningVersion": 5,
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
        "aliases": [],
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

    // Another device pushes between the fetch of the publication and its push
    // (issue 36, PUB-94, PUB-97). The author pulls, and the next run publishes
    // on top of the other device, with no forced push.
    test('a push that another device made first is refused, and after a pull the next run publishes with no forced push', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const other = join(stores.root, 'other-device')
        await git('clone', '--quiet', stores.contentStore, other)
        await git('-C', other, 'config', 'user.name', 'Test')
        await git('-C', other, 'config', 'user.email', 'test@example.invalid')
        await git('-C', other, 'config', 'commit.gpgsign', 'false')
        await mkdir(join(other, 'notes'))
        await writeFile(join(other, 'notes', 'Elsewhere.md'), 'A note of another device\n')
        await git('-C', other, 'add', '--', 'notes/Elsewhere.md')
        await git('-C', other, 'commit', '--quiet', '--message', 'A publication of another device')
        const theirs = await git('-C', other, 'rev-parse', 'HEAD')
        // The other device pushes when this one is about to push.
        const hook = join(setup.copy, '.git', 'hooks', 'pre-push')
        await mkdir(join(setup.copy, '.git', 'hooks'), { recursive: true })
        await writeFile(
            hook,
            `#!/bin/sh\nenv -i PATH="$PATH" HOME="$HOME" git -C "${other}" push --quiet origin HEAD:main\n`
        )
        await chmod(hook, 0o755)
        const planned = await plan(setup.device, { include: [NOTE] })
        const before = {
            vault: await picture(setup.vault),
            head: await git('-C', setup.copy, 'rev-parse', 'HEAD')
        }

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('refused')

        // Nothing is published and no property is corrected.
        expect(await git('--git-dir', stores.contentStore, 'rev-parse', 'main')).toBe(theirs)
        expect(await picture(setup.vault)).toEqual(before.vault)
        expect(await git('-C', setup.copy, 'rev-parse', 'HEAD')).toBe(before.head)
        expect(await rejectionOf(plan(setup.device, { include: [NOTE] }))).toContain(
            'git pull --ff-only origin main'
        )

        await rm(hook)
        await git('-C', setup.copy, 'pull', '--quiet', '--ff-only', 'origin', 'main')
        const again = await plan(setup.device, { include: [NOTE] })
        const report = await publish(setup.device, again.id, RUN)

        expect(report.published).toEqual([NOTE])
        expect(report.propertySet).toEqual([NOTE])
        // On top of the commit of the other device: no forced push took it back.
        await git('--git-dir', stores.contentStore, 'merge-base', '--is-ancestor', theirs, 'main')
        expect(await git('--git-dir', stores.contentStore, 'show', `main:notes/${NOTE}`)).toBe(
            NOTE_TEXT.trimEnd()
        )
    })
})

// The takedown (issue 38, PUB-81, PUB-99): one commit with the removals, and
// nothing taken down when the copy is behind or the push is refused.
describe('takedown', () => {
    const LATER = { ...RUN, time: '2031-04-02T08:00:00Z' }

    test('removes the note and its entry in one commit, which names the takedown', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publish(setup.device, (await plan(setup.device, { include: [NOTE] })).id, RUN)

        const report = await takedown(setup.device, [NOTE], LATER)

        expect(report.takenDown).toEqual([NOTE])
        const remote = ['--git-dir', stores.contentStore]
        const commit = await git(
            ...remote,
            'show',
            '--name-status',
            '--format=%B',
            '--no-renames',
            'main'
        )
        expect(commit.replace(/^Plan: [0-9a-f]{16}$/mu, 'Plan: <id>')).toBe(
            `Takedown: 1 note\n\nDevice: garden-shed\nFace: plugin\nPlan: <id>\n\n\nD\tmanifest/${NOTE_ID}.json\nD\tnotes/${NOTE}`
        )
        expect(await git(...remote, 'ls-tree', '-r', '--name-only', 'main')).toBe(
            'configuration.json'
        )
        expect(await exists(join(setup.copy, '.git', 'vault-publish', 'journal.json'))).toBe(false)
        expect(await exists(join(setup.copy, '.git', 'vault-publish', 'lock'))).toBe(false)
    })

    test('a refused push takes nothing down and leaves everything as it was', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publish(setup.device, (await plan(setup.device, { include: [NOTE] })).id, RUN)
        await refusePushes(stores.contentStore)
        const before = {
            vault: await picture(setup.vault),
            copy: await picture(setup.copy),
            storage: await readdir(stores.attachmentStorage),
            head: await git('-C', setup.copy, 'rev-parse', 'HEAD'),
            remote: await git('--git-dir', stores.contentStore, 'rev-parse', 'main')
        }

        const refusal = await rejectionOf(takedown(setup.device, [NOTE], LATER))

        expect(refusal).toContain('refused')
        expect(refusal).toContain('Nothing is taken down')
        expect(await picture(setup.vault)).toEqual(before.vault)
        expect(await picture(setup.copy)).toEqual(before.copy)
        expect(await readdir(stores.attachmentStorage)).toEqual(before.storage)
        expect(await git('-C', setup.copy, 'rev-parse', 'HEAD')).toBe(before.head)
        expect(await git('-C', setup.copy, 'status', '--porcelain')).toBe('')
        expect(await git('--git-dir', stores.contentStore, 'rev-parse', 'main')).toBe(before.remote)
        expect(await exists(join(setup.copy, '.git', 'vault-publish', 'journal.json'))).toBe(false)
    })

    // The cleanup before the path check and the one after the push see the
    // same name: the report says it one time.
    test('a name of the storage that is not a key gives one warning', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publish(setup.device, (await plan(setup.device, { include: [NOTE] })).id, RUN)
        await writeFile(join(stores.attachmentStorage, 'notes.txt'), 'Not a file of the storage\n')

        const report = await takedown(setup.device, [NOTE], LATER)

        expect(report.takenDown).toEqual([NOTE])
        expect(report.storageWarnings.map((warning) => warning.path)).toEqual(['notes.txt'])
        expect(report.warnings).toEqual([])
    })

    // A takedown that stopped after its push is finished in this way.
    test('a path with no entry stops the takedown, whose message says what its cleanup of the storage deleted', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publish(setup.device, (await plan(setup.device, { include: [NOTE] })).id, RUN)
        const key = '0'.repeat(64)
        await writeFile(join(stores.attachmentStorage, key), 'A left file\n')

        const refusal = await rejectionOf(takedown(setup.device, [SECOND], LATER))

        expect(refusal).toContain('is the path of no manifest entry')
        expect(refusal).toContain(
            `The takedown deleted 1 file(s) of the attachment storage that no published note uses: ${key}`
        )
        expect(await exists(join(stores.attachmentStorage, key))).toBe(false)
        expect(await exists(join(setup.copy, 'notes', NOTE))).toBe(true)
    })

    test('a copy that is behind the content store stops the takedown, which says to pull', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publish(setup.device, (await plan(setup.device, { include: [NOTE] })).id, RUN)
        // Another device publishes after the last pull of this copy.
        const other = join(stores.root, 'other-device')
        await git('clone', '--quiet', stores.contentStore, other)
        // A clone has no identity of its own: a machine with no global one cannot commit.
        await git('-C', other, 'config', 'user.name', 'Test')
        await git('-C', other, 'config', 'user.email', 'test@example.invalid')
        await git('-C', other, 'config', 'commit.gpgsign', 'false')
        await writeFile(join(other, 'notes', 'Elsewhere.md'), 'A note of another device\n')
        await git('-C', other, 'add', '--', 'notes/Elsewhere.md')
        await git('-C', other, 'commit', '--quiet', '--message', 'A publication of another device')
        await git('-C', other, 'push', '--quiet', 'origin', 'HEAD:main')
        const remote = await git('--git-dir', stores.contentStore, 'rev-parse', 'main')
        const vault = await picture(setup.vault)

        expect(await rejectionOf(takedown(setup.device, [NOTE], LATER))).toContain(
            'git pull --ff-only origin main'
        )

        expect(await git('--git-dir', stores.contentStore, 'rev-parse', 'main')).toBe(remote)
        expect(await exists(join(setup.copy, 'notes', NOTE))).toBe(true)
        expect(await picture(setup.vault)).toEqual(vault)
    })
})

// A write of the tool into a note (issue 36): the new text goes into a hidden
// file of the same folder, which is then renamed. A stop of the process during
// the write never leaves the note empty or half written.
describe('write of a note', () => {
    test.skipIf(process.platform === 'win32')(
        'replaces the note in one rename and leaves no other file',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            const note = join(setup.vault, NOTE)
            const before = await stat(note)
            const folder = (await readdir(join(setup.vault, '10 Garden'))).sort()

            const planned = await plan(setup.device, { include: [NOTE] })
            await publish(setup.device, planned.id, RUN)

            // Another file, renamed over the old one: a write into the same file keeps its number.
            expect((await stat(note)).ino).not.toBe(before.ino)
            expect(await Bun.file(note).text()).toContain('public_note: true')
            expect((await readdir(join(setup.vault, '10 Garden'))).sort()).toEqual(folder)
        }
    )
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

// The corrections after the first review of issue 36.
describe('failure cases after the first review', () => {
    const OTHER_LOCK = '{\n  "command": "plan",\n  "process": 1\n}\n'

    // The author runs unlock while a publication runs, and another run takes
    // the copy. The publication stops: it never claims what the other run
    // can have taken back, and it never removes the lock of the other run.
    test.skipIf(process.platform === 'win32')(
        'a publication whose lock another run took after its commit corrects no property and keeps that lock',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            const lock = join(setup.copy, '.git', 'vault-publish', 'lock')
            const hook = join(setup.copy, '.git', 'hooks', 'pre-commit')
            await mkdir(join(setup.copy, '.git', 'hooks'), { recursive: true })
            await writeFile(
                hook,
                `#!/bin/sh\nprintf '%s' '${OTHER_LOCK}' > .git/vault-publish/lock\n`
            )
            await chmod(hook, 0o755)
            const planned = await plan(setup.device, { include: [NOTE] })
            const vault = await picture(setup.vault)

            expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('lock')

            expect(await picture(setup.vault)).toEqual(vault)
            expect(await Bun.file(lock).text()).toBe(OTHER_LOCK)
        }
    )

    // Issue 75: the recovery of a plan checks its own lock before each write.
    test('a plan whose lock another run took during its recovery changes nothing more in the copy and in the journal', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        const stopped = crashingStore(setup.device.store, setup.copy, 'write')
        void publish({ ...setup.device, store: stopped.store }, planned.id, RUN)
        await stopped.reached
        expect(await unlock(setup.device)).toBe(true)
        const lock = join(setup.copy, '.git', 'vault-publish', 'lock')
        const journal = join(setup.copy, '.git', 'vault-publish', 'journal.json')
        const journalText = await Bun.file(journal).text()
        const written = join(setup.copy, 'notes', NOTE)
        expect(await Bun.file(written).exists()).toBe(true)
        // Another run takes the copy as the recovery of the plan starts.
        const store = setup.device.store
        const device: Device = {
            ...setup.device,
            store: {
                ...store,
                recover: async (...args: Parameters<typeof store.recover>) => {
                    await writeFile(lock, OTHER_LOCK)
                    return await store.recover(...args)
                }
            }
        }

        expect(await rejectionOf(plan(device, { include: [NOTE] }))).toContain(
            'the lock of this publication was removed while it ran'
        )

        expect(await Bun.file(written).exists()).toBe(true)
        expect(await Bun.file(journal).text()).toBe(journalText)
        expect(await Bun.file(lock).text()).toBe(OTHER_LOCK)
    })

    test('a publication whose lock another run took after the recovery found the push of a stopped run leaves the journal as it was', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const first = await plan(setup.device, { include: [NOTE] })
        const second = await plan(setup.device, { include: [SECOND] })
        const stopped = crashingStore(setup.device.store, setup.copy, 'push')
        void publish({ ...setup.device, store: stopped.store }, second.id, RUN)
        await stopped.reached
        expect(await unlock(setup.device)).toBe(true)
        const lock = join(setup.copy, '.git', 'vault-publish', 'lock')
        const journal = join(setup.copy, '.git', 'vault-publish', 'journal.json')
        const journalText = await Bun.file(journal).text()
        // Another run takes the copy once the recovery knows that the push arrived.
        const store = setup.device.store
        const device: Device = {
            ...setup.device,
            store: {
                ...store,
                recover: async (...args: Parameters<typeof store.recover>) => {
                    const result = await store.recover(...args)
                    await writeFile(lock, OTHER_LOCK)
                    return result
                }
            }
        }

        expect(await rejectionOf(publish(device, first.id, RUN))).toContain(
            'the lock of this publication was removed while it ran'
        )

        expect(await Bun.file(journal).text()).toBe(journalText)
        expect(await Bun.file(lock).text()).toBe(OTHER_LOCK)
    })

    test('a publication whose lock another run took before its commit leaves the copy to that run and pushes nothing', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const lock = join(setup.copy, '.git', 'vault-publish', 'lock')
        const planned = await plan(setup.device, { include: [NOTE] })
        const remote = await git('--git-dir', stores.contentStore, 'rev-parse', 'main')
        let taken = false
        const device: Device = {
            ...setup.device,
            store: {
                ...setup.device.store,
                async write(path, text) {
                    await setup.device.store.write(path, text)
                    if (!taken) {
                        taken = true
                        await writeFile(lock, OTHER_LOCK)
                    }
                }
            }
        }

        expect(await rejectionOf(publish(device, planned.id, RUN))).toContain('lock')

        // The other run owns the copy now: this run puts nothing back over its work.
        expect(await exists(join(setup.copy, 'notes', NOTE))).toBe(true)
        expect(await git('--git-dir', stores.contentStore, 'rev-parse', 'main')).toBe(remote)
        expect(await Bun.file(lock).text()).toBe(OTHER_LOCK)
    })

    // The case of the second review: the author runs unlock while publication
    // A runs, and publication B takes the copy. A must not put the files of a
    // forced removal back between the removal of B and its commit.
    test('a publication that lost its lock never undoes the forced removal of the run that took the copy', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publish(setup.device, (await plan(setup.device, { include: [NOTE] })).id, RUN)
        await writeFile(join(setup.vault, NOTE), IGNORED_NOTE)
        const later = { ...RUN, time: '2031-04-02T09:00:00Z' }
        const planned = await plan(setup.device, { include: [SECOND] })
        expect(planned.plan.forcedRemove).toEqual([NOTE])
        const a = Promise.withResolvers<undefined>()
        const aWaits = Promise.withResolvers<undefined>()
        const first: Device = {
            ...setup.device,
            store: {
                ...setup.device.store,
                async write(path, text) {
                    await setup.device.store.write(path, text)
                    aWaits.resolve(undefined)
                    await a.promise
                }
            }
        }
        const b = Promise.withResolvers<undefined>()
        const bWaits = Promise.withResolvers<undefined>()
        const second: Device = {
            ...setup.device,
            store: {
                ...setup.device.store,
                async commitAndPush(message, paths) {
                    bWaits.resolve(undefined)
                    await b.promise
                    await setup.device.store.commitAndPush(message, paths)
                }
            }
        }

        const runA = rejectionOf(publish(first, planned.id, RUN))
        await aWaits.promise
        expect(await unlock(setup.device)).toBe(true)
        const runB = publish(second, planned.id, later)
        await bWaits.promise
        a.resolve(undefined)
        expect(await runA).toContain('lock')
        b.resolve(undefined)
        const report = await runB

        expect(report.forcedRemoved).toEqual([NOTE])
        expect(report.published).toEqual([SECOND])
        // The cleaned note under the guard left the content store.
        const files = await git(
            '--git-dir',
            stores.contentStore,
            'ls-tree',
            '-r',
            '--name-only',
            'main'
        )
        expect(files.split('\n')).not.toContain(`notes/${NOTE}`)
        expect(files.split('\n')).toContain(`notes/${SECOND}`)
    })

    // Another run puts a file of the run back during the commit: the commit
    // then misses a forced removal, and it must never be pushed.
    test.skipIf(process.platform === 'win32')(
        'a commit that does not hold exactly the files of the run is never pushed',
        async () => {
            await using stores = await makeTestStores()
            const setup = await setUp(stores)
            await publish(setup.device, (await plan(setup.device, { include: [NOTE] })).id, RUN)
            await writeFile(join(setup.vault, NOTE), IGNORED_NOTE)
            const planned = await plan(setup.device, { include: [] })
            expect(planned.plan.forcedRemove).toEqual([NOTE])
            const remote = await git('--git-dir', stores.contentStore, 'rev-parse', 'main')
            const hook = join(setup.copy, '.git', 'hooks', 'pre-commit')
            await mkdir(join(setup.copy, '.git', 'hooks'), { recursive: true })
            await writeFile(hook, `#!/bin/sh\ngit checkout HEAD -- "notes/${NOTE}"\n`)
            await chmod(hook, 0o755)

            expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain(
                'does not hold exactly its files'
            )

            expect(await git('--git-dir', stores.contentStore, 'rev-parse', 'main')).toBe(remote)
            expect(await git('-C', setup.copy, 'rev-parse', 'HEAD')).toBe(remote)
        }
    )

    // A cleaned note that git skips is not compared by git status: its
    // removal would stage nothing.
    test('a cleaned note that git skips stops the run', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publish(setup.device, (await plan(setup.device, { include: [NOTE] })).id, RUN)
        await git('-C', setup.copy, 'update-index', '--skip-worktree', '--', `notes/${NOTE}`)
        await rm(join(setup.copy, 'notes', NOTE))

        expect(await rejectionOf(status(setup.device))).toContain('--no-skip-worktree')
    })

    // Issue 76: git cannot write some paths on some systems, so they look
    // deleted. The message says why and what to do.
    test('a missing cleaned note whose path git cannot write on some systems gets the cause in the message', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const reserved = '10 Garden/CON.md'
        const long = `${'L'.repeat(150)}/${'x'.repeat(150)}.md`
        await mkdir(join(setup.vault, 'L'.repeat(150)))
        for (const path of [reserved, long]) {
            await writeFile(join(setup.vault, path), '# Odd\n\nA note.\n')
        }
        const planned = await plan(setup.device, { include: [reserved, long] })
        await publish(setup.device, planned.id, RUN)
        await rm(join(setup.copy, 'notes', reserved))
        await rm(join(setup.copy, 'notes', long))

        const message = await rejectionOf(status(setup.device))

        expect(message).toContain(`notes/${reserved} (a name that Windows refuses)`)
        expect(message).toContain(`notes/${long} (a path longer than Windows allows)`)
        expect(message).toContain('git config core.longpaths true')
        expect(message).toContain('rename the note in the vault')
    })

    // A cleaned note that the copy lost would else stay in the content store
    // after its forced removal: the removal stages only what it removes.
    test('a cleaned note that is missing from the copy stops the run', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        await publish(setup.device, planned.id, RUN)
        await rm(join(setup.copy, 'notes', NOTE))

        for (const message of [
            await rejectionOf(status(setup.device)),
            await rejectionOf(plan(setup.device, { include: [] }))
        ]) {
            expect(message).toContain(`notes/${NOTE}`)
            expect(message).toContain('git checkout HEAD -- notes')
        }
    })

    test('a publication of a stale plan cleans the attachment storage before it stops', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        // An upload of a run that stopped halfway: no published note uses it.
        const left = join(stores.attachmentStorage, 'a'.repeat(64))
        await writeFile(left, 'An upload of a run that stopped\n')
        const planned = await plan(setup.device, { include: [NOTE] })
        await writeFile(join(setup.vault, NOTE), `${NOTE_TEXT}\nAn edit after the plan.\n`)

        expect(await rejectionOf(publish(setup.device, planned.id, RUN))).toContain('stale')

        expect(await exists(left)).toBe(false)
    })

    // Issue 77: the warnings of the cleanup of a stale plan are not lost.
    test('the refusal of a stale plan names the warnings of the cleanup of the storage', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(stores.attachmentStorage, 'stray.txt'), 'Not an upload of the tool\n')
        const planned = await plan(setup.device, { include: [NOTE] })
        await writeFile(join(setup.vault, NOTE), `${NOTE_TEXT}\nAn edit after the plan.\n`)

        const message = await rejectionOf(publish(setup.device, planned.id, RUN))

        expect(message).toContain('stale')
        expect(message).toContain(
            'The cleanup of the attachment storage gave these warnings:\n- stray.txt: the attachment storage holds a file whose name is not a key, and the tool leaves it: is the folder of the storage the right one?'
        )
    })

    test('the refusal of a stale plan whose cleanup gave no warning names none', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        await writeFile(join(setup.vault, NOTE), `${NOTE_TEXT}\nAn edit after the plan.\n`)

        const message = await rejectionOf(publish(setup.device, planned.id, RUN))

        expect(message).toBe(
            `the plan ${planned.id} is stale: a note of the plan, the publication queue, the configuration or the content store changed. Make a new plan`
        )
    })

    test('a name of the storage with a line break gives one line in the refusal', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await writeFile(join(stores.attachmentStorage, 'x\n- fake: injected'), 'Odd\n')
        const planned = await plan(setup.device, { include: [NOTE] })
        await writeFile(join(setup.vault, NOTE), `${NOTE_TEXT}\nAn edit after the plan.\n`)

        const message = await rejectionOf(publish(setup.device, planned.id, RUN))

        expect(message.split('\n').filter((line) => line.startsWith('- '))).toEqual([
            '- x\\n- fake: injected: the attachment storage holds a file whose name is not a key, and the tool leaves it: is the folder of the storage the right one?'
        ])
    })

    test('a folder that is not a copy of the content store gets no file of the tool', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const planned = await plan(setup.device, { include: [NOTE] })
        const folder = join(stores.root, 'not-a-copy')
        await mkdir(folder)
        const device = nodeDevice({
            vault: setup.vault,
            contentStore: folder,
            attachmentStorage: stores.attachmentStorage
        })

        expect(await rejectionOf(publish(device, planned.id, RUN))).toContain('not the root')
        expect(await rejectionOf(plan(device, { include: [NOTE] }))).toContain('not the root')
        expect(await readdir(folder)).toEqual([])
    })
})
