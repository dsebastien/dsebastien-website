import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    copyFixtureVault,
    gitEnvironment,
    makeContentStoreCopy,
    makeTestStores
} from '@dsebastien-website/testing'
import { toCanonicalJson } from '../apps/plugin/src/publishing/canonical.ts'
import type { CanonicalValue } from '../apps/plugin/src/publishing/canonical.ts'
import { nodeDevice } from '../apps/plugin/src/publishing/node/device.ts'
import type { Selection } from '../apps/plugin/src/publishing/plan.ts'
import { plan, publish, status } from '../apps/plugin/src/publishing/tool.ts'
import { buildRustProgram, runRustProgram } from './harness.ts'

// The parity rule (ADR 0009, TEST-03 of the spec): for the same input, the
// TypeScript and the Rust implementation write the same bytes in the canonical
// form: the publication plan without its id, the cleaned notes and the
// manifest. The vault after the publication is compared too (SEAM-02). A
// failure here blocks a release.

const TIME = '2031-04-01T08:00:00Z'
const DEVICE = 'garden-shed'

// Notes that give the comparison something to disagree on: a plain note, a
// note at the root, a note whose property is removed by the cleaning step, a
// name outside ASCII, and two names whose order differs between the code
// points and the UTF-16 units.
const NOTES = [
    '10 Garden/Frost dates explained.md',
    'Welcome.md',
    '10 Garden/Bean trellis.md',
    "20 Library/20.02 Recipes/Crème brûlée à l'érable.md",
    '10 Garden/🌱 Seedlings.md',
    '10 Garden/～ Pond.md',
    // Notes with links: every form of a link, a name that two notes have, a
    // link in a property, a link into a folder of the deny list, and names
    // with characters that a URL encodes.
    '10 Garden/Drip irrigation.md',
    '10 Garden/Herb bed/Thyme.md',
    '10 Garden/Seed swap day.md',
    '10 Garden/Watering schedule.md',
    '20 Library/20.02 Recipes/Recipes.md'
]

const MARK = String.fromCharCode(0xfeff)

// Notes in forms that the fixture vault does not have. Each one was a way to
// make the two implementations disagree, or to damage a note. They are written
// into the copy of the vault of each implementation before it runs.
const CRAFTED: Record<string, string> = {
    'Crafted/Windows line ends.md':
        '---\r\ntags: a\r\npublic_note: false\r\n---\r\nText\r\nMore\r\n',
    'Crafted/Byte order mark.md': `${MARK}---\ntags: a\n---\nText\n`,
    'Crafted/Mark and no properties.md': `${MARK}Text\n`,
    'Crafted/No properties.md': 'Text\n\n---\n\nMore text\n',
    'Crafted/Windows and no properties.md': 'Text\r\nMore\r\n',
    'Crafted/Odd state.md':
        '---\npublic_note : true\ntags: a\n"public_note": false\npublic_note:\n  - x\n  - y\nlast: b\n---\nText\n',
    'Crafted/Never closed.md': '---\ntags: a\nText\n',
    'Crafted/Empty.md': '',
    'Crafted/Empty properties.md': '---\n---\nText\n',
    'Crafted/No line end.md': '---\ntags: a\n---',
    'Crafted/Lone return.md': 'One\rTwo\n',
    'Crafted/Ignore is false.md': '---\npublish_ignore: false\n---\nText\n',
    // Properties in the flow form of YAML: the tool never writes into them.
    'Crafted/Flow form.md': '---\n{ "tags": ["a"] }\n---\nText\n',
    // Links in hard forms: another letter case, a table, paths from the folder
    // of the note and from the root, destinations to decode, and brackets
    // that open no link.
    'Crafted/Links.md': [
        '---',
        'related: "[[frost DATES explained]]"',
        'sources:',
        "  - '[[10 Garden/Herb bed/Mint|the plant]]'",
        '---',
        '| One | Two |',
        '| --- | --- |',
        '| [[Welcome\\|home]] | ![[🌱 Seedlings#Top]] |',
        '',
        'From here: [[../10 Garden/Bean trellis]], [[./Byte order mark]] and [[/Welcome]].',
        "Markdown: [a](../Welcome.md) [b](<Windows line ends.md>) [c](Cr%C3%A8me%20br%C3%BBl%C3%A9e%20%C3%A0%20l'%C3%A9rable.md#top) [d](https://garden.example/x) [e](Bad%ZZ.md) [f](%EF%BB%BFmark.md)",
        "Names: [[～ Pond]] [[CRÈME BRÛLÉE À L'ÉRABLE]] [[Mint]] [[Sprout.js]] [[日本の庭]] [[Nothing here]] [[Greenhouse alarm code]] [[Ignore is false]]",
        'Brackets: [[[Welcome]]] [[one [[Empty]] ]] [[ Odd state |x]] [[Never closed#part|y]] [[#Here]]',
        ''
    ].join('\n'),
    'Crafted/Links with Windows line ends.md':
        '[[Welcome]]\r\n[b](Welcome.md)\r\nAlone\r[[Empty]]\n',
    // A note whose folder enters the deny list after its publication.
    'Private/Diary.md': 'Diary\n'
}

