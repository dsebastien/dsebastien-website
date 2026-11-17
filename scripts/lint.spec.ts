import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Acceptance criterion of issue 16: the lint script exists and fails on one warning.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readLintScript(): Promise<string> {
    const manifest: unknown = await Bun.file(`${ROOT}package.json`).json()
    if (!isRecord(manifest) || !isRecord(manifest['scripts'])) {
        throw new Error('package.json has no scripts')
    }
    const script = manifest['scripts']['lint']
    if (typeof script !== 'string') {
        throw new Error('package.json has no lint script')
    }
    return script
}

/**
 * Runs the lint script of the repository on one source text. The script lints
 * the whole repository (`.`): here the target is replaced by standard input,
 * and one rule is set to "warn", so that the source gives exactly one warning.
 * The source takes the name of this file, because the type-aware rules need a
 * file that the TypeScript project knows.
 */
async function lintSource(source: string, file = 'scripts/lint.spec.ts'): Promise<number> {
    const script = await readLintScript()
    const command = script.replace(
        /\beslint \./,
        `eslint --stdin --stdin-filename ${file} --rule 'no-debugger: warn'`
    )
    expect(command).not.toBe(script)
    const child = Bun.spawn(['sh', '-c', command], {
        cwd: ROOT,
        stdin: new TextEncoder().encode(source),
        stdout: 'ignore',
        stderr: 'ignore'
    })
    return await child.exited
}

describe('lint script', () => {
    test('passes on a source without findings', async () => {
        expect(await lintSource('export const answer = 42\n')).toBe(0)
    }, 60_000)

    test('fails on one warning', async () => {
        expect(await lintSource('debugger\nexport const answer = 42\n')).not.toBe(0)
    }, 60_000)
})

// The publishing logic runs in the plugin and is compared with the Rust
// program, which has no Obsidian. It takes what it needs as input.
describe('lint of the publishing logic', () => {
    const SOURCE = "import { Plugin } from 'obsidian'\nexport const loaded = Plugin.name\n"

    test('refuses an import of Obsidian', async () => {
        expect(await lintSource(SOURCE, 'apps/plugin/src/publishing/plan.ts')).not.toBe(0)
    }, 60_000)

    test('accepts the same import in the plugin itself', async () => {
        expect(await lintSource(SOURCE, 'apps/plugin/src/app/plugin.ts')).toBe(0)
    }, 60_000)
})
