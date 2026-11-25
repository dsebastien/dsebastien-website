import { toCanonicalJson } from './canonical.ts'
import type { CanonicalValue } from './canonical.ts'

// The deploy that the tool starts after a push (issue 32, BUILD-02, PUB-42,
// decision R76): the deploy command of the site runs on this machine, in a
// clean clone of the site code that is kept for deploys, and gives its result
// as the last line of its standard output. This module makes the command and
// reads the result. It starts no process: the face gives the port that does
// (`app/deploy.ts`), and a test gives a fake. The Rust twin is
// `cli/src/deploy.rs`; both read the shared cases of
// `fixtures/canonical/deploy.json`.
//
// The publication is done at the push: a deploy that fails never undoes it,
// and never turns the publication report into a failure. The deploy report
// is apart from the publication report, which the parity rule compares.

/** The settings of a deploy on this device. An empty text is a setting that is not set. */
export interface DeploySettings {
    /** The folder of the clean clone of the site code, kept for deploys. */
    readonly siteCode: string
    /** The private target file of the deployment (the names of the host). */
    readonly target: string
    /** The private env file that holds the token of the deployment. Optional. */
    readonly envFile: string
    /** The bun program. Empty for `bun` of the path of the system. */
    readonly bun: string
    /** The folder of the copy of the content store. */
    readonly contentStore: string
    /** The folder of the attachment storage. */
    readonly attachments: string
    /** The time limit of the deploy, in minutes. Absent for 30. */
    readonly timeoutMinutes?: number
}

/** The time limit of a deploy when the settings name none, in minutes. */
export const DEFAULT_TIMEOUT_MINUTES = 30

/** The most for the time limit of a deploy, in minutes: 24 hours. A timer of the plugin holds it. */
export const MAX_TIMEOUT_MINUTES = 1440

/**
 * What the tool runs: a program with a list of arguments, no shell, in a
 * folder, stopped with the programs that it started after its time limit.
 */
export interface DeployCommand {
    readonly program: string
    readonly args: readonly string[]
    readonly folder: string
    readonly timeoutMinutes: number
}

/** What a run of the deploy gave. */
export interface ChildRun {
    /** The exit code, or `null` when a signal stopped the program. */
    readonly code: number | null
    /** The standard output, where the last line is the result. */
    readonly stdout: string
    /** The whole output (standard output and errors), for the author only. */
    readonly output: string
    /** Why the tool stopped the deploy: its time limit, or the author. Absent when it ended by itself. */
    readonly stopped?: 'time' | 'author'
}

/**
 * A takedown that waits for its deploy: the commit of its push, or, before
 * the push, the commit of the copy before it (`above`, `null` for a copy
 * with no commit): the commit of the takedown comes after it. `any` is an
 * entry that cannot be read: any deploy with `--takedown` that succeeds
 * settles it.
 */
export type TakedownEntry =
    { readonly commit: string } | { readonly above: string | null } | { readonly any: true }

/**
 * The marker of the takedowns of this device, one entry per takedown, in the
 * git folder of the copy (`.git/vault-publish/takedowns/`). An entry is
 * written before the push of a takedown and holds its commit after it; it
 * goes when nothing was pushed. Every deploy runs with `--takedown` while an
 * entry is there, and a deploy with `--takedown` that succeeded removes only
 * the entries that its release holds: its content revision is the commit of
 * the entry or descends from it. So a takedown is never lost when its
 * deploy fails, waits, is skipped or is stopped, or when an older deploy
 * ends after its push.
 */
export interface TakedownMarker {
    /** The entries, with their ids. It throws when they cannot be read: the marker then counts as set. */
    entries(): Promise<readonly { readonly id: string; readonly entry: TakedownEntry }[]>
    /** Adds an entry, and gives its id. */
    add(entry: TakedownEntry): Promise<string>
    /** Writes the entry of this id again. */
    replace(id: string, entry: TakedownEntry): Promise<void>
    remove(id: string): Promise<void>
    /**
     * True when `ancestor` is `revision` or one of its ancestors in the copy,
     * false when it is not, `undefined` when the copy does not know them.
     */
    isAncestor(ancestor: string, revision: string): Promise<boolean | undefined>
}

