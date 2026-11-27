import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores,
    rejectionOf,
    sealHead,
    sealOfCommit,
    type TestStores
} from '@dsebastien-website/testing'
import { nodeDevice } from './node/device.ts'
import type { Device } from './ports.ts'
import { MISSING_KEY } from './seal.ts'
import { confirmState, plan, publish, status, takedown } from './tool.ts'

// The seal of the content store (R104), at the seams of the tool: every
// commit of the tool is sealed, and a state that no commit of the tool sealed
// stops the runs until the author confirms it.

const NOTE = '10 Garden/Frost dates explained.md'
const OTHER = '10 Garden/Bean trellis.md'
const RUN = { time: '2031-04-01T08:00:00Z', device: 'garden-shed', face: 'plugin' } as const
const LATER = { ...RUN, time: '2031-04-02T08:00:00Z' }

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
    return output.trim()
}

interface Setup {
    readonly vault: string
    readonly copy: string
    readonly device: Device
}

async function setUp(stores: TestStores): Promise<Setup> {
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        vault,
        contentStore: copy,
        attachmentStorage: stores.attachmentStorage
    })
    return { vault, copy, device }
}

/** Writes files into the copy and commits them by hand, with no tool, then pushes them. */
async function commitByHand(
    copy: string,
    files: Record<string, string>,
    options: { seal?: boolean; message?: string } = {}
): Promise<string> {
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(copy, path)), { recursive: true })
        await writeFile(join(copy, path), text)
    }
    await git(copy, 'add', '--all')
    await git(copy, 'commit', '--quiet', '--message', options.message ?? 'A commit by hand')
    if (options.seal === true) {
        await sealHead(copy)
    }
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
    return await git(copy, 'rev-parse', 'HEAD')
}

/** The seal of the last line of the message of a commit. */
async function sealLine(repository: string, commit: string): Promise<string> {
    return (await git(repository, 'log', '-1', '--format=%B', commit)).split('\n').at(-1) ?? ''
}

