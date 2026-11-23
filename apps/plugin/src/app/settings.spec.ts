import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deviceOf, loadSettings, saveSettings, SETTINGS_KEY } from './settings.ts'
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

const NO_TYPES = { recognize: () => Promise.resolve({ success: true, data: [] }) }

describe('the settings of a device', () => {
    test('are empty on a new device', () => {
        expect(loadSettings(storage())).toEqual({
            contentStore: '',
            attachmentStorage: '',
            git: ''
        })
    })

    test('are kept in the local storage of Obsidian', () => {
        const kept = storage()
        saveSettings(kept, {
            contentStore: '/data/copy',
            attachmentStorage: '/data/files',
            git: ''
        })

        expect(kept.values.get(SETTINGS_KEY)).toEqual({
            contentStore: '/data/copy',
            attachmentStorage: '/data/files',
            git: ''
        })
        expect(loadSettings(kept)).toEqual({
            contentStore: '/data/copy',
            attachmentStorage: '/data/files',
            git: ''
        })
    })

    test('read a value that is not text as empty', () => {
        expect(
            loadSettings(storage({ [SETTINGS_KEY]: { contentStore: 3, attachmentStorage: '/a' } }))
        ).toEqual({ contentStore: '', attachmentStorage: '/a', git: '' })
        expect(loadSettings(storage({ [SETTINGS_KEY]: 'text' }))).toEqual({
            contentStore: '',
            attachmentStorage: '',
            git: ''
        })
    })
})

describe('the device of the settings', () => {
    const vault = join('/', 'vaults', 'notes')

    test('names the missing setting', () => {
        expect(() =>
            deviceOf(
                { contentStore: '', attachmentStorage: '/a', git: '' },
                vault,
                '.obsidian',
                NO_TYPES
            )
        ).toThrow(
            'Set the folder of the copy of the content store in the settings of Vault Publish'
        )
        expect(() =>
            deviceOf(
                { contentStore: '/c', attachmentStorage: '', git: '' },
                vault,
                '.obsidian',
                NO_TYPES
            )
        ).toThrow('Set the folder of the attachment storage in the settings of Vault Publish')
    })

    test('wants absolute paths', () => {
        expect(() =>
            deviceOf(
                { contentStore: 'copy', attachmentStorage: '/a', git: '' },
                vault,
                '.obsidian',
                NO_TYPES
            )
        ).toThrow('The folder of the copy of the content store must be an absolute path: "copy"')
        expect(() =>
            deviceOf(
                { contentStore: '/c', attachmentStorage: '/a', git: 'bin/git' },
                vault,
                '.obsidian',
                NO_TYPES
            )
        ).toThrow('The git program must be an absolute path: "bin/git"')
    })

    test('reads the rename journals of the configuration folder of Obsidian', async () => {
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
            const device = deviceOf(
                { contentStore: '/c', attachmentStorage: '/a', git: '' },
                folder,
                '.config-of-obsidian',
                NO_TYPES
            )
            expect(await device.renames.list()).toEqual(['00000000000000aa.jsonl'])
        } finally {
            // Remove only the folder that this test made.
            await rm(folder, { recursive: true, force: true })
        }
    })
})
