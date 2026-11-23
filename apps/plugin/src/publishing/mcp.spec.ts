import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
    answer,
    MCP_TOOLS,
    outcomeOfPublication,
    outcomeOfTakedown,
    PROTOCOL_VERSIONS,
    toolCallOf,
    TOOL_NAMES
} from './mcp.ts'
import type { ToolCall, ToolOutcome } from './mcp.ts'
import definitions from './mcp-tools.json'

// The protocol of the MCP server of the publishing tool (issue 41, TOOL-03):
// the shared cases that the Rust face reads too (`cli/src/mcp.rs`). The
// operations are a stand-in here: the cases check the messages, the
// arguments and the answers. The operations on a real device are tested in
// `mcp-server.spec.ts`.
const CASES = fileURLToPath(new URL('../../../../fixtures/canonical/mcp.json', import.meta.url))

interface Case {
    readonly name: string
    readonly request: unknown
    readonly call: unknown
    readonly operation?: { output?: string; failure?: string; error?: string }
    readonly response: unknown
}

// The file is test data of this repository. The cast is the boundary: a wrong
// shape fails the tests that read it.
const cases = ((await Bun.file(CASES).json()) as { cases: Case[] }).cases

const INFO = { name: 'dsebastien-vault-publish', version: 'test' }

/** The expected answer, with the instructions and the tools of `mcp-tools.json`. */
function expected(value: unknown): unknown {
    if (value === '<instructions>') {
        return definitions.instructions
    }
    if (value === '<tools>') {
        return definitions.tools
    }
    if (Array.isArray(value)) {
        return value.map(expected)
    }
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expected(item)]))
    }
    return value
}

describe('the shared cases of the MCP server', () => {
    test.each(cases.map((one) => [one.name, one] as const))('%s', async (_name, one) => {
        const calls: ToolCall[] = []
        const operations = (call: ToolCall): Promise<ToolOutcome> => {
            calls.push(call)
            const outcome = one.operation ?? {}
            if (outcome.error !== undefined) {
                return Promise.reject(new Error(outcome.error))
            }
            return Promise.resolve({
                output: outcome.output ?? '',
                ...(outcome.failure === undefined ? {} : { failure: outcome.failure })
            })
        }
        const message = typeof one.request === 'string' ? one.request : JSON.stringify(one.request)

        const response = await answer(message, INFO, operations)

        expect(calls).toEqual(one.call === null ? [] : [one.call as ToolCall])
        expect(response === undefined ? null : JSON.parse(response)).toEqual(expected(one.response))
    })

    test('the shared file has cases of each kind', () => {
        expect(cases.length).toBeGreaterThan(30)
        const called = new Set(
            cases.flatMap((one) => (one.call === null ? [] : [(one.call as ToolCall).tool]))
        )
        expect([...called].sort()).toEqual([...TOOL_NAMES].sort())
    })
})

describe('the tools of the MCP server', () => {
    test('are the tools of the shared file, in its order', () => {
        expect(MCP_TOOLS).toEqual(definitions.tools)
        expect(definitions.tools.map((tool): string => tool.name)).toEqual([...TOOL_NAMES])
    })

    test('are the operations of the command line program (TOOL-03, TEST-17)', () => {
        // The Rust face compares its tools with its commands (`cli/src/mcp.rs`).
        expect([...TOOL_NAMES].sort()).toEqual([
            'plan',
            'publish',
            'status',
            'takedown',
            'unlock',
            'unpublish'
        ])
    })

    test.each(TOOL_NAMES.map((name) => [name]))('%s has a call', (name) => {
        const args =
            name === 'publish'
                ? { plan: '0123456789abcdef' }
                : name === 'unpublish' || name === 'takedown'
                  ? { paths: ['a.md'] }
                  : {}
        expect(toolCallOf(name, args).tool).toBe(name)
    })

    test('the selection of a plan holds every list of the selection file', () => {
        // The four lists of `plan --selection` (cli/src/main.rs).
        const plan = definitions.tools.find((tool) => tool.name === 'plan')
        expect(Object.keys(plan?.inputSchema.properties ?? {}).sort()).toEqual([
            'hold',
            'include',
            'pair',
            'remove'
        ])
    })

    test('the newest version comes first', () => {
        expect([...PROTOCOL_VERSIONS].sort().reverse()).toEqual([...PROTOCOL_VERSIONS])
    })
})

const SKILL = fileURLToPath(
    new URL('../../../../skills/developassion-publish-notes/SKILL.md', import.meta.url)
)
const text = await Bun.file(SKILL).text()

describe('the skill of the publishing tool (TOOL-04)', () => {
    test('names every tool, and every argument of each tool', () => {
        for (const tool of definitions.tools) {
            expect(text).toContain(`\`${tool.name}\``)
            for (const key of Object.keys(tool.inputSchema.properties)) {
                expect(text).toContain(`\`${key}\``)
            }
        }
    })

    test('names the faces: the server of the plugin, the mcp command and the commands', () => {
        expect(text).toContain('http://127.0.0.1:<port>/mcp')
        expect(text).toContain('dsebastien-vault-publish mcp --vault')
        expect(text).toContain('dsebastien-vault-publish status --vault')
    })

    test('has the name of its folder', () => {
        expect(text).toStartWith('---\nname: developassion-publish-notes\n')
    })
})

describe('the failure texts of the tools', () => {
    const report = {
        attachmentsDeleted: [],
        attachmentsUploaded: [],
        failed: [
            { path: 'a.md', reason: 'the upload failed' },
            { path: 'b.md', reason: 'it cannot be read' }
        ],
        forcedRemoved: [],
        moved: [],
        propertyRemoved: [],
        propertySet: [],
        published: [],
        removed: [],
        skipped: [],
        updated: [],
        warnings: []
    }

    test('a publication names each note that was left out, with its reason', () => {
        expect(outcomeOfPublication(report).failure).toBe(
            '2 notes of the plan were left out: "a.md": the upload failed; "b.md": it cannot be read'
        )
        expect(
            outcomeOfPublication({
                ...report,
                failed: [{ path: 'a.md', reason: 'the upload failed' }]
            }).failure
        ).toBe('1 note of the plan was left out: "a.md": the upload failed')
        expect(outcomeOfPublication({ ...report, failed: [] }).failure).toBeUndefined()
    })

    test('a takedown names each file of the storage that gave a warning', () => {
        expect(
            outcomeOfTakedown({
                attachmentsDeleted: [],
                propertyRemoved: [],
                storageWarnings: [{ path: 'k1', message: 'it cannot be deleted' }],
                takenDown: ['a.md'],
                warnings: []
            }).failure
        ).toContain('can still be public: "k1": it cannot be deleted. Correct the storage')
    })
})
