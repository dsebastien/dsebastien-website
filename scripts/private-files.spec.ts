import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPrivateFiles, listRepositoryFiles, readDeclaredFixtureFiles } from './private-files.ts'

// Acceptance criterion 4 of issue 17: a check fails when a file of a real vault
// or of the private folder enters the repository.
//
// The check cannot see the real vault, so it uses structure: the private
// folders hold nothing that git tracks, a vault file exists only in the fixture
// vault, and every file of the fixture vault is declared in its catalog.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const NOTE = '---\ntags:\n  - type/note\n---\n\n# A note\n'

let folder: string | undefined

/** Writes the files into a folder of the test and checks them, as the files of a repository. */
async function check(
    files: Record<string, string>,
    declared: string[] = []
): Promise<{ path: string; reason: string }[]> {
    if (folder === undefined) {
        throw new Error('the folder of the test does not exist')
    }
    const root = await mkdtemp(join(folder, 'case-'))
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await Bun.write(join(root, path), text)
    }
    return await findPrivateFiles(root, Object.keys(files), new Set(declared))
}

async function refusedPaths(files: Record<string, string>, declared?: string[]): Promise<string[]> {
    return (await check(files, declared)).map((violation) => violation.path)
}

beforeAll(async () => {
    const cache = join(ROOT, '.cache')
    await mkdir(cache, { recursive: true })
    folder = await mkdtemp(join(cache, 'private-files-'))
})

afterAll(async () => {
    // Remove only a folder that this test made.
    if (folder !== undefined) {
        await rm(folder, { recursive: true, force: true })
    }
})

describe('check of private files', () => {
    test('refuses a file of the private folder', async () => {
        expect(await refusedPaths({ '.private/baseline/export.csv': 'a,b\n' })).toEqual([
            '.private/baseline/export.csv'
        ])
    })

    test('refuses a file of the exported content and of a cache folder', async () => {
        const files = { '.content/note.md': 'text\n', 'apps/site/.cache/page.html': '<p></p>\n' }
        expect(await refusedPaths(files)).toEqual([
            '.content/note.md',
            'apps/site/.cache/page.html'
        ])
    })

    test('refuses a note outside the fixture vault', async () => {
        expect(await refusedPaths({ 'documentation/A real note.md': NOTE })).toEqual([
            'documentation/A real note.md'
        ])
    })

    test('refuses the files that only a vault holds', async () => {
        const files = {
            'somewhere/.obsidian/app.json': '{}\n',
            'somewhere/Board.canvas': '{}\n',
            'somewhere/Tasks.base': 'views: []\n'
        }
        expect(await refusedPaths(files)).toEqual(Object.keys(files))
    })

    test('refuses a file of the fixture vault that the catalog does not declare', async () => {
        const files = { 'fixtures/vault/Declared.md': NOTE, 'fixtures/vault/Copied.md': NOTE }
        expect(await refusedPaths(files, ['Declared.md'])).toEqual(['fixtures/vault/Copied.md'])
    })

    test('says why it refuses a file', async () => {
        const [violation] = await check({ '.private/export.csv': 'a,b\n' })
        expect(violation?.reason).toContain('private')
    })

    test('accepts code, and documents without properties', async () => {
        const files = {
            'README.md': '# Notes website\n',
            'documentation/Architecture.md': '# Architecture\n\n---\n\nA rule below a line.\n',
            'scripts/tool.ts': 'export const one = 1\n'
        }
        expect(await refusedPaths(files)).toEqual([])
    })
})

describe('this repository', () => {
    test('holds no private file', async () => {
        const files = await listRepositoryFiles(ROOT, { untracked: true })
        expect(files.length).toBeGreaterThan(50)
        expect(await findPrivateFiles(ROOT, files, await readDeclaredFixtureFiles(ROOT))).toEqual(
            []
        )
    })

    test('keeps the private folders out of git', async () => {
        for (const path of ['.private/export.csv', '.content/note.md', '.cache/store/note.md']) {
            const child = Bun.spawn(['git', 'check-ignore', '--quiet', path], { cwd: ROOT })
            expect(await child.exited, path).toBe(0)
        }
    })
})
