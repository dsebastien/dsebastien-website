import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The stores of a test live in the `.cache` folder of the clone, which git
// ignores: nothing that a test writes can enter a commit, and a tool that
// moves files into a store stays on one file system.
const CACHE = fileURLToPath(new URL('../../../.cache/test-stores', import.meta.url))

/** A content store and an attachment storage that exist for one test. */
export interface TestStores extends AsyncDisposable {
    /** The folder that was made for the test. The stores are inside it, and a test can add its own folders. */
    readonly root: string
    /**
     * An empty content store: a bare git repository with no commit and the
     * branch `main`. It stands for the remote repository. A test clones it and
     * pushes to it.
     */
    readonly contentStore: string
    /** An empty attachment storage: a folder that stands for the object storage. */
    readonly attachmentStorage: string
    /** Removes the folder of the test, and nothing else. */
    remove(): Promise<void>
}

/** The environment without the variables that point git to another repository. */
function cleanEnvironment(): Record<string, string> {
    const entries = Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')
    )
    return Object.fromEntries(entries)
}

async function makeContentStore(path: string): Promise<void> {
    const child = Bun.spawn(['git', 'init', '--quiet', '--bare', '--initial-branch=main', path], {
        env: cleanEnvironment(),
        stdout: 'ignore',
        stderr: 'pipe'
    })
    const errors = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) {
        throw new Error(`git could not make the content store of the test: ${errors.trim()}`)
    }
}

/**
 * Makes an empty content store and an empty attachment storage for one test.
 *
 * Declare the result with `await using`: the folder is removed when the test
 * ends, also when it fails.
 *
 *     await using stores = await makeTestStores()
 */
export async function makeTestStores(): Promise<TestStores> {
    await mkdir(CACHE, { recursive: true })
    const root = await mkdtemp(join(CACHE, 'test-'))
    // Only a folder that this call made is ever removed.
    const remove = async (): Promise<void> => {
        await rm(root, { recursive: true, force: true })
    }

    try {
        const contentStore = join(root, 'content-store.git')
        const attachmentStorage = join(root, 'attachment-storage')
        await makeContentStore(contentStore)
        await mkdir(attachmentStorage)
        return { root, contentStore, attachmentStorage, remove, [Symbol.asyncDispose]: remove }
    } catch (error) {
        await remove()
        throw error
    }
}
