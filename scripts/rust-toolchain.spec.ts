import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Guard: the machines of the author and CI use the same Rust toolchain. With
// "stable", CI takes each new version at once, and a new rule of clippy fails
// a run with no change of the code (it happened with issue 29).
const FILE = fileURLToPath(new URL('../rust-toolchain.toml', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readToolchain(): Promise<Record<string, unknown>> {
    const file: unknown = Bun.TOML.parse(await Bun.file(FILE).text())
    const toolchain = isRecord(file) ? file['toolchain'] : undefined
    if (!isRecord(toolchain)) {
        throw new Error('rust-toolchain.toml has no toolchain table')
    }
    return toolchain
}

test('the Rust toolchain is one exact version', async () => {
    expect((await readToolchain())['channel']).toMatch(/^\d+\.\d+\.\d+$/)
})

test('the Rust toolchain has the formatter and the linter', async () => {
    const components = (await readToolchain())['components']
    expect(components).toContain('rustfmt')
    expect(components).toContain('clippy')
})

// CI must not install a second toolchain next to the pinned one.
test('CI installs the pinned version', async () => {
    const workflow: unknown = Bun.YAML.parse(
        await Bun.file(
            fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url))
        ).text()
    )
    const jobs = isRecord(workflow) && isRecord(workflow['jobs']) ? workflow['jobs'] : {}
    const steps: unknown[] = Object.values(jobs).flatMap((job): unknown[] => {
        const list: unknown = isRecord(job) ? job['steps'] : undefined
        return Array.isArray(list) ? list : []
    })
    const versions = steps
        .filter(isRecord)
        .filter((step) => String(step['uses']).startsWith('dtolnay/rust-toolchain@'))
        .map((step) => (isRecord(step['with']) ? step['with']['toolchain'] : undefined))

    expect(versions.length).toBeGreaterThanOrEqual(2)
    expect(new Set(versions)).toEqual(new Set([(await readToolchain())['channel']]))
})