/** The entry of a takedown as its file holds it, or `any` for a text that cannot be read. */
export function takedownEntryOf(text: string): TakedownEntry {
    try {
        const value: unknown = JSON.parse(text)
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const keys = Object.keys(value)
            const record = value as Record<string, unknown>
            if (keys.length === 1 && typeof record['commit'] === 'string') {
                return { commit: record['commit'] }
            }
            if (
                keys.length === 1 &&
                'above' in record &&
                (typeof record['above'] === 'string' || record['above'] === null)
            ) {
                return { above: record['above'] }
            }
        }
    } catch {
        // A file that a stop cut: it still counts.
    }
    return { any: true }
}

/** The text of the file of an entry, in the canonical form (`any` is never written). */
export function takedownEntryText(entry: TakedownEntry): string {
    if ('commit' in entry) {
        return toCanonicalJson({ commit: entry.commit })
    }
    if ('above' in entry) {
        return entry.above === null
            ? '{\n  "above": null\n}\n'
            : toCanonicalJson({ above: entry.above })
    }
    return toCanonicalJson({ any: true })
}

/**
 * True when a release of this content revision holds the takedown of the
 * entry. A release built elsewhere (`null`) holds none, and a commit that
 * the copy does not know counts as not held.
 */
export async function holdsTakedown(
    entry: TakedownEntry,
    revision: string | null,
    isAncestor: (ancestor: string, revision: string) => Promise<boolean | undefined>
): Promise<boolean> {
    if ('any' in entry) {
        return true
    }
    if (revision === null) {
        return false
    }
    if ('commit' in entry) {
        return revision === entry.commit || (await isAncestor(entry.commit, revision)) === true
    }
    if (revision === entry.above) {
        return false
    }
    return entry.above === null || (await isAncestor(entry.above, revision)) === true
}

/**
 * The record of the deploys of this device, in the git folder of the copy:
 * whether a deploy runs (`.git/vault-publish/deploy-running`) and the report
 * of the last one (`deploy-report.json`), so that an agent reads them later
 * and every face of this device sees them. A deploy that stopped with its
 * program (a crash) shows as running until the next deploy ends.
 */
export interface DeployRecord {
    setRunning(running: boolean): Promise<void>
    running(): Promise<boolean>
    /** Keeps the text of the last deploy report (`deploymentText`). */
    saveLast(text: string): Promise<void>
    /** The text of the last deploy report, or `undefined` when there is none. */
    last(): Promise<string | undefined>
}

/** What a deploy follows: a push, or nothing (a deploy again), and whether it runs with `--takedown`. */
export interface DeployKind {
    readonly push: 'ok' | 'skipped'
    readonly takedown: boolean
}

/**
 * The port that starts the deploy as a child process. It throws when the
 * program cannot start. After the time limit of the command, or when the
 * signal aborts, it stops the program with the programs that it started.
 */
export interface DeployProcess {
    run(command: DeployCommand, signal?: AbortSignal): Promise<ChildRun>
}

export type StepResult = 'ok' | 'failed' | 'skipped'

/**
 * The deploy report: the push, the build and the deploy apart (PUB-42), and
 * "live" with the URL when the deployment record names the new revision
 * (STORE-08, PUB-43). A field that is not known is absent.
 */
export interface DeployReport {
    /** `skipped` for a deploy again, with no publication. */
    readonly push: 'ok' | 'skipped'
    /** True for a deploy with `--takedown`. */
    readonly takedown: boolean
    readonly build: StepResult
    readonly deploy: StepResult
    readonly live: boolean
    readonly url?: string
    readonly contentRevision?: string
    readonly uploaded: number
    readonly deleted: number
    readonly warnings: readonly string[]
    readonly error?: string
}

/** A deploy report with the whole output of the child, which only the author sees. */
export interface Deployment {
    readonly report: DeployReport
    readonly output: string
}

/** The start of the last line of the standard output of the deploy. */
export const RESULT_PREFIX = 'DEPLOY-RESULT '

type SettingName = Exclude<keyof DeploySettings, 'timeoutMinutes'>