describe('the seal of the content store', () => {
    test('every commit of a publication carries the seal of its parent and its state', async () => {
        await using stores = await makeTestStores()
        const { device } = await setUp(stores)

        await publish(device, (await plan(device, { include: [NOTE] })).id, RUN)
        await publish(device, (await plan(device, { include: [OTHER] })).id, LATER)

        for (const commit of ['main', 'main~1']) {
            expect(await sealLine(stores.contentStore, commit)).toBe(
                `Seal: ${await sealOfCommit(stores.contentStore, commit)}`
            )
        }
    }, 60_000)

    test('a manifest entry that no tool wrote stops the plan and the publication, and names the note', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        await publish(device, (await plan(device, { include: [NOTE] })).id, RUN)
        const waiting = await plan(device, { include: [] })
        const head = await commitByHand(copy, {
            'manifest/0123456789abcdef.json': `{\n  "path": "${OTHER}",\n  "state": "published"\n}\n`
        })

        const refused = await rejectionOf(plan(device, { include: [] }))
        expect(refused).toContain(`is not the state that a commit of the tool sealed`)
        expect(refused).toContain(`manifest entries added (1): "${OTHER}" (none to published)`)
        expect(refused).toContain(`confirm-state --head ${head}`)
        expect(await rejectionOf(publish(device, waiting.id, LATER))).toBe(refused)
        expect(await rejectionOf(status(device))).toBe(refused)
        // Nothing was pushed after the commit by hand.
        expect(await git(stores.contentStore, 'rev-parse', 'main')).toBe(head)
    }, 60_000)

    test('a deny list loosened by hand is named as looser guards', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        await commitByHand(copy, { 'configuration.json': '{\n  "denyList": ["80 Templates"]\n}\n' })

        expect(await rejectionOf(plan(device, { include: [] }))).toContain(
            'folders that left the deny list, so the guards are looser: "90 Locked Shed"'
        )
    }, 60_000)

    test('a commit of the redirect list alone changes no sealed state', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        await commitByHand(copy, { 'redirects.json': '{}\n' })

        expect((await plan(device, { include: [NOTE] })).plan.publish).toEqual([NOTE])
    }, 60_000)

    test('an older sealed message on top of a newer state does not pass', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        const first = await git(copy, 'rev-parse', 'HEAD')
        await publish(device, (await plan(device, { include: [NOTE] })).id, RUN)
        // The state and the message of the first commit, again on top of the last one.
        await git(copy, 'rm', '--quiet', '-r', 'manifest', 'notes')
        const message = await git(copy, 'log', '-1', '--format=%B', first)
        await git(copy, 'commit', '--quiet', '--message', message)
        await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')

        expect(await rejectionOf(plan(device, { include: [] }))).toContain(
            'manifest entries removed (1)'
        )
    }, 60_000)

    test('a store with no seal is confirmed one time, for the commit that its difference names', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        // Under another key, no commit of the store has a valid seal: a store
        // from before the seal reads the same.
        const device: Device = {
            ...setup.device,
            seal: { environment: () => '6f'.repeat(32), envFile: () => Promise.resolve(undefined) }
        }
        const last = await git(setup.copy, 'rev-parse', 'HEAD')

        const refused = await rejectionOf(status(device))
        expect(refused).toStartWith('the content store has no sealed state yet')
        expect(refused).toContain('files of the store: configuration.json (added)')
        expect(await rejectionOf(confirmState(device, 'ab'.repeat(20), RUN))).toContain(
            `its last commit is now ${last}, not ${'ab'.repeat(20)}`
        )
        expect(await rejectionOf(confirmState(device, 'not a commit', RUN))).toBe(
            'the commit to confirm must be the 40 or 64 small hexadecimal digits of a commit'
        )

        const confirmed = await confirmState(device, last, RUN)

        expect(confirmed.confirmed).toBe(true)
        expect(confirmed.difference?.sealed).toBe('none')
        const sealed = await git(stores.contentStore, 'rev-parse', 'main')
        expect(await git(stores.contentStore, 'rev-parse', 'main~1')).toBe(last)
        expect(await git(stores.contentStore, 'diff', '--name-only', last, sealed)).toBe('')
        expect(await git(stores.contentStore, 'log', '-1', '--format=%B', 'main')).toBe(
            `Confirm the state of the content store\n\nConfirmed: ${last}\nDevice: garden-shed\nFace: plugin\nSeal: ${await sealOfCommit(stores.contentStore, 'main', '6f'.repeat(32))}`
        )
        expect((await plan(device, { include: [NOTE] })).plan.publish).toEqual([NOTE])
        expect(await confirmState(device, sealed, LATER)).toEqual({ confirmed: false })
    }, 60_000)

    test('without a key, nothing is planned, and the message says how to make one', async () => {
        await using stores = await makeTestStores()
        const setup = await setUp(stores)
        const none: Device = {
            ...setup.device,
            seal: { environment: () => undefined, envFile: () => Promise.resolve(undefined) }
        }
        const short: Device = {
            ...setup.device,
            seal: {
                environment: () => undefined,
                envFile: () => Promise.resolve(`VAULT_PUBLISH_SEAL_KEY=${'7c'.repeat(20)}\n`)
            }
        }

        expect(await rejectionOf(plan(none, { include: [NOTE] }))).toBe(MISSING_KEY)
        const invalid = await rejectionOf(plan(short, { include: [NOTE] }))
        expect(invalid).toStartWith(
            'VAULT_PUBLISH_SEAL_KEY of the .env file of the vault is not 64'
        )
        expect(invalid).not.toContain('7c7c')
    }, 60_000)

    test('reads the key of the .env file at the root of the vault', async () => {
        await using stores = await makeTestStores()
        const { vault, copy } = await setUp(stores)
        await writeFile(join(vault, '.env'), `VAULT_PUBLISH_SEAL_KEY="${'5e'.repeat(32)}"\n`)
        const saved = process.env['VAULT_PUBLISH_SEAL_KEY']
        delete process.env['VAULT_PUBLISH_SEAL_KEY']
        try {
            const device = nodeDevice({
                vault,
                contentStore: copy,
                attachmentStorage: stores.attachmentStorage
            })
            expect((await plan(device, { include: [NOTE] })).plan.publish).toEqual([NOTE])
        } finally {
            process.env['VAULT_PUBLISH_SEAL_KEY'] = saved
        }
    }, 60_000)

    test('a takedown never waits for a confirmation, and seals nothing that is not sealed', async () => {
        await using stores = await makeTestStores()
        const { copy, device } = await setUp(stores)
        await publish(device, (await plan(device, { include: [NOTE, OTHER] })).id, RUN)
        await commitByHand(copy, { 'configuration.json': '{\n  "denyList": ["80 Templates"]\n}\n' })

        expect((await takedown(device, [NOTE], LATER)).takenDown).toEqual([NOTE])

        expect(await sealLine(stores.contentStore, 'main')).toStartWith('Plan: ')
        expect(await rejectionOf(plan(device, { include: [] }))).toContain(
            'manifest entries removed (1)'
        )
    }, 60_000)
})