// Notes that no implementation may publish. Both must refuse each one.
const REFUSED: Record<string, string> = {
    'Refused/Quoted key.md': '---\n"publish_ignore": yes # never\n---\nText\n',
    'Refused/Nested key.md': '---\nmeta:\n  publish_ignore: true\n---\nText\n',
    'Refused/Value below.md': '---\npublish_ignore:\n  - true\n---\nText\n',
    'Refused/Mark.md': `${MARK}---\npublish_ignore: true\n---\nText\n`,
    'Refused/Next line character.md': '---\npublish_ignore: false\u0085\n---\nText\n',
    'Refused/One line of JSON.md': '---\n{ "publish_ignore": true, "tags": ["a"] }\n---\nText\n',
    'Refused/Inside a word.md': '---\nnot_publish_ignore_x: 1\n---\nText\n'
}

// A note that cannot be read stops every plan, so it is not in the vault of the other cases.
const NOT_UTF8 = 'Refused/Not UTF-8.md'

/** Paths that no implementation may publish, with no file to write. */
const REFUSED_PATHS = [
    '90 Locked Shed/Shed inventory.md',
    '90 locked shed/Shed inventory.md',
    'Refused/Linked.md',
    'Refused/Linked folder/Shed inventory.md',
    './Welcome.md',
    'Welcome.MD',
    '10 Garden//Compost basics.md'
]

/** Writes the crafted notes, the refused notes and two symbolic links into a copy of the vault. */
async function craft(vault: string): Promise<void> {
    await mkdir(join(vault, 'Crafted'))
    await mkdir(join(vault, 'Refused'))
    await mkdir(join(vault, 'Private'))
    for (const [path, text] of Object.entries({ ...CRAFTED, ...REFUSED })) {
        await writeFile(join(vault, path), text)
    }
    await symlink(
        join(vault, '90 Locked Shed', 'Shed inventory.md'),
        join(vault, 'Refused/Linked.md')
    )
    await symlink(join(vault, '90 Locked Shed'), join(vault, 'Refused/Linked folder'))
}

/** Every note that both implementations publish in the parity run. */
const PUBLISHED = [...NOTES, ...Object.keys(CRAFTED)]

/** What one implementation left behind: each file as text, by its path. */
interface Result {
    /** The stored plans, without their ids: the records, sorted. */
    plans: string[]
    /** The files of the content store, the git folder left out. */
    store: Record<string, string>
    /** The files of the vault. Attachments are compared as their bytes in hexadecimal. */
    vault: Record<string, string>
}

async function filesOf(folder: string): Promise<Record<string, string>> {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true })
    const files: Record<string, string> = {}
    for (const entry of entries) {
        const path = join(entry.parentPath, entry.name)
        const name = path.slice(folder.length + 1).replaceAll('\\', '/')
        // A symbolic link is not a file here: `isFile` is false for it.
        if (entry.isFile() && !name.startsWith('.git/')) {
            const bytes = await Bun.file(path).bytes()
            // With the byte order mark kept: it is a part of what the implementations write.
            files[name] = name.endsWith('.png')
                ? bytes.toHex()
                : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
        }
    }
    return Object.fromEntries(Object.entries(files).sort(([one], [two]) => (one < two ? -1 : 1)))
}

