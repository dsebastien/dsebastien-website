import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { refreshAfterRun, SeenNotes, seeingVault } from './after.ts'
import { queryNamesProperty } from './frozen.ts'
import { nodeDevice } from './node/device.ts'
import type { Device, ListRefresh, RefreshResult, Vault } from './ports.ts'
import { plan, publish, status, takedown, unpublish } from './tool.ts'

// The refresh of the frozen lists after a publication, an unpublish and a
// takedown, in Obsidian (decision R84, issue 134): only the notes whose query
// names a property that the publication writes are asked. A stand-in takes
// the place of the Dataview Serializer.

const PUBLIC_LIST = '50 Field guide/Queries/Public notes.md'
const FROZEN = '50 Field guide/Queries/Frozen table.md'
const PLAIN = '10 Garden/Frost dates explained.md'
const RUN = { time: '2031-04-01T08:00:00Z', device: 'garden-shed', face: 'plugin' } as const

/** A note whose frozen list reads the state property. */
const PUBLIC_QUERY = [
    '# Public notes',
    '',
    '<!-- QueryToSerialize: LIST FROM "10 Garden" WHERE public_note SORT file.name ASC -->',
    '<!-- SerializedQuery: LIST FROM "10 Garden" WHERE public_note SORT file.name ASC -->',
    '',
    '<!-- SerializedQuery END -->',
    ''
].join('\n')

/** A folder of the deny list whose path Obsidian reads as `My Private` (issue 110). */
const DENIED_FOLDER = 'My\u00a0Private'

/** Another device adds a folder to the deny list of the content store, and pushes it. */
async function denyAlso(copy: string, folder: string): Promise<void> {
    await writeFile(
        join(copy, 'configuration.json'),
        `${JSON.stringify({ denyList: ['80 Templates', '90 Locked Shed', folder] }, null, 4)}\n`
    )
    for (const args of [
        ['add', '--', 'configuration.json'],
        ['commit', '--quiet', '--message', 'Deny one more folder'],
        ['push', '--quiet', 'origin', 'HEAD:main']
    ]) {
        const child = Bun.spawn(['git', ...args], { cwd: copy, env: gitEnvironment() })
        if ((await child.exited) !== 0) {
            throw new Error(`git ${args.join(' ')} failed`)
        }
    }
}

interface Setup {
    vault: string
    copy: string
    device: Device
    /** The paths of each call of the stand-in, in order. */
    calls: string[][]
}

/** Writes a note into the copy of the vault. */
async function note(vault: string, path: string, text: string): Promise<void> {
    await mkdir(dirname(join(vault, path)), { recursive: true })
    await writeFile(join(vault, path), text)
}

/** A device with the note of `PUBLIC_LIST`, whose stand-in serializer writes it, or fails. */
async function setUp(stores: TestStores, fails = false): Promise<Setup> {
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    await note(vault, PUBLIC_LIST, PUBLIC_QUERY)
    const calls: string[][] = []
    const lists: ListRefresh = {
        async refresh(paths): Promise<RefreshResult> {
            calls.push([...paths])
            if (fails) {
                return {
                    refreshed: new Set(),
                    written: new Map(),
                    wrote: false,
                    problems: paths.map((path) => ({ path, message: 'a query failed' }))
                }
            }
            const written = new Map<string, number>()
            for (const path of paths) {
                const file = join(vault, path)
                const text = await readFile(file, 'utf8')
                await writeFile(
                    file,
                    text.replace(
                        '\n<!-- SerializedQuery END',
                        '- refreshed\n<!-- SerializedQuery END'
                    )
                )
                written.set(path, 1)
            }
            return { refreshed: new Set(paths), written, wrote: written.size > 0, problems: [] }
        }
    }
    const device = {
        ...nodeDevice({ vault, contentStore: copy, attachmentStorage: stores.attachmentStorage }),
        lists
    }
    return { vault, copy, device, calls }
}