/** The name of each setting in a message, and its option in the command line program. */
const SETTINGS: Record<SettingName, { readonly name: string; readonly option: string }> = {
    siteCode: { name: 'the folder of the site code', option: '--site-code' },
    target: { name: 'the target file of the deployment', option: '--deploy-target' },
    envFile: { name: 'the env file of the deployment', option: '--deploy-env-file' },
    bun: { name: 'the bun program', option: '--bun' },
    contentStore: { name: 'the copy of the content store', option: '--content-store' },
    attachments: { name: 'the attachment storage', option: '--attachment-storage' }
}

/** The settings that a deploy needs, in the order of a message. */
const REQUIRED: readonly SettingName[] = ['siteCode', 'target', 'contentStore', 'attachments']

/** The settings that must be absolute paths when they are set, in the order of a message. */
const PATHS: readonly SettingName[] = [
    'siteCode',
    'target',
    'envFile',
    'bun',
    'contentStore',
    'attachments'
]

/**
 * True for an absolute path, by one rule in both faces: on Unix a path that
 * starts with `/`; on Windows a drive with its separator (`C:\`, `C:/`) or a
 * network path (`\\server\share`). On Windows, `\foo` and `/foo` are not
 * absolute: they depend on the drive of the moment.
 */
export function isAbsolutePath(path: string, windows: boolean): boolean {
    if (!windows) {
        return path.startsWith('/')
    }
    return /^[A-Za-z]:[\\/]/u.test(path) || /^[\\/]{2}[^\\/]/u.test(path)
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
    const last = items.at(-1) ?? ''
    return items.length < 2 ? last : `${items.slice(0, -1).join(', ')} and ${last}`
}

/**
 * The command of the deploy (the interface of `scripts/deploy.ts`), or the
 * error of a deploy report that deploys nothing: a setting that is not set,
 * or a path that is not absolute (`isAbsolutePath`). Every path is absolute,
 * so no argument starts with `-`.
 *
 * @param windows true on Windows, for the rule of an absolute path
 */
export function deployCommandOf(
    settings: DeploySettings,
    takedown: boolean,
    windows: boolean
): { readonly command: DeployCommand } | { readonly error: string } {
    const missing = REQUIRED.filter((key) => settings[key] === '')
    if (missing.length > 0) {
        const names = listed(missing.map((key) => SETTINGS[key].name))
        const options = listed(missing.map((key) => SETTINGS[key].option))
        return {
            error: `nothing was deployed: ${names} ${missing.length === 1 ? 'is' : 'are'} not set (in the settings of Vault Publish, or ${options} of the command line program)`
        }
    }
    const relative = PATHS.find(
        (key) => settings[key] !== '' && !isAbsolutePath(settings[key], windows)
    )
    if (relative !== undefined) {
        return {
            error: `nothing was deployed: ${SETTINGS[relative].name} must be an absolute path: "${settings[relative]}"`
        }
    }
    const timeoutMinutes = settings.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES
    if (
        !Number.isSafeInteger(timeoutMinutes) ||
        timeoutMinutes < 1 ||
        timeoutMinutes > MAX_TIMEOUT_MINUTES
    ) {
        return {
            error: `nothing was deployed: the time limit of the deploy must be a whole number of minutes from 1 to ${String(MAX_TIMEOUT_MINUTES)}`
        }
    }
    return {
        command: {
            program: settings.bun === '' ? 'bun' : settings.bun,
            folder: settings.siteCode,
            timeoutMinutes,
            args: [
                ...(settings.envFile === '' ? [] : [`--env-file=${settings.envFile}`]),
                'run',
                'deploy',
                '--from-main',
                '--target',
                settings.target,
                '--content-store',
                settings.contentStore,
                '--attachments',
                settings.attachments,
                ...(takedown ? ['--takedown'] : [])
            ]
        }
    }
}

/**
 * True when the deploy succeeded: `deploy` is `ok` and no error came. A
 * deploy with `--takedown` must also be seen live: the pages of the
 * takedown must be gone.
 */
export function succeeded(report: DeployReport): boolean {
    return report.deploy === 'ok' && report.error === undefined && (!report.takedown || report.live)
}

