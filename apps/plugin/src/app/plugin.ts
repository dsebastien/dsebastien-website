import { hostname } from 'node:os'
import {
    Modal,
    normalizePath,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    setIcon,
    TFolder
} from 'obsidian'
import type { App, TAbstractFile, WorkspaceLeaf } from 'obsidian'
import { markUnpublish } from '../publishing/center.ts'
import type { NoteStateKind } from '../publishing/center.ts'
import { runDeploy, succeeded } from '../publishing/deploy.ts'
import type { DeployReport } from '../publishing/deploy.ts'
import { lockHolderOf, processRuns, pullContentStore } from '../publishing/node/device.ts'
import { JOURNAL_FOLDER } from '../publishing/renames.ts'
import { addressOf, PublicationCenter } from './center.ts'
import type { FileStat } from './center.ts'
import { editorWrites } from './editor-writes.ts'
import { isolateNames, lockState } from './messages.ts'
import { childProcess, deploySettingsOf, deployFiles } from './deploy.ts'
import { Measures } from './measures.ts'
import { LocalMcpServer, MCP_HOST } from './mcp-server.ts'
import { journalName, RenameRecorder } from './rename-journal.ts'
import {
    claudeCommandOf,
    deviceOf,
    isPort,
    keyOf,
    loadMcpSettings,
    loadSettings,
    MCP_KEY_SECRET,
    newKey,
    pullOptionsOf,
    saveMcpSettings,
    saveSettings
} from './settings.ts'
import type { DeviceSettings } from './settings.ts'
import { serializerLists } from './serializer.ts'
import { starterKitNoteTypes } from './starter-kit.ts'
import type { PluginHost } from './starter-kit.ts'
import { PublicationCenterView, TakedownModal, VIEW_TYPE } from './view.ts'

/**
 * The Obsidian plugin of the publishing tool.
 *
 * It is a face of the tool (MOD-16 of the spec): a thin layer over the
 * publishing logic in `src/publishing/`, which never imports Obsidian. No rule
 * of the publishing logic lives here.
 */

/** The icon of each state of the open note: a state never shows by its color alone (C10). */
const STATE_ICONS: Record<NoteStateKind, string> = {
    unknown: 'help-circle',
    unchecked: 'help-circle',
    live: 'globe',
    changed: 'pencil',
    technical: 'refresh-cw',
    moved: 'move-right',
    movedEdited: 'move-right',
    new: 'circle',
    unpublish: 'minus-circle',
    forced: 'shield-alert',
    excluded: 'lock'
}

/** The folder of the vault on this desktop: the logic reads the vault as files (TOOL-01: desktop only). */
function vaultFolder(app: App): string {
    const adapter: unknown = app.vault.adapter
    const getBasePath =
        typeof adapter === 'object' && adapter !== null
            ? (adapter as { getBasePath?: unknown }).getBasePath
            : undefined
    if (typeof getBasePath !== 'function') {
        throw new Error('Vault Publish needs a vault in a folder of this computer')
    }
    const folder: unknown = getBasePath.call(adapter)
    if (typeof folder !== 'string') {
        throw new Error('Vault Publish needs a vault in a folder of this computer')
    }
    return folder
}

/** A notice whose names are isolated from the text around them (issue 106). */
function notify(text: string): void {
    new Notice(isolateNames(text))
}

function isNote(file: TAbstractFile): boolean {
    return !(file instanceof TFolder) && file.path.endsWith('.md')
}

/** Random bytes of the system, for the key of the MCP server. */
function randomBytes(size: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(size))
}

export class VaultPublishPlugin extends Plugin {
    readonly measures = new Measures()
    center!: PublicationCenter
    #openStart: number | undefined
    #mcp: LocalMcpServer | undefined
    #restarting: Promise<void> = Promise.resolve()
    /** What the MCP server does now, for the settings tab. */
    mcpState = 'off'

