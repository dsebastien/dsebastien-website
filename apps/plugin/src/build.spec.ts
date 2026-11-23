import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Acceptance criterion of issue 29: the plugin loads in a test vault. Since
// issue 37 it records the renames of the vault in the rename journal of the
// device, and since issue 39 it adds the publication center: a view, its
// commands, a settings tab and a status bar item. It runs no check at load.
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
/** The first argument of each registration, by its method. */
const registered = new Map<string, unknown[]>()

class Plugin {
    constructor(
        readonly app: unknown,
        readonly manifest: unknown
    ) {}
}

/** An element of the status bar: the test keeps its texts. */
class StandInElement {
    readonly texts: string[] = []
    readonly attributes = new Map<string, string>()
    hidden = false
    addClass(): void {}
    empty(): void {
        this.texts.length = 0
    }
    hide(): void {
        this.hidden = true
    }
    show(): void {
        this.hidden = false
    }
    createSpan(options?: { text?: string }): StandInElement {
        if (options?.text !== undefined) {
            this.texts.push(options.text)
        }
        return new StandInElement()
    }
    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value)
    }
}
const statusBar = new StandInElement()

/** The classes of Obsidian that the plugin extends: the test never makes one. */
class StandIn {
    readonly standIn = true
}
class ItemView extends StandIn {}
class Modal extends StandIn {}
class FuzzySuggestModal extends StandIn {}
class AbstractInputSuggest extends StandIn {}
class Menu extends StandIn {}
class Setting extends StandIn {}
class PluginSettingTab extends StandIn {}
function setIcon(): void {}

/** A folder of the vault, for the check `instanceof TFolder` of the plugin. */
class TFolder {
    constructor(readonly path: string) {}

    get name(): string {
        return this.path.slice(this.path.lastIndexOf('/') + 1)
    }
}

/** A notice of Obsidian: the test keeps its message. */
const notices: string[] = []
class Notice {
    constructor(readonly message: string) {
        notices.push(message)
    }

