import { FuzzySuggestModal, ItemView, Menu, Modal, Notice, Setting, setIcon } from 'obsidian'
import type { App, WorkspaceLeaf } from 'obsidian'
import {
    describePlan,
    filterRows,
    markUnpublish,
    pairByHand,
    rowsOf,
    setTicks,
    summaryOf,
    togglePairing,
    toggleRow,
    toggleTechnical
} from '../publishing/center.ts'
import type { Filter, Row, RowGroup, ViewList } from '../publishing/center.ts'
import type { PublicationPlan } from '../publishing/plan.ts'
import { FolderSuggest } from './folder-suggest.ts'
import { addressOf } from './center.ts'
import type { PublicationCenter } from './center.ts'
import type { Measures } from './measures.ts'

// The view of the publication center (TOOL-20 to TOOL-22, TOOL-25, decision
// R67): a tab in the main area that shows the state of the controller and the
// rows of the model. It holds no rule of the publishing logic: every rule is
// behind SEAM-01 and SEAM-02, and the author checks this view by hand in a
// test vault (section 18.1 of the spec).

export const VIEW_TYPE = 'dsebastien-vault-publish-center'

/** The height of a row of the lists, in pixels: the virtual list needs one height (PERF-12). */
const ROW_HEIGHT = 30

/** The rows that the virtual list renders above and below the visible ones. */
const MARGIN_ROWS = 10

/** The most lines of a section that is not virtual: the moves, the pairings, a list of a report. */
const SECTION_LINES = 200

const LISTS: readonly { list: ViewList; label: string }[] = [
    { list: 'new', label: 'New' },
    { list: 'changed', label: 'Changed' },
    { list: 'toRemove', label: 'To remove' },
    { list: 'unchanged', label: 'Unchanged' }
]

/** What a row says next to its path. */
const GROUP_TEXT: Record<RowGroup, string> = {
    candidate: '',
    paired: 'paired',
    changed: '',
    technical: 'technical update',
    movedEdited: 'moved, its new text waits for a tick',
    forced: 'a guard excludes it: every publication removes it',
    unpublishedUnderGuard: 'unpublished, a guard excludes it: its entry leaves the store',
    unpublish: 'will be unpublished',
    missing: 'missing from this vault',
    unchanged: ''
}

/** The rows of a published note: the ones that the author can copy the address of or take down. */
const PUBLISHED_GROUPS = new Set<RowGroup>([
    'changed',
    'technical',
    'movedEdited',
    'forced',
    'unpublish',
    'missing',
    'unchanged'
])

/** What the view needs of the plugin. */
export interface ViewHost {
    readonly center: PublicationCenter
    readonly measures: Measures
    /** The moment of the command that opened the view, for PERF-01, or `undefined`. */
    takeOpenStart(): number | undefined
    /** Opens the settings tab of the plugin. */
    openSettings(): void
    /** Asks the author to confirm the removal of the lock of the device, then removes it. */
    confirmUnlock(): void
}

/**
 * Writes "from → to" with each path in an element of its own, isolated from
 * the text around it: a right-to-left mark in a file name never reorders the
 * other name.
 */
function names(parent: HTMLElement, from: string, to: string): void {
    parent.createSpan({ cls: 'vault-publish-name', text: from, attr: { dir: 'auto' } })
    parent.appendText(' → ')
    parent.createSpan({ cls: 'vault-publish-name', text: to, attr: { dir: 'auto' } })
}

