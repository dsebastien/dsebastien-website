import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCorpus, type CorpusFile } from './corpus.ts'

// Issue 18: one command writes a vault of full size from invented content, so
// that prototypes and budget tests run without any real note.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = join(ROOT, 'scripts', 'generate-corpus.ts')

/** The digest of the corpus of seed 1 with 50 notes. */
const PINNED_DIGEST = 'e1cb8e05d85fc123b066e8bcb703c25535f0c92c13474b28bba22d6720a77381'

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

    // A corpus that changes without a change of the generator would break the
    // budget measurements that are compared over time. This digest also fails
    // when the output depends on the clock, the time zone or the machine. When
    // the generator changes on purpose, the test prints the new digest.
    test('is the same on every machine and on every day', () => {
        expect(digest(corpus(1, 50))).toBe(PINNED_DIGEST)
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

    test('links to a heading only where the target has that heading', () => {
        const byName = new Map(notes.map((note) => [note.name, note.text]))
        const headingLinks = notes.flatMap((note) =>
            [...note.text.matchAll(/\[\[([^\]|#]+)#([^\]|]+)\]\]/g)].map(
                (match) => [match[1] ?? '', match[2] ?? ''] as const
            )
        )
        const broken = headingLinks.filter(
            ([name, heading]) => !(byName.get(name) ?? '').includes(`\n## ${heading}\n`)
        )
        expect(broken).toEqual([])
    })

    // The image is read with the zlib of Node, not with the code that wrote it.
    test('writes images that a PNG reader accepts', () => {
        const image = files.find((file) => file.path.endsWith('.png'))
        if (image === undefined) {
            throw new Error('the corpus has no image')
        }
        const bytes = image.bytes
        expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        // The header chunk: 8 by 8 pixels, 8 bits, red, green and blue.
        expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe('IHDR')
        expect([view.getUint32(16), view.getUint32(20), bytes[24], bytes[25]]).toEqual([8, 8, 8, 2])
        // The data chunk follows the header chunk (8 + 25 bytes).
        const length = view.getUint32(33)
        expect(new TextDecoder().decode(bytes.subarray(37, 41))).toBe('IDAT')
        const pixels = inflateSync(bytes.subarray(41, 41 + length))
        // Each of the 8 rows: one filter byte and 8 pixels of 3 bytes.
        expect(pixels.length).toBe(8 * (1 + 8 * 3))
    })

    test('uses Unix line ends and UTF-8', () => {
        expect(notes.filter((note) => note.text.includes('\r'))).toEqual([])
        expect(notes.every((note) => note.text.startsWith('---\n'))).toBe(true)
    })
})

describe('corpus of full size', () => {
    const notes: { name: string; bytes: number; links: number }[] = []
    for (const file of generateCorpus({ seed: 1 })) {
        if (file.path.endsWith('.md')) {
            const text = new TextDecoder().decode(file.bytes)
            notes.push({
                name: (file.path.split('/').at(-1) ?? file.path).replace(/\.md$/, ''),
                bytes: file.bytes.length,
                // The links in the text. The cover of a media note is a link in a property.
                links: [...text.matchAll(/(?<!!)(?<!cover: ")\[\[/g)].length
            })
        }
    }

    // Acceptance criterion 1: more than 20,000 notes by default.
    test('has more than 20,000 notes by default', () => {
        expect(notes.length).toBeGreaterThan(20_000)
    })

    // In a corpus of this size, two notes get the same name by chance about
    // 200 times. The generator must draw again.
    test('has no two notes with the same file name', () => {
        expect(new Set(notes.map((note) => note.name.toLowerCase())).size).toBe(notes.length)
    })

    // The corpus is for budget tests, so its size must be the size of the
    // public notes: about 71 MB of notes and about 155,000 links (research 1.3).
    test('has about the size and the number of links of the public notes', () => {
        const megabytes = notes.reduce((sum, note) => sum + note.bytes, 0) / 1_000_000
        const links = notes.reduce((sum, note) => sum + note.links, 0)
        expect(megabytes).toBeGreaterThan(60)
        expect(megabytes).toBeLessThan(82)
        expect(links).toBeGreaterThan(135_000)
        expect(links).toBeLessThan(175_000)
    })

    test('refuses a seed that it cannot keep', () => {
        expect(() => [...generateCorpus({ seed: 2 ** 32, notes: 1 })]).toThrow('seed')
        expect(() => [...generateCorpus({ seed: 1.5, notes: 1 })]).toThrow('seed')
    })
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
    test('refuses a folder of the clone that git could commit', async () => {
        const out = join(ROOT, 'scripts', 'corpus-output')
        try {
            const result = await run('--notes', '10', '--out', out)

            expect(result.exitCode).not.toBe(0)
            expect(result.stderr).toContain('never committed')
            expect(await Bun.file(join(out, 'corpus.json')).exists()).toBe(false)
        } finally {
            await rm(out, { recursive: true, force: true })
        }
    }, 60_000)

    test('checks its options before it removes its earlier output', async () => {
        const out = join(folderPath(), 'kept')
        await run('--notes', '30', '--out', out)

        for (const args of [
            ['--notes', '0'],
            ['--notes', '1e2'],
            ['--seed', ''],
            ['--seed', '4294967296'],
            ['--unknown']
        ]) {
            const result = await run(...args, '--out', out)
            expect(result.exitCode, args.join(' ')).not.toBe(0)
            // One line, not a stack trace.
            expect(result.stderr.trim().split('\n').length, result.stderr).toBe(1)
        }
        expect(await countNotes(out)).toBe(30)
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
