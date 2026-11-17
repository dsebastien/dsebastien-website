import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_VAULT } from '../packages/testing/src/index.ts'
import { findPrivateFiles } from './private-files.ts'

// Issue 64: one command copies the notes that are published today, with their
// attachments, from the vault of the author into an ignored folder.
//
// The tests use the fixture vault, or a copy of it, as the vault, with an
// invented list. The real list and the path of the real vault never enter
// this repository.
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

async function jsonList(name: string, paths: readonly string[] = PUBLISHED): Promise<string> {
    return await writeList(`${name}.json`, JSON.stringify(paths))
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

/** Every file below a folder with a hash of its bytes: a picture to compare before and after. */
async function picture(below: string): Promise<Record<string, string>> {
    const entries = await readdir(below, { recursive: true, withFileTypes: true })
    const files: [string, string][] = []
    for (const entry of entries) {
        if (entry.isFile()) {
            const path = join(entry.parentPath, entry.name)
            const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(path).bytes())
            files.push([path.slice(below.length + 1).replaceAll('\\', '/'), hash.digest('hex')])
        }
    }
    return Object.fromEntries(files.sort(([one], [two]) => (one < two ? -1 : 1)))
}

async function exported(out: string): Promise<string[]> {
    return Object.keys(await picture(join(out, 'vault')))
}

/** A copy of the fixture vault that a test can change. */
async function vaultCopy(name: string): Promise<string> {
    const vault = join(folderPath(), name)
    await cp(FIXTURE_VAULT, vault, { recursive: true })
    return vault
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
        const copies = await picture(join(out, 'vault'))
        const originals = await picture(FIXTURE_VAULT)
        for (const path of PUBLISHED) {
            expect(copies[path], path).toBe(originals[path])
        }
    }, 60_000)

    test('reads a list that is a JSON list or one path per line', async () => {
        const asList = await jsonList('list')
        // A line that starts like JSON is still a path, because the file is not a JSON file.
        const asLines = await writeList('list.txt', `${PUBLISHED.join('\n')}\n\n[Draft] plan.md\n`)

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

    // Acceptance criterion 5. The marker holds counts and no path.
    test('says how many notes and attachments it copied, and counts a file one time', async () => {
        const out = join(folderPath(), 'counts')
        const list = await jsonList('counts', [
            ...PUBLISHED,
            'Welcome.md',
            './Welcome.md',
            '10 Garden/../Welcome.md'
        ])

        const result = await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(result.stderr).toContain('Copied 3 notes and 1 attachments')
        expect(result.stderr).toContain('0 missing')
        expect(await Bun.file(join(out, 'published.json')).json()).toEqual({
            tool: 'corpus:published',
            notes: 3,
            attachments: 1,
            missing: 0
        })
    }, 60_000)

    test('reports a file that is missing in the vault, and goes on', async () => {
        const out = join(folderPath(), 'missing')
        const list = await jsonList('missing', ['No such note.md', 'Welcome.md', '10 Garden'])

        const result = await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain('2 missing')
        expect(await exported(out)).toEqual(['Welcome.md'])
        expect(await Bun.file(join(out, 'missing.txt')).text()).toBe('No such note.md\n10 Garden\n')
    }, 60_000)

    test('reports a file that it cannot read, and goes on', async () => {
        const vault = await vaultCopy('unreadable-vault')
        await chmod(join(vault, 'Welcome.md'), 0o000)
        const out = join(folderPath(), 'unreadable')
        const list = await jsonList('unreadable', ['Welcome.md', '10 Garden/Compost basics.md'])

        const result = await run('--vault', vault, '--list', list, '--out', out)

        await chmod(join(vault, 'Welcome.md'), 0o644)
        expect(result.exitCode).toBe(0)
        expect(await exported(out)).toEqual(['10 Garden/Compost basics.md'])
        expect(await Bun.file(join(out, 'missing.txt')).text()).toBe('Welcome.md\n')
    }, 60_000)

    test('never reads a file outside the vault', async () => {
        const out = join(folderPath(), 'outside')
        const list = await jsonList('outside', [
            '../configuration.json',
            '/etc/hostname',
            '..\\configuration.json',
            'Welcome.md'
        ])

        const result = await run('--vault', FIXTURE_VAULT, '--list', list, '--out', out)

        expect(result.exitCode).toBe(0)
        expect(await exported(out)).toEqual(['Welcome.md'])
    }, 60_000)

    test('never follows a symbolic link that leaves the vault', async () => {
        const vault = await vaultCopy('linked-vault')
        const outside = join(folderPath(), 'outside-the-vault')
        await mkdir(outside)
        await Bun.write(join(outside, 'Secret.md'), 'Not a file of the vault.\n')
        await symlink(join(outside, 'Secret.md'), join(vault, 'Linked note.md'))
        await symlink(outside, join(vault, 'Linked folder'))
        // A link that stays inside the vault is a file of the vault.
        await symlink(join(vault, 'Welcome.md'), join(vault, 'Welcome again.md'))
        const out = join(folderPath(), 'linked')
        const list = await jsonList('linked', [
            'Linked note.md',
            'Linked folder/Secret.md',
            'Welcome again.md'
        ])

        const result = await run('--vault', vault, '--list', list, '--out', out)

        expect(result.exitCode).toBe(0)
        expect(await exported(out)).toEqual(['Welcome again.md'])
        expect(result.stderr).toContain('2 missing')
    }, 60_000)

    test('a name at the root that starts with two dots is a file of the vault', async () => {
        const vault = await vaultCopy('dots-vault')
        await Bun.write(join(vault, '...And more.md'), 'A note.\n')
        const out = join(folderPath(), 'dots')
        const list = await jsonList('dots', ['...And more.md'])

        await run('--vault', vault, '--list', list, '--out', out)

        expect(await exported(out)).toEqual(['...And more.md'])
    }, 60_000)

    test('leaves the vault as it is', async () => {
        const vault = await vaultCopy('untouched-vault')
        const before = await picture(vault)
        const out = join(folderPath(), 'untouched')

        await run('--vault', vault, '--list', await jsonList('untouched'), '--out', out)

        expect(await picture(vault)).toEqual(before)
    }, 60_000)

    test('writes over its own earlier output', async () => {
        const out = join(folderPath(), 'again')
        await run('--vault', FIXTURE_VAULT, '--list', await jsonList('again-1'), '--out', out)

        const result = await run(
            '--vault',
            FIXTURE_VAULT,
            '--list',
            await jsonList('again-2', ['Welcome.md']),
            '--out',
            out
        )

        expect(result.exitCode).toBe(0)
        expect(await exported(out)).toEqual(['Welcome.md'])
    }, 60_000)
})