function timeOf(date: Date): string {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export class PublicationCenterView extends ItemView {
    #list: ViewList = 'changed'
    #filter: Filter = { text: '', folder: '' }
    #unsubscribe: (() => void) | undefined
    /** The moment of the last change of a filter or of a tick, for PERF-07. */
    #changeStart: number | undefined
    #rows: Row[] = []
    #shown: Row[] = []
    #frame = 0
    #renderFrame = 0
    /** The rows of the last queue and choices: a scroll and a filter do not compute them again. */
    #allRowsOf: { queue: unknown; choices: unknown; rows: Record<ViewList, Row[]> } | undefined
    /** The sections that the author opened, by their names: a render keeps them open. */
    readonly #open = new Set<string>()
    /** The sections that showed one time: their default applies only then. */
    readonly #seen = new Set<string>()
    // The parts of the view, made one time in `onOpen`.
    #header!: HTMLElement
    #message!: HTMLElement
    #tabs!: HTMLElement
    #filters!: HTMLElement
    #summary!: HTMLElement
    #scroller!: HTMLElement
    #spacer!: HTMLElement
    #body!: HTMLElement
    #sections!: HTMLElement
    #footer!: HTMLElement
    #panels!: HTMLElement
    #log!: HTMLElement

    constructor(
        leaf: WorkspaceLeaf,
        private readonly host: ViewHost
    ) {
        super(leaf)
    }

    getViewType(): string {
        return VIEW_TYPE
    }

    getDisplayText(): string {
        return 'Publication center'
    }

    override getIcon(): string {
        return 'send'
    }

    override async onOpen(): Promise<void> {
        const root = this.contentEl
        root.empty()
        root.addClass('vault-publish-center')
        this.#header = root.createDiv({ cls: 'vault-publish-header' })
        this.#message = root.createDiv({ cls: 'vault-publish-message' })
        this.#tabs = root.createDiv({ cls: 'vault-publish-tabs', attr: { role: 'tablist' } })
        this.#filters = root.createDiv({ cls: 'vault-publish-filters' })
        this.#makeFilters()
        this.#summary = root.createDiv({ cls: 'vault-publish-summary' })
        this.#scroller = root.createDiv({ cls: 'vault-publish-scroller' })
        this.#spacer = this.#scroller.createDiv({ cls: 'vault-publish-spacer' })
        this.#body = this.#spacer.createDiv({ cls: 'vault-publish-rows' })
        this.registerDomEvent(this.#scroller, 'scroll', () => {
            this.#scheduleRows()
        })
        this.#sections = root.createDiv({ cls: 'vault-publish-sections' })
        this.#footer = root.createDiv({ cls: 'vault-publish-footer' })
        this.#panels = root.createDiv({ cls: 'vault-publish-panels' })
        this.#log = root.createEl('details', { cls: 'vault-publish-log' })
        // One render per frame, however many changes of the state come in it.
        this.#unsubscribe = this.host.center.subscribe(() => {
            cancelAnimationFrame(this.#renderFrame)
            this.#renderFrame = requestAnimationFrame(() => {
                this.#render()
            })
        })
        // The lists show the last check at once, with its time (PERF-01). The
        // command that opens the view starts a new check: a view that
        // Obsidian restores at its start runs none (R67, PERF-06).
        this.#render()
        await Promise.resolve()
    }

    override async onClose(): Promise<void> {
        this.#unsubscribe?.()
        cancelAnimationFrame(this.#frame)
        cancelAnimationFrame(this.#renderFrame)
        await Promise.resolve()
    }

    /** Shows one note: its list, with a filter on its path. */
    showNote(path: string): void {
        const rows = this.#allRows()
        const found = LISTS.find(({ list }) => rows?.[list].some((row) => row.path === path))
        if (found !== undefined) {
            this.#list = found.list
        }
        this.#filter = { text: path, folder: '' }
        this.#makeFilters()
        this.#render()
    }

    #allRows(): Record<ViewList, Row[]> | undefined {
        const { queue, choices } = this.host.center.state
        if (queue === undefined) {
            return undefined
        }
        if (this.#allRowsOf?.queue !== queue || this.#allRowsOf.choices !== choices) {
            this.#allRowsOf = { queue, choices, rows: rowsOf(queue, choices) }
        }
        return this.#allRowsOf.rows
    }

    /** A section that keeps its open state between two renders. */
    #section(
        parent: HTMLElement,
        name: string,
        title: string,
        cls: string,
        openByDefault = false
    ): HTMLDetailsElement {
        const section = parent.createEl('details', { cls })
        if (!this.#seen.has(name)) {
            this.#seen.add(name)
            if (openByDefault) {
                this.#open.add(name)
            }
        }
        if (this.#open.has(name)) {
            section.setAttribute('open', '')
        }
        section.createEl('summary', { text: title })
        section.addEventListener('toggle', () => {
            if (section.open) {
                this.#open.add(name)
            } else {
                this.#open.delete(name)
            }
        })
        return section
    }

    /** Opens a note by its exact path: `#` and `^` in a file name are no part of a link. */
    #openNote(path: string, newLeaf: boolean): void {
        const file = this.app.vault.getFileByPath(path)
        if (file !== null) {
            void this.app.workspace.getLeaf(newLeaf).openFile(file)
        }
    }

    #changed(): void {
        this.#changeStart = performance.now()
    }

    #makeFilters(): void {
        this.#filters.empty()
        const text = this.#filters.createEl('input', {
            type: 'search',
            placeholder: 'Filter by path',
            attr: { 'aria-label': 'Filter by path' },
            value: this.#filter.text
        })
        let timer = 0
        // The inputs are made again by `showNote` and Clear: a listener of the
        // element goes with it.
        text.addEventListener('input', () => {
            window.clearTimeout(timer)
            timer = window.setTimeout(() => {
                this.#changed()
                this.#filter = { ...this.#filter, text: text.value }
                this.#render()
            }, 120)
        })
        const folder = this.#filters.createEl('input', {
            type: 'search',
            placeholder: 'Folder',
            attr: { 'aria-label': 'Filter by folder' },
            value: this.#filter.folder
        })
        const apply = (): void => {
            this.#changed()
            this.#filter = { ...this.#filter, folder: folder.value }
            this.#render()
        }
        new FolderSuggest(this.app, folder, apply)
        folder.addEventListener('change', apply)
        const clear = this.#filters.createEl('button', { text: 'Clear' })
        clear.addEventListener('click', () => {
            this.#changed()
            this.#filter = { text: '', folder: '' }
            this.#makeFilters()
            this.#render()
        })
    }

    /** The key of the element that has the focus, so that a render can give it back. */
    #focused(): string | undefined {
        const active = this.contentEl.ownerDocument.activeElement
        return active instanceof HTMLElement && this.contentEl.contains(active)
            ? (active.getAttribute('data-focus') ?? undefined)
            : undefined
    }

    /** Gives the focus back to the element of the key, when the render made it again. */
    #refocus(key: string | undefined): void {
        if (key === undefined) {
            return
        }
        const found = [...this.contentEl.querySelectorAll('[data-focus]')].find(
            (element) => element.getAttribute('data-focus') === key
        )
        if (found instanceof HTMLElement) {
            found.focus()
        }
    }

    #render(): void {
        const focused = this.#focused()
        this.#renderAll()
        this.#refocus(focused)
    }

    #renderAll(): void {
        const { center } = this.host
        const { state } = center
        const rows = this.#allRows()
        this.#renderHeader()
        this.#message.empty()
        if (state.error !== undefined) {
            this.#message.createDiv({ cls: 'vault-publish-error', text: state.error })
            if (
                state.error.includes('settings of Vault Publish') ||
                state.error.includes('must be an absolute path') ||
                state.error.includes('copy of the content store')
            ) {
                const open = this.#message.createEl('button', { text: 'Open the settings' })
                open.addEventListener('click', () => {
                    this.host.openSettings()
                })
            }
            if (state.error.includes('a publication runs on this device, or one stopped halfway')) {
                const unlock = this.#message.createEl('button', { text: 'Remove the lock…' })
                unlock.disabled = state.activity !== 'idle'
                unlock.addEventListener('click', () => {
                    this.host.confirmUnlock()
                })
            }
        }
        this.#tabs.empty()
        for (const { list, label } of LISTS) {
            const count = rows?.[list].length
            const tab = this.#tabs.createEl('button', {
                cls: list === this.#list ? 'vault-publish-tab is-active' : 'vault-publish-tab',
                text: count === undefined ? label : `${label} ${count.toLocaleString()}`,
                attr: { 'role': 'tab', 'aria-selected': String(list === this.#list) }
            })
            tab.addEventListener('click', () => {
                this.#list = list
                this.#scroller.scrollTop = 0
                this.#render()
            })
        }
        this.#rows = rows?.[this.#list] ?? []
        this.#shown = filterRows(this.#rows, this.#filter)
        this.#renderSummary()
        this.#spacer.style.height = `${String(this.#shown.length * ROW_HEIGHT)}px`
        this.#renderRows()
        this.#renderSections()
        this.#renderFooter()
        this.#renderPanels()
        this.#renderLog()
        if (rows !== undefined) {
            const opened = this.host.takeOpenStart()
            requestAnimationFrame(() => {
                if (opened !== undefined) {
                    this.host.measures.record('open', performance.now() - opened)
                }
                if (this.#changeStart !== undefined) {
                    this.host.measures.record('filter', performance.now() - this.#changeStart)
                    this.#changeStart = undefined
                }
            })
        }
    }

    #renderHeader(): void {
        const { center } = this.host
        const { state } = center
        this.#header.empty()
        const line = this.#header.createDiv({ cls: 'vault-publish-state' })
        const activity =
            state.activity === 'idle'
                ? state.checkedAt === undefined
                    ? 'Not checked yet'
                    : `Checked at ${timeOf(state.checkedAt)}`
                : `${state.activity[0]?.toUpperCase() ?? ''}${state.activity.slice(1)}…`
        line.createSpan({ text: activity })
        const refresh = this.#header.createEl('button', { text: 'Refresh' })
        refresh.disabled = state.activity !== 'idle'
        refresh.addEventListener('click', () => {
            void center.check()
        })
        const behind = state.queue?.behind ?? 0
        if (behind > 0) {
            const warning = this.#header.createDiv({ cls: 'vault-publish-behind' })
            warning.createSpan({
                text: `The copy of the content store is ${String(behind)} ${behind === 1 ? 'commit' : 'commits'} behind: another device published. Pull before you publish.`
            })
            const pull = warning.createEl('button', { text: 'Pull' })
            pull.disabled = state.activity !== 'idle'
            pull.addEventListener('click', () => {
                void center.pull()
            })
        }
    }

    #renderSummary(): void {
        this.#summary.empty()
        const { center } = this.host
        const { queue } = center.state
        const summary = summaryOf(this.#rows, this.#shown)
        this.#summary.createSpan({
            text: `Shown ${summary.shown.toLocaleString()} of ${summary.total.toLocaleString()} · Selected ${summary.selected.toLocaleString()}${summary.hidden > 0 ? ` (${summary.hidden.toLocaleString()} not shown)` : ''}`
        })
        if (queue === undefined || this.#list === 'unchanged') {
            return
        }
        const paths = this.#shown.map((row) => row.path)
        for (const [label, ticked] of [
            ['Select shown', true],
            ['Unselect shown', false]
        ] as const) {
            const button = this.#summary.createEl('button', { text: label })
            button.addEventListener('click', () => {
                this.#changed()
                center.choose((current, choices) => setTicks(current, choices, paths, ticked))
            })
        }
        if (this.#list === 'changed' && queue.technicalUpdates.length > 0) {
            const line = this.#summary.createEl('label', { cls: 'vault-publish-technical' })
            const box = line.createEl('input', { type: 'checkbox' })
            box.checked = !center.state.choices.holdTechnical
            line.appendText(
                ` Technical updates: ${queue.technicalUpdates.length.toLocaleString()} notes (links or files changed, no edit)`
            )
            box.addEventListener('change', () => {
                this.#changed()
                center.choose((_queue, choices) => toggleTechnical(choices))
            })
        }
    }

    #scheduleRows(): void {
        cancelAnimationFrame(this.#frame)
        this.#frame = requestAnimationFrame(() => {
            const focused = this.#focused()
            this.#renderRows()
            this.#refocus(focused)
        })
    }

    /** Renders the visible rows only (PERF-12): about 20,000 unchanged notes from the first day. */
    #renderRows(): void {
        const top = this.#scroller.scrollTop
        const height = this.#scroller.clientHeight || 600
        const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - MARGIN_ROWS)
        const last = Math.min(
            this.#shown.length,
            Math.ceil((top + height) / ROW_HEIGHT) + MARGIN_ROWS
        )
        this.#body.empty()
        this.#body.style.transform = `translateY(${String(first * ROW_HEIGHT)}px)`
        if (this.#shown.length === 0) {
            this.#body.createDiv({
                cls: 'vault-publish-empty',
                text: this.host.center.state.queue === undefined ? 'No check yet.' : 'No note.'
            })
            return
        }
        for (const row of this.#shown.slice(first, last)) {
            this.#renderRow(row)
        }
    }

    #renderRow(row: Row): void {
        const { center } = this.host
        const line = this.#body.createDiv({
            cls: 'vault-publish-row',
            attr: { 'data-path': row.path }
        })
        line.style.height = `${String(ROW_HEIGHT)}px`
        if (row.checkable) {
            const box = line.createEl('input', {
                type: 'checkbox',
                attr: { 'aria-label': `Select ${row.path}`, 'data-focus': `box\n${row.path}` }
            })
            box.checked = row.ticked
            box.disabled = row.locked
            box.addEventListener('change', () => {
                this.#changed()
                center.choose((queue, choices) => toggleRow(queue, choices, row.path))
            })
        } else {
            line.createSpan({ cls: 'vault-publish-box' })
        }
        const path = line.createEl('a', {
            cls: 'vault-publish-path',
            text: row.path,
            attr: {
                'dir': 'auto',
                'tabindex': '0',
                'role': 'link',
                'data-focus': `path\n${row.path}`
            }
        })
        const open = (newLeaf: boolean): void => {
            if (row.group !== 'missing') {
                this.#openNote(row.path, newLeaf)
            }
        }
        path.addEventListener('click', (event) => {
            open(event.ctrlKey || event.metaKey)
        })
        path.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                open(event.ctrlKey || event.metaKey)
            }
        })
        const note =
            row.pairedWith === undefined ? GROUP_TEXT[row.group] : `paired with ${row.pairedWith}`
        if (note !== '') {
            line.createSpan({ cls: 'vault-publish-note', text: note })
        }
        const more = line.createEl('button', {
            cls: 'clickable-icon vault-publish-more',
            attr: { 'aria-label': `Actions for ${row.path}`, 'data-focus': `more\n${row.path}` }
        })
        setIcon(more, 'more-horizontal')
        more.addEventListener('click', (event) => {
            const menu = this.#menuOf(row)
            // A click from the keyboard has no position: the menu opens at its button.
            if (event.detail === 0) {
                const place = more.getBoundingClientRect()
                menu.showAtPosition({ x: place.left, y: place.bottom })
            } else {
                menu.showAtMouseEvent(event)
            }
        })
    }

    #menuOf(row: Row): Menu {
        const { center } = this.host
        const menu = new Menu()
        if (row.group !== 'missing' && row.group !== 'unpublishedUnderGuard') {
            menu.addItem((item) =>
                item
                    .setTitle('Open the note')
                    .setIcon('file-text')
                    .onClick(() => {
                        this.#openNote(row.path, false)
                    })
            )
        }
        if (PUBLISHED_GROUPS.has(row.group)) {
            menu.addItem((item) =>
                item
                    .setTitle('Copy the live address')
                    .setIcon('link')
                    .onClick(() => {
                        void navigator.clipboard.writeText(addressOf(row.path))
                        new Notice(`Copied ${addressOf(row.path)}`)
                    })
            )
        }
        if (
            row.group === 'changed' ||
            row.group === 'technical' ||
            row.group === 'movedEdited' ||
            row.group === 'unchanged'
        ) {
            menu.addItem((item) =>
                item
                    .setTitle('Unpublish with the next publication')
                    .setIcon('eye-off')
                    .onClick(() => {
                        this.#changed()
                        center.choose((queue, choices) => markUnpublish(queue, choices, row.path))
                    })
            )
        }
        if (row.group === 'unpublish') {
            menu.addItem((item) =>
                item
                    .setTitle('Keep it published')
                    .setIcon('eye')
                    .onClick(() => {
                        this.#changed()
                        center.choose((queue, choices) => toggleRow(queue, choices, row.path))
                    })
            )
        }
        if (row.group === 'missing') {
            menu.addItem((item) =>
                item
                    .setTitle('Pair with a new note…')
                    .setIcon('link-2')
                    .onClick(() => {
                        const candidates = center.state.queue?.new ?? []
                        new PairModal(this.app, row.path, candidates, (to) => {
                            this.#changed()
                            center.choose((_queue, choices) => pairByHand(choices, row.path, to))
                        }).open()
                    })
            )
        }
        if (PUBLISHED_GROUPS.has(row.group) || row.group === 'unpublishedUnderGuard') {
            menu.addSeparator()
            menu.addItem((item) =>
                item
                    .setTitle('Take down now…')
                    .setIcon('trash-2')
                    .setWarning(true)
                    .onClick(() => {
                        const stored = center.storePathOf(row.path)
                        new TakedownModal(this.app, row.path, stored, () => {
                            void center.takedown([row.path], [stored])
                        }).open()
                    })
            )
        }
        return menu
    }

    #renderSections(): void {
        this.#sections.empty()
        const { center } = this.host
        const { queue, choices } = center.state
        if (queue === undefined) {
            return
        }
        if (queue.renamed.length > 0) {
            const moves = this.#section(
                this.#sections,
                'moves',
                `Moves: ${queue.renamed.length.toLocaleString()} (every publication applies them, the old addresses redirect)`,
                'vault-publish-moves'
            )
            for (const move of queue.renamed.slice(0, SECTION_LINES)) {
                names(moves.createDiv(), move.from, move.to)
            }
            if (queue.renamed.length > SECTION_LINES) {
                moves.createDiv({
                    text: `and ${(queue.renamed.length - SECTION_LINES).toLocaleString()} more`
                })
            }
        }
        const key = (pairing: { from: string; to: string }): string =>
            `${pairing.from}\n${pairing.to}`
        const proposed = new Set(queue.pairings.map(key))
        const confirmed = new Set(choices.pair.map(key))
        const pairings = [
            ...queue.pairings,
            ...choices.pair.filter((one) => !proposed.has(key(one)))
        ]
        if (pairings.length > 0) {
            const box = this.#section(
                this.#sections,
                'pairings',
                `Pairings: ${pairings.length.toLocaleString()}. A published note is missing, and a new note has its text. Confirm, and the old address redirects to the new note.`,
                'vault-publish-pairings',
                true
            )
            for (const pairing of pairings.slice(0, SECTION_LINES)) {
                const line = box.createEl('label', { cls: 'vault-publish-pairing' })
                const confirm = line.createEl('input', { type: 'checkbox' })
                confirm.checked = confirmed.has(key(pairing))
                line.appendText(' ')
                names(line, pairing.from, pairing.to)
                if (!proposed.has(key(pairing))) {
                    line.appendText(' (by hand)')
                }
                confirm.addEventListener('change', () => {
                    this.#changed()
                    center.choose((_queue, current) => togglePairing(current, pairing))
                })
            }
            if (pairings.length > SECTION_LINES) {
                box.createDiv({
                    text: `and ${(pairings.length - SECTION_LINES).toLocaleString()} more: filter the list "To remove" and pair by hand`
                })
            }
        }
    }

    #renderFooter(): void {
        this.#footer.empty()
        const { center } = this.host
        const { state } = center
        const counted = center.plan()
        const busy = state.activity !== 'idle'
        const dry = this.#footer.createEl('button', {
            text: 'Dry run',
            attr: { 'data-focus': 'dry run' }
        })
        dry.disabled = busy || counted === undefined
        dry.addEventListener('click', () => {
            void center.dryRun()
        })
        const label = center.label()
        const publish = this.#footer.createEl('button', {
            cls: 'mod-cta',
            text: label,
            attr: { 'data-focus': 'publish' }
        })
        publish.disabled =
            busy ||
            counted === undefined ||
            label === 'Nothing to publish' ||
            (state.queue?.behind ?? 0) > 0
        publish.addEventListener('click', () => {
            void center.publish(performance.now())
        })
        if (busy) {
            this.#footer.createSpan({
                cls: 'vault-publish-busy',
                text: 'It runs in the background: you can close this tab and write.'
            })
        }
    }

    #renderPlan(parent: HTMLElement, plan: PublicationPlan): void {
        const parts: [string, readonly string[]][] = [
            ['New', plan.publish],
            ['Updates', plan.update],
            ['Removals', plan.remove],
            ['Forced removals', plan.forcedRemove],
            ['Moves', plan.move.map((move) => `${move.from} → ${move.to}`)]
        ]
        for (const [title, paths] of parts) {
            if (paths.length === 0) {
                continue
            }
            const part = parent.createEl('details')
            part.createEl('summary', { text: `${title}: ${paths.length.toLocaleString()}` })
            for (const path of paths.slice(0, 500)) {
                part.createDiv({ text: path })
            }
            if (paths.length > 500) {
                part.createDiv({ text: `and ${String(paths.length - 500)} more` })
            }
        }
    }

    #renderPanels(): void {
        this.#panels.empty()
        const { center } = this.host
        const { dryRun, report } = center.state
        if (dryRun !== undefined) {
            const panel = this.#panels.createDiv({ cls: 'vault-publish-panel' })
            const stopped = center.state.error?.startsWith('The plan changed') === true
            panel.createDiv({
                cls: 'vault-publish-section-title',
                text: `${stopped ? 'The plan of the vault now' : 'Dry run'}: ${describePlan(dryRun.plan)}. Nothing was published.${dryRun.offline ? ' No network: the plan uses the last fetch.' : ''}`
            })
            this.#renderPlan(panel, dryRun.plan)
        }
        if (report === undefined) {
            return
        }
        const panel = this.#panels.createDiv({ cls: 'vault-publish-panel vault-publish-report' })
        const head = panel.createDiv({ cls: 'vault-publish-section-title' })
        head.createSpan({
            text: report.kind === 'publication' ? 'Publication report' : 'Takedown report'
        })
        const close = head.createEl('button', { text: 'Close' })
        close.addEventListener('click', () => {
            center.closeReport()
        })
        const lines: [string, readonly string[]][] =
            report.kind === 'publication'
                ? [
                      ['Removed', report.report.removed],
                      ['Forced removals', report.report.forcedRemoved],
                      ['Moved', report.report.moved.map((move) => `${move.from} → ${move.to}`)],
                      ['Skipped (their live version stays)', report.report.skipped],
                      ['Failed', report.report.failed.map((one) => `${one.path}: ${one.reason}`)],
                      [
                          'Warnings',
                          report.report.warnings.map((one) => `${one.path}: ${one.message}`)
                      ]
                  ]
                : [
                      ['Taken down (404 after the next build)', report.report.takenDown],
                      [
                          'Storage warnings (a file can still be public)',
                          report.report.storageWarnings.map((one) => `${one.path}: ${one.message}`)
                      ],
                      [
                          'Warnings',
                          report.report.warnings.map((one) => `${one.path}: ${one.message}`)
                      ]
                  ]
        if (report.addresses.length > 0) {
            const live = panel.createEl('details', { attr: { open: '' } })
            live.createEl('summary', {
                text: `Published, updated and moved: ${report.addresses.length.toLocaleString()} (live after the next build)`
            })
            for (const address of report.addresses.slice(0, 500)) {
                const line = live.createDiv()
                line.createEl('a', { text: address.path, href: address.url })
            }
        }
        for (const [title, items] of lines) {
            if (items.length === 0) {
                continue
            }
            const part = panel.createEl('details', { attr: { open: '' } })
            part.createEl('summary', { text: `${title}: ${items.length.toLocaleString()}` })
            for (const item of items.slice(0, 500)) {
                part.createDiv({ text: item })
            }
        }
    }

    #renderLog(): void {
        const open = this.#log.hasAttribute('open')
        this.#log.empty()
        if (open) {
            this.#log.setAttribute('open', '')
        }
        const { log } = this.host.center.state
        const last = log.at(-1)
        this.#log.createEl('summary', {
            text: last === undefined ? 'Run log: empty' : `Run log: ${last.text}`
        })
        for (const line of [...log].reverse()) {
            this.#log.createDiv({ text: `${line.time} ${line.text}` })
        }
    }
}