/** The error of a deploy with `--takedown` that was not seen live, as the deploy command writes it. */
export const TAKEDOWN_NOT_LIVE =
    'the release of the takedown was not seen live, so the takedown waits for a deploy that is seen live'

/** A report with no step done, before the warning of a takedown. */
function bare(error: string, kind: DeployKind): DeployReport {
    return {
        push: kind.push,
        takedown: kind.takedown,
        build: 'skipped',
        deploy: 'skipped',
        live: false,
        uploaded: 0,
        deleted: 0,
        warnings: [],
        error
    }
}

/** The warning of a takedown whose deploy did not succeed (PUB-42). */
export const TAKEDOWN_WAITS =
    'the notes of the takedown can still be live until a deploy with --takedown succeeds: the next deploy runs with --takedown'

/** A report of a deploy with `--takedown` that did not succeed warns that the takedown waits. */
function withTakedown(report: DeployReport): DeployReport {
    return report.takedown && !succeeded(report)
        ? { ...report, warnings: [...report.warnings, TAKEDOWN_WAITS] }
        : report
}

/** A deploy report that deploys nothing, with its reason. */
export function reportOfNothing(error: string, kind: DeployKind): DeployReport {
    return withTakedown(bare(error, kind))
}

/** The deploy report of a program that could not start. */
export function reportOfStartError(message: string, kind: DeployKind): DeployReport {
    return withTakedown({
        ...bare(`the deploy could not start: ${message}`, kind),
        deploy: 'failed'
    })
}

/** The deploy report of a deploy that the tool stopped: after its time limit, or for the author. */
export function reportOfStop(
    stopped: 'time' | 'author',
    timeoutMinutes: number,
    kind: DeployKind
): DeployReport {
    const why =
        stopped === 'time'
            ? `after its time limit of ${String(timeoutMinutes)} minutes`
            : 'by the author'
    return failed(
        `the deploy was stopped ${why}, with the programs that it started: ${READ_OUTPUT}`,
        kind
    )
}

function failed(error: string, kind: DeployKind): DeployReport {
    return withTakedown({ ...bare(error, kind), build: 'failed', deploy: 'failed' })
}

const READ_OUTPUT = 'read the output of the deploy'

function isStep(value: unknown): value is StepResult {
    return value === 'ok' || value === 'failed' || value === 'skipped'
}

/** A count: a whole number from 0 that a double holds exactly, in any form of JSON (`1.0`, `1e2`, `-0`). */
function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** True when a number of the value is not finite: `JSON.parse` reads 1e400 as Infinity, which is no JSON for the Rust face. */
function holdsInfinity(value: unknown): boolean {
    if (typeof value === 'number') {
        return !Number.isFinite(value)
    }
    if (typeof value === 'object' && value !== null) {
        return Object.values(value).some(holdsInfinity)
    }
    return false
}

/** A line of the output with its end and a byte order mark at its start taken away. */
function lineOf(line: string): string {
    return line.replace(/\r$/u, '').replace(/^\uFEFF/u, '')
}

/** A line with spaces and tabs only, which the result never is. */
function isBlank(line: string): boolean {
    return /^[ \t]*$/u.test(line)
}

function isOptionalText(value: unknown): value is string | null | undefined {
    return value === undefined || value === null || typeof value === 'string'
}

/** The result line, read strictly, or `undefined` when its shape is wrong. Unknown fields are ignored. */
function resultOf(value: unknown, kind: DeployKind): DeployReport | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined
    }
    const result = value as Record<string, unknown>
    const { build, deploy, live, url, contentRevision, uploaded, deleted, warnings, error } = result
    if (
        !isStep(build) ||
        !isStep(deploy) ||
        typeof live !== 'boolean' ||
        !isOptionalText(url) ||
        !isOptionalText(contentRevision) ||
        !isCount(uploaded) ||
        !isCount(deleted) ||
        !Array.isArray(warnings) ||
        !warnings.every((one) => typeof one === 'string') ||
        !isOptionalText(error)
    ) {
        return undefined
    }
    return {
        push: kind.push,
        takedown: kind.takedown,
        build,
        deploy,
        live,
        // An empty text is a field that the deploy did not know (a target
        // file that cannot be read gives an empty URL).
        ...(typeof url === 'string' && url !== '' ? { url } : {}),
        ...(typeof contentRevision === 'string' && contentRevision !== ''
            ? { contentRevision }
            : {}),
        // `-0` is 0.
        uploaded: uploaded + 0,
        deleted: deleted + 0,
        warnings,
        ...(typeof error === 'string' && error !== '' ? { error } : {})
    }
}

