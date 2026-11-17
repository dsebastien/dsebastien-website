import { join } from 'node:path'

// The check of private files. This repository is public, and the vault and the
// working files of the author are private (business rule 13).
//
// It cannot see the real vault, so it uses structure:
//
//  1. The private folders hold nothing that git tracks.
//  2. A vault file (a note with properties, the settings folder of a vault, a
//     canvas, a base) exists only in the fixture vault.
//  3. Every file of the fixture vault is declared in the catalog, with the
//     feature or the trap that it serves. A file that someone copies into the
//     fixture vault is refused until its entry says why it is there.
//
// It runs two times: as a pre-commit hook on the staged files (`.gitconfig`),
// so that a private file is refused before it leaves the machine, and in the
// tests on every file of the clone that git does not ignore.

/** Folders that git ignores and that hold private or generated files, at any depth. */
const PRIVATE_FOLDERS = ['.private', '.content', '.cache']

/** Folders that only a vault holds. */
const VAULT_FOLDERS = ['.obsidian', '.trash']

/** File endings that only a vault holds. */
const VAULT_ENDINGS = ['.canvas', '.base', '.excalidraw']

const FIXTURE_VAULT = 'fixtures/vault/'
const FIXTURE_CATALOG = 'fixtures/catalog.json'

/** A file that must not be in the repository, and the reason. */
export interface Violation {
    path: string
    reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the file is Markdown and starts with a block of properties. */
async function isNote(root: string, path: string): Promise<boolean> {
    if (!path.toLowerCase().endsWith('.md')) {
        return false
    }
    const file = Bun.file(join(root, path))
    // A file that is staged and then deleted from the work tree has no text to read.
    if (!(await file.exists())) {
        return false
    }
    // A file can start with a byte order mark.
    const head = await file.slice(0, 8).text()
    const start = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head
    return /^---\r?\n/.test(start)
}

async function reasonToRefuse(
    root: string,
    path: string,
    declared: ReadonlySet<string>
): Promise<string | undefined> {
    const segments = path.split('/')
    const privateFolder = PRIVATE_FOLDERS.find((folder) => segments.includes(folder))
    if (privateFolder !== undefined) {
        return `it is in the private folder "${privateFolder}", which git must ignore`
    }
    if (path.startsWith(FIXTURE_VAULT)) {
        return declared.has(path.slice(FIXTURE_VAULT.length))
            ? undefined
            : `it is in the fixture vault and "${FIXTURE_CATALOG}" does not declare it. Add an entry that says which feature or trap this invented file serves`
    }
    if (VAULT_FOLDERS.some((folder) => segments.includes(folder))) {
        return 'it is in a folder that only a vault holds. Vault files exist only in the fixture vault'
    }
    if (VAULT_ENDINGS.some((ending) => path.toLowerCase().endsWith(ending))) {
        return 'it is a file that only a vault holds. Vault files exist only in the fixture vault'
    }
    if (await isNote(root, path)) {
        return 'it is a note (a Markdown file with properties) outside the fixture vault. Notes exist only in the fixture vault, and they are invented'
    }
    return undefined
}

/**
 * Finds the files that must not be in the repository.
 *
 * @param root the folder of the repository
 * @param paths the files to check, relative to the root, with `/` as the separator
 * @param declared the files that the catalog of the fixture vault declares, relative to the fixture vault
 */
export async function findPrivateFiles(
    root: string,
    paths: readonly string[],
    declared: ReadonlySet<string>
): Promise<Violation[]> {
    const violations: Violation[] = []
    for (const path of paths) {
        const reason = await reasonToRefuse(root, path, declared)
        if (reason !== undefined) {
            violations.push({ path, reason })
        }
    }
    return violations
}

/** Reads the files that the catalog of the fixture vault declares. Empty when there is no catalog. */
export async function readDeclaredFixtureFiles(root: string): Promise<Set<string>> {
    const file = Bun.file(join(root, FIXTURE_CATALOG))
    if (!(await file.exists())) {
        return new Set()
    }
    const catalog: unknown = await file.json()
    const entries = isRecord(catalog) && Array.isArray(catalog['entries']) ? catalog['entries'] : []
    const declared = new Set<string>()
    for (const entry of entries) {
        const files: unknown = isRecord(entry) ? entry['files'] : undefined
        if (Array.isArray(files)) {
            for (const path of files) {
                if (typeof path === 'string') {
                    declared.add(path)
                }
            }
        }
    }
    return declared
}

/**
 * Lists the files of a repository that git tracks or has staged. With
 * `untracked`, also the files that git does not track and does not ignore:
 * they are the next to be added.
 */
export async function listRepositoryFiles(
    root: string,
    options: { untracked: boolean }
): Promise<string[]> {
    const others = options.untracked ? ['--others', '--exclude-standard'] : []
    const child = Bun.spawn(['git', 'ls-files', '-z', '--cached', ...others], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
    ])
    if ((await child.exited) !== 0) {
        throw new Error(`git could not list the files of the repository: ${stderr.trim()}`)
    }
    return [...new Set(stdout.split('\0').filter((path) => path !== ''))]
}

// As a program: the pre-commit hook. It checks what the index holds.
if (import.meta.main) {
    const root = process.cwd()
    const violations = await findPrivateFiles(
        root,
        await listRepositoryFiles(root, { untracked: false }),
        await readDeclaredFixtureFiles(root)
    )
    if (violations.length > 0) {
        console.error('This repository is public. These files must not enter it:\n')
        for (const violation of violations) {
            console.error(`  ${violation.path}\n    ${violation.reason}\n`)
        }
        process.exitCode = 1
    }
}
