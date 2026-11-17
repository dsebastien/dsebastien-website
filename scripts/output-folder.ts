import { mkdir, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The folder into which a command of this repository writes a corpus: the
// invented one (`generate-corpus.ts`) or the published one
// (`export-published.ts`). A corpus is never committed.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** True when the folder is inside the clone and git does not ignore it. */
async function couldBeCommitted(folder: string, marker: string): Promise<boolean> {
    const fromRoot = relative(ROOT, folder)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        return false
    }
    const child = Bun.spawn(['git', 'check-ignore', '--quiet', join(folder, marker)], {
        cwd: ROOT,
        stdout: 'ignore',
        stderr: 'ignore'
    })
    return (await child.exited) !== 0
}

/**
 * Makes the folder empty and ready for a new output.
 *
 * It throws when the folder is in the clone and git does not ignore it, and
 * when the folder holds files without the marker of an earlier run of the same
 * command: only a folder that the command made is ever removed.
 *
 * @param out the folder of the output, as an absolute path
 * @param marker the name of the file that the command writes first into its output
 */
export async function prepareOutputFolder(out: string, marker: string): Promise<void> {
    if (await couldBeCommitted(out, marker)) {
        throw new Error(
            `git does not ignore "${out}". A corpus is never committed: choose a folder that git ignores, for example inside .cache/`
        )
    }
    let entries: string[]
    try {
        entries = await readdir(out)
    } catch {
        entries = []
    }
    if (entries.length > 0 && !entries.includes(marker)) {
        throw new Error(
            `"${out}" holds files and is not the output of an earlier run. Choose another folder`
        )
    }
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
}
