import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_VAULT, listFixtureVaultFiles } from '../packages/testing/src/index.ts'
import { findPrivateFiles, workTreeSource } from './private-files.ts'

// Issue 64: one command copies the notes that are published today, with their
// attachments, from the vault of the author into an ignored folder.
//
// The tests use the fixture vault as the vault and an invented list. The real
// list and the path of the real vault never enter this repository.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = join(ROOT, 'scripts', 'export-published.ts')

const PUBLISHED = [
    'Welcome.md',
    '10 Garden/Compost basics.md',
    "20 Library/20.02 Recipes/Crème brûlée à l'érable.md",
    'Attachments/garden-plan.png'
]

let folder: string | undefined

function folderPath(): string {
    if (folder === undefined) {
        throw new Error('the folder of the test does not exist')
    }
    return folder
}

async function writeList(name: string, text: string): Promise<string> {
    const path = join(folderPath(), name)
    await Bun.write(path, text)
    return path
}

async function run(...args: string[]): Promise<{ exitCode: number; stderr: string }> {
    const child = Bun.spawn(['bun', COMMAND, ...args], {
        cwd: ROOT,
        stdout: 'ignore',
        stderr: 'pipe'
    })
    const stderr = await new Response(child.stderr).text()
    return { exitCode: await child.exited, stderr }
}

async function exported(out: string): Promise<string[]> {
    const vault = join(out, 'vault')
    const entries = await readdir(vault, { recursive: true, withFileTypes: true })
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(vault.length + 1))
        .map((path) => path.replaceAll('\\', '/'))
        .sort()
}

beforeAll(async () => {
    const cache = join(ROOT, '.cache')
    await mkdir(cache, { recursive: true })
    folder = await mkdtemp(join(cache, 'export-spec-'))
})

afterAll(async () => {
    // Remove only a folder that this test made.
    if (folder !== undefined) {
        await rm(folder, { recursive: true, force: true })
    }
})

describe('export of the published corpus', () => {
    test('copies exactly the files of the list, with their vault paths', async () => {
        const out = join(folderPath(), 'exact')
        // The form of the list of Obsidian Publish: an object whose keys are the paths.
        const list = await writeList(
            'cache.json',
            JSON.stringify(Object.fromEntries(PUBLISHED.map((path) => [path, null])))
        )

        const result = await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(result.exitCode).toBe(0)
        expect(await exported(out)).toEqual([...PUBLISHED].sort())
        const copy = await Bun.file(join(out, 'vault', 'Attachments/garden-plan.png')).bytes()
        const original = await Bun.file(join(FIXTURE_VAULT, 'Attachments/garden-plan.png')).bytes()
        expect(copy).toEqual(original)
    }, 60_000)

    test('reads a list that is a JSON list or one path per line', async () => {
        const asList = await writeList('list.json', JSON.stringify(PUBLISHED))
        const asLines = await writeList('list.txt', `${PUBLISHED.join('\n')}\n\n`)

        for (const [name, list] of [
            ['json', asList],
            ['lines', asLines]
        ] as const) {
            const out = join(folderPath(), name)
            const result = await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)
            expect(result.exitCode).toBe(0)
            expect(await exported(out)).toEqual([...PUBLISHED].sort())
        }
    }, 60_000)

    test('reports a file that is missing in the vault, and goes on', async () => {
        const out = join(folderPath(), 'missing')
        const list = await writeList(
            'missing.json',
            JSON.stringify(['No such note.md', 'Welcome.md'])
        )

        const result = await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain('1 missing')
        expect(await exported(out)).toEqual(['Welcome.md'])
        expect(await Bun.file(join(out, 'missing.txt')).text()).toBe('No such note.md\n')
    }, 60_000)

    test('never reads a file outside the vault', async () => {
        const out = join(folderPath(), 'outside')
        const list = await writeList(
            'outside.json',
            JSON.stringify(['../configuration.json', '/etc/hostname', 'Welcome.md'])
        )

        const result = await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(result.exitCode).toBe(0)
        expect(await exported(out)).toEqual(['Welcome.md'])
        expect(await readdir(out)).not.toContain('configuration.json')
    }, 60_000)

    test('leaves the vault as it is', async () => {
        const before = await listFixtureVaultFiles()
        const out = join(folderPath(), 'untouched')
        const list = await writeList('untouched.json', JSON.stringify(PUBLISHED))

        await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(await listFixtureVaultFiles()).toEqual(before)
    }, 60_000)

    // The corpus is never committed.
    test('refuses a folder of the clone that git does not ignore', async () => {
        const out = join(ROOT, 'scripts', 'published-output')
        const list = await writeList('refused.json', JSON.stringify(PUBLISHED))

        const result = await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain('ignore')
        expect(await Bun.file(join(out, 'vault', 'Welcome.md')).exists()).toBe(false)
    }, 60_000)

    test('keeps the check of private files green after an export', async () => {
        const out = join(folderPath(), 'checked')
        const list = await writeList('checked.json', JSON.stringify(PUBLISHED))
        await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(await findPrivateFiles(workTreeSource(ROOT))).toEqual([])
    }, 60_000)

    test('stops when the vault or the list is not given', async () => {
        const list = await writeList('alone.json', JSON.stringify(PUBLISHED))

        expect((await run('--list', list)).exitCode).not.toBe(0)
        expect((await run('--vault', FIXTURE_VAULT)).exitCode).not.toBe(0)
    }, 60_000)
})
