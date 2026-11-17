import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Acceptance criterion of issue 29: the plugin loads in a test vault and does
// nothing yet.
//
// The test builds the plugin as a release and loads the bundle the way
// Obsidian does: it requires `main.js`, makes the default export with an app
// and a manifest, and calls `onload`. The `obsidian` module exists only inside
// Obsidian, so the test gives a stand-in whose `Plugin` class records every
// call. The load in a real vault is checked by hand (documentation/Configuration.md).
const PLUGIN = fileURLToPath(new URL('..', import.meta.url))

/** The methods with which a plugin adds something to Obsidian. */
const REGISTRATIONS = [
    'addCommand',
    'addRibbonIcon',
    'addSettingTab',
    'addStatusBarItem',
    'registerView',
    'registerEvent',
    'registerInterval',
    'registerDomEvent',
    'registerExtensions',
    'registerMarkdownPostProcessor',
    'registerMarkdownCodeBlockProcessor',
    'registerEditorExtension',
    'registerObsidianProtocolHandler',
    'loadData',
    'saveData'
] as const

const calls: string[] = []

class Plugin {
    constructor(
        readonly app: unknown,
        readonly manifest: unknown
    ) {}
}
for (const name of REGISTRATIONS) {
    Object.defineProperty(Plugin.prototype, name, {
        value: () => {
            calls.push(name)
        }
    })
}

let outDir: string | undefined
let exitCode = -1

function outputPath(): string {
    if (outDir === undefined) {
        throw new Error('the output folder does not exist')
    }
    return outDir
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

beforeAll(async () => {
    const cache = join(PLUGIN, '.cache')
    await mkdir(cache, { recursive: true })
    outDir = await mkdtemp(join(cache, 'build-spec-'))
    const child = Bun.spawn(['bun', 'run', 'build', '--outdir', outDir], {
        cwd: PLUGIN,
        stdout: 'ignore',
        stderr: 'ignore'
    })
    exitCode = await child.exited
}, 120_000)

afterAll(async () => {
    // Remove only a folder that this test made.
    if (outDir !== undefined) {
        await rm(outDir, { recursive: true, force: true })
    }
})

describe('build of the plugin', () => {
    test('completes', () => {
        expect(exitCode).toBe(0)
    })

    test('writes the two files that Obsidian reads', async () => {
        expect((await readdir(outputPath())).sort()).toEqual(['main.js', 'manifest.json'])
    })

    test('names the plugin as the command line program, for desktop only', async () => {
        const manifest: unknown = await Bun.file(join(outputPath(), 'manifest.json')).json()
        expect(manifest).toMatchObject({ id: 'dsebastien-vault-publish', isDesktopOnly: true })
    })

    test('leaves the modules of Obsidian out of the bundle', async () => {
        const bundle = await Bun.file(join(outputPath(), 'main.js')).text()
        expect(bundle).toContain('require("obsidian")')
    })
})

describe('the built plugin', () => {
    test('loads and does nothing yet', async () => {
        await mock.module('obsidian', () => ({ Plugin }))
        const loaded: unknown = createRequire(import.meta.url)(join(outputPath(), 'main.js'))
        const Loaded = isRecord(loaded) ? loaded['default'] : undefined
        if (typeof Loaded !== 'function') {
            throw new Error('the bundle has no default export')
        }

        const plugin: unknown = Reflect.construct(Loaded, [{}, { id: 'dsebastien-vault-publish' }])
        expect(plugin).toBeInstanceOf(Plugin)
        if (!isRecord(plugin) || typeof plugin['onload'] !== 'function') {
            throw new Error('the plugin has no onload method')
        }
        await Reflect.apply(plugin['onload'], plugin, [])

        expect(calls).toEqual([])
    })
})
