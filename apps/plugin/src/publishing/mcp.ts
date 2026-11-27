import { toCanonicalJson } from './canonical.ts'
import type { EditAction, EditEvent } from './edits.ts'
import definitions from './mcp-tools.json'
import { sortByCodePoint } from './order.ts'
import type { Move } from './queue.ts'
import type { GuardsReport, PublicationReport, StoredPlan, TakedownReport } from './tool.ts'

// The MCP server of the publishing tool (issue 41, TOOL-03, TOOL-27): the
// messages of the protocol and the calls of the tools, with no transport. The
// plugin serves it over HTTP on this computer (`app/mcp-server.ts`), and the
// Rust twin (`cli/src/mcp.rs`) over the standard input and output. Both read
// the tools from `mcp-tools.json` and pass the shared cases of
// `fixtures/canonical/mcp.json`. A tool does what the command of the same name
// of the command line program does, and gives the same output: no rule of the
// publishing logic lives here. The controller of the publication center runs
// the calls of the plugin (`app/center.ts`).

/** The versions of the protocol that the server knows, the newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/** The tools, as `tools/list` gives them. */
export const MCP_TOOLS = definitions.tools

/** The names of the tools: the names of the commands of the command line program, but `mcp`. */
export const TOOL_NAMES = [
    'status',
    'plan',
    'publish',
    'unpublish',
    'takedown',
    'guards',
    'deny',
    'allow',
    'ignore',
    'unignore',
    'unlock',
    'confirm_store_state',
    'deploy'
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** A call of a tool, with its arguments read. */
export type ToolCall =
    | { readonly tool: 'status' }
    | {
          readonly tool: 'plan'
          readonly include: readonly string[]
          readonly hold: readonly string[]
          readonly remove: readonly string[]
          readonly pair: readonly Move[]
          /** The paths that the author named for rule 10; no key when the call has none. */
          readonly accept?: readonly string[]
      }
    | { readonly tool: 'publish'; readonly plan: string }
    | {
          readonly tool: 'unpublish'
          readonly paths: readonly string[]
          readonly accept?: readonly string[]
      }
    | { readonly tool: 'takedown'; readonly paths: readonly string[] }
    | { readonly tool: 'guards' }
    | { readonly tool: EditAction; readonly path: string }
    | { readonly tool: 'unlock' }
    /** The confirmation of the state of the content store (R104): the last commit that the author read the difference of. */
    | { readonly tool: 'confirm_store_state'; readonly head: string }
    | {
          readonly tool: 'deploy'
          /** True to run with `--takedown`; no key when the call has none or false. */
          readonly takedown?: true
          /** True to read the last deploy report, with no deploy; no key when the call has none or false. */
          readonly last?: true
      }

/**
 * What a tool gives: the output of its command, what failed in a command that
 * still wrote its output, and the deploy report of the deploy after its push
 * (issue 32), which never turns the result into a failure.
 */
export interface ToolOutcome {
    readonly output: string
    readonly failure?: string
    readonly deploy?: string
}

/** Runs the call of a tool. A failure throws with the message for the agent. */
export type Operations = (call: ToolCall) => Promise<ToolOutcome>

export interface ServerInfo {
    readonly name: string
    readonly version: string
}

/** The name of the server in `initialize`. */
export const SERVER_NAME = 'dsebastien-vault-publish'

/** A tool call that the server cannot make: its message goes back to the agent as a tool error. */
export class ArgumentError extends Error {}

/** A tool that the server does not offer. */
class UnknownTool extends Error {}

const PARSE_ERROR = -32_700
const INVALID_REQUEST = -32_600
const METHOD_NOT_FOUND = -32_601
const INVALID_PARAMS = -32_602

type Id = string | number | null

/** True when a number of the value is not finite: `JSON.parse` reads 1e400 as Infinity. */
function holdsInfinity(value: unknown): boolean {
    if (typeof value === 'number') {
        return !Number.isFinite(value)
    }
    if (typeof value === 'object' && value !== null) {
        return Object.values(value).some(holdsInfinity)
    }
    return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTextList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isToolName(name: string): name is ToolName {
    return (TOOL_NAMES as readonly string[]).includes(name)
}

/** The keys that each tool takes. */
const ARGUMENTS: Record<ToolName, readonly string[]> = {
    status: [],
    plan: ['include', 'hold', 'remove', 'pair', 'accept'],
    publish: ['plan'],
    unpublish: ['paths', 'accept'],
    takedown: ['paths'],
    guards: [],
    deny: ['path'],
    allow: ['path'],
    ignore: ['path'],
    unignore: ['path'],
    unlock: [],
    confirm_store_state: ['head'],
    deploy: ['last', 'takedown']
}

function listOf(args: Record<string, unknown>, key: string, tool = 'plan'): readonly string[] {
    const value = args[key]
    if (value === undefined) {
        return []
    }
    if (!isTextList(value)) {
        throw new ArgumentError(`the argument "${key}" of ${tool} must be a list of vault paths`)
    }
    return value
}

/** The list `accept` of a call, as a key only when it is not empty, as the Rust face writes the call. */
function acceptOf(
    args: Record<string, unknown>,
    tool: 'plan' | 'unpublish'
): { readonly accept?: readonly string[] } {
    const accept = listOf(args, 'accept', tool)
    return accept.length === 0 ? {} : { accept }
}

function pairsOf(args: Record<string, unknown>): readonly Move[] {
    const value = args['pair']
    if (value === undefined) {
        return []
    }
    const wrong = new ArgumentError(
        'the argument "pair" of plan must be a list of objects with exactly "from" and "to", two vault paths'
    )
    if (!Array.isArray(value)) {
        throw wrong
    }
    return value.map((item: unknown) => {
        if (
            !isRecord(item) ||
            Object.keys(item).length !== 2 ||
            typeof item['from'] !== 'string' ||
            typeof item['to'] !== 'string'
        ) {
            throw wrong
        }
        return { from: item['from'], to: item['to'] }
    })
}

function pathsOf(tool: 'unpublish' | 'takedown', args: Record<string, unknown>): readonly string[] {
    const value = args['paths']
    if (!isTextList(value)) {
        throw new ArgumentError(`${tool} needs the argument "paths": a list of vault paths`)
    }
    return value
}

/**
 * The call of a tool with its arguments. It throws an `ArgumentError` with
 * the message for the agent when the arguments do not fit the tool.
 */
export function toolCallOf(name: string, args: unknown): ToolCall {
    if (!isToolName(name)) {
        throw new UnknownTool(`Unknown tool: ${name}`)
    }
    const given = args ?? {}
    if (!isRecord(given)) {
        throw new ArgumentError(`the arguments of ${name} must be an object`)
    }
    // The first key that the tool does not take, in the order of the code
    // points, as the Rust face finds it.
    const other = sortByCodePoint(Object.keys(given)).find((key) => !ARGUMENTS[name].includes(key))
    if (other !== undefined) {
        throw new ArgumentError(`${name} takes no argument "${other}"`)
    }
    switch (name) {
        case 'status':
        case 'guards':
        case 'unlock':
            return { tool: name }
        case 'deploy': {
            const flag = (key: 'takedown' | 'last'): boolean => {
                const value = given[key]
                if (value !== undefined && typeof value !== 'boolean') {
                    throw new ArgumentError(`the argument "${key}" of deploy must be true or false`)
                }
                return value === true
            }
            // In the order of their names, as the Rust face checks them.
            const last = flag('last')
            const takedown = flag('takedown')
            if (takedown && last) {
                throw new ArgumentError(
                    'deploy takes "last" to read the last report or "takedown" to deploy, not both'
                )
            }
            return {
                tool: 'deploy',
                ...(takedown ? { takedown } : {}),
                ...(last ? { last } : {})
            }
        }
        case 'deny':
        case 'allow':
        case 'ignore':
        case 'unignore': {
            const path = given['path']
            if (typeof path !== 'string') {
                throw new ArgumentError(
                    `${name} needs the argument "path": the vault path of ${name === 'ignore' || name === 'unignore' ? 'the note' : 'the folder'}`
                )
            }
            return { tool: name, path }
        }
        case 'plan':
            return {
                tool: 'plan',
                include: listOf(given, 'include'),
                hold: listOf(given, 'hold'),
                remove: listOf(given, 'remove'),
                pair: pairsOf(given),
                ...acceptOf(given, 'plan')
            }
        case 'publish': {
            const id = given['plan']
            if (typeof id !== 'string') {
                throw new ArgumentError(
                    'publish needs the argument "plan": the id that the plan tool gave'
                )
            }
            return { tool: 'publish', plan: id }
        }
        case 'unpublish':
            return { tool: name, paths: pathsOf(name, given), ...acceptOf(given, name) }
        case 'takedown':
            return { tool: name, paths: pathsOf(name, given) }
        case 'confirm_store_state': {
            const head = given['head']
            if (typeof head !== 'string') {
                throw new ArgumentError(
                    'confirm_store_state needs the argument "head": the last commit that the difference names'
                )
            }
            return { tool: name, head }
        }
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'it failed'
}

function errorAnswer(id: Id, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

function resultAnswer(id: Id, result: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function toolResult(texts: readonly string[], isError: boolean): unknown {
    return { content: texts.map((text) => ({ type: 'text', text })), isError }
}

function initializeResult(params: unknown, info: ServerInfo): unknown {
    const asked = isRecord(params) ? params['protocolVersion'] : undefined
    const version =
        typeof asked === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0]
    return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        instructions: definitions.instructions
    }
}

async function callResult(id: Id, params: unknown, operations: Operations): Promise<string> {
    const name = isRecord(params) ? params['name'] : undefined
    if (!isRecord(params) || typeof name !== 'string') {
        return errorAnswer(
            id,
            INVALID_PARAMS,
            'Invalid params: tools/call needs the name of a tool'
        )
    }
    let call: ToolCall
    try {
        call = toolCallOf(name, params['arguments'])
    } catch (error) {
        if (error instanceof UnknownTool) {
            return errorAnswer(id, INVALID_PARAMS, error.message)
        }
        return resultAnswer(id, toolResult([messageOf(error)], true))
    }
    try {
        const outcome = await operations(call)
        // The deploy report comes last: a failed deploy is no error of the tool.
        const texts = [
            outcome.output,
            ...(outcome.failure === undefined ? [] : [outcome.failure]),
            ...(outcome.deploy === undefined ? [] : [outcome.deploy])
        ]
        return resultAnswer(id, toolResult(texts, outcome.failure !== undefined))
    } catch (error) {
        return resultAnswer(id, toolResult([messageOf(error)], true))
    }
}

/**
 * The answer to one message of the client, as one line of JSON, or
 * `undefined` when the message needs none: a notification, or an answer of
 * the client. A notification never calls a tool.
 */
export async function answer(
    message: string,
    info: ServerInfo,
    operations: Operations
): Promise<string | undefined> {
    let value: unknown
    try {
        value = JSON.parse(message)
    } catch {
        return errorAnswer(null, PARSE_ERROR, 'Parse error: the message is not JSON')
    }
    // A number that a double cannot hold (1e400) is no JSON for the Rust face.
    if (holdsInfinity(value)) {
        return errorAnswer(null, PARSE_ERROR, 'Parse error: the message is not JSON')
    }
    if (Array.isArray(value)) {
        return errorAnswer(null, INVALID_REQUEST, 'Invalid Request: a batch is not supported')
    }
    if (!isRecord(value)) {
        return errorAnswer(null, INVALID_REQUEST, 'Invalid Request: the message must be an object')
    }
    const hasId = Object.hasOwn(value, 'id')
    const rawId = value['id']
    // A number id must be a whole number that a double holds exactly, so
    // that both faces give it back as it came (the Rust face reads more).
    if (hasId && typeof rawId !== 'string' && !Number.isSafeInteger(rawId)) {
        return errorAnswer(
            null,
            INVALID_REQUEST,
            'Invalid Request: the id must be a text or a whole number'
        )
    }
    // `-0` comes back as `0`, as in the Rust face.
    const id: Id = hasId ? (rawId === 0 ? 0 : (rawId as string | number)) : null
    if (value['jsonrpc'] !== '2.0') {
        return errorAnswer(id, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"')
    }
    const method = value['method']
    if (!Object.hasOwn(value, 'method')) {
        // An answer of the client: the server asks nothing, so it reads none.
        if (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error')) {
            return undefined
        }
        return hasId
            ? errorAnswer(id, INVALID_REQUEST, 'Invalid Request: the method must be a text')
            : undefined
    }
    if (typeof method !== 'string') {
        return hasId
            ? errorAnswer(id, INVALID_REQUEST, 'Invalid Request: the method must be a text')
            : undefined
    }
    if (!hasId) {
        return undefined
    }
    switch (method) {
        case 'initialize':
            return resultAnswer(id, initializeResult(value['params'], info))
        case 'ping':
            return resultAnswer(id, {})
        case 'tools/list':
            return resultAnswer(id, { tools: MCP_TOOLS })
        case 'tools/call':
            return await callResult(id, value['params'], operations)
        default:
            return errorAnswer(id, METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
}

/** The output of the `plan` tool, as the `plan` command writes it. */
export function outcomeOfPlan(stored: StoredPlan): ToolOutcome {
    return {
        output: toCanonicalJson({
            attachmentsRemoved: stored.attachmentsRemoved,
            configurationChanged: stored.configurationChanged,
            id: stored.id,
            listsNotRefreshed: stored.listsNotRefreshed,
            listsNotRefreshedReasons: stored.listsNotRefreshedReasons,
            liveQueries: stored.liveQueries,
            offline: stored.offline,
            plan: stored.plan,
            tooLarge: stored.tooLarge
        })
    }
}

/** The items of a list of a report as one text, as in Rust: `"<path>": <text>`, joined with `; `. */
function listed(items: readonly { readonly path: string; readonly text: string }[]): string {
    return items.map((item) => `"${item.path}": ${item.text}`).join('; ')
}

/** The output of the `guards` tool, as the `guards` command writes it. */
export function outcomeOfGuards(report: GuardsReport): ToolOutcome {
    return { output: toCanonicalJson(report) }
}

/** The output of a tool that edits the guards, as the command of the same name writes it: its event. */
export function outcomeOfEdit(event: EditEvent): ToolOutcome {
    return { output: toCanonicalJson({ edit: event }) }
}

/** The outcome of a publication: it failed when a note of the plan was left out, as in Rust. */
export function outcomeOfPublication(report: PublicationReport): ToolOutcome {
    const output = toCanonicalJson(report)
    const count = report.failed.length
    if (count === 0) {
        return { output }
    }
    // The failure names each note with its reason, as in Rust: a client can
    // cut the middle of a long report.
    const notes = listed(report.failed.map((one) => ({ path: one.path, text: one.reason })))
    return {
        output,
        failure:
            count === 1
                ? `1 note of the plan was left out: ${notes}`
                : `${String(count)} notes of the plan were left out: ${notes}`
    }
}

/** The outcome of a takedown: it failed when the attachment storage gave a warning, as in Rust. */
export function outcomeOfTakedown(report: TakedownReport): ToolOutcome {
    const output = toCanonicalJson(report)
    const count = report.storageWarnings.length
    return count === 0
        ? { output }
        : {
              output,
              failure: `the notes are taken down, but the attachment storage gave ${String(count)} warning(s), and a file that stays there can still be public: ${listed(report.storageWarnings.map((one) => ({ path: one.path, text: one.message })))}. Correct the storage, then run a takedown or a publication, which delete the files that no published note uses`
          }
}
