import { describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from './node/device.ts'
import type { Device, ListRefresh, RefreshResult } from './ports.ts'
import { plan, publish, unpublish } from './tool.ts'

// The refresh of the frozen lists before a plan, in Obsidian (PUB-35, R71,
// TEST-22): `documentation/Canonical Form.md`, "The frozen lists of a note".
// A stand-in takes the place of the Dataview Serializer.

const FROZEN = '50 Field guide/Queries/Frozen table.md'
const LIVE = '50 Field guide/Queries/Live Dataview.md'
const PLAIN = '10 Garden/Frost dates explained.md'
const RUN = { time: '2031-04-01T08:00:00Z', device: 'garden-shed', face: 'plugin' } as const

/** The row that the stand-in serializer adds to a frozen list. */
const NEW_ROW = '| [[Water butt]] | 2031-03-04T07:00 |\n'

interface Setup {
    vault: string
    copy: string
    device: Device
    /** The paths of each call of the stand-in, in order. */
    calls: string[][]
}

/**
 * A device whose stand-in serializer adds a row to each frozen list that it
 * is asked to refresh, and reports the outcome that `outcome` gives.
 */
async function setUp(
    stores: TestStores,
    outcome: (path: string) => 'updated' | 'unchanged' | 'failed' = () => 'updated'
): Promise<Setup> {
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    const calls: string[][] = []
    const lists: ListRefresh = {
        async refresh(paths): Promise<RefreshResult> {
            calls.push([...paths])
            const refreshed = new Set<string>()
            const problems: { path: string; message: string }[] = []
            let wrote = false
            for (const path of paths) {
                const result = outcome(path)
                if (result === 'failed') {
                    problems.push({ path, message: 'a query failed' })
                    continue
                }
                if (result === 'updated' && path === FROZEN) {
                    const file = join(vault, path)
                    const text = await readFile(file, 'utf8')
                    await writeFile(
                        file,
                        text.replace(
                            '\n\n<!-- SerializedQuery END',
                            `${NEW_ROW}\n<!-- SerializedQuery END`
                        )
                    )
                    wrote = true
                }
                refreshed.add(path)
            }
            return { refreshed, wrote, problems }
        }
    }
    const device = {
        ...nodeDevice({ vault, contentStore: copy, attachmentStorage: stores.attachmentStorage }),
        lists
    }
    return { vault, copy, device, calls }
}

describe('the refresh of the frozen lists before a plan', () => {
    test('asks the serializer for the notes of the plan only, sorted by path', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)

        await plan(device, { include: [PLAIN, FROZEN] })

        expect(calls).toEqual([[PLAIN, FROZEN].sort()])
    })

    test('the plan holds the refreshed text, and the publication publishes it (TEST-22)', async () => {
        await using stores = await makeTestStores()
        const { device, copy } = await setUp(stores)

        const planned = await plan(device, { include: [FROZEN] })
        const report = await publish(device, planned.id, RUN)

        expect(report.published).toEqual([FROZEN])
        expect(await readFile(join(copy, 'notes', FROZEN), 'utf8')).toContain(NEW_ROW)
        expect(planned.listsNotRefreshed).toEqual([])
    })

    test('the publication does not refresh again: the plan is not stale', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)

        const planned = await plan(device, { include: [FROZEN] })
        await publish(device, planned.id, RUN)

        expect(calls).toHaveLength(1)
    })

    test('a refresh that wrote nothing gives the plan of the same id', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores, () => 'unchanged')

        const once = await plan(device, { include: [FROZEN] })
        const twice = await plan(device, { include: [FROZEN] })

        expect(twice.id).toBe(once.id)
    })

    test('a note that the serializer did not refresh is marked, with the reason', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores, (path) => (path === FROZEN ? 'failed' : 'updated'))

        const planned = await plan(device, { include: [FROZEN, LIVE] })

        expect(planned.listsNotRefreshed).toEqual([FROZEN])
        expect(planned.liveQueries).toEqual([LIVE])
        expect(planned.refreshProblems).toEqual([{ path: FROZEN, message: 'a query failed' }])
    })

    test('a plan with no note to publish or update asks no refresh', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)

        await plan(device, { include: [] })

        expect(calls).toEqual([])
    })

    test('an unpublish asks no refresh', async () => {
        await using stores = await makeTestStores()
        const { device, calls } = await setUp(stores)
        const first = await plan(device, { include: [PLAIN] })
        await publish(device, first.id, RUN)
        calls.length = 0

        await unpublish(device, [PLAIN], { ...RUN, time: '2031-04-02T08:00:00Z' })

        expect(calls).toEqual([])
    })

    test('without a serializer, every note with a list to refresh is marked', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)
        const { lists: _lists, ...withoutLists } = device

        const planned = await plan(withoutLists, { include: [FROZEN, PLAIN] })

        expect(planned.listsNotRefreshed).toEqual([FROZEN])
        expect(planned.refreshProblems).toEqual([])
    })
})
