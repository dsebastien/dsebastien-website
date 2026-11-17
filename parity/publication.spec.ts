import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { copyFixtureVault, makeContentStoreCopy, makeTestStores } from '@dsebastien-website/testing'
import { nodeDevice } from '../apps/plugin/src/publishing/node/device.ts'
import { plan, publish } from '../apps/plugin/src/publishing/tool.ts'
import { buildRustProgram, runRustProgram } from './harness.ts'

// The parity rule (ADR 0009, TEST-03 of the spec): for the same input, the
// TypeScript and the Rust implementation write the same bytes in the canonical
// form: the publication plan without its id, the cleaned notes and the
// manifest. The vault after the publication is compared too (SEAM-02). A
// failure here blocks a release.

const TIME = '2031-04-01T08:00:00Z'

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
    '10 Garden/～ Pond.md'
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
    'Crafted/Ignore is false.md': '---\npublish_ignore: false\n---\nText\n'
}

// Notes that no implementation may publish. Both must refuse each one.
const REFUSED: Record<string, string | Uint8Array> = {
    'Refused/Quoted key.md': '---\n"publish_ignore": yes # never\n---\nText\n',
    'Refused/Nested key.md': '---\nmeta:\n  publish_ignore: true\n---\nText\n',
    'Refused/Value below.md': '---\npublish_ignore:\n  - true\n---\nText\n',
    'Refused/Mark.md': `${MARK}---\npublish_ignore: true\n---\nText\n`,
    'Refused/Next line character.md': '---\npublish_ignore: false\u0085\n---\nText\n',
    'Refused/Not UTF-8.md': Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
}

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
    await publish(device, planned.id, TIME)
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
        for (const note of PUBLISHED) {
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
            '10 Garden/Frost dates explained.md',
            '10 Garden/～ Pond.md',
            '10 Garden/🌱 Seedlings.md',
            "20 Library/20.02 Recipes/Crème brûlée à l'érable.md",
            'Welcome.md'
        ])
    })
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
            '{\n  "plan": {\n    "publish": [],\n    "remove": [],\n    "update": []\n  },\n  "selection": {\n    "include": []\n  },\n  "state": {\n    "configuration": "sha256:e06bbfc5161c72405ce2776eab77bc0001e63cdfc935e664fe5e8be0d98b9a12",\n    "manifest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",\n    "notes": []\n  }\n}\n'
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
        expect(Object.values(fromTypeScript)).toEqual(refused.map(() => false))
    }, 120_000)
})
