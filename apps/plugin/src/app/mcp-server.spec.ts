import { describe, expect, test } from 'bun:test'
import { request } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    copyFixtureVault,
    FIXTURE_NOTE_TYPES,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores
} from '@dsebastien-website/testing'
import type { TestStores } from '@dsebastien-website/testing'
import { toCanonicalJson } from '../publishing/canonical.ts'
import { fileNoteTypes, nodeDevice } from '../publishing/node/device.ts'
import type { Device } from '../publishing/ports.ts'
import { guards, status } from '../publishing/tool.ts'
import { toggleRow } from '../publishing/center.ts'
import { PublicationCenter } from './center.ts'
import { LocalMcpServer } from './mcp-server.ts'

// The MCP server of the plugin (issue 41, TOOL-03): an HTTP server on this
// computer, at http://127.0.0.1:<port>/mcp, with a key. Each tool call goes
// through the controller of the publication center, so one run at a time
// holds the copy, and the view shows what the agent did. The tests start it
// on a free port, on a real device: a copy of the fixture vault, a copy of the
// content store and an attachment storage made for the test.

const KEY = 'a-key-for-the-tests'
const NOTE = '10 Garden/Frost dates explained.md'
const SECOND = '10 Garden/Compost basics.md'

interface Answer {
    readonly status: number
    readonly headers: Record<string, string | string[] | undefined>
    readonly body: string
}

function send(
    port: number,
    options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                host: '127.0.0.1',
                port,
                method: options.method ?? 'POST',
                path: options.path ?? '/mcp',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'Authorization': `Bearer ${KEY}`,
                    ...options.headers
                }
            },
            (incoming) => {
                const chunks: Buffer[] = []
                incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
                incoming.on('end', () => {
                    resolve({
                        status: incoming.statusCode ?? 0,
                        headers: incoming.headers,
                        body: Buffer.concat(chunks).toString('utf8')
                    })
                })
            }
        )
        outgoing.on('error', reject)
        outgoing.end(options.body)
    })
}

interface Setup {
    readonly vault: string
    readonly copy: string
    readonly device: Device
    readonly center: PublicationCenter
    readonly server: LocalMcpServer
    readonly port: number
    /** Calls a tool and gives the result of the answer. */
    readonly call: (tool: string, args?: unknown) => Promise<{ texts: string[]; isError: boolean }>
}

async function setUp(stores: TestStores, key: string | null = KEY): Promise<Setup> {
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    const device = nodeDevice({
        vault,
        contentStore: copy,
        attachmentStorage: stores.attachmentStorage,
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES)
    })
    let minute = 0
    const center = new PublicationCenter({
        device: () => device,
        pull: () => Promise.resolve(),
        now: () => new Date(Date.UTC(2031, 3, 1, 8, minute++)),
        deviceName: 'garden-shed'
    })
    const server = new LocalMcpServer({
        port: 0,
        key: () => key,
        version: 'test',
        operations: (call) => center.serve(call)
    })
    const port = await server.start()
    let id = 0
    const call = async (
        tool: string,
        args: unknown = {}
    ): Promise<{ texts: string[]; isError: boolean }> => {
        id += 1
        const answer = await send(port, {
            body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: { name: tool, arguments: args }
            })
        })
        expect(answer.status).toBe(200)
        const parsed = JSON.parse(answer.body) as {
            result: { content: { text: string }[]; isError: boolean }
        }
        return {
            texts: parsed.result.content.map((item) => item.text),
            isError: parsed.result.isError
        }
    }
    return { vault, copy, device, center, server, port, call }
}

const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })

async function lastCommit(copy: string): Promise<string> {
    const child = Bun.spawn(['git', '-C', copy, 'log', '-1', '--format=%B'], {
        env: gitEnvironment(),
        stdout: 'pipe'
    })
    return await new Response(child.stdout).text()
}