/** The dialog of a takedown (decision R67): the note, what goes, what stays, one button. */
export class TakedownModal extends Modal {
    /**
     * @param path the vault path of the note
     * @param stored the path of the note in the content store: its old path while its move waits for a publication
     */
    constructor(
        app: App,
        private readonly path: string,
        private readonly stored: string,
        private readonly confirm: () => void
    ) {
        super(app)
    }

    override onOpen(): void {
        this.setTitle('Take down this note now?')
        const { contentEl } = this
        contentEl.createEl('p', {
            cls: 'vault-publish-path',
            text: this.path,
            attr: { dir: 'auto' }
        })
        if (this.stored !== this.path) {
            contentEl.createEl('p', {
                text: `It is published at its old path "${this.stored}": its move waits for the next publication. The takedown removes it there.`
            })
        }
        contentEl.createEl('p', {
            text: 'If the content store has the note, it leaves it at once, with no plan: its page, its Markdown, its manifest entry with its former paths, and the attachments that no other published note uses. After the next build, every address of the note answers 404, with no redirect. A note that was never published is refused, and nothing changes.'
        })
        contentEl.createEl('p', {
            text: 'Copies in the caches of browsers and at crawlers cannot be recalled, and the text stays in the history of the content store.'
        })
        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText('Cancel').onClick(() => {
                    this.close()
                })
            )
            .addButton((button) =>
                button
                    .setButtonText('Take down')
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

/** The choice of the new note of a pairing by hand (PUB-96). */
class PairModal extends FuzzySuggestModal<string> {
    constructor(
        app: App,
        from: string,
        private readonly candidates: readonly string[],
        private readonly choose: (to: string) => void
    ) {
        super(app)
        this.setPlaceholder(`The new note that is "${from}" now`)
    }

    getItems(): string[] {
        return [...this.candidates]
    }

    getItemText(item: string): string {
        return item
    }

    onChooseItem(item: string): void {
        this.choose(item)
    }
}