    override onload(): void {
        const started = performance.now()
        // The rename journal of this device (PUB-60, decision R66): each
        // rename that Obsidian reports, so that the next publication keeps the
        // old URL as a redirect.
        const recorder = new RenameRecorder(
            this.app.vault.adapter,
            `${this.app.vault.configDir}/${JOURNAL_FOLDER}`,
            journalName(this.app, () => crypto.getRandomValues(new Uint8Array(8)))
        )
        this.center = new PublicationCenter({
            device: () =>
                deviceOf(
                    loadSettings(this.app),
                    vaultFolder(this.app),
                    this.app.vault.configDir,
                    // `app.plugins` is not in the API of Obsidian: the face
                    // checks every step of it (starter-kit.ts).
                    starterKitNoteTypes(this.app as unknown as PluginHost),
                    // The refresh of the frozen lists before a plan (PUB-35, R71).
                    serializerLists(this.app as unknown as PluginHost, normalizePath),
                    // The writes into the notes, as edits of Obsidian (issue 106).
                    (vault) => editorWrites(vault, this.app.vault)
                ),
            // The size and the time of a note, read the same way for an
            // event and for a write of a run (issue 106).
            stat: (path) => this.#statOf(path),
            pull: () => pullContentStore(pullOptionsOf(loadSettings(this.app))),
            // The deploy of the site after a push (issue 32), as a child
            // process in the clean clone of the site code of this device.
            deploy: (kind, signal) => {
                const settings = loadSettings(this.app)
                return runDeploy(
                    childProcess({ programs: [settings.git.trim(), settings.bun.trim()] }),
                    deployFiles(settings.contentStore, gitOf(settings)),
                    deploySettingsOf(settings),
                    kind,
                    process.platform === 'win32',
                    signal
                )
            },
            takedowns: () => {
                const settings = loadSettings(this.app)
                return deployFiles(settings.contentStore, gitOf(settings))
            },
            record: () => deployFiles(loadSettings(this.app).contentStore),
            now: () => new Date(),
            deviceName: hostname().replace(/\s+/gu, ' ').trim() || 'unnamed device',
            // The message that the publication started (PERF-04): its plan
            // is the plan of the label.
            started: (label, clickedAt) => {
                new Notice(`Vault Publish: publication started. ${label}`)
                if (clickedAt !== undefined) {
                    requestAnimationFrame(() => {
                        this.measures.record('start', performance.now() - clickedAt)
                    })
                }
            }
        })
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                const kind = file instanceof TFolder ? 'folder' : 'file'
                recorder.record(kind, oldPath, file.path, new Date()).catch((error: unknown) => {
                    // A rename that is not recorded loses its redirect: the
                    // author must know, and can confirm the pairing later.
                    notify(
                        `Vault Publish could not record the rename of "${oldPath}" in its journal: ${error instanceof Error ? error.message : 'it failed'}. At the next publication, confirm the pairing, or pair the two notes by hand.`
                    )
                })
                if (isNote(file)) {
                    this.#noteChanged(file.path)
                }
            })
        )
        // Obsidian reports every file as made while it loads the vault: the
        // edits count from the moment that the layout is ready.
        this.app.workspace.onLayoutReady(() => {
            const changed = (file: TAbstractFile): void => {
                if (isNote(file)) {
                    // With its size and time after the event: an event of a
                    // write of a run is no edit (issue 106).
                    void this.#statOf(file.path).then((stat) => {
                        this.#noteChanged(file.path, stat)
                    })
                }
            }
            this.registerEvent(this.app.vault.on('modify', changed))
            this.registerEvent(this.app.vault.on('create', changed))
            // A takedown whose deploy did not succeed is tried again (issue 32).
            void this.center.refreshTakedowns().then((waits) => {
                if (waits) {
                    new Notice(
                        'Vault Publish: a takedown waits for its deploy, so the deploy runs again with --takedown'
                    )
                    void this.center.deploy()
                }
            })
        })

        this.registerView(
            VIEW_TYPE,
            (leaf: WorkspaceLeaf) =>
                new PublicationCenterView(leaf, {
                    center: this.center,
                    measures: this.measures,
                    takeOpenStart: () => {
                        const opened = this.#openStart
                        this.#openStart = undefined
                        return opened
                    },
                    openSettings: () => {
                        this.#openSettings()
                    },
                    confirmUnlock: () => {
                        void this.#confirmUnlock()
                    }
                })
        )
        this.addRibbonIcon('send', 'Open publication center', () => {
            void this.#openView()
        })
        this.#addCommands()
        this.addSettingTab(new DeviceSettingTab(this.app, this))
        this.#addStatusBar()
        this.#watchRuns()
        this.#watchPauses()
        void this.restartMcp()
        this.measures.record('load', performance.now() - started)
    }

    override onunload(): void {
        // After the restart that runs, so that no server stays open.
        void this.#restarting.then(() => this.#mcp?.stop())
    }

    /** The key of the MCP server of this device: the first start makes it. */
    mcpKey(): string {
        return keyOf(this.app.secretStorage, randomBytes)
    }

    /** Makes a new key: an agent with the old key is refused from now on. */
    newMcpKey(): string {
        const key = newKey(randomBytes)
        this.app.secretStorage.setSecret(MCP_KEY_SECRET, key)
        return key
    }

    /**
     * Starts the MCP server of the tool with the settings of this device
     * (issue 41, R68), or stops it when they turn it off. A start that fails
     * shows a notice: the rest of the plugin works without the server.
     */
    restartMcp(): Promise<void> {
        // One restart at a time: two quick changes in the settings tab must
        // never leave a first server open.
        this.#restarting = this.#restarting
            .then(() => this.#restartMcp())
            .catch((error: unknown) => {
                this.mcpState = `not started: ${error instanceof Error ? error.message : 'it failed'}`
                new Notice(`Vault Publish: the MCP server is ${this.mcpState}`)
            })
        return this.#restarting
    }

    async #restartMcp(): Promise<void> {
        await this.#mcp?.stop()
        this.#mcp = undefined
        const settings = loadMcpSettings(this.app)
        if (!settings.enabled) {
            this.mcpState = 'off'
            return
        }
        // The key exists before the first request.
        this.mcpKey()
        const server = new LocalMcpServer({
            port: settings.port,
            key: () => this.app.secretStorage.getSecret(MCP_KEY_SECRET),
            version: this.manifest.version,
            operations: (call) => this.center.serve(call)
        })
        this.#mcp = server
        try {
            const port = await server.start()
            this.mcpState = `on, at http://${MCP_HOST}:${String(port)}/mcp`
        } catch (error) {
            this.mcpState = `not started: ${error instanceof Error ? error.message : 'it failed'}`
            new Notice(`Vault Publish: the MCP server is ${this.mcpState}`)
        }
    }

    async #openView(path?: string): Promise<void> {
        this.#openStart = performance.now()
        const { workspace } = this.app
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0]
        if (leaf === undefined) {
            leaf = workspace.getLeaf('tab')
            await leaf.setViewState({ type: VIEW_TYPE, active: true })
        }
        await workspace.revealLeaf(leaf)
        if (path !== undefined && leaf.view instanceof PublicationCenterView) {
            leaf.view.showNote(path)
        }
        // The lists show the last check at once, and a new check runs in the
        // background (PERF-01, R67).
        void this.center.check()
    }

    #openSettings(): void {
        const settings: unknown = (this.app as unknown as { setting?: unknown }).setting
        const open =
            typeof settings === 'object' && settings !== null
                ? (settings as { open?: unknown; openTabById?: unknown })
                : undefined
        if (typeof open?.open === 'function' && typeof open.openTabById === 'function') {
            open.open.call(settings)
            open.openTabById.call(settings, this.manifest.id)
        } else {
            new Notice('Open the settings of Vault Publish in the settings of Obsidian')
        }
    }

    /** The open note, when it is a note. */
    #openNote(): string | undefined {
        const file = this.app.workspace.getActiveFile()
        return file !== null && file.path.endsWith('.md') ? file.path : undefined
    }

    #addCommands(): void {
        this.addCommand({
            id: 'open-publication-center',
            name: 'Open publication center',
            callback: () => {
                void this.#openView()
            }
        })
        this.addCommand({
            id: 'check-for-changes',
            name: 'Check for changes',
            callback: () => {
                void this.center.check()
            }
        })
        this.addCommand({
            id: 'unpublish-open-note',
            name: 'Unpublish the open note with the next publication',
            checkCallback: (checking) => {
                const path = this.#openNote()
                const kind = path === undefined ? undefined : this.center.stateOf(path).kind
                if (
                    path === undefined ||
                    !['live', 'changed', 'technical', 'moved', 'movedEdited'].includes(kind ?? '')
                ) {
                    return false
                }
                if (!checking) {
                    const before = this.center.state.choices
                    this.center.choose((queue, choices) => markUnpublish(queue, choices, path))
                    notify(
                        this.center.state.choices === before
                            ? `"${path}" was already marked for its unpublish`
                            : `"${path}" is marked: the next publication of the publication center unpublishes it. Obsidian does not keep the mark when it closes.`
                    )
                }
                return true
            }
        })
        this.addCommand({
            id: 'take-down-open-note',
            name: 'Take down the open note now',
            checkCallback: (checking) => {
                const path = this.#openNote()
                if (path === undefined) {
                    return false
                }
                if (!checking) {
                    const stored = this.center.storePathOf(path)
                    new TakedownModal(this.app, path, stored, () => {
                        void this.center.takedown([path], [stored])
                    }).open()
                }
                return true
            }
        })
        this.addCommand({
            id: 'copy-live-address',
            name: 'Copy the live address of the open note',
            checkCallback: (checking) => {
                const path = this.#openNote()
                if (path === undefined) {
                    return false
                }
                if (!checking) {
                    void navigator.clipboard.writeText(addressOf(path))
                    new Notice(`Copied ${addressOf(path)}`)
                }
                return true
            }
        })
        this.addCommand({
            id: 'deploy-again',
            name: 'Deploy the site again, with no publication',
            callback: () => {
                void this.center.deploy()
            }
        })
        this.addCommand({
            id: 'remove-lock',
            name: 'Remove the lock of this device, after a run that stopped',
            callback: () => {
                void this.#confirmUnlock()
            }
        })
        this.addCommand({
            id: 'show-measures',
            name: 'Show the measures of the publication center',
            callback: () => {
                new MeasuresModal(this.app, this.measures).open()
            }
        })
    }

    /** Updates the status bar item: the state of the open note. */
    #updateStatus: () => void = () => undefined

    /** The size and the time of the last change of a note, from the adapter of Obsidian. */
    async #statOf(path: string): Promise<FileStat | undefined> {
        try {
            const stat = await this.app.vault.adapter.stat(path)
            return stat === null ? undefined : { size: stat.size, mtime: stat.mtime }
        } catch {
            return undefined
        }
    }

    /** A note changed in the vault: a mark for the status bar, with no render of the view. */
    #noteChanged(path: string, stat?: FileStat): void {
        this.center.noteChanged(path, stat)
        if (this.#openNote() === path) {
            this.#updateStatus()
        }
    }

    /** The confirmation of the removal of the lock, with whether its process still runs (issue 106). */
    async #confirmUnlock(): Promise<void> {
        const { error } = this.center.state
        const text = await this.center.lockText()
        const holder = lockState(text === undefined ? undefined : lockHolderOf(text), processRuns)
        new ConfirmModal(
            this.app,
            'Remove the lock of this device?',
            isolateNames(
                `${holder} Remove the lock only when no publication runs on this device: not in Obsidian, and not in the command line program. A run that stopped halfway (a crash, Obsidian closed during a run) left it. The next dry run, publication or takedown then puts the copy of the content store back.${error === undefined ? '' : ` The last message: ${error}`}`
            ),
            'Remove the lock',
            () => {
                void this.center.unlock()
            }
        ).open()
    }

    /** The status bar item with the state of the open note (TOOL-23, R67). */
    #addStatusBar(): void {
        const item = this.addStatusBarItem()
        item.addClass('mod-clickable', 'vault-publish-status')
        const update = (): void => {
            const path = this.#openNote()
            item.empty()
            if (path === undefined) {
                item.hide()
                return
            }
            item.show()
            const state = this.center.stateOf(path)
            const icon = item.createSpan({ cls: 'vault-publish-status-icon' })
            setIcon(icon, STATE_ICONS[state.kind])
            item.createSpan({ text: state.label })
            item.setAttribute(
                'aria-label',
                `Vault Publish: ${state.label}. Click to open the publication center.`
            )
        }
        this.registerDomEvent(item, 'click', () => {
            void this.#openView(this.#openNote())
        })
        this.#updateStatus = update
        this.registerEvent(this.app.workspace.on('file-open', update))
        this.register(this.center.subscribe(update))
        update()
    }

    /** A notice at the end of a run and of a deploy, also when the view is closed (PERF-11). */
    #watchRuns(): void {
        let before = this.center.state.activity
        let deploying = false
        this.register(
            this.center.subscribe(() => {
                const { deployment } = this.center.state
                if (deploying && deployment?.running === false) {
                    notify(`Vault Publish: ${deployNotice(deployment.report)}`)
                }
                deploying = deployment?.running === true
            })
        )
        this.register(
            this.center.subscribe(() => {
                const { activity, error, outcome } = this.center.state
                if (
                    before !== 'idle' &&
                    before !== 'checking' &&
                    before !== 'answering' &&
                    activity === 'idle'
                ) {
                    notify(`Vault Publish: ${error ?? outcome ?? 'done'}`)
                }
                before = activity
            })
        )
    }

    /** The longest pauses of the interface (PERF-05): the long tasks that Chromium reports. */
    #watchPauses(): void {
        if (
            typeof PerformanceObserver === 'undefined' ||
            !PerformanceObserver.supportedEntryTypes.includes('longtask')
        ) {
            return
        }
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                this.measures.record('pause', entry.duration)
            }
        })
        observer.observe({ type: 'longtask', buffered: false })
        this.register(() => {
            observer.disconnect()
        })
    }
}

