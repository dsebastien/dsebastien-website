import { hostname } from 'node:os'
import { Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon, TFolder } from 'obsidian'
import type { App, TAbstractFile, WorkspaceLeaf } from 'obsidian'
import { markUnpublish } from '../publishing/center.ts'
import type { NoteStateKind } from '../publishing/center.ts'
import { pullContentStore } from '../publishing/node/device.ts'
import { JOURNAL_FOLDER } from '../publishing/renames.ts'
import { addressOf, PublicationCenter } from './center.ts'
import { Measures } from './measures.ts'
import { journalName, RenameRecorder } from './rename-journal.ts'
import { deviceOf, loadSettings, saveSettings } from './settings.ts'
import type { DeviceSettings } from './settings.ts'
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

function isNote(file: TAbstractFile): boolean {
    return !(file instanceof TFolder) && file.path.endsWith('.md')
}

export class VaultPublishPlugin extends Plugin {
    readonly measures = new Measures()
    center!: PublicationCenter
    #openStart: number | undefined

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
                    starterKitNoteTypes(this.app as unknown as PluginHost)
                ),
            pull: () => {
                const settings = loadSettings(this.app)
                return pullContentStore({
                    contentStore: settings.contentStore,
                    ...(settings.git.trim() === '' ? {} : { git: settings.git.trim() })
                })
            },
            now: () => new Date(),
            deviceName: hostname().replace(/\s+/gu, ' ').trim() || 'unnamed device'
        })
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                const kind = file instanceof TFolder ? 'folder' : 'file'
                recorder.record(kind, oldPath, file.path, new Date()).catch((error: unknown) => {
                    // A rename that is not recorded loses its redirect: the
                    // author must know, and can confirm the pairing later.
                    new Notice(
                        `Vault Publish could not record the rename of "${oldPath}" in its journal: ${error instanceof Error ? error.message : 'it failed'}. At the next publication, confirm the pairing, or pair the two notes by hand.`
                    )
                })
                if (isNote(file)) {
                    this.center.noteChanged(file.path)
                }
            })
        )
        const changed = (file: TAbstractFile): void => {
            if (isNote(file)) {
                this.center.noteChanged(file.path)
            }
        }
        this.registerEvent(this.app.vault.on('modify', changed))
        this.registerEvent(this.app.vault.on('create', changed))

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
        this.measures.record('load', performance.now() - started)
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
                    !['live', 'changed', 'technical', 'moved'].includes(kind ?? '')
                ) {
                    return false
                }
                if (!checking) {
                    this.center.choose((queue, choices) => markUnpublish(queue, choices, path))
                    new Notice(`"${path}" is unpublished with the next publication`)
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
                    new TakedownModal(this.app, path, () => {
                        void this.center.takedown([path])
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
            id: 'show-measures',
            name: 'Show the measures of the publication center',
            callback: () => {
                new MeasuresModal(this.app, this.measures).open()
            }
        })
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
        this.registerEvent(this.app.workspace.on('file-open', update))
        this.register(this.center.subscribe(update))
        update()
    }

    /** A notice at the end of a run, also when the view is closed (PERF-11). */
    #watchRuns(): void {
        let before = this.center.state.activity
        this.register(
            this.center.subscribe(() => {
                const { activity, error, log } = this.center.state
                if (before !== 'idle' && before !== 'checking' && activity === 'idle') {
                    new Notice(`Vault Publish: ${error ?? log.at(-1)?.text ?? 'done'}`)
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
        new Setting(containerEl)
            .setName('Check the settings')
            .setDesc('Runs a check of the vault and of the copy with these settings.')
            .addButton((button) =>
                button.setButtonText('Check').onClick(() => {
                    void this.plugin.center.check().then(() => {
                        new Notice(
                            `Vault Publish: ${this.plugin.center.state.error ?? this.plugin.center.state.log.at(-1)?.text ?? 'done'}`
                        )
                    })
                })
            )
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
