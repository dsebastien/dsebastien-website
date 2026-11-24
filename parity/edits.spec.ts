import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    FIXTURE_NOTE_TYPES,
    copyFixtureVault,
    makeContentStoreCopy,
    makeTestStores
} from '@dsebastien-website/testing'
import { toCanonicalJson } from '../apps/plugin/src/publishing/canonical.ts'
import type { EditAction } from '../apps/plugin/src/publishing/edits.ts'
import { fileNoteTypes, nodeDevice } from '../apps/plugin/src/publishing/node/device.ts'
import { edit, guards, plan, publish, status } from '../apps/plugin/src/publishing/tool.ts'
import { buildRustProgram, runRustProgram } from './harness.ts'

// The parity rule for the edits of the guards (issue 42, R69): the same edits
// through the TypeScript and the Rust implementation give the same events, the
// same `edits.json` and `configuration.json`, the same notes in the vault, and
// the same queue, plan and guards after them. A failure here blocks a release.

const DEVICE = 'garden-shed'
const PUBLISHED = '10 Garden/Compost basics.md'
const WRITING = '40 Writing/Reading list.md'
const NEVER = '10 Garden/Wormery.md'
const JOURNALS = join('.obsidian', 'plugins', 'dsebastien-vault-publish', 'renames')

/**
 * The edits, in order: each is applied, proposed or refused the same way by
 * both. A refusal states a part of its reason that both implementations write.
 */
const EDITS: readonly { action: EditAction; path: string; time: string; refused?: string }[] = [
    // A folder with no note on the site: it applies at once.
    { action: 'deny', path: '30 People', time: '2031-04-02T08:00:00Z' },
    // The same folder again: refused.
    {
        action: 'deny',
        path: '30 People',
        time: '2031-04-02T08:01:00Z',
        refused: 'already in the deny list'
    },
    // A folder with a published note: a proposal that names it.
    { action: 'deny', path: '40 Writing', time: '2031-04-02T08:02:00Z' },
    // A looser edit: always a proposal.
    { action: 'allow', path: '90 Locked Shed', time: '2031-04-02T08:03:00Z' },
    // A note that was never published: the property is written at once.
    { action: 'ignore', path: NEVER, time: '2031-04-02T08:04:00Z' },
    // A published note: a proposal.
    { action: 'ignore', path: PUBLISHED, time: '2031-04-02T08:05:00Z' },
    // The removal of the property: always a proposal.
    { action: 'unignore', path: NEVER, time: '2031-04-02T08:06:00Z' },
    // A folder that is not an entry of the deny list: refused.
    {
        action: 'allow',
        path: '10 Garden',
        time: '2031-04-02T08:07:00Z',
        refused: 'is not an entry of the deny list'
    }
]

/**
 * The outcome of an edit for the comparison: the event, or `refused:` and the
 * part of the reason that the step states (else the whole message, which
 * then differs between the two and fails the test).
 */
function refusal(message: string, reason: string | undefined): string {
    return `refused: ${reason !== undefined && message.includes(reason) ? reason : message}`
}

interface Tool {
    publish(include: readonly string[], time: string): Promise<void>
    /** The event as canonical data, or `refused:` and the reason (see `refusal`). */
    edit(action: EditAction, path: string, time: string, reason?: string): Promise<string>
    guards(): Promise<string>
    status(): Promise<string>
    /** The plan of a selection without paths, as canonical data. */
    plan(): Promise<string>
}

let program: string

beforeAll(async () => {
    program = await buildRustProgram()
}, 600_000)

function storageOf(copy: string): string {
    return join(dirname(copy), 'attachment-storage')
}

