import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCorpus, type CorpusFile } from './corpus.ts'

// Issue 18: one command writes a vault of full size from invented content, so
// that prototypes and budget tests run without any real note.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = join(ROOT, 'scripts', 'generate-corpus.ts')

function corpus(seed: number, notes: number): CorpusFile[] {
    return [...generateCorpus({ seed, notes })]
}

function notesOf(files: CorpusFile[]): { path: string; name: string; text: string }[] {
    return files
        .filter((file) => file.path.endsWith('.md'))
        .map((file) => ({
            path: file.path,
            name: (file.path.split('/').at(-1) ?? file.path).replace(/\.md$/, ''),
            text: new TextDecoder().decode(file.bytes)
        }))
}

function digest(files: CorpusFile[]): string {
    const hasher = new Bun.CryptoHasher('sha256')
    for (const file of files) {
        hasher.update(file.path)
        hasher.update(file.bytes)
    }
    return hasher.digest('hex')
}

describe('generated corpus', () => {
    const files = corpus(1, 600)
    const notes = notesOf(files)

    test('has the number of notes that was asked', () => {
        expect(notes.length).toBe(600)
    })

    test('is the same for the same seed, byte for byte', () => {
        expect(digest(corpus(1, 600))).toBe(digest(files))
    })

    test('differs for another seed', () => {
        expect(digest(corpus(2, 600))).not.toBe(digest(files))
    })

    // Acceptance criterion 2: every name pattern of the research (1.4b).
    test.each([
        ['a dot', /\./],
        ['an ending like a file extension', /\.(js|ts|io|net|ai)$/],
        ['an apostrophe', /'/],
        ['a character outside ASCII', /\P{ASCII}/u],
        ['an ampersand', /&/],
        ['a literal plus', /\+/],
        ['a percent sign', /%/]
    ])('has a note name with %s', (_pattern, expression) => {
        expect(notes.some((note) => expression.test(note.name))).toBe(true)
    })

    test('has a folder whose name holds a dot', () => {
        expect(
            notes.some((note) => /\d\.\d/.test(note.path.split('/').slice(0, -1).join('/')))
        ).toBe(true)
    })

    test('has no name that Windows refuses', () => {
        const refused = files.filter((file) =>
            file.path
                .split('/')
                .some((segment) => /[<>:"|?*\\]/.test(segment) || /[. ]$/.test(segment))
        )
        expect(refused).toEqual([])
    })

    test('has no two paths that differ by letter case only', () => {
        const lower = new Set(files.map((file) => file.path.toLowerCase()))
        expect(lower.size).toBe(files.length)
    })

    test('has no two notes with the same file name', () => {
        expect(new Set(notes.map((note) => note.name.toLowerCase())).size).toBe(notes.length)
    })

    test('has several note types, as tags', () => {
        const types = new Set(
            notes.flatMap((note) =>
                [...note.text.matchAll(/^ {2}- (type\/[a-z-]+)$/gm)].map((m) => m[1])
            )
        )
        expect(types.size).toBeGreaterThanOrEqual(8)
    })

    test('has aliases, an alias that two notes carry, and an alias that is the name of another note', () => {
        const names = new Set(notes.map((note) => note.name))
        const owners = new Map<string, number>()
        let equalToName = 0
        for (const note of notes) {
            const list = /^aliases:\n((?: {2}- .*\n)+)/m.exec(note.text)?.[1] ?? ''
            for (const alias of list.split('\n').filter((line) => line !== '')) {
                const text = alias.replace(/^ {2}- /, '')
                owners.set(text, (owners.get(text) ?? 0) + 1)
                if (names.has(text) && text !== note.name) {
                    equalToName += 1
                }
            }
        }
        expect(owners.size).toBeGreaterThan(50)
        expect([...owners.values()].some((count) => count > 1)).toBe(true)
        expect(equalToName).toBeGreaterThan(0)
    })

    test('links its notes to each other, and every link leads to a file of the corpus', () => {
        // A link names a note by its name or by its path, and a cover by its file name.
        const targets = new Set([
            ...notes.flatMap((note) => [note.name, note.path.replace(/\.md$/, '')]),
            ...files.map((file) => file.path.split('/').at(-1) ?? file.path)
        ])
        const links = notes.flatMap((note) =>
            [...note.text.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(
                (match) => match[1] ?? ''
            )
        )
        expect(links.length).toBeGreaterThan(notes.length)
        expect(links.filter((target) => !targets.has(target))).toEqual([])
    })

    test('writes the attachment of every embed', () => {
        const paths = new Set(files.map((file) => file.path.split('/').at(-1)))
        const embeds = notes.flatMap((note) =>
            [...note.text.matchAll(/!\[\[([^\]|#]+\.png)(?:\|[^\]]*)?\]\]/g)].map(
                (match) => match[1]
            )
        )
        expect(embeds.length).toBeGreaterThan(100)
        expect(embeds.filter((embed) => !paths.has(embed))).toEqual([])
    })

    test('uses Unix line ends and UTF-8', () => {
        expect(notes.filter((note) => note.text.includes('\r'))).toEqual([])
        expect(notes.every((note) => note.text.startsWith('---\n'))).toBe(true)
    })
})

describe('corpus of full size', () => {
    // Acceptance criterion 1: more than 20,000 notes by default.
    test('has more than 20,000 notes by default', () => {
        let notes = 0
        for (const file of generateCorpus({ seed: 1 })) {
            notes += file.path.endsWith('.md') ? 1 : 0
        }
        expect(notes).toBeGreaterThan(20_000)
    }, 120_000)
})

describe('corpus command', () => {
    let folder: string | undefined

    function folderPath(): string {
        if (folder === undefined) {
            throw new Error('the folder of the test does not exist')
        }
        return folder
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

    async function countNotes(out: string): Promise<number> {
        const entries = await readdir(join(out, 'vault'), { recursive: true })
        return entries.filter((entry) => entry.endsWith('.md')).length
    }

    beforeAll(async () => {
        const cache = join(ROOT, '.cache')
        await mkdir(cache, { recursive: true })
        folder = await mkdtemp(join(cache, 'corpus-spec-'))
    })

    afterAll(async () => {
        // Remove only a folder that this test made.
        if (folder !== undefined) {
            await rm(folder, { recursive: true, force: true })
        }
    })

    test('writes the corpus into an ignored folder', async () => {
        const out = join(folderPath(), 'corpus')

        expect((await run('--notes', '120', '--out', out)).exitCode).toBe(0)

        expect(await countNotes(out)).toBe(120)
    }, 60_000)

    test('writes a corpus again over its own earlier output', async () => {
        const out = join(folderPath(), 'again')
        await run('--notes', '120', '--out', out)

        expect((await run('--notes', '40', '--out', out)).exitCode).toBe(0)

        expect(await countNotes(out)).toBe(40)
    }, 60_000)

    // Acceptance criterion 4: the corpus is never committed.
    test('refuses a folder of the clone that git does not ignore', async () => {
        const out = join(ROOT, 'scripts', 'corpus-output')

        const result = await run('--notes', '10', '--out', out)

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain('ignore')
        expect(await Bun.file(join(out, 'corpus.json')).exists()).toBe(false)
    }, 60_000)

    test('refuses a folder that holds files of something else', async () => {
        const out = join(folderPath(), 'other')
        await mkdir(out)
        await Bun.write(join(out, 'keep.txt'), 'not a corpus\n')

        const result = await run('--notes', '10', '--out', out)

        expect(result.exitCode).not.toBe(0)
        expect(await Bun.file(join(out, 'keep.txt')).text()).toBe('not a corpus\n')
    }, 60_000)
})
