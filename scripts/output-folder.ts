import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The folder into which a command of this repository writes a corpus: the
// invented one (`generate-corpus.ts`) or the published one
// (`export-published.ts`). A corpus is never committed, and a command removes
// only a folder that it made itself.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The folders of the clone that git ignores and that the check of private files guards. */
const PRIVATE_FOLDERS = ['.cache', '.content', '.private']

/** What a command says about its output folder. */
export interface OutputOptions {
    /** The name of the file that marks the folder as an output of the command. */
    marker: string
    /** The name of the command. The marker holds it, so that a file with the same name is not taken for a marker. */
    tool: string
    /** Folders that the command reads. The output never touches them. */
    inputs?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the second path is below the first one. Both are real paths. */
export function isInside(folder: string, path: string): boolean {
    const fromFolder = relative(folder, path)
    return (
        fromFolder !== '' &&
        fromFolder !== '..' &&
        !fromFolder.startsWith(`..${sep}`) &&
        !isAbsolute(fromFolder)
    )
}

/**
 * The path with every symbolic link resolved. The last parts of the path can
 * be missing: the real path of the deepest part that exists is used.
 */
export async function realPathOf(path: string): Promise<string> {
    const missing: string[] = []
    let existing = path
    for (;;) {
        try {
            return join(await realpath(existing), ...missing)
        } catch {
            const parent = dirname(existing)
            if (parent === existing) {
                return path
            }
            missing.unshift(basename(existing))
            existing = parent
        }
    }
}

/** True when the two folders are the same, or one holds the other. */
function touches(one: string, two: string): boolean {
    return one === two || isInside(one, two) || isInside(two, one)
}

async function isIgnoredByGit(path: string): Promise<boolean> {
    const child = Bun.spawn(['git', 'check-ignore', '--quiet', path], {
        cwd: ROOT,
        stdout: 'ignore',
        stderr: 'ignore'
    })
    return (await child.exited) === 0
}

/** Says why the folder cannot be an output, or `undefined` when it can. */
async function reasonToRefuse(out: string, options: OutputOptions): Promise<string | undefined> {
    const root = await realPathOf(ROOT)
    if (out === root || isInside(out, root)) {
        return 'it is the clone of this repository, or a folder that holds it'
    }
    if (isInside(root, out)) {
        const first = relative(root, out).split(sep)[0] ?? ''
        const below = relative(root, out).split(sep).length > 1
        if (!PRIVATE_FOLDERS.includes(first) || !below) {
            return `inside the clone, a corpus goes below ${PRIVATE_FOLDERS.join(', ')} only. A corpus is never committed`
        }
        if (!(await isIgnoredByGit(join(out, options.marker)))) {
            return 'git does not ignore it. A corpus is never committed'
        }
    }
    for (const input of options.inputs ?? []) {
        if (touches(await realPathOf(input), out)) {
            return `it is "${input}", or inside it, or it holds it. The command never writes where it reads`
        }
    }
    return undefined
}

/** True when the folder holds the marker of the command, with the name of the command in it. */
async function isOwnOutput(out: string, options: OutputOptions): Promise<boolean> {
    try {
        const marker: unknown = await Bun.file(join(out, options.marker)).json()
        return isRecord(marker) && marker['tool'] === options.tool
    } catch {
        return false
    }
}

/**
 * Makes the folder empty and ready for a new output, and returns its real
 * path. The folder then holds the marker of the command.
 *
 * It throws, and removes nothing, when the folder:
 *
 * - is the clone, holds the clone, or is in the clone outside the private
 *   folders that git ignores;
 * - is an input of the command, is inside one, or holds one;
 * - is a file or a symbolic link;
 * - holds files and is not the output of an earlier run of the same command.
 *
 * @param out the folder of the output, as an absolute path
 */
export async function prepareOutputFolder(out: string, options: OutputOptions): Promise<string> {
    const real = await realPathOf(out)
    const reason = await reasonToRefuse(real, options)
    if (reason !== undefined) {
        throw new Error(`"${out}" cannot be the output folder: ${reason}`)
    }

    let exists = true
    try {
        const entry = await lstat(out)
        if (!entry.isDirectory()) {
            throw new Error(`"${out}" cannot be the output folder: it is not a folder`)
        }
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error
        }
        exists = false
    }
    if (exists && (await readdir(out)).length > 0 && !(await isOwnOutput(out, options))) {
        throw new Error(
            `"${out}" holds files and is not the output of an earlier run of this command. Choose another folder`
        )
    }

    // Only a folder that this command made, or an empty one, is removed.
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
    // The marker comes first: a run that stops halfway leaves a folder that
    // the next run can write over.
    await writeMarker(out, options, {})
    return real
}

/** Writes the marker of the command, with what the command wants to record. It never holds a path. */
export async function writeMarker(
    out: string,
    options: OutputOptions,
    record: Record<string, number>
): Promise<void> {
    const marker = { tool: options.tool, ...record }
    await Bun.write(join(out, options.marker), `${JSON.stringify(marker, null, 4)}\n`)
}