/**
 * The deploy report of a run of the deploy, from its exit code and its
 * standard output: the last line is the result. A missing or broken result
 * line is a failed deploy. The deploy succeeded only when the exit code is 0
 * and the result says so.
 */
export function reportOfRun(code: number | null, stdout: string, kind: DeployKind): DeployReport {
    const ended = code === null ? 'stopped by a signal' : `exit code ${String(code)}`
    const last =
        stdout
            .split('\n')
            .map(lineOf)
            .findLast((line) => !isBlank(line)) ?? ''
    if (!last.startsWith(RESULT_PREFIX)) {
        return failed(`the deploy gave no result line (${ended}): ${READ_OUTPUT}`, kind)
    }
    let value: unknown
    try {
        value = JSON.parse(last.slice(RESULT_PREFIX.length))
    } catch {
        value = Infinity
    }
    if (holdsInfinity(value)) {
        return failed(`the result line of the deploy is not JSON: ${READ_OUTPUT}`, kind)
    }
    const result = resultOf(value, kind)
    if (result === undefined) {
        return failed(`the result line of the deploy has the wrong shape: ${READ_OUTPUT}`, kind)
    }
    if (result.deploy === 'ok' && code === 0 && result.error === undefined) {
        return result.takedown && !result.live
            ? withTakedown({ ...result, error: TAKEDOWN_NOT_LIVE })
            : result
    }
    // A step after the switch failed (a cleanup of a takedown): the error
    // of the deploy and "live" stay, and the deploy is no success.
    if (result.deploy === 'ok' && result.error !== undefined) {
        return withTakedown(result)
    }
    if (result.deploy === 'ok') {
        return withTakedown({
            ...result,
            deploy: 'failed',
            live: false,
            error: `the deploy ${code === null ? 'was stopped by a signal' : `ended with the exit code ${String(code)}`}, but its result line says that it succeeded: ${READ_OUTPUT}`
        })
    }
    return withTakedown({
        ...result,
        live: false,
        error: result.error ?? `the deploy did not succeed (${ended}): ${READ_OUTPUT}`
    })
}

/**
 * Runs the deploy of the settings, or gives the report that names the
 * missing setting. The deploy never throws: its failures are in the report.
 * It runs with `--takedown` when the run asks for it or when the marker of a
 * takedown is set, and removes the marker only when such a deploy succeeded.
 * The record says that it runs, then keeps its report; a record that cannot
 * be written stops nothing.
 */
export async function runDeploy(
    child: DeployProcess,
    files: TakedownMarker & DeployRecord,
    settings: DeploySettings,
    asked: DeployKind,
    windows: boolean,
    signal?: AbortSignal
): Promise<Deployment> {
    await files.setRunning(true).catch(() => undefined)
    let deployment: Deployment
    try {
        deployment = await deployWith(child, files, settings, asked, windows, signal)
    } finally {
        await files.setRunning(false).catch(() => undefined)
    }
    await files.saveLast(deploymentText(deployment.report)).catch(() => undefined)
    return deployment
}

/** True when a takedown waits for its deploy. A marker that cannot be read counts as set. */
export async function takedownWaits(marker: TakedownMarker): Promise<boolean> {
    try {
        return (await marker.entries()).length > 0
    } catch {
        return true
    }
}

/**
 * Removes the entries of the marker that a release of this content revision
 * holds, after a deploy with `--takedown` that succeeded. It gives the
 * warnings: the takedowns that still wait, and an entry that could not be
 * removed.
 */
