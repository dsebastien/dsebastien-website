import { isAbsolute, join } from 'node:path'
import { nodeDevice } from '../publishing/node/device.ts'
import type { Device, NoteTypes } from '../publishing/ports.ts'
import { JOURNAL_FOLDER } from '../publishing/renames.ts'
import type { DeviceStorage } from './rename-journal.ts'

// The settings of a device (decision R67, ST6a of the tool study): the folder
// of the copy of the content store, the folder of the attachment storage
// (until the slice of the hosting gives the tool an object storage), and the
// git program, for an Obsidian that starts with another path of the system
// than a terminal. They are kept in the local storage of Obsidian, never in
// `data.json`: they never travel with the vault to another device.

export interface DeviceSettings {
    /** The folder of the copy of the content store: a git clone whose `origin` is the content store. */
    readonly contentStore: string
    /** The folder of the attachment storage. */
    readonly attachmentStorage: string
    /** The git program. Empty for `git` of the path of the system. */
    readonly git: string
}

/** The key of the settings of this device in the local storage of Obsidian. */
export const SETTINGS_KEY = 'dsebastien-vault-publish-device'

function textOf(value: unknown, key: string): string {
    if (typeof value !== 'object' || value === null) {
        return ''
    }
    const field: unknown = (value as Record<string, unknown>)[key]
    return typeof field === 'string' ? field : ''
}

/** The settings of this device. A value that is not text reads as empty. */
export function loadSettings(storage: DeviceStorage): DeviceSettings {
    const kept = storage.loadLocalStorage(SETTINGS_KEY)
    return {
        contentStore: textOf(kept, 'contentStore'),
        attachmentStorage: textOf(kept, 'attachmentStorage'),
        git: textOf(kept, 'git')
    }
}

export function saveSettings(storage: DeviceStorage, settings: DeviceSettings): void {
    storage.saveLocalStorage(SETTINGS_KEY, {
        contentStore: settings.contentStore,
        attachmentStorage: settings.attachmentStorage,
        git: settings.git
    })
}

function folderOf(value: string, name: string): string {
    const path = value.trim()
    if (path === '') {
        throw new Error(`Set the folder of ${name} in the settings of Vault Publish`)
    }
    if (!isAbsolute(path)) {
        throw new Error(`The folder of ${name} must be an absolute path: "${path}"`)
    }
    return path
}

/**
 * The device of the settings, for the vault of Obsidian. It throws with a
 * message that names the setting to change.
 *
 * @param vault the folder of the vault
 * @param configDir the configuration folder of Obsidian, relative to the vault
 */
export function deviceOf(
    settings: DeviceSettings,
    vault: string,
    configDir: string,
    noteTypes: NoteTypes
): Device {
    const { contentStore, git } = pullOptionsOf(settings)
    const attachmentStorage = folderOf(settings.attachmentStorage, 'the attachment storage')
    return nodeDevice({
        vault,
        contentStore,
        attachmentStorage,
        noteTypes,
        renames: join(vault, configDir, JOURNAL_FOLDER),
        ...(git === undefined ? {} : { git })
    })
}

/**
 * The paths of the pull of the copy (`pullContentStore`), with the checks of
 * the device: the folder of the copy and the git program are absolute paths.
 */
export function pullOptionsOf(settings: DeviceSettings): { contentStore: string; git?: string } {
    const contentStore = folderOf(settings.contentStore, 'the copy of the content store')
    const git = settings.git.trim()
    if (git !== '' && !isAbsolute(git)) {
        throw new Error(`The git program must be an absolute path: "${git}"`)
    }
    return git === '' ? { contentStore } : { contentStore, git }
}
