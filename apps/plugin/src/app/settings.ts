import { isAbsolute } from 'node:path'
import { nodeDevice } from '../publishing/node/device.ts'
import { httpsMainSite } from '../publishing/node/main-site.ts'
import type { Device, ListRefresh, NoteTypes, Vault } from '../publishing/ports.ts'
import type { DeviceStorage } from './rename-journal.ts'

// The settings of a device (decision R67, ST6a of the tool study): the folder
// of the copy of the content store, the attachment folder (the deploy uploads
// its files to the object storage of the host, issue 32), and the git
// program, for an Obsidian that starts with another path of the system than a
// terminal. Then the settings of the deploy after a push (issue 32): the
// folder of the clean clone of the site code, the private target file, the
// private env file with the token, the bun program, and the time limit of a
// deploy. They are kept in the local storage of Obsidian, never in
// `data.json`: they never travel with the vault to another device.

export interface DeviceSettings {
    /** The folder of the copy of the content store: a git clone whose `origin` is the content store. */
    readonly contentStore: string
    /** The folder of the attachment storage. */
    readonly attachmentStorage: string
    /** The git program. Empty for `git` of the path of the system. */
    readonly git: string
    /** The folder of the clean clone of the site code, kept for deploys (issue 32). */
    readonly siteCode: string
    /** The private target file of the deployment. */
    readonly deployTarget: string
    /** The private env file of the deployment, with its token. Empty for none. */
    readonly deployEnvFile: string
    /** The bun program. Empty for `bun` of the path of the system. */
    readonly bun: string
    /** The time limit of a deploy, in minutes. Empty for 30. */
    readonly deployTimeout: string
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
        git: textOf(kept, 'git'),
        siteCode: textOf(kept, 'siteCode'),
        deployTarget: textOf(kept, 'deployTarget'),
        deployEnvFile: textOf(kept, 'deployEnvFile'),
        bun: textOf(kept, 'bun'),
        deployTimeout: textOf(kept, 'deployTimeout')
    }
}

export function saveSettings(storage: DeviceStorage, settings: DeviceSettings): void {
    storage.saveLocalStorage(SETTINGS_KEY, {
        contentStore: settings.contentStore,
        attachmentStorage: settings.attachmentStorage,
        git: settings.git,
        siteCode: settings.siteCode,
        deployTarget: settings.deployTarget,
        deployEnvFile: settings.deployEnvFile,
        bun: settings.bun,
        deployTimeout: settings.deployTimeout
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
 * @param vault the folder of the vault; the rename journals of each of its
 * configuration folders are read (decision of the author R82)
 * @param writes makes the vault whose writes into the notes go through Obsidian
 */
export function deviceOf(
    settings: DeviceSettings,
    vault: string,
    noteTypes: NoteTypes,
    lists?: ListRefresh,
    writes?: (vault: Vault) => Vault
): Device {
    const { contentStore, git } = pullOptionsOf(settings)
    const attachmentStorage = folderOf(settings.attachmentStorage, 'the attachment storage')
    const made = nodeDevice({
        vault,
        contentStore,
        attachmentStorage,
        noteTypes,
        ...(git === undefined ? {} : { git }),
        // The check of the originals on the main site (PUB-100).
        mainSite: httpsMainSite()
    })
    // The writes into the notes go through the vault of Obsidian (`editorWrites`).
    const device = writes === undefined ? made : { ...made, vault: writes(made.vault) }
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