async function settleTakedowns(marker: TakedownMarker, revision: string | null): Promise<string[]> {
    const warnings: string[] = []
    let entries: Awaited<ReturnType<TakedownMarker['entries']>>
    try {
        entries = await marker.entries()
    } catch (error) {
        return [
            `the marker of the takedowns cannot be read, so the next deploy runs with --takedown too: ${messageOf(error)}`
        ]
    }
    let waiting = 0
    for (const { id, entry } of entries) {
        const held = await holdsTakedown(entry, revision, (one, two) =>
            marker.isAncestor(one, two).catch(() => undefined)
        )
        if (!held) {
            waiting += 1
            continue
        }
        try {
            await marker.remove(id)
        } catch (error) {
            warnings.push(
                `the marker of a takedown could not be removed, so the next deploy runs with --takedown too: ${messageOf(error)}`
            )
        }
    }
    if (waiting > 0) {
        warnings.push(
            `${String(waiting)} takedown(s) came after the content of this release and wait for their deploy: the next deploy runs with --takedown`
        )
    }
    return warnings
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'it failed'
}

async function deployWith(
    child: DeployProcess,
    marker: TakedownMarker,
    settings: DeploySettings,
    asked: DeployKind,
    windows: boolean,
    signal?: AbortSignal
): Promise<Deployment> {
    const pending = await takedownWaits(marker)
    const kind: DeployKind = { push: asked.push, takedown: asked.takedown || pending }
    const made = deployCommandOf(settings, kind.takedown, windows)
    if ('error' in made) {
        return { report: reportOfNothing(made.error, kind), output: '' }
    }
    let run: ChildRun
    try {
        run = await child.run(made.command, signal)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'it failed'
        return { report: reportOfStartError(message, kind), output: '' }
    }
    const report =
        run.stopped === undefined
            ? reportOfRun(run.code, run.stdout, kind)
            : reportOfStop(run.stopped, made.command.timeoutMinutes, kind)
    if (report.takedown && succeeded(report)) {
        const warnings = await settleTakedowns(marker, report.contentRevision ?? null)
        return {
            report: { ...report, warnings: [...report.warnings, ...warnings] },
            output: run.output
        }
    }
    return { report, output: run.output }
}

/**
 * The deploy report as the tool writes it: its own object `deployment`, in
 * the canonical form, with `state` `done`.
 */
export function deploymentText(report: DeployReport): string {
    return toCanonicalJson({ deployment: { ...report, state: 'done' } })
}

/**
 * The deploy report of a deploy that starts in the background (the MCP
 * server never waits for a build): `state` `started`, with its push and
 * whether it was asked with `--takedown`. The `deploy` tool with `last`
 * reads its result later.
 */
export function startedText(kind: DeployKind): string {
    return toCanonicalJson({
        deployment: { push: kind.push, state: 'started', takedown: kind.takedown }
    })
}

/** The text that `status` of the MCP server adds after its report while a takedown waits for its deploy, outside the report. */
export function takedownWaitsText(): string {
    return toCanonicalJson({ takedownWaits: true })
}

/**
 * What the `deploy` tool and command give with `last`: the last deploy
 * report of the record (absent when there is none, or when its text is
 * broken), and whether a deploy runs. It starts no deploy.
 */
export function lastText(
    stored: string | undefined,
    running: boolean,
    takedownWaits: boolean
): string {
    let deployment: unknown
    try {
        deployment =
            stored === undefined
                ? undefined
                : (JSON.parse(stored) as { deployment?: unknown }).deployment
    } catch {
        deployment = undefined
    }
    const kept = isCanonicalObject(deployment) ? { deployment } : {}
    return toCanonicalJson({ ...kept, running, takedownWaits })
}

/** A JSON object whose values have a canonical form: texts, booleans, whole numbers, lists and objects of them. */
function isCanonicalObject(value: unknown): value is { readonly [key: string]: CanonicalValue } {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every(isCanonical)
    )
}

function isCanonical(value: unknown): value is CanonicalValue {
    if (typeof value === 'string' || typeof value === 'boolean') {
        return true
    }
    if (typeof value === 'number') {
        return Number.isSafeInteger(value)
    }
    if (Array.isArray(value)) {
        return value.every(isCanonical)
    }
    return isCanonicalObject(value)
}