function typescriptTool(vault: string, copy: string): Tool {
    const device = nodeDevice({
        noteTypes: fileNoteTypes(FIXTURE_NOTE_TYPES),
        vault,
        contentStore: copy,
        attachmentStorage: storageOf(copy)
    })
    const runAt = (time: string) => ({ time, device: DEVICE, face: 'command-line' }) as const
    return {
        async publish(include, time) {
            const planned = await plan(device, { include })
            await publish(device, planned.id, runAt(time))
        },
        async edit(action, path, time, reason) {
            try {
                return toCanonicalJson({ edit: await edit(device, { action, path }, runAt(time)) })
            } catch (error) {
                return refusal(error instanceof Error ? error.message : '', reason)
            }
        },
        guards: async () => toCanonicalJson(await guards(device)),
        status: async () => toCanonicalJson(await status(device)),
        plan: async () => toCanonicalJson((await plan(device, { include: [] })).plan)
    }
}

function rustTool(vault: string, copy: string): Tool {
    const places = ['--vault', vault, '--content-store', copy]
    const call = async (
        args: readonly string[]
    ): Promise<{ code: number; out: string; errors: string }> => {
        const result = await runRustProgram(program, [args[0] ?? '', ...places, ...args.slice(1)])
        return {
            code: result.exitCode,
            out: new TextDecoder().decode(result.stdout),
            errors: result.stderr
        }
    }
    return {
        async publish(include, time) {
            const planned = await call(['plan', ...include.flatMap((path) => ['--include', path])])
            expect(planned.code).toBe(0)
            const { id } = JSON.parse(planned.out) as { id: string }
            const published = await call([
                'publish',
                '--attachment-storage',
                storageOf(copy),
                '--plan',
                id,
                '--time',
                time,
                '--device',
                DEVICE
            ])
            expect(published.code).toBe(0)
        },
        async edit(action, path, time, reason) {
            const result = await call([action, '--path', path, '--time', time, '--device', DEVICE])
            return result.code === 0 ? result.out : refusal(result.errors, reason)
        },
        guards: async () => (await call(['guards'])).out,
        status: async () => (await call(['status'])).out,
        async plan() {
            const planned = await call(['plan'])
            expect(planned.code).toBe(0)
            return toCanonicalJson((JSON.parse(planned.out) as { plan: never }).plan)
        }
    }
}

interface Outcome {
    events: string[]
    guards: string
    status: string
    plan: string
    files: Record<string, string>
}

async function outcomeOf(toolOf: (vault: string, copy: string) => Tool): Promise<Outcome> {
    await using stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    const tool = toolOf(vault, copy)
    await tool.publish([PUBLISHED, WRITING], '2031-04-01T08:00:00Z')
    const events: string[] = []
    for (const { action, path, time, refused } of EDITS) {
        events.push(await tool.edit(action, path, time, refused))
    }
    const text = (path: string): Promise<string> => readFile(path, 'utf8')
    return {
        events,
        guards: await tool.guards(),
        status: await tool.status(),
        plan: await tool.plan(),
        files: {
            'configuration.json': await text(join(copy, 'configuration.json')),
            'edits.json': await text(join(copy, 'edits.json')),
            [NEVER]: await text(join(vault, NEVER)),
            [PUBLISHED]: await text(join(vault, PUBLISHED))
        }
    }
}

