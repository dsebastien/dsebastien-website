import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
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
const NOTE_ID = '203d446940c02032'
const NOTE_HASH = 'sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b'

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
  "cleaningVersion": 1,
  "firstPublished": "${TIME}",
  "formerPaths": [],
  "id": "${NOTE_ID}",
  "lastPublished": "${TIME}",
  "path": "${NOTE}",
  "sourceHash": "${NOTE_HASH}",
  "state": "published"
}
`

const PLAN_RECORD = `{
  "plan": {
    "publish": [
      "${NOTE}"
    ],
    "remove": [],
    "update": []
  },
  "selection": {
    "include": [
      "${NOTE}"
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
    return { stores, vault, copy, device: nodeDevice({ vault, contentStore: copy }) }
}

async function git(...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { env: gitEnvironment(), stdout: 'pipe' })
    const stdout = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return stdout.trimEnd()
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

        expect(planned.plan).toEqual({ publish: [NOTE], update: [], remove: [] })
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

        expect(plan(device, { include: [path] })).rejects.toThrow(reason)
        expect(await Bun.file(join(copy, '.git', 'vault-publish')).exists()).toBe(false)
    })
})

describe('first publication of a note', () => {
    async function publishNote(setup: Setup, note = NOTE): Promise<void> {
        const planned = await plan(setup.device, { include: [note] })
        await publish(setup.device, planned.id, TIME)
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

    test('sets the property of the note to true, and changes no other file of the vault', async () => {
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
        expect(changed).toEqual([NOTE])
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

        expect(publish(device, '0000000000000000', TIME)).rejects.toThrow('plan')
    })

    test('refuses a time that is not in the canonical form', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const planned = await plan(device, { include: [NOTE] })

        expect(publish(device, planned.id, '2031-04-01 08:00')).rejects.toThrow('time')
    })

    test('refuses a second first publication of the same note', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        await publishNote(setup)

        expect(plan(setup.device, { include: [NOTE] })).rejects.toThrow('already published')
    })
})