describe('a query that names a property of the publication (R84)', () => {
    test('a marker line that names public_note counts', () => {
        expect(queryNamesProperty(PUBLIC_QUERY, ['public_note'])).toBe(true)
    })

    test('a query that names another property does not count', () => {
        const source = '<!-- QueryToSerialize: LIST WHERE public_notes OR my_public_note -->\n'
        expect(queryNamesProperty(source, ['public_note'])).toBe(false)
    })

    test('the name only in the serialized output or in a fence does not count', () => {
        const source = [
            '<!-- QueryToSerialize: LIST FROM #topic/water -->',
            '<!-- SerializedQuery: LIST WHERE public_note -->',
            '```',
            '<!-- QueryToSerialize: LIST WHERE public_note -->',
            '```',
            ''
        ].join('\n')
        expect(queryNamesProperty(source, ['public_note'])).toBe(false)
    })

    test('a JS query that builds the name is not seen (a known limit)', () => {
        const source =
            '<!-- DataviewJSToSerialize: dv.list(dv.pages().where(p => p["public_" + "note"])) -->\n'
        expect(queryNamesProperty(source, ['public_note'])).toBe(false)
    })
})

describe('the refresh of the frozen lists after a run (R84)', () => {
    test('after a publication, only the notes whose query names public_note are asked', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)
        const planned = await plan(device, { include: [PLAIN] })
        await publish(device, planned.id, RUN)
        calls.length = 0

        const after = await refreshAfterRun(device)

        expect(calls).toEqual([[PUBLIC_LIST]])
        expect(after.listsRefreshed).toEqual([PUBLIC_LIST])
        expect(after.refreshProblems).toEqual([])
    }, 60_000)

    // A missing configuration is never an empty deny list (R67).
    test('a configuration that is missing asks no note, and says so', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)
        const missing: Device = {
            ...device,
            store: {
                ...device.store,
                read: async (path) =>
                    path === 'configuration.json' ? undefined : await device.store.read(path)
            }
        }

        const after = await refreshAfterRun(missing)

        expect(calls).toEqual([])
        expect(after.listsRefreshed).toEqual([])
        expect(after.refreshProblems.map((problem) => problem.message).join(' | ')).toContain(
            'has no configuration.json'
        )
    })

    test('after an unpublish, the same notes are asked', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)
        const planned = await plan(device, { include: [PLAIN] })
        await publish(device, planned.id, RUN)
        await unpublish(device, [PLAIN], { ...RUN, time: '2031-04-02T08:00:00Z' })
        calls.length = 0

        const after = await refreshAfterRun(device)

        expect(calls).toEqual([[PUBLIC_LIST]])
        expect(after.listsRefreshed).toEqual([PUBLIC_LIST])
    }, 60_000)

    test('after a takedown, the same notes are asked', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)
        const planned = await plan(device, { include: [PLAIN] })
        await publish(device, planned.id, RUN)
        await takedown(device, [PLAIN], { ...RUN, time: '2031-04-02T08:00:00Z' })
        calls.length = 0

        const after = await refreshAfterRun(device)

        expect(calls).toEqual([[PUBLIC_LIST]])
        expect(after.listsRefreshed).toEqual([PUBLIC_LIST])
    }, 60_000)

    test('a published note that the refresh wrote is a changed note for the next plan', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const planned = await plan(device, { include: [PUBLIC_LIST] })
        await publish(device, planned.id, RUN)

        await refreshAfterRun(device)
        const queue = await status(device)

        expect(queue.changed).toContain(PUBLIC_LIST)
    }, 60_000)

    test('a note under a guard is never asked', async () => {
        await using stores = await makeTestStores()
        const { device, vault, calls } = await setUp(stores)
        await note(vault, '90 Locked Shed/Public notes.md', PUBLIC_QUERY)
        await note(
            vault,
            '50 Field guide/Queries/Ignored public notes.md',
            `---\npublish_ignore: true\n---\n${PUBLIC_QUERY}`
        )

        await refreshAfterRun(device)

        expect(calls).toEqual([[PUBLIC_LIST]])
    }, 60_000)

    test('a note that names no property of the publication is never asked', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)

        await refreshAfterRun(device)

        expect(calls.flat()).not.toContain(FROZEN)
    }, 60_000)

    test('a refresh that fails is reported and throws nothing', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores, true)

        const after = await refreshAfterRun(device)

        expect(after.listsRefreshed).toEqual([])
        expect(after.refreshProblems).toEqual([{ path: PUBLIC_LIST, message: 'a query failed' }])
    }, 60_000)

    test('a refresh that throws is reported for each note', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const broken = {
            ...device,
            lists: {
                refresh: (): Promise<RefreshResult> => Promise.reject(new Error('stopped'))
            }
        }

        const after = await refreshAfterRun(broken)

        expect(after.refreshProblems).toEqual([
            { path: PUBLIC_LIST, message: 'the refresh of the Dataview Serializer failed: stopped' }
        ])
    }, 60_000)

    test('without a serializer, nothing is asked and nothing is reported', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const { lists: _lists, ...withoutLists } = device

        expect(await refreshAfterRun(withoutLists)).toEqual({
            listsRefreshed: [],
            refreshProblems: []
        })
    }, 60_000)
})