async function resultOf(vault: string, copy: string): Promise<Result> {
    const plans = await filesOf(join(copy, '.git', 'vault-publish', 'plans'))
    return {
        plans: Object.values(plans).sort(),
        store: await filesOf(copy),
        vault: await filesOf(vault)
    }
}

type Implementation = (vault: string, copy: string, include: readonly string[]) => Promise<void>

const typescript: Implementation = async (vault, copy, include) => {
    const device = nodeDevice({ vault, contentStore: copy })
    const planned = await plan(device, { include })
    await publish(device, planned.id, { time: TIME, device: DEVICE, face: 'command-line' })
}

let program: string

const rust: Implementation = async (vault, copy, include) => {
    const places = ['--vault', vault, '--content-store', copy]
    const planned = await runRustProgram(program, [
        'plan',
        ...places,
        ...include.flatMap((path) => ['--include', path])
    ])
    expect(planned.stderr).toBe('')
    const output: unknown = JSON.parse(new TextDecoder().decode(planned.stdout))
    const id = typeof output === 'object' && output !== null && 'id' in output ? output.id : ''
    const published = await runRustProgram(program, [
        'publish',
        ...places,
        '--plan',
        String(id),
        '--time',
        TIME
    ])
    expect(published.stderr).toBe('')
}

/** Runs one implementation on stores of its own and gives what it left behind. */
async function run(implementation: Implementation, include: readonly string[]): Promise<Result> {
    await using stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    await craft(vault)
    await implementation(vault, copy, include)
    return await resultOf(vault, copy)
}

beforeAll(async () => {
    program = await buildRustProgram()
}, 600_000)

describe('parity of a first publication', () => {
    let fromTypeScript: Result
    let fromRust: Result

    beforeAll(async () => {
        fromTypeScript = await run(typescript, PUBLISHED)
        fromRust = await run(rust, PUBLISHED)
    }, 120_000)

    test('both implementations store the same plan', () => {
        expect(fromRust.plans).toEqual(fromTypeScript.plans)
        expect(fromTypeScript.plans.length).toBe(1)
    })

    test('both implementations write the same content store', () => {
        expect(fromRust.store).toEqual(fromTypeScript.store)
    })

    test('both implementations leave the same vault', () => {
        expect(fromRust.vault).toEqual(fromTypeScript.vault)
    })

    // The comparison must have something to compare.
    test('the publication wrote every note, its manifest entry and its property', () => {
        const files = Object.keys(fromTypeScript.store)
        expect(files.filter((file) => file.startsWith('notes/')).sort()).toEqual(
            PUBLISHED.map((note) => `notes/${note}`).sort()
        )
        expect(files.filter((file) => file.startsWith('manifest/')).length).toBe(PUBLISHED.length)
        for (const note of PUBLISHED.filter((path) => path !== 'Crafted/Flow form.md')) {
            expect(fromTypeScript.vault[note], note).toMatch(/(^|\n)public_note: true(\r?\n|$)/)
        }
    })

    // What the canonical form says about the crafted notes, stated by hand.
    test('the crafted notes are cleaned and corrected as the canonical form says', () => {
        const store = fromRust.store
        const vault = fromRust.vault
        expect(store['notes/Crafted/Windows line ends.md']).toBe('---\ntags: a\n---\nText\nMore\n')
        expect(vault['Crafted/Windows line ends.md']).toBe(
            '---\r\ntags: a\r\npublic_note: true\r\n---\r\nText\r\nMore\r\n'
        )
        expect(store['notes/Crafted/Byte order mark.md']).toBe('---\ntags: a\n---\nText\n')
        expect(vault['Crafted/Byte order mark.md']).toBe(
            `${MARK}---\ntags: a\npublic_note: true\n---\nText\n`
        )
        expect(vault['Crafted/Mark and no properties.md']).toBe(
            `${MARK}---\npublic_note: true\n---\nText\n`
        )
        expect(store['notes/Crafted/Odd state.md']).toBe('---\ntags: a\nlast: b\n---\nText\n')
        expect(vault['Crafted/Odd state.md']).toBe(
            '---\npublic_note: true\ntags: a\nlast: b\n---\nText\n'
        )
        expect(vault['Crafted/Windows and no properties.md']).toBe(
            '---\r\npublic_note: true\r\n---\r\nText\r\nMore\r\n'
        )
        expect(vault['Crafted/Empty.md']).toBe('---\npublic_note: true\n---\n')
        expect(store['notes/Crafted/Lone return.md']).toBe('One\rTwo\n')
        expect(store['notes/Crafted/Flow form.md']).toBe('---\n{ "tags": ["a"] }\n---\nText\n')
        expect(vault['Crafted/Flow form.md']).toBe('---\n{ "tags": ["a"] }\n---\nText\n')
    })

    // The order of the code points, not the order of the UTF-16 units.
    test('the plan lists the notes in the order of the canonical form', () => {
        const record: unknown = JSON.parse(fromRust.plans[0] ?? '{}')
        const publish: unknown =
            typeof record === 'object' && record !== null && 'plan' in record
                ? (record.plan as { publish?: unknown }).publish
                : undefined
        const fixtureNotes = Array.isArray(publish)
            ? publish.filter((path) => typeof path === 'string' && NOTES.includes(path))
            : []
        expect(fixtureNotes).toEqual([
            '10 Garden/Bean trellis.md',
            '10 Garden/Drip irrigation.md',
            '10 Garden/Frost dates explained.md',
            '10 Garden/Herb bed/Thyme.md',
            '10 Garden/Seed swap day.md',
            '10 Garden/Watering schedule.md',
            '10 Garden/～ Pond.md',
            '10 Garden/🌱 Seedlings.md',
            "20 Library/20.02 Recipes/Crème brûlée à l'érable.md",
            '20 Library/20.02 Recipes/Recipes.md',
            'Welcome.md'
        ])
    })
})