describe('parity of the edits of the guards', () => {
    test('both implementations write the same events, files, queue, plan and guards', async () => {
        const fromTypeScript = await outcomeOf(typescriptTool)
        const fromRust = await outcomeOf(rustTool)

        expect(fromRust).toEqual(fromTypeScript)
        // What the edits did, so that two implementations that agree on a wrong
        // result still fail.
        const states = fromTypeScript.events.map((event) =>
            event.startsWith('refused: ')
                ? event
                : (JSON.parse(event) as { edit: { state: string } }).edit.state
        )
        expect(states).toEqual([
            'applied',
            'refused: already in the deny list',
            'proposed',
            'proposed',
            'applied',
            'proposed',
            'proposed',
            'refused: is not an entry of the deny list'
        ])
        expect(JSON.parse(fromTypeScript.events[2] ?? '')).toMatchObject({
            edit: { removes: [WRITING] }
        })
        expect(fromTypeScript.files['configuration.json']).toBe(
            toCanonicalJson({ denyList: ['80 Templates', '90 Locked Shed', '30 People'] })
        )
        expect(fromTypeScript.files[NEVER]).toContain('publish_ignore: true')
        expect(fromTypeScript.files[PUBLISHED]).not.toContain('publish_ignore')
        const queue = JSON.parse(fromTypeScript.status) as { proposals: unknown[] }
        expect(queue.proposals).toHaveLength(4)
        const planned = JSON.parse(fromTypeScript.plan) as { edits: unknown[] }
        expect(planned.edits).toHaveLength(6)
    }, 300_000)

    test('both count a published note that a rename journal moves under the new guard', async () => {
        const outcome = async (
            toolOf: (vault: string, copy: string) => Tool
        ): Promise<{ event: string; status: string; guards: string }> => {
            await using stores = await makeTestStores()
            const vault = await copyFixtureVault(stores)
            const copy = await makeContentStoreCopy(stores)
            const tool = toolOf(vault, copy)
            await tool.publish([PUBLISHED], '2031-04-01T08:00:00Z')
            // The journal of another device moves the note into the folder,
            // and this device still has the old file.
            const moved = '30 People/Compost basics.md'
            const journal = join(vault, JOURNALS, '00000000000000aa.jsonl')
            await mkdir(dirname(journal), { recursive: true })
            await writeFile(join(vault, moved), await readFile(join(vault, PUBLISHED), 'utf8'))
            await writeFile(
                journal,
                `${JSON.stringify({ from: PUBLISHED, kind: 'note', time: '2031-04-01T09:00:00Z', to: moved })}\n`
            )
            return {
                event: await tool.edit('deny', '30 People', '2031-04-02T08:00:00Z'),
                status: await tool.status(),
                guards: await tool.guards()
            }
        }
        const fromTypeScript = await outcome(typescriptTool)
        const fromRust = await outcome(rustTool)

        expect(fromRust).toEqual(fromTypeScript)
        expect(JSON.parse(fromTypeScript.event)).toMatchObject({
            edit: { state: 'proposed', removes: [PUBLISHED] }
        })
    }, 300_000)

    test('both apply a deny whose attachment only a note under a guard uses (review round 2, finding 1)', async () => {
        const outcome = async (
            toolOf: (vault: string, copy: string) => Tool
        ): Promise<{ event: string; status: string; guards: string }> => {
            await using stores = await makeTestStores()
            const vault = await copyFixtureVault(stores)
            const copy = await makeContentStoreCopy(stores)
            const tool = toolOf(vault, copy)
            await mkdir(join(vault, 'Pub'), { recursive: true })
            await mkdir(join(vault, 'img'), { recursive: true })
            await writeFile(join(vault, 'Pub', 'p.md'), '# P\n\n![[pic.png]]\n')
            await writeFile(
                join(vault, 'img', 'pic.png'),
                Buffer.from(
                    '89504e470d0a1a0a0000000d49484452000000100000000c080200000000000000',
                    'hex'
                )
            )
            await tool.publish(['Pub/p.md'], '2031-04-01T08:00:00Z')
            // The author adds the ignore property by hand: the entry is a
            // forced removal with the guards of now and with the deny.
            await writeFile(
                join(vault, 'Pub', 'p.md'),
                '---\npublish_ignore: true\n---\n# P\n\n![[pic.png]]\n'
            )
            return {
                event: await tool.edit('deny', 'img', '2031-04-02T08:00:00Z'),
                status: await tool.status(),
                guards: await tool.guards()
            }
        }
        const fromTypeScript = await outcome(typescriptTool)
        const fromRust = await outcome(rustTool)

        expect(fromRust).toEqual(fromTypeScript)
        const { edit } = JSON.parse(fromTypeScript.event) as {
            edit: { state: string; removes?: unknown; affects?: unknown }
        }
        expect(edit.state).toBe('applied')
        expect(edit.removes).toBeUndefined()
        expect(edit.affects).toBeUndefined()
    }, 300_000)
})