describe('the MCP server of the plugin', () => {
    test('answers on 127.0.0.1 at /mcp with the key', async () => {
        await using stores = await makeTestStores()
        const { server, port } = await setUp(stores)
        try {
            const answer = await send(port, { body: PING })

            expect(answer.status).toBe(200)
            expect(answer.headers['content-type']).toBe('application/json')
            expect(JSON.parse(answer.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
            expect(server.port).toBe(port)
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('refuses a request without the key or with another key', async () => {
        await using stores = await makeTestStores()
        const { server, port } = await setUp(stores)
        try {
            const none = await send(port, { body: PING, headers: { Authorization: '' } })
            const other = await send(port, {
                body: PING,
                headers: { Authorization: 'Bearer another-key' }
            })
            const basic = await send(port, {
                body: PING,
                headers: { Authorization: `Basic ${KEY}` }
            })

            for (const answer of [none, other, basic]) {
                expect(answer.status).toBe(401)
                expect(answer.headers['www-authenticate']).toBe('Bearer')
                expect(answer.body).toContain('key')
            }
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('refuses every request when this device has no key', async () => {
        await using stores = await makeTestStores()
        const { server, port } = await setUp(stores, null)
        try {
            const answer = await send(port, { body: PING })

            expect(answer.status).toBe(401)
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('refuses a request of a web page, and a Host that is not 127.0.0.1 at its port', async () => {
        await using stores = await makeTestStores()
        const { server, port } = await setUp(stores)
        try {
            const page = await send(port, {
                body: PING,
                headers: { Origin: 'https://example.com' }
            })
            const rebound = await send(port, {
                body: PING,
                headers: { Host: `garden.example:${String(port)}` }
            })
            const otherPort = await send(port, {
                body: PING,
                headers: { Host: `127.0.0.1:${String(port + 1)}` }
            })
            const local = await send(port, {
                body: PING,
                headers: { Host: `localhost:${String(port)}` }
            })

            expect(page.status).toBe(403)
            expect(rebound.status).toBe(403)
            expect(otherPort.status).toBe(403)
            // A client that asks `localhost` can reach a program on [::1].
            expect(local.status).toBe(403)
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('takes only a POST of JSON at /mcp, of 1 MiB at most', async () => {
        await using stores = await makeTestStores()
        const { server, port } = await setUp(stores)
        try {
            const read = await send(port, { method: 'GET' })
            const elsewhere = await send(port, { path: '/other', body: PING })
            const text = await send(port, {
                body: PING,
                headers: { 'Content-Type': 'text/plain' }
            })
            const large = await send(port, { body: ' '.repeat(1024 * 1024 + 1) })
            const version = await send(port, {
                body: PING,
                headers: { 'MCP-Protocol-Version': '1999-01-01' }
            })
            const known = await send(port, {
                body: PING,
                headers: { 'MCP-Protocol-Version': '2025-06-18' }
            })

            expect(read.status).toBe(405)
            expect(read.headers['allow']).toBe('POST')
            expect(elsewhere.status).toBe(404)
            expect(text.status).toBe(415)
            expect(large.status).toBe(413)
            expect(version.status).toBe(400)
            expect(known.status).toBe(200)
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('a notification gets an empty answer 202', async () => {
        await using stores = await makeTestStores()
        const { server, port } = await setUp(stores)
        try {
            const answer = await send(port, {
                body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
            })

            expect(answer.status).toBe(202)
            expect(answer.body).toBe('')
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('status gives the queue as the status command writes it', async () => {
        await using stores = await makeTestStores()
        const { server, call, device } = await setUp(stores)
        try {
            const answer = await call('status')

            expect(answer.isError).toBe(false)
            expect(answer.texts).toEqual([toCanonicalJson(await status(device))])
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('drives a publication with paths to include, to hold and to remove (TEST-17)', async () => {
        await using stores = await makeTestStores()
        const { server, call, vault, copy, center } = await setUp(stores)
        try {
            const first = await call('plan', { include: [NOTE, SECOND] })
            const planned = JSON.parse(first.texts[0] ?? '') as {
                id: string
                plan: { publish: string[] }
                listsNotRefreshed: string[]
                liveQueries: string[]
            }
            expect(planned.plan.publish).toEqual([SECOND, NOTE])
            // The two lists of the frozen lists come with the plan (R71).
            expect(planned.listsNotRefreshed).toEqual([])
            expect(planned.liveQueries).toEqual([])
            const published = await call('publish', { plan: planned.id })
            expect(published.isError).toBe(false)
            expect(
                (JSON.parse(published.texts[0] ?? '') as { published: string[] }).published
            ).toEqual([SECOND, NOTE])
            expect(await lastCommit(copy)).toContain('Device: garden-shed\nFace: mcp-server\n')
            // The view shows what the agent did, and its queue is new.
            expect(center.state.report?.kind).toBe('publication')
            expect(center.state.queue?.unchanged).toEqual([SECOND, NOTE])

            const source = join(vault, NOTE)
            await writeFile(source, `${await readFile(source, 'utf8')}\nOne more line.\n`)
            const held = await call('plan', { hold: [NOTE], remove: [SECOND] })
            const plan = JSON.parse(held.texts[0] ?? '') as {
                id: string
                plan: { update: string[]; remove: string[] }
            }
            expect(plan.plan.update).toEqual([])
            expect(plan.plan.remove).toEqual([SECOND])
            const removed = await call('publish', { plan: plan.id })
            const report = JSON.parse(removed.texts[0] ?? '') as {
                removed: string[]
                skipped: string[]
            }
            expect(report.removed).toEqual([SECOND])
            expect(report.skipped).toEqual([NOTE])

            const unpublished = await call('unpublish', { paths: [NOTE] })
            expect(
                (JSON.parse(unpublished.texts[0] ?? '') as { removed: string[] }).removed
            ).toEqual([NOTE])
            const takenDown = await call('takedown', { paths: [NOTE] })
            expect(
                (JSON.parse(takenDown.texts[0] ?? '') as { takenDown: string[] }).takenDown
            ).toEqual([NOTE])
            expect(await call('unlock')).toEqual({
                texts: ['{\n  "removed": false\n}\n'],
                isError: false
            })
            expect(center.state.log.map((line) => line.text)).toContain(
                'Agent publication done: 2 new, 0 updated, 0 removed, 0 forced, 0 moved, 0 failed'
            )
        } finally {
            await server.stop()
        }
    }, 120_000)

    test('a tool error goes to the agent and to the view', async () => {
        await using stores = await makeTestStores()
        const { server, call, center } = await setUp(stores)
        try {
            const answer = await call('publish', { plan: '0123456789abcdef' })

            expect(answer.isError).toBe(true)
            expect(answer.texts[0]).toContain('0123456789abcdef')
            expect(center.state.error).toBe(answer.texts[0])
            expect(center.state.activity).toBe('idle')
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('a call waits for the run of the view, then runs', async () => {
        await using stores = await makeTestStores()
        const { server, call, center } = await setUp(stores)
        try {
            await center.check()
            center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
            const publication = center.publish()

            const answer = await call('status')
            await publication

            expect(answer.isError).toBe(false)
            expect(
                (JSON.parse(answer.texts[0] ?? '') as { unchanged: string[] }).unchanged
            ).toEqual([NOTE])
            expect(center.state.error).toBeUndefined()
        } finally {
            await server.stop()
        }
    }, 120_000)

    test('a stopped server frees its port, and a new one takes it', async () => {
        await using stores = await makeTestStores()
        const { server, port, center } = await setUp(stores)
        await server.stop()
        expect(server.port).toBeUndefined()
        const again = new LocalMcpServer({
            port,
            key: () => KEY,
            version: 'test',
            operations: (one) => center.serve(one)
        })
        try {
            expect(await again.start()).toBe(port)
            expect((await send(port, { body: PING })).status).toBe(200)
        } finally {
            await again.stop()
        }
    }, 60_000)

    test('two calls at one time: the check after the publication still runs', async () => {
        await using stores = await makeTestStores()
        const { server, call, center } = await setUp(stores)
        try {
            const planned = JSON.parse(
                (await call('plan', { include: [NOTE] })).texts[0] ?? ''
            ) as {
                id: string
            }

            const [published, read] = await Promise.all([
                call('publish', { plan: planned.id }),
                call('status')
            ])

            expect(published.isError).toBe(false)
            expect(read.isError).toBe(false)
            expect(center.state.queue?.unchanged).toEqual([NOTE])
            expect(center.state.log.map((line) => line.text).join('\n')).not.toContain('refused')
        } finally {
            await server.stop()
        }
    }, 120_000)

    test('a new key refuses the old one at once', async () => {
        await using stores = await makeTestStores()
        const { server: first, center } = await setUp(stores)
        await first.stop()
        let key = KEY
        const server = new LocalMcpServer({
            port: 0,
            key: () => key,
            version: 'test',
            operations: (one) => center.serve(one)
        })
        const port = await server.start()
        try {
            expect((await send(port, { body: PING })).status).toBe(200)
            key = 'the-new-key'

            expect((await send(port, { body: PING })).status).toBe(401)
            expect(
                (
                    await send(port, {
                        body: PING,
                        headers: { Authorization: 'Bearer the-new-key' }
                    })
                ).status
            ).toBe(200)
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('a note under a guard cannot be included through the server', async () => {
        await using stores = await makeTestStores()
        const { server, call, copy } = await setUp(stores)
        try {
            const before = await lastCommit(copy)

            const answer = await call('plan', { include: ['90 Locked Shed/Shed inventory.md'] })

            expect(answer.isError).toBe(true)
            expect(answer.texts[0]).toContain('90 Locked Shed/Shed inventory.md')
            expect(await lastCommit(copy)).toBe(before)
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('an action of the author waits for a call that only reads', async () => {
        await using stores = await makeTestStores()
        const { server, center } = await setUp(stores)
        try {
            await center.check()
            center.choose((queue, choices) => toggleRow(queue, choices, NOTE))

            // The read takes the activity at once, then the author clicks.
            const read = center.serve({ tool: 'status' })
            await center.dryRun()
            await read

            expect(center.state.error).toBeUndefined()
            expect(center.state.dryRun?.plan.publish).toEqual([NOTE])
            expect(center.state.log.map((line) => line.text).join('\n')).not.toContain('refused')
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('after a run of an agent, a ticked new note that changed still stops a publication of the view', async () => {
        await using stores = await makeTestStores()
        const { server, call, center } = await setUp(stores)
        try {
            await center.check()
            center.choose((queue, choices) => toggleRow(queue, choices, NOTE))
            // Another program writes the ticked note after the check.
            center.noteChanged(NOTE)
            const planned = JSON.parse(
                (await call('plan', { include: [SECOND] })).texts[0] ?? ''
            ) as { id: string }
            expect((await call('publish', { plan: planned.id })).isError).toBe(false)

            await center.publish()

            expect(center.state.error).toContain('A new note changed after the check')
            expect(center.state.queue?.new).toContain(NOTE)
        } finally {
            await server.stop()
        }
    }, 120_000)

    test('after a run of an agent, a new note that changed and is ticked later still stops a publication', async () => {
        await using stores = await makeTestStores()
        const { server, call, center } = await setUp(stores)
        try {
            await center.check()
            center.noteChanged(NOTE)
            const planned = JSON.parse(
                (await call('plan', { include: [SECOND] })).texts[0] ?? ''
            ) as { id: string }
            expect((await call('publish', { plan: planned.id })).isError).toBe(false)
            center.choose((queue, choices) => toggleRow(queue, choices, NOTE))

            await center.publish()

            expect(center.state.error).toContain('A new note changed after the check')
        } finally {
            await server.stop()
        }
    }, 120_000)

    test('the outcome of a run is its result, not the check after it', async () => {
        await using stores = await makeTestStores()
        const { server, call, center } = await setUp(stores)
        try {
            const planned = JSON.parse(
                (await call('plan', { include: [NOTE] })).texts[0] ?? ''
            ) as {
                id: string
            }
            await call('publish', { plan: planned.id })

            expect(center.state.outcome).toBe(
                'Agent publication done: 1 new, 0 updated, 0 removed, 0 forced, 0 moved, 0 failed'
            )
            expect(center.state.log.at(-1)?.text).toStartWith('Check done:')
        } finally {
            await server.stop()
        }
    }, 120_000)

    test('a read of an agent leaves the error of the author', async () => {
        await using stores = await makeTestStores()
        const { server, call, center } = await setUp(stores)
        try {
            await center.publish()
            expect(center.state.error).toBe('check the vault first')

            await call('status')

            expect(center.state.error).toBe('check the vault first')
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('a body that is not UTF-8 is a message that is not JSON', async () => {
        await using stores = await makeTestStores()
        const { server, port } = await setUp(stores)
        try {
            const answer = await new Promise<string>((resolve, reject) => {
                const outgoing = request(
                    {
                        host: '127.0.0.1',
                        port,
                        method: 'POST',
                        path: '/mcp',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${KEY}`
                        }
                    },
                    (incoming) => {
                        const chunks: Buffer[] = []
                        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
                        incoming.on('end', () => {
                            resolve(Buffer.concat(chunks).toString('utf8'))
                        })
                    }
                )
                outgoing.on('error', reject)
                outgoing.end(
                    Buffer.concat([
                        Buffer.from('{"jsonrpc":"2.0","id":1,"method":"'),
                        Buffer.from([0xff]),
                        Buffer.from('"}')
                    ])
                )
            })

            expect(JSON.parse(answer)).toEqual({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error: the message is not JSON' }
            })
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('a port in use is an error that names it', async () => {
        await using stores = await makeTestStores()
        const { server, port, center } = await setUp(stores)
        const second = new LocalMcpServer({
            port,
            key: () => KEY,
            version: 'test',
            operations: (one) => center.serve(one)
        })
        try {
            let message = ''
            try {
                await second.start()
            } catch (error) {
                message = error instanceof Error ? error.message : ''
            }
            expect(message).toContain(String(port))
            expect(second.port).toBeUndefined()
        } finally {
            await server.stop()
        }
    }, 60_000)

    test('guards and the edits of the guards go through the server, with the face mcp-server (issue 42)', async () => {
        await using stores = await makeTestStores()
        const { server, call, copy, device, center } = await setUp(stores)
        try {
            const read = await call('guards')
            expect(read).toEqual({
                texts: [toCanonicalJson(await guards(device))],
                isError: false
            })
            expect(JSON.parse(read.texts[0] ?? '')).toEqual({
                denyList: ['80 Templates', '90 Locked Shed'],
                edits: [],
                proposals: []
            })

            const denied = await call('deny', { path: '30 People' })
            expect(denied.isError).toBe(false)
            const event = (JSON.parse(denied.texts[0] ?? '') as { edit: Record<string, unknown> })
                .edit
            expect(event).toMatchObject({
                action: 'deny',
                face: 'mcp-server',
                device: 'garden-shed',
                path: '30 People',
                state: 'applied'
            })
            expect((await lastCommit(copy)).trimEnd()).toBe(
                `Edit: deny (applied)\n\nDevice: garden-shed\nFace: mcp-server\nPlan: ${String(event['id'])}`
            )

            const allowed = await call('allow', { path: '90 Locked Shed' })
            expect(JSON.parse(allowed.texts[0] ?? '')).toMatchObject({
                edit: { action: 'allow', state: 'proposed' }
            })
            // The view shows the proposal, which only the author decides.
            expect(center.state.queue?.proposals.map((one) => one.path)).toEqual(['90 Locked Shed'])

            const refused = await call('unignore', { path: NOTE })
            expect(refused.isError).toBe(true)
            expect(refused.texts[0]).toContain('does not exclude')
        } finally {
            await server.stop()
        }
    }, 120_000)

    test('a plan without paths holds changed notes only, and a first publication, an unpublish and a takedown happen only for the named paths (TEST-25)', async () => {
        await using stores = await makeTestStores()
        const { server, call, vault, center } = await setUp(stores)
        try {
            // No path: no new note is published.
            const empty = JSON.parse((await call('plan')).texts[0] ?? '') as {
                plan: { publish: string[]; update: string[]; remove: string[] }
            }
            expect(empty.plan.publish).toEqual([])
            expect(empty.plan.update).toEqual([])
            expect(empty.plan.remove).toEqual([])

            // The first publication of exactly the named notes.
            const first = JSON.parse(
                (await call('plan', { include: [NOTE, SECOND] })).texts[0] ?? ''
            ) as { id: string }
            const published = JSON.parse(
                (await call('publish', { plan: first.id })).texts[0] ?? ''
            ) as { published: string[] }
            expect(published.published).toEqual([SECOND, NOTE])
            expect(center.state.queue?.unchanged).toEqual([SECOND, NOTE])

            // Both notes change: a plan without paths updates them, and adds no new note.
            for (const path of [NOTE, SECOND]) {
                const source = join(vault, path)
                await writeFile(source, `${await readFile(source, 'utf8')}\nOne more line.\n`)
            }
            const changed = JSON.parse((await call('plan')).texts[0] ?? '') as {
                plan: { publish: string[]; update: string[]; remove: string[] }
            }
            expect(changed.plan).toMatchObject({
                publish: [],
                update: [SECOND, NOTE],
                remove: []
            })

            // An unpublish of one note removes that note only, and holds the other one.
            const unpublished = JSON.parse(
                (await call('unpublish', { paths: [NOTE] })).texts[0] ?? ''
            ) as { removed: string[]; updated: string[]; skipped: string[]; published: string[] }
            expect(unpublished.removed).toEqual([NOTE])
            expect(unpublished.updated).toEqual([])
            expect(unpublished.published).toEqual([])
            expect(unpublished.skipped).toEqual([SECOND])

            // A takedown of one note takes that note only.
            const takenDown = JSON.parse(
                (await call('takedown', { paths: [SECOND] })).texts[0] ?? ''
            ) as { takenDown: string[] }
            expect(takenDown.takenDown).toEqual([SECOND])
            const queue = center.state.queue
            expect(queue?.changed).toEqual([])
            expect(queue?.unchanged).toEqual([])
            expect(queue?.new).toContain(NOTE)
            expect(queue?.new).toContain(SECOND)
        } finally {
            await server.stop()
        }
    }, 120_000)
})