// The publication queue (issue 33). Each implementation goes through the same
// story on stores of its own: a first publication, then what an author and
// another device do, then the queue, a plan with paths to include, to hold and
// to remove, and its publication.

const LATER = '2031-04-02T09:00:00Z'

/** One implementation on one vault and one copy of the content store. Every result is text in the canonical form. */
interface Tool {
    status(): Promise<string>
    /** Makes the plan of a selection, applies it, and gives the plan and the lists of paths of the report. */
    publish(selection: Selection, time: string): Promise<{ plan: string; report: string }>
}

/** The lists of paths of a report: the texts for a person are outside the parity rule. */
function reportLists(report: Record<string, unknown>): string {
    const pathsOf = (list: unknown): string[] =>
        Array.isArray(list)
            ? list.map((item: unknown) =>
                  typeof item === 'string' ? item : (item as { path: string }).path
              )
            : []
    return toCanonicalJson(
        Object.fromEntries(Object.keys(report).map((key) => [key, pathsOf(report[key])]))
    )
}

function typescriptTool(vault: string, copy: string): Tool {
    const device = nodeDevice({ vault, contentStore: copy })
    return {
        status: async () => toCanonicalJson(await status(device)),
        async publish(selection, time) {
            const planned = await plan(device, selection)
            const report = await publish(device, planned.id, {
                time,
                device: DEVICE,
                face: 'command-line'
            })
            return { plan: toCanonicalJson(planned.plan), report: reportLists(report) }
        }
    }
}

