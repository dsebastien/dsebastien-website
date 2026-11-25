import { toCanonicalJson } from './canonical.ts'

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
}

/** What the tool runs: a program with a list of arguments, no shell, in a folder. */
export interface DeployCommand {
    readonly program: string
    readonly args: readonly string[]
    readonly folder: string
}

/** What a run of the deploy gave. */
export interface ChildRun {
    /** The exit code, or `null` when a signal stopped the program. */
    readonly code: number | null
    /** The standard output, where the last line is the result. */
    readonly stdout: string
    /** The whole output (standard output and errors), for the author only. */
    readonly output: string
}

/** The port that starts the deploy as a child process. It throws when the program cannot start. */
export interface DeployProcess {
    run(command: DeployCommand): Promise<ChildRun>
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

type SettingName = keyof DeploySettings

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

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
    const last = items.at(-1) ?? ''
    return items.length < 2 ? last : `${items.slice(0, -1).join(', ')} and ${last}`
}

/**
 * The command of the deploy (the interface of `scripts/deploy.ts`), or the
 * error of a deploy report that deploys nothing: a setting that is not set,
 * or a path that is not absolute.
 *
 * @param isAbsolute the rule of the system for an absolute path
 */
export function deployCommandOf(
    settings: DeploySettings,
    takedown: boolean,
    isAbsolute: (path: string) => boolean
): { readonly command: DeployCommand } | { readonly error: string } {
    const missing = REQUIRED.filter((key) => settings[key] === '')
    if (missing.length > 0) {
        const names = listed(missing.map((key) => SETTINGS[key].name))
        const options = listed(missing.map((key) => SETTINGS[key].option))
        return {
            error: `nothing was deployed: ${names} ${missing.length === 1 ? 'is' : 'are'} not set (in the settings of Vault Publish, or ${options} of the command line program)`
        }
    }
    const relative = PATHS.find((key) => settings[key] !== '' && !isAbsolute(settings[key]))
    if (relative !== undefined) {
        return {
            error: `nothing was deployed: ${SETTINGS[relative].name} must be an absolute path: "${settings[relative]}"`
        }
    }
    return {
        command: {
            program: settings.bun === '' ? 'bun' : settings.bun,
            folder: settings.siteCode,
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

/** A deploy report that deploys nothing, with its reason. */
export function reportOfNothing(error: string, push: DeployReport['push']): DeployReport {
    return {
        push,
        build: 'skipped',
        deploy: 'skipped',
        live: false,
        uploaded: 0,
        deleted: 0,
        warnings: [],
        error
    }
}

/** The deploy report of a program that could not start. */
export function reportOfStartError(message: string, push: DeployReport['push']): DeployReport {
    return {
        ...reportOfNothing(`the deploy could not start: ${message}`, push),
        deploy: 'failed'
    }
}

function failed(error: string, push: DeployReport['push']): DeployReport {
    return { ...reportOfNothing(error, push), build: 'failed', deploy: 'failed' }
}

const READ_OUTPUT = 'read the output of the deploy'

function isStep(value: unknown): value is StepResult {
    return value === 'ok' || value === 'failed' || value === 'skipped'
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isOptionalText(value: unknown): value is string | null | undefined {
    return value === undefined || value === null || typeof value === 'string'
}

/** The result line, read strictly, or `undefined` when its shape is wrong. Unknown fields are ignored. */
function resultOf(value: unknown, push: DeployReport['push']): DeployReport | undefined {
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
        push,
        build,
        deploy,
        live,
        // An empty text is a field that the deploy did not know (a target
        // file that cannot be read gives an empty URL).
        ...(typeof url === 'string' && url !== '' ? { url } : {}),
        ...(typeof contentRevision === 'string' && contentRevision !== ''
            ? { contentRevision }
            : {}),
        uploaded,
        deleted,
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
export function reportOfRun(
    code: number | null,
    stdout: string,
    push: DeployReport['push']
): DeployReport {
    const ended = code === null ? 'stopped by a signal' : `exit code ${String(code)}`
    const lines = stdout.split('\n').map((line) => line.replace(/\r$/u, ''))
    const last = lines.findLast((line) => line.trim() !== '') ?? ''
    if (!last.startsWith(RESULT_PREFIX)) {
        return failed(`the deploy gave no result line (${ended}): ${READ_OUTPUT}`, push)
    }
    let value: unknown
    try {
        value = JSON.parse(last.slice(RESULT_PREFIX.length))
    } catch {
        return failed(`the result line of the deploy is not JSON: ${READ_OUTPUT}`, push)
    }
    const result = resultOf(value, push)
    if (result === undefined) {
        return failed(`the result line of the deploy has the wrong shape: ${READ_OUTPUT}`, push)
    }
    if (result.deploy === 'ok' && code === 0) {
        return result
    }
    if (result.deploy === 'ok') {
        return {
            ...result,
            deploy: 'failed',
            live: false,
            error: `the deploy ${code === null ? 'was stopped by a signal' : `ended with the exit code ${String(code)}`}, but its result line says that it succeeded: ${READ_OUTPUT}`
        }
    }
    return {
        ...result,
        live: false,
        error: result.error ?? `the deploy did not succeed (${ended}): ${READ_OUTPUT}`
    }
}

/**
 * Runs the deploy of the settings, or gives the report that names the
 * missing setting. The deploy never throws: its failures are in the report.
 */
export async function runDeploy(
    child: DeployProcess,
    settings: DeploySettings,
    takedown: boolean,
    push: DeployReport['push'],
    isAbsolute: (path: string) => boolean
): Promise<Deployment> {
    const made = deployCommandOf(settings, takedown, isAbsolute)
    if ('error' in made) {
        return { report: reportOfNothing(made.error, push), output: '' }
    }
    let run: ChildRun
    try {
        run = await child.run(made.command)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'it failed'
        return { report: reportOfStartError(message, push), output: '' }
    }
    return { report: reportOfRun(run.code, run.stdout, push), output: run.output }
}

/** The deploy report as the tool writes it: its own object `deployment`, in the canonical form. */
export function deploymentText(report: DeployReport): string {
    return toCanonicalJson({ deployment: { ...report } })
}
