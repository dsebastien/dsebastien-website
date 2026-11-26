import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    claudeCommandOf,
    deviceOf,
    keyOf,
    loadMcpSettings,
    loadSettings,
    MCP_KEY_SECRET,
    MCP_SETTINGS_KEY,
    newKey,
    pullOptionsOf,
    saveMcpSettings,
    saveSettings,
    SETTINGS_KEY
} from './settings.ts'
import type { DeviceStorage } from './rename-journal.ts'

// The settings of a device (decision R67): the folder of the copy of the
// content store, the folder of the attachment storage and the git program.
// They are kept in the local storage of Obsidian, so they never travel with
// the vault to another device.

function storage(values: Record<string, unknown> = {}): DeviceStorage & {
    values: Map<string, unknown>
} {
    const kept = new Map(Object.entries(values))
    return {
        values: kept,
        loadLocalStorage: (key) => kept.get(key) ?? null,
        saveLocalStorage: (key, data) => {
            kept.set(key, data)
        }
    }
}

/** The settings of the deploy of a device where none is set (issue 32). */
const NO_DEPLOY = {
    siteCode: '',
    deployTarget: '',
    deployEnvFile: '',
    bun: '',
    deployTimeout: ''
}

const NO_TYPES = { recognize: () => Promise.resolve({ success: true, data: [] }) }

describe('the settings of a device', () => {
    test('are empty on a new device', () => {
        expect(loadSettings(storage())).toEqual({
            contentStore: '',
            attachmentStorage: '',
            git: '',
            ...NO_DEPLOY
        })
    })

    test('are kept in the local storage of Obsidian', () => {
        const kept = storage()
        saveSettings(kept, {
            contentStore: '/data/copy',
            attachmentStorage: '/data/files',
            git: '',
            ...NO_DEPLOY
        })

        expect(kept.values.get(SETTINGS_KEY)).toEqual({
            contentStore: '/data/copy',
            attachmentStorage: '/data/files',
            git: '',
            ...NO_DEPLOY
        })
        expect(loadSettings(kept)).toEqual({
            contentStore: '/data/copy',
            attachmentStorage: '/data/files',
            git: '',
            ...NO_DEPLOY
        })
    })

    test('keep the settings of the deploy (issue 32)', () => {
        const kept = storage()
        const settings = {
            contentStore: '/data/copy',
            attachmentStorage: '/data/files',
            git: '',
            siteCode: '/work/site-code',
            deployTarget: '/private/target.json',
            deployEnvFile: '/private/deploy.env',
            bun: '/opt/bun/bin/bun',
            deployTimeout: '45'
        }
        saveSettings(kept, settings)

        expect(kept.values.get(SETTINGS_KEY)).toEqual(settings)
        expect(loadSettings(kept)).toEqual(settings)
    })

    test('read a value that is not text as empty', () => {
        expect(
            loadSettings(storage({ [SETTINGS_KEY]: { contentStore: 3, attachmentStorage: '/a' } }))
        ).toEqual({ contentStore: '', attachmentStorage: '/a', git: '', ...NO_DEPLOY })
        expect(loadSettings(storage({ [SETTINGS_KEY]: 'text' }))).toEqual({
            contentStore: '',
            attachmentStorage: '',
            git: '',
            ...NO_DEPLOY
        })
    })
})

describe('the device of the settings', () => {
    const vault = join('/', 'vaults', 'notes')

    test('names the missing setting', () => {
        expect(() =>
            deviceOf(
                { contentStore: '', attachmentStorage: '/a', git: '', ...NO_DEPLOY },
                vault,
                NO_TYPES
            )
        ).toThrow(
            'Set the folder of the copy of the content store in the settings of Vault Publish'
        )
        expect(() =>
            deviceOf(
                { contentStore: '/c', attachmentStorage: '', git: '', ...NO_DEPLOY },
                vault,
                NO_TYPES
            )
        ).toThrow('Set the folder of the attachment storage in the settings of Vault Publish')
    })

    test('wants absolute paths', () => {
        expect(() =>
            deviceOf(
                { contentStore: 'copy', attachmentStorage: '/a', git: '', ...NO_DEPLOY },
                vault,
                NO_TYPES
            )
        ).toThrow('The folder of the copy of the content store must be an absolute path: "copy"')
        expect(() =>
            deviceOf(
                { contentStore: '/c', attachmentStorage: '/a', git: 'bin/git', ...NO_DEPLOY },
                vault,
                NO_TYPES
            )
        ).toThrow('The git program must be an absolute path: "bin/git"')
    })

    test('reads the rename journals of every configuration folder of the vault', async () => {
        const cache = join(import.meta.dir, '..', '..', '.cache')
        await mkdir(cache, { recursive: true })
        const folder = await mkdtemp(join(cache, 'settings-spec-'))
        try {
            const journals = join(
                folder,
                '.config-of-obsidian',
                'plugins',
                'dsebastien-vault-publish',
                'renames'
            )
            await mkdir(journals, { recursive: true })
            await writeFile(join(journals, '00000000000000aa.jsonl'), '')
            const other = join(
                folder,
                '.obsidian',
                'plugins',
                'dsebastien-vault-publish',
                'renames'
            )
            await mkdir(other, { recursive: true })
            await writeFile(join(other, '00000000000000bb.jsonl'), '')
            const device = deviceOf(
                { contentStore: '/c', attachmentStorage: '/a', git: '', ...NO_DEPLOY },
                folder,
                NO_TYPES
            )
            expect((await device.renames.list()).sort()).toEqual([
                '00000000000000aa.jsonl',
                '00000000000000bb.jsonl'
            ])
        } finally {
            // Remove only the folder that this test made.
            await rm(folder, { recursive: true, force: true })
        }
    })
})

