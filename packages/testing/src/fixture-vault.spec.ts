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
    if (!denyList.every((entry) => typeof entry === 'string')) {
        throw new Error('an entry of the deny list of the fixture configuration is not a text')
    }
    return denyList
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

// The rules of `fixtures/README.md` that keep the fixture vault readable on
// every system. The Rust checks run on Windows.
describe('file names of the fixture vault', () => {
    test('are names that Windows accepts', async () => {
        const refused = (await listFixtureVaultFiles()).filter((path) =>
            path
                .split('/')
                .some(
                    (segment) =>
                        /[<>:"|?*\\]/.test(segment) ||
                        /[. ]$/.test(segment) ||
                        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(segment)
                )
        )
        expect(refused).toEqual([])
    })

    test('do not differ by letter case only', async () => {
        const files = await listFixtureVaultFiles()
        const lower = files.map((path) => path.toLowerCase())
        expect(files.filter((_, index) => lower.indexOf(lower[index] ?? '') !== index)).toEqual([])
    })

    // macOS can give another Unicode form to a name. Git stores the composed form.
    test('are in the composed Unicode form', async () => {
        const files = await listFixtureVaultFiles()
        expect(files.filter((path) => path !== path.normalize('NFC'))).toEqual([])
    })
})

// The first set of notes: one entry of the catalog per feature and per trap of
// spec 18.4. Each check says what the files of the entry must hold. The rules
// come from the spec and from the text of the catalog entry, not from the notes.
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

    /** The entries whose notes have a name that is hard in a URL. */
    const HARD_NAMES = [
        'name-with-plus',
        'name-with-percent',
        'name-with-ampersand',
        'name-with-apostrophe',
        'name-with-dots',
        'name-with-non-ascii',
        'name-ending-like-extension'
    ]

    interface Note {
        path: string
        folder: string
        name: string
        properties: string
        body: string
        isNote: boolean
        denied: boolean
    }

    interface Link {
        embed: boolean
        target: string
        heading: boolean
        label: boolean
    }

    async function readNote(path: string): Promise<Note> {
        const isNote = path.endsWith('.md')
        const text = isNote ? await Bun.file(join(FIXTURE_VAULT, path)).text() : ''
        const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
        const segments = path.split('/')
        const denyList = await readDenyList()
        return {
            path,
            folder: segments.slice(0, -1).join('/'),
            name: (segments.at(-1) ?? path).replace(/\.md$/, ''),
            properties: match?.[1] ?? '',
            body: match?.[2] ?? text,
            isNote,
            denied: denyList.some((folder) => path.startsWith(`${folder}/`))
        }
    }

    async function readNotes(id: string): Promise<Note[]> {
        const entry = (await readFixtureCatalog()).find((candidate) => candidate.id === id)
        if (entry === undefined) {
            throw new Error(`the catalog has no entry "${id}"`)
        }
        return await Promise.all(entry.files.map(readNote))
    }

    /** Every link of the form `[[target#heading|label]]` in a text, embeds included. */
    function links(text: string): Link[] {
        return [...text.matchAll(/(!?)\[\[([^\]|#]*)(#[^\]|]*)?(\|[^\]]*)?\]\]/g)].map((match) => ({
            embed: match[1] === '!',
            target: match[2] ?? '',
            heading: match[3] !== undefined,
            label: match[4] !== undefined
        }))
    }

    function linksTo(from: Note, to: Note, wanted: Partial<Link> = {}): boolean {
        const targets = [to.name, to.path.replace(/\.md$/, '')]
        return links(from.body).some(
            (link) =>
                targets.includes(link.target) &&
                (wanted.embed === undefined || link.embed === wanted.embed) &&
                (wanted.heading === undefined || link.heading === wanted.heading) &&
                (wanted.label === undefined || link.label === wanted.label)
        )
    }

    function linksInProperty(from: Note, to: Note): boolean {
        return links(from.properties).some((link) => link.target === to.name)
    }

    /** The saved rows of the frozen queries of a note. */
    function frozenRows(note: Note): string {
        const rows = note.body.matchAll(
            /<!-- QueryToSerialize: (.*) -->\n<!-- SerializedQuery: \1 -->\n([\s\S]*?)<!-- SerializedQuery END -->/g
        )
        return [...rows].map((match) => match[2] ?? '').join('\n')
    }

    function property(note: Note, key: string): string | undefined {
        return new RegExp(`^${key}:[ ]?(.*)$`, 'm').exec(note.properties)?.[1]
    }

    function aliases(note: Note): string[] {
        const list = /^aliases:\n((?: {2}- .*\n?)+)/m.exec(note.properties)?.[1] ?? ''
        return list
            .split('\n')
            .map((line) => line.replace(/^ {2}- /, ''))
            .filter((line) => line !== '')
    }

    /** The text of the author: the lines of the body that are not empty and not a heading. */
    function ownText(note: Note): string[] {
        return note.body.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
    }

    async function noteNames(): Promise<Set<string>> {
        const files = await listFixtureVaultFiles()
        return new Set(files.map((path) => (path.split('/').at(-1) ?? path).replace(/\.md$/, '')))
    }

    type Check = (notes: Note[]) => void | Promise<void>

    /** Takes the notes of an entry in the order of the catalog. */
    function take(notes: Note[], count: number): Note[] {
        expect(notes.length).toBeGreaterThanOrEqual(count)
        return notes
    }

    const CHECKS: Record<string, Check> = {
        'link-to-deny-list-note': (notes) => {
            const [from, to] = take(notes, 2)
            expect(from?.denied).toBe(false)
            expect(to?.denied).toBe(true)
            if (from === undefined || to === undefined) return
            expect(linksTo(from, to, { embed: false })).toBe(true)
            expect(linksTo(from, to, { embed: true })).toBe(true)
        },
        'link-to-unpublished-note': async (notes) => {
            const [from, to] = take(notes, 2)
            if (from === undefined || to === undefined) return
            expect(from.denied || to.denied).toBe(false)
            expect(linksTo(from, to, { embed: false })).toBe(true)
            expect(linksTo(from, to, { embed: true })).toBe(true)
            expect(linksInProperty(from, to)).toBe(true)
            const names = await noteNames()
            expect(links(from.body).some((link) => !names.has(link.target))).toBe(true)
        },
        'attachment-in-deny-list-folder': (notes) => {
            const [from, attachment] = take(notes, 2)
            if (from === undefined || attachment === undefined) return
            expect(from.denied).toBe(false)
            expect(attachment.denied).toBe(true)
            expect(attachment.isNote).toBe(false)
            expect(linksTo(from, attachment, { embed: true })).toBe(true)
        },
        'attachment': (notes) => {
            const [from, attachment] = take(notes, 2)
            if (from === undefined || attachment === undefined) return
            expect(from.denied || attachment.denied).toBe(false)
            expect(attachment.isNote).toBe(false)
            // The only embed of the note, so that the simple case can be tested alone.
            expect(links(from.body)).toEqual([
                { embed: true, target: attachment.name, heading: false, label: false }
            ])
        },
        'deny-list-folder': (notes) => {
            expect(notes.every((note) => note.denied)).toBe(true)
            expect(notes.filter((note) => note.isNote).length).toBeGreaterThan(1)
            expect(notes.some((note) => !note.isNote)).toBe(true)
            expect(notes.some((note) => property(note, 'public_note') === 'true')).toBe(true)
        },
        'templates-folder': (notes) => {
            expect(notes.every((note) => note.denied)).toBe(true)
            expect(notes.every((note) => property(note, 'public_note') === 'true')).toBe(true)
        },
        'move-into-deny-list-folder': (notes) => {
            expect(notes.map((note) => note.denied)).toEqual([false])
        },
        'ignore-property': (notes) => {
            expect(notes.every((note) => !note.denied)).toBe(true)
            expect(notes.map((note) => property(note, 'publish_ignore'))).toEqual(['true'])
        },
        'new-note-with-public-note-true': (notes) => {
            expect(notes.every((note) => !note.denied)).toBe(true)
            expect(notes.map((note) => property(note, 'public_note'))).toEqual(['true'])
        },
        'person-data': (notes) => {
            for (const note of notes) {
                expect(property(note, 'date_of_birth')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
                expect(property(note, 'email')).toMatch(/^\S+@example\.invalid$/)
                expect(property(note, 'location')).toMatch(/\S/)
            }
        },
        'frozen-query-with-deny-list-row': (notes) => {
            const [list, row] = take(notes, 2)
            if (list === undefined || row === undefined) return
            expect(list.denied).toBe(false)
            expect(row.denied).toBe(true)
            expect(frozenRows(list)).toContain(`- [[${row.name}]]`)
        },
        'rename-with-link-cascade': (notes) => {
            const [target, ...sources] = take(notes, 3)
            if (target === undefined) return
            expect(
                sources.every(
                    (source) => linksTo(source, target) || linksInProperty(source, target)
                )
            ).toBe(true)
            const some = (test: (source: Note) => boolean): boolean => sources.some(test)
            // Each form that the catalog entry names.
            expect(
                some((source) =>
                    linksTo(source, target, { embed: false, heading: false, label: false })
                )
            ).toBe(true)
            expect(some((source) => linksTo(source, target, { label: true }))).toBe(true)
            expect(some((source) => linksTo(source, target, { embed: false, heading: true }))).toBe(
                true
            )
            expect(some((source) => linksTo(source, target, { embed: true }))).toBe(true)
            expect(
                some((source) =>
                    links(source.body).some(
                        (link) => link.target === `${target.folder}/${target.name}`
                    )
                )
            ).toBe(true)
            expect(some((source) => source.body.includes(`](${encodeURI(target.name)}.md)`))).toBe(
                true
            )
            expect(some((source) => linksInProperty(source, target))).toBe(true)
            expect(some((source) => frozenRows(source).includes(`[[${target.name}]]`))).toBe(true)
            expect(
                some((source) =>
                    new RegExp(`^LINKS?:? \\[\\[${target.name}[\\]|]`, 'm').test(source.body)
                )
            ).toBe(true)
        },
        'folder-rename': (notes) => {
            const [first] = take(notes, 3)
            if (first === undefined) return
            const folder = first.folder
            const inside = notes.filter((note) => note.folder === folder)
            const outside = notes.filter((note) => note.folder !== folder)
            expect(folder).not.toBe('')
            expect(inside.length).toBeGreaterThanOrEqual(2)
            // The folder note has the name of its folder.
            expect(inside.some((note) => note.name === folder.split('/').at(-1))).toBe(true)
            const namesTheFolder = (note: Note): boolean =>
                links(note.body).some((link) => link.target.startsWith(`${folder}/`))
            expect(inside.some(namesTheFolder)).toBe(true)
            expect(outside.length).toBeGreaterThanOrEqual(1)
            expect(outside.every(namesTheFolder)).toBe(true)
        },
        'duplicate-name': (notes) => {
            const [one, two, linker] = take(notes, 3)
            if (one === undefined || two === undefined || linker === undefined) return
            expect(one.name).toBe(two.name)
            expect(one.folder).not.toBe(two.folder)
            const targets = links(linker.body).map((link) => link.target)
            expect(targets).toContain(one.name)
            expect(targets).toContain(two.path.replace(/\.md$/, ''))
        },
        'alias-of-two-notes': (notes) => {
            const [one, two] = take(notes, 2)
            if (one === undefined || two === undefined) return
            expect(aliases(one).filter((alias) => aliases(two).includes(alias)).length).toBe(1)
        },
        'alias-equal-to-a-file-name': (notes) => {
            const [withAlias, named] = take(notes, 2)
            if (withAlias === undefined || named === undefined) return
            expect(aliases(withAlias)).toContain(named.name)
        },
        'name-with-plus': (notes) => {
            expect(notes.every((note) => note.name.includes('+'))).toBe(true)
        },
        'name-with-percent': (notes) => {
            expect(notes.every((note) => note.name.includes('%'))).toBe(true)
        },
        'name-with-ampersand': (notes) => {
            expect(notes.every((note) => note.name.includes('&'))).toBe(true)
        },
        'name-with-apostrophe': (notes) => {
            expect(notes.every((note) => note.name.includes("'"))).toBe(true)
        },
        'name-with-dots': (notes) => {
            expect(notes.every((note) => note.name.includes('.'))).toBe(true)
        },
        'folder-name-with-dot': (notes) => {
            expect(notes.every((note) => note.folder.includes('.'))).toBe(true)
        },
        'name-with-non-ascii': (notes) => {
            expect(notes.every((note) => /\P{ASCII}/u.test(note.name))).toBe(true)
            // One name has no ASCII letter at all.
            expect(notes.some((note) => !/[a-z]/i.test(note.name))).toBe(true)
        },
        'names-that-sort-differently': (notes) => {
            const [astral, high] = take(notes, 2)
            expect(astral?.name.codePointAt(0) ?? 0).toBeGreaterThan(0xffff)
            const first = high?.name.codePointAt(0) ?? 0
            expect(first).toBeGreaterThanOrEqual(0xe000)
            expect(first).toBeLessThanOrEqual(0xffff)
        },
        'name-ending-like-extension': (notes) => {
            expect(notes.every((note) => /\.[a-z]{2,4}$/.test(note.name))).toBe(true)
        },
        'french-note-with-twin': (notes) => {
            const [french, english] = take(notes, 2)
            if (french === undefined || english === undefined) return
            expect(property(french, 'language')).toBe('fr')
            expect(property(english, 'language')).toBe('en')
            expect(linksInProperty(french, english)).toBe(true)
            expect(linksInProperty(english, french)).toBe(true)
        },
        'music-blocks': (notes) => {
            for (const note of notes) {
                const languages = [...note.body.matchAll(/^```(\w+)$/gm)].map((match) => match[1])
                expect(languages.sort()).toEqual([...MUSIC_LANGUAGES].sort())
            }
        },
        'link-blocks': async (notes) => {
            const [note, denied, unpublished] = take(notes, 3)
            if (note === undefined || denied === undefined || unpublished === undefined) return
            expect(denied.denied).toBe(true)
            expect(unpublished.denied).toBe(false)
            const forms: Record<string, RegExp> = {
                // CARD-01: two keywords, an optional colon, three kinds of target.
                'LINK with a colon and a URL': /^LINK: https:\/\/\S+$/m,
                'LINK without a colon': /^LINK https:\/\/\S+$/m,
                'LINKS with a colon': /^LINKS: https:\/\/\S+$/m,
                'LINKS without a colon': /^LINKS https:\/\/\S+$/m,
                'a Markdown link': /^LINK: \[[^\]]+\]\(https:\/\/\S+\)$/m,
                'a link to a note': /^LINK: \[\[[^\]|]+\]\]$/m,
                'a link to a note with a label': /^LINK: \[\[[^\]|]+\|[^\]]+\]\]$/m,
                // CARD-02: the keyword alone, then list items, with no limit of five lines.
                'a list after LINK with a colon': /^LINK:\n- \S/m,
                'a list after LINK without a colon': /^LINK\n- \S/m,
                'a list after LINKS with a colon': /^LINKS:\n- \S/m,
                'a list after LINKS without a colon': /^LINKS\n- \S/m,
                'a list of more than five lines': /^LINKS?:?\n(?:- \S.*\n){6,}/m,
                'a list with a URL': /^LINKS?:?\n(?:- .*\n)*- https:\/\/\S+$/m,
                'a list with a Markdown link':
                    /^LINKS?:?\n(?:- .*\n)*- \[[^\]]+\]\(https:\/\/\S+\)$/m,
                // CARD-04: a target that is not published.
                'a target that is not published': new RegExp(
                    `^LINKS?:?\\n(?:- .*\\n)*- \\[\\[${RegExp.escape(unpublished.name)}\\]\\]$`,
                    'm'
                ),
                // CARD-05: a block where nothing can show.
                'a block with a deny list target only': new RegExp(
                    `\\n\\nLINK: \\[\\[${RegExp.escape(denied.name)}\\]\\]\\n\\n`
                ),
                // CARD-08: lines that are not LINK lines.
                'a line in a code block': /^```text\nLINK: https:\/\/\S+\n```$/m,
                'a line in inline code': /`LINK: https:\/\/\S+`/,
                'a line in a comment of Obsidian': /^%%\nLINK: https:\/\/\S+\n%%$/m,
                'a line in an HTML comment': /^<!--\nLINK: https:\/\/\S+\n-->$/m
            }
            for (const [form, pattern] of Object.entries(forms)) {
                expect(pattern.test(note.body), form).toBe(true)
            }
            // CARD-08: a line in the saved rows of a frozen query.
            expect(frozenRows(note)).toMatch(/^LINK: https:\/\/\S+$/m)
            // CARD-05: a block whose only target does not exist.
            const names = await noteNames()
            const listTargets = [...note.body.matchAll(/^LINK\n- \[\[([^\]]+)\]\]\n\n/gm)]
            expect(listTargets.some((match) => !names.has(match[1] ?? ''))).toBe(true)
        },
        'main-site-with-url': (notes) => {
            for (const note of notes) {
                expect(property(note, 'ghost_publish')).toBe('true')
                expect(property(note, 'ghost_publish_id')).toMatch(/^\S+$/)
                expect(property(note, 'main_site_url')).toMatch(/^https:\/\/\S+$/)
            }
        },
        'main-site-without-url': (notes) => {
            for (const note of notes) {
                expect(property(note, 'ghost_publish')).toBe('true')
                expect(property(note, 'ghost_publish_id')).toMatch(/^\S+$/)
                expect(property(note, 'main_site_url')).toBeUndefined()
            }
        },
        'stub': (notes) => {
            for (const note of notes) {
                expect(property(note, 'status')).toMatch(/\S/)
                expect(property(note, 'rating')).toBe('')
                expect(ownText(note)).toEqual([])
            }
        },
        'media-note-with-text': (notes) => {
            for (const note of notes) {
                expect(property(note, 'rating')).toMatch(/^\d$/)
                expect(ownText(note).length).toBeGreaterThan(0)
            }
        },
        'ai-generated': (notes) => {
            expect(notes.map((note) => property(note, 'ai_generated'))).toEqual(['true'])
        },
        'root-note': (notes) => {
            expect(notes.map((note) => note.folder)).toEqual([''])
        },
        'links-to-hard-names': async (notes) => {
            const [note] = take(notes, 1)
            if (note === undefined) return
            const targets = links(note.body).map((link) => link.target.split('/').at(-1))
            for (const id of HARD_NAMES) {
                for (const hard of await readNotes(id)) {
                    expect(targets, hard.name).toContain(hard.name)
                }
            }
        }
    }

    for (const [id, check] of Object.entries(CHECKS)) {
        test(id, async () => {
            await check(await readNotes(id))
        })
    }

    // An entry without a check would be a claim that nothing tests.
    test('every entry of the catalog has a check', async () => {
        const ids = (await readFixtureCatalog()).map((entry) => entry.id)
        expect(ids.filter((id) => !(id in CHECKS))).toEqual([])
    })
})