describe('the refresh after a run reads little and fails closed (R84 review)', () => {
    /** The same device with a vault that counts its reads of notes and can fail on one path. */
    function counting(device: Device, fails?: string): { device: Device; reads: string[] } {
        const reads: string[] = []
        const wrap = (vault: Vault): Vault => ({
            ...vault,
            list: (folder) => vault.list(folder),
            readBytes: (path) => vault.readBytes(path),
            size: (path) => vault.size(path),
            hasFolder: (path) => vault.hasFolder(path),
            write: (path, text, before) => vault.write(path, text, before),
            read: async (path) => {
                reads.push(path)
                if (path === fails) {
                    throw new Error('not valid UTF-8')
                }
                return await vault.read(path)
            },
            forRun: () => wrap(vault.forRun())
        })
        return { device: { ...device, vault: wrap(device.vault) }, reads }
    }

    test('with the notes that the check read, only the notes to refresh are read again', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)
        const seen = new SeenNotes()
        await status({ ...device, vault: seeingVault(device.vault, seen) })
        const { device: counted, reads } = counting(device)

        const after = await refreshAfterRun(counted, seen)

        expect(reads).toEqual([PUBLIC_LIST])
        expect(calls).toEqual([[PUBLIC_LIST]])
        expect(after.listsRefreshed).toEqual([PUBLIC_LIST])
    }, 60_000)

    test('a guard added after the check is seen before the call', async () => {
        await using stores = await makeTestStores()
        const { device, vault, calls } = await setUp(stores)
        const seen = new SeenNotes()
        await status({ ...device, vault: seeingVault(device.vault, seen) })
        await note(vault, PUBLIC_LIST, `---\npublish_ignore: true\n---\n${PUBLIC_QUERY}`)

        await refreshAfterRun(device, seen)

        expect(calls).toEqual([])
    }, 60_000)

    test('a note whose Obsidian path is the one of a file of the deny list is never asked', async () => {
        await using stores = await makeTestStores()
        const { device, vault, copy, calls } = await setUp(stores)
        await denyAlso(copy, DENIED_FOLDER)
        await note(vault, `${DENIED_FOLDER}/Public notes.md`, PUBLIC_QUERY)
        await note(vault, 'My Private/Public notes.md', PUBLIC_QUERY)

        await refreshAfterRun(device)

        expect(calls).toEqual([[PUBLIC_LIST]])
    }, 60_000)

    test('the twins come from a listing of the vault, not from what the check read', async () => {
        await using stores = await makeTestStores()
        const { device, vault, calls } = await setUp(stores)
        await note(vault, PUBLIC_LIST.replace('Public notes', 'Public notes'), PUBLIC_QUERY)
        const seen = new SeenNotes()
        seen.note(PUBLIC_LIST, PUBLIC_QUERY)

        await refreshAfterRun(device, seen)

        expect(calls).toEqual([])
    }, 60_000)

    test('a note that cannot be read is reported', async () => {
        await using stores = await makeTestStores()
        const { device: plain } = await setUp(stores)
        const { device } = counting(plain, PLAIN)

        const after = await refreshAfterRun(device)

        expect(after.refreshProblems).toEqual([
            {
                path: PLAIN,
                message: 'the note cannot be read, so its lists are not refreshed: not valid UTF-8'
            }
        ])
    }, 60_000)

    test('the serializer is told that the refresh comes after a run', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const moments: (string | undefined)[] = []
        const told = {
            ...device,
            lists: {
                refresh: (paths: readonly string[], moment?: string): Promise<RefreshResult> => {
                    moments.push(moment)
                    return Promise.resolve({
                        refreshed: new Set(paths),
                        written: new Map(),
                        wrote: false,
                        problems: []
                    })
                }
            }
        }

        await refreshAfterRun(told)

        expect(moments).toEqual(['after-run'])
    }, 60_000)
})
