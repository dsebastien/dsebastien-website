import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

// The check of private files. This repository is public, and the vault and the
// working files of the author are private (business rule 13).
//
// It cannot see the real vault, so it uses structure:
//
//  1. The private folders hold nothing that git tracks.
//  2. A vault file (a note with properties, the settings folder of a vault, a
//     canvas, a base) exists only in the fixture vault.
//  3. Every file of the fixture vault is declared in the fixture catalog, with
//     the feature or the trap that it serves. A file that someone copies into
//     the fixture vault is refused until an entry says why it is there.
//  4. No symbolic link: a link can point to a file outside the repository.
//
// A note without properties and an attachment look like any other file. The
// check cannot find them outside the fixture vault. It does not replace care.
//
// It runs three times (`.gitconfig`): before a commit on the content of the
// index, before a push on the content of each pushed commit, and in the tests
// on every file of the clone that git does not ignore. Each run reads the
// files and the catalog from the place that it checks, never from another one.

/** Folders that git ignores and that hold private or generated files, at any depth. */
const PRIVATE_FOLDERS = ['.private', '.content', '.cache']

/** Folders that only a vault holds. */
const VAULT_FOLDERS = ['.obsidian', '.trash']

/** File endings that only a vault holds. */
const VAULT_ENDINGS = ['.canvas', '.base', '.excalidraw']

/** File endings of Markdown. */
const MARKDOWN_ENDINGS = ['.md', '.markdown', '.mdx']

/** True for a file that holds secrets: `.env`, `.env.*` (not `.env.example`), `.dev.vars`, keys. */
function isSecretFile(lowerPath: string): boolean {
    const name = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
    if (name === '.env.example') {
        return false
    }
    return (
        name === '.env' ||
        name.startsWith('.env.') ||
        name === '.dev.vars' ||
        name.startsWith('.dev.vars.') ||
        name.endsWith('.pem') ||
        name.endsWith('.key')
    )
}

const FIXTURE_VAULT = 'fixtures/vault/'
const FIXTURE_CATALOG = 'fixtures/catalog.json'

/** A file that must not be in the repository, and the reason. */
export interface Violation {
    path: string
    reason: string
}

/** A file of the place that is checked. */
export interface RepositoryFile {
    /** Relative to the root of the repository, with `/` as the separator. */
    path: string
    symlink: boolean
}

/** A place that holds the files of the repository: the work tree, the index or a commit. */
export interface FileSource {
    list(): Promise<RepositoryFile[]>
    /** The text of a file, or `undefined` when the place does not hold it. */
    read(path: string): Promise<string | undefined>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The skills of this repository. A new skill is added here by hand. */
const SKILLS: readonly string[] = ['developassion-publish-notes']

/**
 * True for a skill of the tool (TOOL-04): `skills/<name>/SKILL.md`, whose
 * first property is `name: <name>`. The standard of the skills wants
 * properties, and a note of a vault never has this path and this first line.
 */
function isSkill(path: string, text: string): boolean {
    const match = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(path)
    const name = match?.[1]
    // Only the skills of this repository: the vault of the author holds many
    // private skills of the same form.
    return name !== undefined && SKILLS.includes(name) && text.startsWith(`---\nname: ${name}\n`)
}

/** True when the text starts with a block of properties. A byte order mark can come first. */
function startsWithProperties(text: string): boolean {
    const start = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    return /^---[ \t]*\r?\n/.test(start)
}

/** Reads the files that the fixture catalog of the source declares. Empty when there is no catalog. */
async function readDeclaredFixtureFiles(source: FileSource): Promise<Set<string>> {
    const text = await source.read(FIXTURE_CATALOG)
    if (text === undefined) {
        return new Set()
    }
    const catalog: unknown = JSON.parse(text)
    const entries = isRecord(catalog) ? catalog['entries'] : undefined
    if (!Array.isArray(entries)) {
        throw new Error(`"${FIXTURE_CATALOG}" has no list of entries`)
    }
    const declared = new Set<string>()
    for (const entry of entries) {
        const files: unknown = isRecord(entry) ? entry['files'] : undefined
        if (!Array.isArray(files) || !files.every((path) => typeof path === 'string')) {
            throw new Error(`an entry of "${FIXTURE_CATALOG}" has no list of files`)
        }
        for (const path of files) {
            declared.add(path)
        }
    }
    return declared
}

async function reasonToRefuse(
    source: FileSource,
    file: RepositoryFile,
    declared: ReadonlySet<string>
): Promise<string | undefined> {
    // Windows and macOS do not tell `.Private` from `.private`.
    const lowerPath = file.path.toLowerCase()
    const segments = lowerPath.split('/')
    const privateFolder = PRIVATE_FOLDERS.find((folder) => segments.includes(folder))
    if (privateFolder !== undefined) {
        return `it is in the private folder "${privateFolder}", which git must ignore`
    }
    if (file.symlink) {
        return 'it is a symbolic link, and a link can point to a file outside the repository'
    }
    if (isSecretFile(lowerPath)) {
        return 'it can hold secrets (.env, .dev.vars, a key file). Keep it out of git. Only ".env.example" is allowed'
    }
    if (lowerPath.startsWith(FIXTURE_VAULT)) {
        if (!file.path.startsWith(FIXTURE_VAULT)) {
            return `its folder differs from "${FIXTURE_VAULT}" by letter case only`
        }
        return declared.has(file.path.slice(FIXTURE_VAULT.length))
            ? undefined
            : `it is in the fixture vault and "${FIXTURE_CATALOG}" does not declare it. Add an entry that says which feature or trap this invented file serves`
    }
    if (VAULT_FOLDERS.some((folder) => segments.includes(folder))) {
        return 'it is in a folder that only a vault holds. Vault files exist only in the fixture vault'
    }
    if (VAULT_ENDINGS.some((ending) => lowerPath.endsWith(ending))) {
        return 'it is a file that only a vault holds. Vault files exist only in the fixture vault'
    }
    if (MARKDOWN_ENDINGS.some((ending) => lowerPath.endsWith(ending))) {
        const text = await source.read(file.path)
        if (text !== undefined && startsWithProperties(text) && !isSkill(file.path, text)) {
            return 'it is a note (a Markdown file with properties) outside the fixture vault. Notes exist only in the fixture vault, and they are invented'
        }
    }
    return undefined
}

/** Finds the files of a source that must not be in the repository. */
export async function findPrivateFiles(source: FileSource): Promise<Violation[]> {
    const declared = await readDeclaredFixtureFiles(source)
    const violations: Violation[] = []
    for (const file of await source.list()) {
        const reason = await reasonToRefuse(source, file, declared)
        if (reason !== undefined) {
            violations.push({ path: file.path, reason })
        }
    }
    return violations
}

interface GitResult {
    exitCode: number
    stdout: string
    stderr: string
}

async function git(root: string, args: string[]): Promise<GitResult> {
    const child = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
    ])
    return { exitCode: await child.exited, stdout, stderr }
}