describe('output folder of the export', () => {
    /** Runs the export with an output folder that must be refused, and checks that nothing was written. */
    async function refused(out: string, vault = FIXTURE_VAULT): Promise<string> {
        const result = await run(
            '--vault',
            vault,
            '--list',
            await jsonList('refused'),
            '--out',
            out
        )
        expect(result.exitCode).not.toBe(0)
        return result.stderr
    }

    // The corpus is never committed.
    test('is refused in a folder of the clone that git could commit', async () => {
        const out = join(ROOT, 'scripts', 'published-output')
        try {
            expect(await refused(out)).toContain('never committed')
            expect(await Bun.file(join(out, 'published.json')).exists()).toBe(false)
        } finally {
            await rm(out, { recursive: true, force: true })
        }
    }, 60_000)

    test('is refused in an ignored folder of the clone that the check of private files does not guard', async () => {
        const out = join(ROOT, 'node_modules', 'published-output')
        try {
            expect(await refused(out)).toContain('never committed')
        } finally {
            await rm(out, { recursive: true, force: true })
        }
    }, 60_000)

    test('is refused when it is the clone or a folder that holds it', async () => {
        expect(await refused(ROOT)).toContain('clone')
        expect(await refused(dirname(ROOT))).toContain('clone')
    }, 60_000)

    test('is refused inside the vault, and the vault stays as it is', async () => {
        const vault = await vaultCopy('inside-vault')
        const before = await picture(vault)

        expect(await refused(join(vault, 'export'), vault)).toContain('never writes where it reads')

        expect(await picture(vault)).toEqual(before)
    }, 60_000)

    // A file with the name of the marker is not a marker.
    test('is refused when it is the vault, also when the vault holds a file with the name of the marker', async () => {
        const vault = await vaultCopy('marked-vault')
        await Bun.write(join(vault, 'published.json'), '{}\n')
        const before = await picture(vault)

        await refused(vault, vault)

        expect(await picture(vault)).toEqual(before)
    }, 60_000)

    test('is refused when it holds the vault', async () => {
        const holder = join(folderPath(), 'holder')
        await mkdir(holder)
        await Bun.write(join(holder, 'published.json'), '{ "tool": "corpus:published" }\n')
        const vault = join(holder, 'vault')
        await cp(FIXTURE_VAULT, vault, { recursive: true })
        const before = await picture(vault)

        await refused(holder, vault)

        expect(await picture(vault)).toEqual(before)
    }, 60_000)

    test('is refused when it is a file, and the file stays', async () => {
        const out = join(folderPath(), 'a-file.txt')
        await Bun.write(out, 'keep me\n')

        expect(await refused(out)).toContain('not a folder')

        expect(await Bun.file(out).text()).toBe('keep me\n')
    }, 60_000)

    test('is refused when it holds files of something else, and they stay', async () => {
        const out = join(folderPath(), 'other')
        await mkdir(out)
        await Bun.write(join(out, 'keep.txt'), 'not a corpus\n')
        await Bun.write(join(out, 'published.json'), '{ "tool": "something else" }\n')

        await refused(out)

        expect(await Bun.file(join(out, 'keep.txt')).text()).toBe('not a corpus\n')
    }, 60_000)
})