    hide(): void {
        notices.splice(notices.indexOf(this.message), 1)
    }
}
for (const name of [...REGISTRATIONS, 'register'] as const) {
    Object.defineProperty(Plugin.prototype, name, {
        value: (first: unknown) => {
            calls.push(name)
            registered.set(name, [...(registered.get(name) ?? []), first])
            return name === 'addStatusBarItem' ? statusBar : undefined
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

    test('writes the three files that Obsidian reads', async () => {
        expect((await readdir(outputPath())).sort()).toEqual([
            'main.js',
            'manifest.json',
            'styles.css'
        ])
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
    test('loads with its publication center, runs no check, and records the renames in the journal of the device', async () => {
        await mock.module('obsidian', () => ({
            AbstractInputSuggest,
            FuzzySuggestModal,
            ItemView,
            Menu,
            Modal,
            Notice,
            Plugin,
            PluginSettingTab,
            Setting,
            TFolder,
            setIcon
        }))
        const loaded: unknown = createRequire(import.meta.url)(join(outputPath(), 'main.js'))
        const Loaded = isRecord(loaded) ? loaded['default'] : undefined
        if (typeof Loaded !== 'function') {
            throw new Error('the bundle has no default export')
        }
        // A vault of Obsidian in memory: its files, its events and the local storage.
        const files = new Map<string, string>()
        const listeners = new Map<string, (...values: unknown[]) => void>()
        const workspaceListeners = new Map<string, (...values: unknown[]) => void>()
        const layoutReady: (() => void)[] = []
        const storage = new Map<string, unknown>()
        let asked = 0
        const app = {
            vault: {
                configDir: '.obsidian',
                adapter: {
                    exists: (path: string) =>
                        Promise.resolve(files.has(path) || path.endsWith('/renames')),
                    mkdir: () => Promise.resolve(),
                    readBinary: (path: string) =>
                        Promise.resolve(new TextEncoder().encode(files.get(path) ?? '').buffer),
                    write: (path: string, data: string) => {
                        files.set(path, data)
                        return Promise.resolve()
                    },
                    append: (path: string, data: string) => {
                        files.set(path, (files.get(path) ?? '') + data)
                        return Promise.resolve()
                    }
                },
                on: (name: string, listener: (...values: unknown[]) => void) => {
                    listeners.set(name, listener)
                    return { name }
                }
            },
            workspace: {
                on: (name: string, listener: (...values: unknown[]) => void) => {
                    workspaceListeners.set(name, listener)
                    return { name }
                },
                getActiveFile: () => ({ path: 'Notes/Alpha.md' }),
                // The edits count from the moment that the layout is ready.
                onLayoutReady: (callback: () => void) => {
                    layoutReady.push(callback)
                }
            },
            // A check would ask the Starter Kit: the load must not.
            get plugins() {
                asked += 1
                return { plugins: {} }
            },
            loadLocalStorage: (key: string) => storage.get(key) ?? null,
            saveLocalStorage: (key: string, data: unknown) => storage.set(key, data)
        }

        const plugin: unknown = Reflect.construct(Loaded, [app, { id: 'dsebastien-vault-publish' }])
        expect(plugin).toBeInstanceOf(Plugin)
        if (!isRecord(plugin) || typeof plugin['onload'] !== 'function') {
            throw new Error('the plugin has no onload method')
        }
        await Reflect.apply(plugin['onload'], plugin, [])

        const count = (name: string): number => calls.filter((call) => call === name).length
        expect(count('registerView')).toBe(1)
        expect(registered.get('registerView')).toEqual(['dsebastien-vault-publish-center'])
        expect(count('addCommand')).toBe(7)
        expect(
            (registered.get('addCommand') ?? []).map((command) =>
                isRecord(command) ? command['id'] : undefined
            )
        ).toEqual([
            'open-publication-center',
            'check-for-changes',
            'unpublish-open-note',
            'take-down-open-note',
            'copy-live-address',
            'remove-lock',
            'show-measures'
        ])
        expect(count('addSettingTab')).toBe(1)
        expect(count('addStatusBarItem')).toBe(1)
        expect(count('addRibbonIcon')).toBe(1)
        expect(count('loadData') + count('saveData')).toBe(0)
        // Obsidian reports every file as made while it loads the vault: the
        // listeners of the edits wait for the layout.
        expect([...listeners.keys()]).toEqual(['rename'])
        for (const callback of layoutReady) {
            callback()
        }
        expect([...listeners.keys()].sort()).toEqual(['create', 'modify', 'rename'])
        expect([...workspaceListeners.keys()]).toEqual(['file-open'])
        // No check at the start of Obsidian (R67, PERF-06): the state of the
        // open note is unknown until the first check.
        expect(asked).toBe(0)
        expect(statusBar.texts).toEqual(['State unknown'])
        listeners.get('rename')?.({ path: 'Notes/Alpha.md' }, 'Alpha.md')
        listeners.get('rename')?.(new TFolder('Area'), 'Folder')
        await Bun.sleep(20)
        const journal = storage.get('dsebastien-vault-publish-journal')
        expect(journal).toMatch(/^[0-9a-f]{16}\.jsonl$/u)
        const text = files.get(
            `.obsidian/plugins/dsebastien-vault-publish/renames/${String(journal)}`
        )
        expect(
            text
                ?.split('\n')
                .filter((line) => line !== '')
                .map((line) => {
                    const { from, kind, to } = JSON.parse(line) as Record<string, string>
                    return [from, kind, to]
                })
        ).toEqual([
            ['Alpha.md', 'note', 'Notes/Alpha.md'],
            ['Folder', 'folder', 'Area']
        ])
        expect(notices).toEqual([])
    })
})

// A development build can copy itself into a vault, for a test by hand. The
// template of the author reads the vault from OBSIDIAN_VAULT_LOCATION, which
// names his real vault on his machines. This plugin must never go there by
// accident, so it reads a variable of its own and wants a real vault folder.
describe('development build', () => {
    const ID = 'dsebastien-vault-publish'

    async function developmentBuild(
        name: string,
        environment: Record<string, string>
    ): Promise<{ exitCode: number; vault: string; stderr: string }> {
        const vault = join(outputPath(), name)
        const child = Bun.spawn(
            ['bun', 'scripts/build.ts', '--once', '--outdir', join(outputPath(), `${name}-dist`)],
            {
                cwd: PLUGIN,
                env: {
                    PATH: process.env['PATH'] ?? '',
                    ...Object.fromEntries(
                        Object.entries(environment).map(([key, value]) => [
                            key,
                            value.replace('<vault>', vault)
                        ])
                    )
                },
                stdout: 'ignore',
                stderr: 'pipe'
            }
        )
        const stderr = await new Response(child.stderr).text()
        return { exitCode: await child.exited, vault, stderr }
    }

    test('copies the plugin into the vault that its own variable names', async () => {
        await mkdir(join(outputPath(), 'vault', '.obsidian'), { recursive: true })

        const build = await developmentBuild('vault', { VAULT_PUBLISH_DEV_VAULT: '<vault>' })

        expect(build.exitCode).toBe(0)
        const copied = await readdir(join(build.vault, '.obsidian', 'plugins', ID))
        expect(copied.sort()).toEqual(['.hotreload', 'main.js', 'manifest.json', 'styles.css'])
    }, 120_000)

    test('never follows the variable of the plugin template', async () => {
        await mkdir(join(outputPath(), 'template-vault', '.obsidian'), { recursive: true })

        const build = await developmentBuild('template-vault', {
            OBSIDIAN_VAULT_LOCATION: '<vault>'
        })

        expect(build.exitCode).toBe(0)
        expect(await readdir(join(build.vault, '.obsidian'))).toEqual([])
    }, 120_000)

    test('refuses a folder that is not a vault, and makes nothing in it', async () => {
        await mkdir(join(outputPath(), 'not-a-vault'), { recursive: true })

        const build = await developmentBuild('not-a-vault', { VAULT_PUBLISH_DEV_VAULT: '<vault>' })

        expect(build.exitCode).not.toBe(0)
        expect(build.stderr).toContain('.obsidian')
        expect(await readdir(build.vault)).toEqual([])
    }, 120_000)

    test('refuses a folder that does not exist, and does not make it', async () => {
        const build = await developmentBuild('missing', { VAULT_PUBLISH_DEV_VAULT: '<vault>' })

        expect(build.exitCode).not.toBe(0)
        expect(
            await Bun.file(join(build.vault, '.obsidian', 'plugins', ID, 'main.js')).exists()
        ).toBe(false)
    }, 120_000)
})