async function gitList(root: string, args: string[]): Promise<string[]> {
    const result = await git(root, args)
    if (result.exitCode !== 0) {
        throw new Error(`git could not list the files: ${result.stderr.trim()}`)
    }
    return result.stdout.split('\0').filter((line) => line !== '')
}

/** Reads one object of git (`:path` in the index, `commit:path` in a commit). */
async function gitRead(root: string, object: string): Promise<string | undefined> {
    const result = await git(root, ['cat-file', 'blob', object])
    return result.exitCode === 0 ? result.stdout : undefined
}

/** Turns lines of the form `<mode> ...<tab><path>` into files. */
function toFiles(lines: string[]): RepositoryFile[] {
    return lines.map((line) => {
        const tab = line.indexOf('\t')
        return { path: line.slice(tab + 1), symlink: line.startsWith('120000') }
    })
}

/**
 * The work tree: every file that git tracks, and every file that git does not
 * track and does not ignore, because those are the next to be added.
 */
export function workTreeSource(root: string): FileSource {
    return {
        async list() {
            const paths = await gitList(root, [
                'ls-files',
                '-z',
                '--cached',
                '--others',
                '--exclude-standard'
            ])
            const files: RepositoryFile[] = []
            for (const path of new Set(paths)) {
                try {
                    files.push({ path, symlink: (await lstat(join(root, path))).isSymbolicLink() })
                } catch {
                    // A tracked file that was deleted from the work tree.
                    files.push({ path, symlink: false })
                }
            }
            return files
        },
        async read(path) {
            const file = Bun.file(join(root, path))
            return (await file.exists()) ? await file.text() : undefined
        }
    }
}

/** The index: what the next commit holds. */
export function indexSource(root: string): FileSource {
    return {
        list: async () => toFiles(await gitList(root, ['ls-files', '-z', '--stage'])),
        read: (path) => gitRead(root, `:${path}`)
    }
}

/** One commit: what a push sends. */
export function commitSource(root: string, commit: string): FileSource {
    return {
        list: async () => toFiles(await gitList(root, ['ls-tree', '-r', '-z', commit])),
        read: (path) => gitRead(root, `${commit}:${path}`)
    }
}

/** The commits that a push sends: git gives one line per reference to the pre-push hook. */
function pushedCommits(input: string): string[] {
    const commits = input
        .split('\n')
        .map((line) => line.split(' ')[1])
        .filter((commit): commit is string => commit !== undefined && !/^0+$/.test(commit))
    return [...new Set(commits)]
}

// As a program: the hooks. Without an argument it checks the index (before a
// commit). With `--pushed` it checks each commit that git names on the
// standard input (before a push).
if (import.meta.main) {
    const root = process.cwd()
    const sources = process.argv.includes('--pushed')
        ? pushedCommits(await Bun.stdin.text()).map((commit) => commitSource(root, commit))
        : [indexSource(root)]
    const found = new Map<string, string>()
    for (const source of sources) {
        for (const violation of await findPrivateFiles(source)) {
            found.set(violation.path, violation.reason)
        }
    }
    if (found.size > 0) {
        console.error('This repository is public. These files must not enter it:\n')
        for (const [path, reason] of found) {
            console.error(`  ${path}\n    ${reason}\n`)
        }
        process.exitCode = 1
    }
}
