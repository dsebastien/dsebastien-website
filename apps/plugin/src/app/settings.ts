import { isAbsolute, join } from 'node:path'
import { nodeDevice } from '../publishing/node/device.ts'
import type { Device, ListRefresh, NoteTypes } from '../publishing/ports.ts'
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
    noteTypes: NoteTypes,
    lists?: ListRefresh
): Device {
    const { contentStore, git } = pullOptionsOf(settings)
    const attachmentStorage = folderOf(settings.attachmentStorage, 'the attachment storage')
    const device = nodeDevice({
        vault,
        contentStore,
        attachmentStorage,
        noteTypes,
        renames: join(vault, configDir, JOURNAL_FOLDER),
        ...(git === undefined ? {} : { git })
    })
    return lists === undefined ? device : { ...device, lists }
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

/** The settings of the MCP server of this device (issue 41, decision of the author R68). */
export interface McpSettings {
    /** True when the plugin starts its MCP server. On by default. */
    readonly enabled: boolean
    /** The port on 127.0.0.1. */
    readonly port: number
}

/** The key of the settings of the MCP server in the local storage of Obsidian. */
export const MCP_SETTINGS_KEY = 'dsebastien-vault-publish-mcp'

/** The port of the MCP server on a new device: beside the Starter Kit (27125) and the REST API (27124). */
export const DEFAULT_MCP_PORT = 27126

/** The id of the key of the MCP server in the secret storage of Obsidian. */
export const MCP_KEY_SECRET = 'dsebastien-vault-publish-mcp-key'

/** True for a port that the server can take without the rights of the system. */
export function isPort(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65_535
}

/** The settings of the MCP server of this device. A value of another kind reads as the default. */
export function loadMcpSettings(storage: DeviceStorage): McpSettings {
    const kept = storage.loadLocalStorage(MCP_SETTINGS_KEY)
    const field = (key: string): unknown =>
        typeof kept === 'object' && kept !== null
            ? (kept as Record<string, unknown>)[key]
            : undefined
    const enabled = field('enabled')
    const port = field('port')
    return {
        enabled: typeof enabled === 'boolean' ? enabled : true,
        port: isPort(port) ? port : DEFAULT_MCP_PORT
    }
}

export function saveMcpSettings(storage: DeviceStorage, settings: McpSettings): void {
    storage.saveLocalStorage(MCP_SETTINGS_KEY, { enabled: settings.enabled, port: settings.port })
}

/** What the plugin needs of the secret storage of Obsidian. */
export interface Secrets {
    getSecret(id: string): string | null
    setSecret(id: string, secret: string): void
}

/** A new key: 32 random bytes in base64url. */
export function newKey(random: (size: number) => Uint8Array): string {
    return Buffer.from(random(32)).toString('base64url')
}

/** The key of the MCP server of this device. The first start makes it and keeps it in the secret storage. */
export function keyOf(secrets: Secrets, random: (size: number) => Uint8Array): string {
    const kept = secrets.getSecret(MCP_KEY_SECRET)
    if (kept !== null && kept !== '') {
        return kept
    }
    const key = newKey(random)
    secrets.setSecret(MCP_KEY_SECRET, key)
    return key
}

/** The command that adds the MCP server of this device to Claude Code. */
export function claudeCommandOf(port: number, key: string): string {
    return `claude mcp add --scope local --transport http vault-publish http://127.0.0.1:${String(port)}/mcp --header "Authorization: Bearer ${key}"`
}