describe('inputs of the export', () => {
    /** Makes an earlier export, runs the command with wrong inputs, and checks that the earlier export stays. */
    async function keepsTheEarlierExport(name: string, ...args: string[]): Promise<void> {
        const out = join(folderPath(), name)
        await run('--vault', FIXTURE_VAULT, '--list', await jsonList(`${name}-first`), '--out', out)
        const before = await picture(out)

        const result = await run(...args, '--out', out)

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr.startsWith('error: ')).toBe(true)
        expect(await picture(out)).toEqual(before)
    }

    test('a vault that is not a folder stops the command before it removes anything', async () => {
        const missing = join(folderPath(), 'no-such-vault')
        await keepsTheEarlierExport('bad-vault', '--vault', missing, '--list', await jsonList('ok'))
    }, 60_000)

    test('an empty list stops the command before it removes anything', async () => {
        const empty = await jsonList('empty', [])
        await keepsTheEarlierExport('empty-list', '--vault', FIXTURE_VAULT, '--list', empty)
    }, 60_000)

    test('a list that is not JSON stops the command before it removes anything', async () => {
        const broken = await writeList('broken.json', '{ not json')
        await keepsTheEarlierExport('broken-list', '--vault', FIXTURE_VAULT, '--list', broken)
    }, 60_000)

    test('a missing or unknown option gives a short error', async () => {
        const list = await jsonList('alone')

        for (const args of [
            ['--list', list],
            ['--vault', FIXTURE_VAULT],
            ['--vault', FIXTURE_VAULT, '--list', list, '--unknown']
        ]) {
            const result = await run(...args)
            expect(result.exitCode).not.toBe(0)
            expect(result.stderr.trim().split('\n').length, result.stderr).toBe(1)
        }
    }, 60_000)
})

describe('export and the check of private files', () => {
    // Acceptance criterion 4. Git ignores the output, so the first barrier
    // holds. The second barrier is the check: a file of the export that
    // someone stages by force is refused, whatever its content.
    test('git ignores the output, and the check refuses every file of it', async () => {
        const out = join(folderPath(), 'checked')
        await run('--vault', FIXTURE_VAULT, '--list', await jsonList('checked'), '--out', out)
        const files = (await exported(out)).map((path) =>
            join(out, 'vault', path).slice(ROOT.length)
        )

        for (const path of files) {
            const child = Bun.spawn(['git', 'check-ignore', '--quiet', path], { cwd: ROOT })
            expect(await child.exited, path).toBe(0)
        }
        const staged = {
            list: () => Promise.resolve(files.map((path) => ({ path, symlink: false }))),
            // The repository of this test has no fixture catalog.
            read: (path: string) =>
                Promise.resolve(path.endsWith('.json') ? undefined : 'A note without properties.\n')
        }
        const refused = (await findPrivateFiles(staged)).map((violation) => violation.path)
        expect(refused).toEqual(files)
    }, 60_000)
})