/** The git program of the settings, or `git` of the path of the system. */
function gitOf(settings: DeviceSettings): string {
    return settings.git.trim() === '' ? 'git' : settings.git.trim()
}

/** The text of the notice at the end of a deploy (PUB-42): live, not live yet, failed, or nothing deployed. */
function deployNotice(report: DeployReport): string {
    if (succeeded(report)) {
        return report.live
            ? `the site is live at ${report.url ?? 'its host'}`
            : 'the site is deployed, but the host does not show the new revision yet'
    }
    if (report.deploy === 'skipped' && report.build === 'skipped') {
        return report.error ?? 'nothing was deployed'
    }
    return `the publication is done, but the deploy failed: ${report.error ?? 'read its output in the publication center'}`
}

/** The settings of this device (decision R67): kept in the local storage of Obsidian. */
class DeviceSettingTab extends PluginSettingTab {
    constructor(
        app: App,
        private readonly plugin: VaultPublishPlugin
    ) {
        super(app, plugin)
    }

    override display(): void {
        const { containerEl } = this
        containerEl.empty()
        containerEl.createEl('p', {
            text: 'These settings belong to this device only: they stay out of the vault and never travel to another device.'
        })
        const settings = loadSettings(this.app)
        const save = (change: Partial<DeviceSettings>): void => {
            saveSettings(this.app, { ...loadSettings(this.app), ...change })
        }
        new Setting(containerEl)
            .setName('Copy of the content store')
            .setDesc(
                'The absolute path of the git clone of the content store on this device. Its origin is the content store.'
            )
            .addText((text) =>
                text
                    .setPlaceholder('/home/me/content-store')
                    .setValue(settings.contentStore)
                    .onChange((value) => {
                        save({ contentStore: value })
                    })
            )
        new Setting(containerEl)
            .setName('Attachment storage')
            .setDesc(
                'The absolute path of the folder that stands for the object storage of the host, until the hosting slice.'
            )
            .addText((text) =>
                text
                    .setPlaceholder('/home/me/attachments')
                    .setValue(settings.attachmentStorage)
                    .onChange((value) => {
                        save({ attachmentStorage: value })
                    })
            )
        new Setting(containerEl)
            .setName('Git program')
            .setDesc(
                'The absolute path of git, when Obsidian does not find it. Empty for git of the path of the system.'
            )
            .addText((text) =>
                text
                    .setPlaceholder('/usr/bin/git')
                    .setValue(settings.git)
                    .onChange((value) => {
                        save({ git: value })
                    })
            )
        deployRows(this.app, containerEl, save)
        mcpRows(this.plugin, containerEl)
        new Setting(containerEl)
            .setName('Check the settings')
            .setDesc('Runs a check of the vault and of the copy with these settings.')
            .addButton((button) =>
                button.setButtonText('Check').onClick(() => {
                    // The result of this check, never an older error: a
                    // check that another activity refuses says so.
                    void this.plugin.center.check().then((result) => {
                        notify(
                            `Vault Publish: ${result.refused ?? result.failure ?? this.plugin.center.state.log.at(-1)?.text ?? 'done'}`
                        )
                    })
                })
            )
    }
}

