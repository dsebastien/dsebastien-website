import { describe, expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
    FIXTURE_CONFIGURATION,
    FIXTURE_VAULT,
    listFixtureVaultFiles,
    readFixtureCatalog
} from './fixture-vault.ts'

// Acceptance criteria 1 and 2 of issue 17: a fixture vault with invented notes
// for the features and traps of spec 18.4, and its own invented configuration
// with a deny list.

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readDenyList(): Promise<string[]> {
    const configuration: unknown = await Bun.file(FIXTURE_CONFIGURATION).json()
    const denyList = isRecord(configuration) ? configuration['denyList'] : undefined
    if (!Array.isArray(denyList)) {
        throw new Error('the fixture configuration has no deny list')
    }
    return denyList.filter((entry): entry is string => typeof entry === 'string')
}

async function isFolder(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

describe('configuration of the fixture vault', () => {
    test('has a deny list', async () => {
        expect((await readDenyList()).length).toBeGreaterThan(0)
    })

    // A deny list entry that matches no folder stops every publication
    // (GATE-38 of the spec), so the fixture must never be in that state.
    test('names only folders of the fixture vault in its deny list', async () => {
        for (const entry of await readDenyList()) {
            expect(await isFolder(join(FIXTURE_VAULT, entry)), entry).toBe(true)
        }
    })
})

describe('catalog of the fixture vault', () => {
    // A file enters the fixture vault only with a reason: the feature or the
    // trap that it serves. The check of private files reads the same catalog.
    test('declares every file of the fixture vault', async () => {
        const declared = new Set((await readFixtureCatalog()).flatMap((entry) => entry.files))
        const missing = (await listFixtureVaultFiles()).filter((file) => !declared.has(file))
        expect(missing).toEqual([])
    })

    test('names only files that exist', async () => {
        const files = new Set(await listFixtureVaultFiles())
        const declared = (await readFixtureCatalog()).flatMap((entry) => entry.files)
        expect(declared.filter((file) => !files.has(file))).toEqual([])
    })
})

// The first set of notes: one entry of the catalog per feature and per trap of
// spec 18.4. Each row says what the files of the entry must hold, read from the
// spec and not from the notes.
describe('first set of notes (spec 18.4)', () => {
    const MUSIC_LANGUAGES = [
        'chord',
        'chords',
        'keyboard',
        'fretboard',
        'strum',
        'picking',
        'progression',
        'circle',
        'tab',
        'score'
    ]
    const LINK_BLOCK_FORMS = [
        /^LINK: https:\/\/\S+$/m,
        /^LINK https:\/\/\S+$/m,
        /^LINK: \[\[[^\]|]+\]\]$/m,
        /^LINK: \[\[[^\]|]+\|[^\]]+\]\]$/m,
        /^LINK:\n- https:\/\/\S+$/m,
        /^LINK\n- \[\[[^\]]+\]\]$/m,
        // CARD-01: `LINKS` means the same, and a target can be a Markdown link.
        /^LINKS: https:\/\/\S+$/m,
        /^LINKS\n- https:\/\/\S+$/m,
        /^LINK: \[[^\]]+\]\(https:\/\/\S+\)$/m,
        // CARD-02: a list has no limit of five lines.
        /^LINKS:\n(?:- \S.*\n){6,}/m,
        // CARD-08: a line inside a code block is not a `LINK` line.
        /^```text\nLINK: https:\/\/\S+\n```$/m
    ]

    interface Note {
        path: string
        name: string
        properties: string
        body: string
        denied: boolean
    }

    async function readNotes(id: string): Promise<Note[]> {
        const entry = (await readFixtureCatalog()).find((candidate) => candidate.id === id)
        if (entry === undefined) {
            throw new Error(`the catalog has no entry "${id}"`)
        }
        const denyList = await readDenyList()
        return await Promise.all(
            entry.files.map(async (path) => {
                const isNote = path.endsWith('.md')
                const text = isNote ? await Bun.file(join(FIXTURE_VAULT, path)).text() : ''
                const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
                return {
                    path,
                    name: (path.split('/').at(-1) ?? path).replace(/\.md$/, ''),
                    properties: match?.[1] ?? '',
                    body: match?.[2] ?? text,
                    denied: denyList.some((folder) => path.startsWith(`${folder}/`))
                }
            })
        )
    }

    function linksTo(from: Note, to: Note): boolean {
        return from.body.includes(`[[${to.name}`) || from.body.includes(`/${to.name}`)
    }

    function aliases(note: Note): string[] {
        const list = /^aliases:\n((?: {2}- .*\n?)+)/m.exec(note.properties)?.[1] ?? ''
        return list
            .split('\n')
            .map((line) => line.replace(/^ {2}- /, ''))
            .filter((line) => line !== '')
    }

    const CHECKS: Record<string, (notes: Note[]) => boolean> = {
        'link-to-deny-list-note': ([from, to]) =>
            from !== undefined &&
            to !== undefined &&
            !from.denied &&
            to.denied &&
            linksTo(from, to),
        'link-to-unpublished-note': ([from, to]) =>
            from !== undefined && to !== undefined && !to.denied && linksTo(from, to),
        'attachment-in-deny-list-folder': ([from, attachment]) =>
            from !== undefined &&
            attachment !== undefined &&
            !from.denied &&
            attachment.denied &&
            !attachment.path.endsWith('.md') &&
            from.body.includes(`![[${attachment.name}]]`),
        'deny-list-folder': (notes) => notes.length > 1 && notes.every((note) => note.denied),
        'templates-folder': (notes) =>
            notes.every((note) => note.denied && /^public_note: true$/m.test(note.properties)),
        'move-into-deny-list-folder': (notes) =>
            notes.length === 1 && notes.every((n) => !n.denied),
        'ignore-property': (notes) =>
            notes.every((note) => !note.denied && /^publish_ignore: true$/m.test(note.properties)),
        'new-note-with-public-note-true': (notes) =>
            notes.every((note) => !note.denied && /^public_note: true$/m.test(note.properties)),
        'person-data': (notes) =>
            notes.every(
                (note) =>
                    /^date_of_birth: \d{4}-\d{2}-\d{2}$/m.test(note.properties) &&
                    /^email: \S+@example\.invalid$/m.test(note.properties)
            ),
        'frozen-query-with-deny-list-row': ([list, row]) =>
            list !== undefined &&
            row !== undefined &&
            row.denied &&
            /<!-- SerializedQuery: [\s\S]*<!-- SerializedQuery END -->/.test(list.body) &&
            list.body.includes(`- [[${row.name}]]`),
        'rename-with-link-cascade': ([target, ...sources]) =>
            target !== undefined &&
            sources.length >= 2 &&
            sources.every((source) => linksTo(source, target)),
        'folder-rename': (notes) => {
            const folders = new Set(
                notes.map((note) => note.path.split('/').slice(0, -1).join('/'))
            )
            const [folder] = folders
            return (
                notes.length >= 2 &&
                folders.size === 1 &&
                folder !== undefined &&
                notes.some((note) => note.body.includes(`[[${folder}/`))
            )
        },
        'duplicate-name': ([one, two]) =>
            one !== undefined &&
            two !== undefined &&
            one.name === two.name &&
            one.path !== two.path,
        'alias-of-two-notes': ([one, two]) =>
            one !== undefined &&
            two !== undefined &&
            aliases(one).some((alias) => aliases(two).includes(alias)),
        'alias-equal-to-a-file-name': ([withAlias, named]) =>
            withAlias !== undefined &&
            named !== undefined &&
            aliases(withAlias).includes(named.name),
        'name-with-plus': (notes) => notes.every((note) => note.name.includes('+')),
        'name-with-percent': (notes) => notes.every((note) => note.name.includes('%')),
        'name-with-ampersand': (notes) => notes.every((note) => note.name.includes('&')),
        'name-with-apostrophe': (notes) => notes.every((note) => note.name.includes("'")),
        'name-with-dots': (notes) => notes.every((note) => note.name.includes('.')),
        'folder-name-with-dot': (notes) =>
            notes.every((note) => note.path.split('/').slice(0, -1).join('/').includes('.')),
        'name-with-non-ascii': (notes) => notes.every((note) => /\P{ASCII}/u.test(note.name)),
        'name-ending-like-extension': (notes) =>
            notes.every((note) => /\.[a-z]{2,4}$/.test(note.name)),
        'french-note-with-twin': ([french, english]) =>
            french !== undefined &&
            english !== undefined &&
            /^language: fr$/m.test(french.properties) &&
            french.properties.includes(`[[${english.name}]]`) &&
            english.properties.includes(`[[${french.name}]]`),
        'music-blocks': (notes) =>
            notes.every((note) =>
                MUSIC_LANGUAGES.every((language) => note.body.includes(`\n\`\`\`${language}\n`))
            ),
        'link-blocks': (notes) =>
            notes.every((note) => LINK_BLOCK_FORMS.every((form) => form.test(note.body))),
        'main-site-with-url': (notes) =>
            notes.every((note) => /^main_site_url: https:\/\/\S+$/m.test(note.properties)),
        'main-site-without-url': (notes) =>
            notes.every(
                (note) =>
                    /^ghost_publish_id: \S+$/m.test(note.properties) &&
                    !note.properties.includes('main_site_url')
            ),
        'stub': (notes) =>
            notes.every(
                (note) =>
                    /^rating:$/m.test(note.properties) &&
                    note.body.split('\n').every((line) => line === '' || line.startsWith('#'))
            ),
        'ai-generated': (notes) =>
            notes.every((note) => /^ai_generated: true$/m.test(note.properties))
    }

    for (const [id, holds] of Object.entries(CHECKS)) {
        test(id, async () => {
            const notes = await readNotes(id)
            expect(notes.length).toBeGreaterThan(0)
            expect(holds(notes)).toBe(true)
        })
    }
})
