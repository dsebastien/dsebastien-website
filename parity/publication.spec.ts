import { beforeAll, describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
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
        if (entry.isFile() && !name.startsWith('.git/')) {
            const bytes = await Bun.file(path).bytes()
            files[name] = name.endsWith('.png') ? bytes.toHex() : new TextDecoder().decode(bytes)
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
        fromTypeScript = await run(typescript, NOTES)
        fromRust = await run(rust, NOTES)
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
            NOTES.map((note) => `notes/${note}`).sort()
        )
        expect(files.filter((file) => file.startsWith('manifest/')).length).toBe(NOTES.length)
        for (const note of NOTES) {
            expect(fromTypeScript.vault[note], note).toContain('\npublic_note: true\n')
        }
    })

    // The order of the code points, not the order of the UTF-16 units.
    test('the plan lists the notes in the order of the canonical form', () => {
        const record: unknown = JSON.parse(fromRust.plans[0] ?? '{}')
        expect(record).toMatchObject({
            plan: {
                publish: [
                    '10 Garden/Bean trellis.md',
                    '10 Garden/Frost dates explained.md',
                    '10 Garden/～ Pond.md',
                    '10 Garden/🌱 Seedlings.md',
                    "20 Library/20.02 Recipes/Crème brûlée à l'érable.md",
                    'Welcome.md'
                ]
            }
        })
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
            '{\n  "plan": {\n    "publish": [],\n    "remove": [],\n    "update": []\n  },\n  "selection": {\n    "include": []\n  }\n}\n'
        ])
    }, 120_000)
})