/**
 * The rows of the deploy after a push (issue 32): the site goes live from this
 * machine, from a clean clone of the site code that is kept for deploys.
 */
function deployRows(
    app: App,
    containerEl: HTMLElement,
    save: (change: Partial<DeviceSettings>) => void
): void {
    const settings = loadSettings(app)
    new Setting(containerEl).setName('Deploy after a push').setHeading()
    containerEl.createEl('p', {
        text: 'After each publication, unpublish and takedown, the plugin runs the deploy of the site on this device: bun run deploy in the folder of the site code. The publication is done at the push: a failed deploy never undoes it. Without the folder of the site code or the target file, nothing is deployed.'
    })
    const rows: [string, string, string, keyof DeviceSettings][] = [
        [
            'Folder of the site code',
            'The absolute path of a clean clone of the repository of the site, on its branch main, used only for deploys. The deploy pulls it first. Use the same clone as the command line program of this machine: the lock of the deploys is in it.',
            '/home/me/deploy/dsebastien-website',
            'siteCode'
        ],
        [
            'Target file',
            'The absolute path of the private target file of the deployment (the names of the host). Never in the vault or in the repository.',
            '/home/me/private/deploy-target.json',
            'deployTarget'
        ],
        [
            'Env file',
            'The absolute path of the private env file with the token of the deployment, read with bun --env-file. Empty when the token is in the environment of Obsidian.',
            '/home/me/private/deploy.env',
            'deployEnvFile'
        ],
        [
            'Bun program',
            'The absolute path of bun, when Obsidian does not find it. Empty for bun of the path of the system.',
            '/home/me/.bun/bin/bun',
            'bun'
        ],
        [
            'Time limit of a deploy',
            'In minutes, from 1 to 1440 (24 hours). After it, the deploy stops with the programs that it started, and fails. Empty for 30.',
            '30',
            'deployTimeout'
        ]
    ]
    for (const [name, description, placeholder, key] of rows) {
        new Setting(containerEl)
            .setName(name)
            .setDesc(description)
            .addText((text) =>
                text
                    .setPlaceholder(placeholder)
                    .setValue(settings[key])
                    .onChange((value) => {
                        save({ [key]: value })
                    })
            )
    }
}

