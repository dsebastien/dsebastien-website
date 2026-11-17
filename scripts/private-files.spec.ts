import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { findPrivateFiles, workTreeSource, type FileSource } from './private-files.ts'

// Acceptance criterion 4 of issue 17: a check fails when a file of a real vault
// or of the private folder enters the repository.
//
// The check cannot see the real vault, so it uses structure: the private
// folders hold nothing that git tracks, a vault file exists only in the fixture
// vault, and every file of the fixture vault is declared in its catalog.
// `scripts/commit-hooks.spec.ts` tests the hooks that run it.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const NOTE = '---\ntags:\n  - type/note\n---\n\n# A note\n'

/** A catalog that declares the files, relative to the fixture vault. */
function catalog(...files: string[]): string {
    return JSON.stringify({ entries: [{ id: 'test', covers: 'A test.', files }] })
}

/** A repository that exists in the test only: its paths and their text. */
function repository(files: Record<string, string>, symlinks: string[] = []): FileSource {
    return {
        list: () =>
            Promise.resolve([
                ...Object.keys(files).map((path) => ({ path, symlink: false })),
                ...symlinks.map((path) => ({ path, symlink: true }))
            ]),
        read: (path) => Promise.resolve(files[path])
    }
}

async function refusedPaths(files: Record<string, string>, symlinks?: string[]): Promise<string[]> {
    return (await findPrivateFiles(repository(files, symlinks))).map((violation) => violation.path)
}

describe('check of private files', () => {
    test('refuses a file of the private folder', async () => {
        expect(await refusedPaths({ '.private/baseline/export.csv': 'a,b\n' })).toEqual([
            '.private/baseline/export.csv'
        ])
    })

    test('refuses a file of the exported content and of a cache folder', async () => {
        const files = { '.content/note.md': 'text\n', 'apps/site/.cache/page.html': '<p></p>\n' }
        expect(await refusedPaths(files)).toEqual(Object.keys(files))
    })

    // Windows and macOS open `.Private` as `.private`.
    test('refuses a private folder in another letter case', async () => {
        const files = { '.Private/export.csv': 'a,b\n', 'apps/site/.CACHE/page.html': '<p></p>\n' }
        expect(await refusedPaths(files)).toEqual(Object.keys(files))
    })

    test('refuses a note outside the fixture vault', async () => {
        expect(await refusedPaths({ 'documentation/A real note.md': NOTE })).toEqual([
            'documentation/A real note.md'
        ])
    })

    test('refuses a note in each form of Markdown file and of first line', async () => {
        const files = {
            'a/Upper case.MD': NOTE,
            'a/Long ending.markdown': NOTE,
            'a/Component.mdx': NOTE,
            'a/Windows line ends.md': NOTE.replaceAll('\n', '\r\n'),
            'a/Byte order mark.md': `${String.fromCharCode(0xfeff)}${NOTE}`,
            'a/Space after the dashes.md': NOTE.replace('---\n', '--- \n')
        }
        expect(await refusedPaths(files)).toEqual(Object.keys(files))
    })

    test('refuses the files that only a vault holds', async () => {
        const files = {
            'somewhere/.obsidian/app.json': '{}\n',
            'somewhere/.Obsidian/app.json': '{}\n',
            'somewhere/.trash/Old note.txt': 'text\n',
            'somewhere/Board.canvas': '{}\n',
            'somewhere/Tasks.base': 'views: []\n',
            'somewhere/Drawing.excalidraw': '{}\n',
            'somewhere/Drawing.EXCALIDRAW': '{}\n'
        }
        expect(await refusedPaths(files)).toEqual(Object.keys(files))
    })

    test('refuses a symbolic link', async () => {
        expect(await refusedPaths({ 'README.md': '# Notes website\n' }, ['notes'])).toEqual([
            'notes'
        ])
    })

    test('refuses a file of the fixture vault that the catalog does not declare', async () => {
        const files = {
            'fixtures/catalog.json': catalog('Declared.md'),
            'fixtures/vault/Declared.md': NOTE,
            'fixtures/vault/Copied.md': NOTE,
            'fixtures/vault/Copied.png': 'not text'
        }
        expect(await refusedPaths(files)).toEqual([
            'fixtures/vault/Copied.md',
            'fixtures/vault/Copied.png'
        ])
    })

    test('refuses every file of the fixture vault when there is no catalog', async () => {
        expect(await refusedPaths({ 'fixtures/vault/Copied.md': NOTE })).toEqual([
            'fixtures/vault/Copied.md'
        ])
    })

    test('refuses a folder that differs from the fixture vault by letter case only', async () => {
        const files = {
            'fixtures/catalog.json': catalog('Copied.md'),
            'fixtures/Vault/Copied.md': 'A note without properties.\n'
        }
        expect(await refusedPaths(files)).toEqual(['fixtures/Vault/Copied.md'])
    })

    test('stops on a catalog that it cannot read', () => {
        const files = { 'fixtures/catalog.json': '{"entries": [{"id": "broken"}]}' }
        expect(findPrivateFiles(repository(files))).rejects.toThrow('no list of files')
    })

    test('says why it refuses a file', async () => {
        const [violation] = await findPrivateFiles(repository({ '.private/export.csv': 'a,b\n' }))
        expect(violation?.reason).toContain('private folder ".private"')
    })

    test('accepts code, documents without properties, and declared fixture files', async () => {
        const files = {
            'README.md': '# Notes website\n',
            'documentation/Architecture.md': '# Architecture\n\n---\n\nA rule below a line.\n',
            'scripts/tool.ts': 'export const one = 1\n',
            'fixtures/catalog.json': catalog('Declared.md', 'Attachments/plan.png'),
            'fixtures/vault/Declared.md': NOTE,
            'fixtures/vault/Attachments/plan.png': 'not text'
        }
        expect(await refusedPaths(files)).toEqual([])
    })
})

describe('this repository', () => {
    test('holds no private file', async () => {
        const source = workTreeSource(ROOT)
        expect((await source.list()).length).toBeGreaterThan(50)
        expect(await findPrivateFiles(source)).toEqual([])
    })

    test('keeps the private folders and the settings of a vault out of git', async () => {
        const paths = [
            '.private/export.csv',
            '.content/note.md',
            '.cache/store/note.md',
            'fixtures/vault/.obsidian/app.json',
            'fixtures/vault/.trash/Old note.md'
        ]
        for (const path of paths) {
            const child = Bun.spawn(['git', 'check-ignore', '--quiet', path], { cwd: ROOT })
            expect(await child.exited, path).toBe(0)
        }
    })
})