function rustTool(vault: string, copy: string): Tool {
    const places = ['--vault', vault, '--content-store', copy]
    const run = async (command: string, args: readonly string[]): Promise<string> => {
        const result = await runRustProgram(program, [command, ...places, ...args])
        expect(result.stderr, command).toBe('')
        return new TextDecoder().decode(result.stdout)
    }
    return {
        status: () => run('status', []),
        async publish(selection, time) {
            const planned = JSON.parse(
                await run('plan', [
                    ...selection.include.map((path) => `--include=${path}`),
                    ...(selection.hold ?? []).map((path) => `--hold=${path}`),
                    ...(selection.remove ?? []).map((path) => `--remove=${path}`)
                ])
            ) as { id: string; plan: Record<string, CanonicalValue> }
            const report = JSON.parse(
                await run('publish', ['--plan', planned.id, '--time', time, '--device', DEVICE])
            ) as Record<string, unknown>
            return { plan: toCanonicalJson(planned.plan), report: reportLists(report) }
        }
    }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
    const child = Bun.spawn(['git', ...args], { cwd, env: gitEnvironment(), stderr: 'pipe' })
    const errors = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${errors.trim()}`)
    }
}

const EDITED = '10 Garden/Frost dates explained.md'
const EDITED_WINDOWS = 'Crafted/Windows line ends.md'
const HELD = 'Welcome.md'
const MISSING = '10 Garden/～ Pond.md'
const GUARDED = 'Crafted/No properties.md'
const TECHNICAL = '10 Garden/🌱 Seedlings.md'
const UNPUBLISHED = 'Crafted/Lone return.md'
const HAND = 'Crafted/Byte order mark.md'
const NEW = 'Crafted/New note.md'
const WRONG = 'Crafted/Wrong property.md'
const DENIED = 'Private/Diary.md'
const MOVED = 'Crafted/Empty properties.md'
const MOVED_TO = '90 Locked Shed/Attachments/empty PROPERTIES.md'
const LINKS = 'Crafted/Links.md'
const LINKING = '10 Garden/Drip irrigation.md'
const TARGET = '10 Garden/Water butt.md'

/** What the author and another device do after the first publication. */
async function change(vault: string, copy: string): Promise<void> {
    const append = async (path: string, text: string): Promise<void> => {
        const file = join(vault, path)
        const before = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
            await Bun.file(file).bytes()
        )
        await writeFile(file, before + text)
    }
    await append(EDITED, '\nA second paragraph.\n')
    await append(EDITED_WINDOWS, 'A third line\r\n')
    await append(HELD, '\nA change that is not ready.\n')
    await rm(join(vault, MISSING))
    await writeFile(join(vault, GUARDED), '---\npublish_ignore: true\n---\nText\n')
    // The author removes the property of a published note by hand.
    await writeFile(join(vault, HAND), `${MARK}---\ntags: a\n---\nText\n`)
    await writeFile(join(vault, NEW), '---\r\ntags: a\r\n---\r\nNew\r\n')
    // A note that carries the property by mistake and that nobody selects.
    await writeFile(join(vault, WRONG), `${MARK}---\npublic_note: true\n---\nNever selected\n`)
    // The author moves a published note into a folder of the deny list, with another letter case.
    await rename(join(vault, MOVED), join(vault, MOVED_TO))
    // The author makes a note that a published note names in a link.
    await writeFile(join(vault, TARGET), 'Another name of the barrel\n')

    // Another device puts the folder of a published note on the deny list.
    await writeFile(
        join(copy, 'configuration.json'),
        '{\n  "denyList": ["80 Templates", "90 Locked Shed", "Private"]\n}\n'
    )
    await git(copy, 'add', '--', 'configuration.json')
    await git(copy, 'commit', '--quiet', '--message', 'A folder enters the deny list')
    await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')

    // The entry of one note comes from an older version of the cleaning step.
    for (const file of await readdir(join(copy, 'manifest'))) {
        const path = join(copy, 'manifest', file)
        const entry = (await Bun.file(path).json()) as Record<string, CanonicalValue>
        if (entry['path'] === TECHNICAL) {
            await writeFile(path, toCanonicalJson({ ...entry, cleaningVersion: 0 }))
            await git(copy, 'add', '--', `manifest/${file}`)
            await git(copy, 'commit', '--quiet', '--message', 'An entry of an older version')
            await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
        }
    }
}

/** What one implementation gave at each step of the story. */
interface Story {
    queueBefore: string
    publication: { plan: string; report: string }
    queueAfter: string
    left: Result
}

async function story(toolOf: (vault: string, copy: string) => Tool): Promise<Story> {
    await using stores = await makeTestStores()
    const vault = await copyFixtureVault(stores)
    const copy = await makeContentStoreCopy(stores)
    await craft(vault)
    const tool = toolOf(vault, copy)
    await tool.publish({ include: PUBLISHED }, TIME)
    await change(vault, copy)
    const queueBefore = await tool.status()
    const publication = await tool.publish(
        { include: [NEW], hold: [HELD], remove: [UNPUBLISHED] },
        LATER
    )
    return {
        queueBefore,
        publication,
        queueAfter: await tool.status(),
        left: await resultOf(vault, copy)
    }
}

describe('parity of the publication queue', () => {
    let fromTypeScript: Story
    let fromRust: Story

    beforeAll(async () => {
        fromTypeScript = await story(typescriptTool)
        fromRust = await story(rustTool)
    }, 120_000)

    test('both implementations give the same queue', () => {
        expect(fromRust.queueBefore).toBe(fromTypeScript.queueBefore)
        expect(fromRust.queueAfter).toBe(fromTypeScript.queueAfter)
    })

    test('both implementations make the same plan and the same report', () => {
        expect(fromRust.publication).toEqual(fromTypeScript.publication)
    })

    test('both implementations store the same plans', () => {
        expect(fromRust.left.plans).toEqual(fromTypeScript.left.plans)
        expect(fromTypeScript.left.plans.length).toBe(2)
    })

    test('both implementations write the same content store', () => {
        expect(fromRust.left.store).toEqual(fromTypeScript.left.store)
    })

    test('both implementations leave the same vault', () => {
        expect(fromRust.left.vault).toEqual(fromTypeScript.left.vault)
    })

    // The comparison must have something to compare. The expected values are stated by hand.
    test('the queue has a note in each list', () => {
        const queue = JSON.parse(fromRust.queueBefore) as Record<string, string[]>
        expect(queue['changed']).toEqual([LINKING, EDITED, TECHNICAL, LINKS, EDITED_WINDOWS, HELD])
        // An older version of the cleaning step, a target that was made, and a target that is missing.
        expect(queue['technicalUpdates']).toEqual([LINKING, TECHNICAL, LINKS])
        expect(queue['toRemove']).toEqual([MISSING, MOVED, GUARDED, DENIED])
        expect(queue['new']).toContain(NEW)
        expect(queue['new']).toContain(TARGET)
        expect(queue['new']).toContain(WRONG)
        expect(queue['unchanged']).toContain(HAND)
        expect(queue['unchanged']).toContain(UNPUBLISHED)
    })

    test('the publication does what the selection says', () => {
        expect(JSON.parse(fromRust.publication.plan)).toEqual({
            // The note that moved into a folder of the deny list, the note with
            // the ignore property, and the note in the new folder of the deny list.
            forcedRemove: [MOVED, GUARDED, DENIED],
            publish: [NEW],
            remove: [UNPUBLISHED],
            update: [LINKING, EDITED, TECHNICAL, LINKS, EDITED_WINDOWS]
        })
        const report = JSON.parse(fromRust.publication.report) as Record<string, string[]>
        expect(report['published']).toEqual([NEW])
        expect(report['updated']).toEqual([LINKING, EDITED, TECHNICAL, LINKS, EDITED_WINDOWS])
        expect(report['removed']).toEqual([UNPUBLISHED])
        expect(report['forcedRemoved']).toEqual([MOVED, GUARDED, DENIED])
        expect(report['skipped']).toEqual([HELD])
        expect(report['failed']).toEqual([])
        expect(report['propertySet']).toEqual([HAND, NEW])
        expect(report['propertyRemoved']).toEqual([UNPUBLISHED, WRONG])

        const { store, vault } = fromRust.left
        expect(store[`notes/${NEW}`]).toBe('---\ntags: a\n---\nNew\n')
        expect(store[`notes/${UNPUBLISHED}`]).toBeUndefined()
        expect(store[`notes/${WRONG}`]).toBeUndefined()
        expect(store[`notes/${EDITED_WINDOWS}`]).toBe(
            '---\ntags: a\n---\nText\nMore\nA third line\n'
        )
        expect(vault[NEW]).toBe('---\r\ntags: a\r\npublic_note: true\r\n---\r\nNew\r\n')
        expect(vault[WRONG]).toBe(`${MARK}Never selected\n`)
        expect(vault[HAND]).toBe(`${MARK}---\ntags: a\npublic_note: true\n---\nText\n`)
        expect(vault[UNPUBLISHED]).toBe('One\rTwo\n')
        // The forced removals left the content store. The note in the folder
        // of the deny list is not written in the vault.
        expect(store[`notes/${GUARDED}`]).toBeUndefined()
        expect(store[`notes/${MOVED}`]).toBeUndefined()
        expect(vault[MOVED_TO]).toBe('---\npublic_note: true\n---\nText\n')
        expect(store[`notes/${DENIED}`]).toBeUndefined()
        expect(Object.values(store).filter((text) => text.includes(`"path": "${DENIED}"`))).toEqual(
            []
        )
        expect(vault[GUARDED]).toBe('---\npublish_ignore: true\n---\nText\n')
        expect(vault[DENIED]).toBe('---\npublic_note: true\n---\nDiary\n')

        const after = JSON.parse(fromRust.queueAfter) as Record<string, string[]>
        expect(after['changed']).toEqual([HELD])
        expect(after['technicalUpdates']).toEqual([])
        expect(after['toRemove']).toEqual([MISSING])
        expect(after['new']).toContain(UNPUBLISHED)
    })

    test('the manifest names the target of each form of a link', () => {
        const linksOf = (note: string): unknown[] => {
            for (const [file, text] of Object.entries(fromRust.left.store)) {
                if (file.startsWith('manifest/')) {
                    const entry = JSON.parse(text) as { path: string; links: unknown[] }
                    if (entry.path === note) {
                        return entry.links
                    }
                }
            }
            throw new Error(`the manifest has no entry for "${note}"`)
        }
        const creme = "20 Library/20.02 Recipes/Crème brûlée à l'érable.md"
        const links = linksOf(LINKS)
        for (const [link, path] of [
            ['frost DATES explained', EDITED],
            ['10 Garden/Herb bed/Mint', '10 Garden/Herb bed/Mint.md'],
            ['Welcome', 'Welcome.md'],
            ['🌱 Seedlings', TECHNICAL],
            ['../10 Garden/Bean trellis', '10 Garden/Bean trellis.md'],
            ['./Byte order mark', HAND],
            ['/Welcome', 'Welcome.md'],
            ['../Welcome.md', 'Welcome.md'],
            ['Windows line ends.md', EDITED_WINDOWS],
            ["Crème brûlée à l'érable.md", creme],
            ["CRÈME BRÛLÉE À L'ÉRABLE", creme],
            ['Mint', '10 Garden/Herb bed/Mint.md'],
            ['Sprout.js', '20 Library/Sprout.js.md'],
            ['日本の庭', '10 Garden/日本の庭.md'],
            ['Ignore is false', 'Crafted/Ignore is false.md'],
            ['Empty', 'Crafted/Empty.md'],
            ['Odd state', 'Crafted/Odd state.md'],
            ['Never closed', 'Crafted/Never closed.md']
        ] as const) {
            expect(links, link).toContainEqual({ link, path })
        }
        // No item for a name that no note has, for a note in a folder of the
        // deny list, for a destination that is not a file of the vault, and
        // for the note that went missing after the first publication.
        expect(links).toHaveLength(18)
        // The link whose target was made after the first publication.
        expect(linksOf(LINKING)).toContainEqual({ link: 'Water butt', path: TARGET })
        expect(linksOf('Crafted/Links with Windows line ends.md')).toEqual([
            { link: 'Empty', path: 'Crafted/Empty.md' },
            { link: 'Welcome', path: 'Welcome.md' },
            { link: 'Welcome.md', path: 'Welcome.md' }
        ])
    })
})

describe('parity of an empty queue', () => {
    test('both implementations write the empty queue of the canonical form', async () => {
        const queueOf = async (toolOf: (vault: string, copy: string) => Tool): Promise<string> => {
            await using stores = await makeTestStores()
            const vault = join(stores.root, 'vault')
            await mkdir(vault)
            const copy = await makeContentStoreCopy(stores)
            await writeFile(join(copy, 'configuration.json'), '{"denyList": []}')
            await git(copy, 'commit', '--quiet', '--all', '--message', 'An empty deny list')
            await git(copy, 'push', '--quiet', 'origin', 'HEAD:main')
            return await toolOf(vault, copy).status()
        }

        const fromTypeScript = await queueOf(typescriptTool)

        expect(await queueOf(rustTool)).toBe(fromTypeScript)
        expect(fromTypeScript).toBe(
            '{\n  "behind": 0,\n  "changed": [],\n  "counts": {\n    "changed": 0,\n    "new": 0,\n    "toRemove": 0,\n    "unchanged": 0\n  },\n  "new": [],\n  "technicalUpdates": [],\n  "toRemove": [],\n  "unchanged": []\n}\n'
        )
    }, 120_000)
})

describe('parity of an empty plan', () => {
    test('both implementations store the same plan and change nothing', async () => {
        const fromTypeScript = await run(async (vault, copy) => {
            await plan(nodeDevice({ vault, contentStore: copy }), { include: [] })
        }, [])
        const fromRust = await run(async (vault, copy) => {
            const planned = await runRustProgram(program, [
                'plan',
                '--vault',
                vault,
                '--content-store',
                copy
            ])
            expect(planned.exitCode).toBe(0)
        }, [])

        expect(fromRust).toEqual(fromTypeScript)
        expect(fromRust.plans).toEqual([
            '{\n  "plan": {\n    "forcedRemove": [],\n    "publish": [],\n    "remove": [],\n    "update": []\n  },\n  "selection": {\n    "hold": [],\n    "include": [],\n    "remove": []\n  },\n  "state": {\n    "configuration": "sha256:e06bbfc5161c72405ce2776eab77bc0001e63cdfc935e664fe5e8be0d98b9a12",\n    "manifest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",\n    "notes": []\n  }\n}\n'
        ])
    }, 120_000)
})

describe('parity of the guards', () => {
    // A note that one implementation refuses and the other publishes is the
    // worst difference that the two can have.
    test('both implementations refuse the same notes, and publish none of them', async () => {
        const refused = [...Object.keys(REFUSED), ...REFUSED_PATHS]
        const outcome = async (
            implementation: Implementation
        ): Promise<Record<string, boolean>> => {
            await using stores = await makeTestStores()
            const vault = await copyFixtureVault(stores)
            const copy = await makeContentStoreCopy(stores)
            await craft(vault)
            const outcomes: Record<string, boolean> = {}
            for (const path of refused) {
                try {
                    await implementation(vault, copy, [path])
                    outcomes[path] = true
                } catch {
                    outcomes[path] = false
                }
            }
            // A note that cannot be read stops the plan of that note, and of every other note.
            await writeFile(join(vault, NOT_UTF8), Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
            for (const path of [NOT_UTF8, 'Welcome.md']) {
                try {
                    await implementation(vault, copy, [path])
                    outcomes[`${path}, with a note that cannot be read`] = true
                } catch {
                    outcomes[`${path}, with a note that cannot be read`] = false
                }
            }
            // Nothing of a refused note reached the content store.
            expect(Object.keys(await filesOf(copy))).toEqual(['configuration.json'])
            return outcomes
        }
        const rustOrThrow: Implementation = async (vault, copy, include) => {
            const planned = await runRustProgram(program, [
                'plan',
                '--vault',
                vault,
                '--content-store',
                copy,
                ...include.map((path) => `--include=${path}`)
            ])
            if (planned.exitCode !== 0) {
                throw new Error(planned.stderr)
            }
        }
        const typescriptPlan: Implementation = async (vault, copy, include) => {
            await plan(nodeDevice({ vault, contentStore: copy }), { include })
        }

        const fromTypeScript = await outcome(typescriptPlan)
        const fromRust = await outcome(rustOrThrow)

        expect(fromRust).toEqual(fromTypeScript)
        expect(Object.values(fromTypeScript)).toEqual(
            [...refused, NOT_UTF8, 'Welcome.md'].map(() => false)
        )
    }, 120_000)
})