/** The rows of the MCP server in the settings tab. */
function mcpRows(plugin: VaultPublishPlugin, containerEl: HTMLElement): void {
    const settings = loadMcpSettings(plugin.app)
    new Setting(containerEl).setName('MCP server').setHeading()
    containerEl.createEl('p', {
        text: 'An AI assistant on this computer can drive the publishing tool through this server: the same operations as the command line program (status, plan, publish, unpublish, takedown, unlock, guards, deny, allow, ignore, unignore, deploy). It listens on 127.0.0.1 only and refuses a request without the key of this device.'
    })
    const running = new Setting(containerEl).setName('Run the MCP server')
    const restart = (): void => {
        running.setDesc('It restarts.')
        void plugin.restartMcp().then(() => {
            running.setDesc(`It is ${plugin.mcpState}.`)
        })
    }
    running.setDesc(`It is ${plugin.mcpState}.`).addToggle((toggle) =>
        toggle.setValue(settings.enabled).onChange((enabled) => {
            saveMcpSettings(plugin.app, { ...loadMcpSettings(plugin.app), enabled })
            restart()
        })
    )
    let port = String(settings.port)
    new Setting(containerEl)
        .setName('Port')
        .setDesc('A port from 1024 to 65535 on 127.0.0.1. Apply restarts the server.')
        .addText((text) =>
            text.setValue(port).onChange((value) => {
                port = value
            })
        )
        .addButton((button) =>
            button.setButtonText('Apply').onClick(() => {
                const value = Number(port.trim())
                if (!isPort(value)) {
                    new Notice(`Vault Publish: "${port}" is not a port from 1024 to 65535`)
                    return
                }
                saveMcpSettings(plugin.app, { ...loadMcpSettings(plugin.app), port: value })
                restart()
            })
        )
    new Setting(containerEl)
        .setName('Key')
        .setDesc(
            'The secret that an agent gives in the header Authorization: Bearer <key>. It stays in the secret storage of Obsidian on this device.'
        )
        .addButton((button) =>
            button.setButtonText('Copy the key').onClick(() => {
                void navigator.clipboard.writeText(plugin.mcpKey())
                new Notice('Copied the key of the MCP server')
            })
        )
        .addButton((button) =>
            button
                .setButtonText('Make a new key')
                .setDestructive()
                .onClick(() => {
                    new ConfirmModal(
                        plugin.app,
                        'Make a new key?',
                        'Every agent that uses the old key is refused from now on. Give the new key to the agents that you use.',
                        'Make a new key',
                        () => {
                            plugin.newMcpKey()
                            new Notice('Vault Publish: the MCP server has a new key')
                        }
                    ).open()
                })
        )
    new Setting(containerEl)
        .setName('Command for Claude Code')
        .setDesc('Adds this server to Claude Code, with the port and the key of this device.')
        .addButton((button) =>
            button.setButtonText('Copy the command').onClick(() => {
                const { port: current } = loadMcpSettings(plugin.app)
                void navigator.clipboard.writeText(claudeCommandOf(current, plugin.mcpKey()))
                new Notice('Copied the command for Claude Code: it holds the key')
            })
        )
}