describe('the pull of the settings', () => {
    test('takes the same checked paths as the device', () => {
        expect(
            pullOptionsOf({
                contentStore: ' /data/copy ',
                attachmentStorage: '',
                git: ' /usr/bin/git ',
                ...NO_DEPLOY
            })
        ).toEqual({ contentStore: '/data/copy', git: '/usr/bin/git' })
        expect(
            pullOptionsOf({
                contentStore: '/data/copy',
                attachmentStorage: '',
                git: '',
                ...NO_DEPLOY
            })
        ).toEqual({
            contentStore: '/data/copy'
        })
        expect(() =>
            pullOptionsOf({ contentStore: 'copy', attachmentStorage: '', git: '', ...NO_DEPLOY })
        ).toThrow('The folder of the copy of the content store must be an absolute path: "copy"')
        expect(() =>
            pullOptionsOf({ contentStore: '/c', attachmentStorage: '', git: 'git', ...NO_DEPLOY })
        ).toThrow('The git program must be an absolute path: "git"')
    })
})

describe('the settings of the MCP server of a device (issue 41)', () => {
    test('are on, at port 27126, on a new device', () => {
        expect(loadMcpSettings(storage())).toEqual({ enabled: true, port: 27126 })
    })

    test('are kept in the local storage of Obsidian, apart from the folders', () => {
        const kept = storage()
        saveMcpSettings(kept, { enabled: false, port: 30001 })

        expect(kept.values.get(MCP_SETTINGS_KEY)).toEqual({ enabled: false, port: 30001 })
        expect(loadMcpSettings(kept)).toEqual({ enabled: false, port: 30001 })
        expect(kept.values.has(SETTINGS_KEY)).toBe(false)
    })

    test('read a value of another kind, or a port outside 1024 to 65535, as the default', () => {
        const cases: [unknown, boolean][] = [
            [{ enabled: 'no', port: '30001' }, true],
            [{ enabled: false, port: 80 }, false],
            [{ enabled: false, port: 65_536 }, false],
            [{ enabled: false, port: 30_001.5 }, false],
            ['text', true]
        ]
        for (const [kept, enabled] of cases) {
            expect(loadMcpSettings(storage({ [MCP_SETTINGS_KEY]: kept }))).toEqual({
                enabled,
                port: 27126
            })
        }
    })
})

describe('the key of the MCP server', () => {
    function secrets(values: Record<string, string> = {}): {
        values: Map<string, string>
        getSecret(id: string): string | null
        setSecret(id: string, secret: string): void
    } {
        const kept = new Map(Object.entries(values))
        return {
            values: kept,
            getSecret: (id) => kept.get(id) ?? null,
            setSecret: (id, secret) => {
                kept.set(id, secret)
            }
        }
    }

    const random = (size: number): Uint8Array => new Uint8Array(size).fill(7)

    test('is made at the first start and kept in the secret storage of Obsidian', () => {
        const kept = secrets()

        const key = keyOf(kept, random)

        expect(key).toBe(newKey(random))
        expect(kept.values.get(MCP_KEY_SECRET)).toBe(key)
        expect(keyOf(kept, () => new Uint8Array(32))).toBe(key)
    })

    test('is 32 random bytes in base64url', () => {
        expect(newKey(random)).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(newKey(random)).not.toBe(newKey((size) => new Uint8Array(size).fill(8)))
    })

    test('a key that is empty is made again', () => {
        const kept = secrets({ [MCP_KEY_SECRET]: '' })

        expect(keyOf(kept, random)).toBe(newKey(random))
    })

    test('the id of the secret is one that Obsidian takes', () => {
        expect(MCP_KEY_SECRET).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    })

    test('the command for Claude Code names the address and the key', () => {
        expect(claudeCommandOf(27126, 'k3y')).toBe(
            'claude mcp add --scope local --transport http vault-publish http://127.0.0.1:27126/mcp --header "Authorization: Bearer k3y"'
        )
    })
})