/** A question with one button for a step that is hard to take back. */
class ConfirmModal extends Modal {
    constructor(
        app: App,
        private readonly title: string,
        private readonly text: string,
        private readonly action: string,
        private readonly confirm: () => void
    ) {
        super(app)
    }

    override onOpen(): void {
        this.setTitle(this.title)
        this.contentEl.createEl('p', { text: this.text })
        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText('Cancel').onClick(() => {
                    this.close()
                })
            )
            .addButton((button) =>
                button
                    .setButtonText(this.action)
                    .setDestructive()
                    .setCta()
                    .onClick(() => {
                        this.close()
                        this.confirm()
                    })
            )
    }

    override onClose(): void {
        this.contentEl.empty()
    }
}

/** The measures of the budgets by hand (PERF-17), to copy into the checklist. */
class MeasuresModal extends Modal {
    constructor(
        app: App,
        private readonly measures: Measures
    ) {
        super(app)
    }

    override onOpen(): void {
        this.setTitle('Measures of the publication center')
        const text = this.measures.text()
        this.contentEl.createEl('pre', { cls: 'vault-publish-measures', text })
        new Setting(this.contentEl).addButton((button) =>
            button.setButtonText('Copy').onClick(() => {
                void navigator.clipboard.writeText(text)
                new Notice('Copied the measures')
            })
        )
    }

    override onClose(): void {
        this.contentEl.empty()
    }
}
