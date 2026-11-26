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
import type { EditAction, EditEvent } from '../publishing/edits.ts'
import type { PublicationPlan } from '../publishing/plan.ts'
import type { ProposalReview } from '../publishing/tool.ts'
import { FolderSuggest } from './folder-suggest.ts'
import { addressOf } from './center.ts'
import type { PublicationCenter, Report } from './center.ts'
import type { Measures } from './measures.ts'
import { isolateNames, waysOut } from './messages.ts'

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

/** What the view says of the action of an edit of the guards (R69). */
const ACTION_TEXT: Record<EditAction, string> = {
    deny: 'Deny the folder',
    allow: 'Allow the folder',
    ignore: 'Ignore the note',
    unignore: 'Stop ignoring the note'
}

/**
 * Writes one event of the edits of the guards: its action, its path in an
 * element of its own (isolated from the text around it), its state, the
 * notes that it takes off the site, and who asked for it.
 */
function eventLine(parent: HTMLElement, event: EditEvent): void {
    const name = (text: string): void => {
        parent.createSpan({ cls: 'vault-publish-name', text, attr: { dir: 'auto' } })
    }
    parent.appendText(`${ACTION_TEXT[event.action]} `)
    name(event.path)
    const removes = event.removes?.length ?? 0
    const affects = event.affects?.length ?? 0
    const leave =
        removes === 0
            ? ''
            : ` · ${removes.toLocaleString()} ${removes === 1 ? 'entry leaves' : 'entries leave'} the content store`
    const lose =
        affects === 0
            ? ''
            : ` · ${affects.toLocaleString()} published ${affects === 1 ? 'note loses' : 'notes lose'} an attachment`
    parent.appendText(` · ${event.state}${leave}${lose} · `)
    // The names of the face and of the device are isolated too: a
    // right-to-left mark in the name of a device never reorders the line.
    name(event.face)
    parent.appendText(', ')
    name(event.device)
    parent.appendText(`, ${event.time}`)
}

/** A text isolated from the text around it in an attribute (U+2068 and U+2069): an aria-label has no element of its own. */
function isolated(text: string): string {
    return `\u2068${text}\u2069`
}

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
        // The failure of a publication or a takedown stays until the author
        // closes it, also after the check that follows it (issue 106).
        if (state.failure !== undefined && state.failure !== state.error) {
            this.#message.createDiv({
                cls: 'vault-publish-error',
                text: `The last publication or takedown failed: ${isolateNames(state.failure)}`
            })
            const close = this.#message.createEl('button', { text: 'Close' })
            close.addEventListener('click', () => {
                center.closeFailure()
            })
        }
        if (state.error !== undefined) {
            this.#message.createDiv({ cls: 'vault-publish-error', text: isolateNames(state.error) })
            const ways = waysOut(state.error)
            if (ways.settings) {
                const open = this.#message.createEl('button', { text: 'Open the settings' })
                open.addEventListener('click', () => {
                    this.host.openSettings()
                })
            }
            if (ways.pull) {
                const pull = this.#message.createEl('button', { text: 'Pull' })
                pull.disabled = state.activity !== 'idle'
                pull.addEventListener('click', () => {
                    void center.pull()
                })
            }
            if (ways.unlock) {
                const unlock = this.#message.createEl('button', { text: 'Remove the lock…' })
                unlock.disabled = state.activity !== 'idle'
                unlock.addEventListener('click', () => {
                    this.host.confirmUnlock()
                })
            }
            if (state.failure === state.error) {
                const close = this.#message.createEl('button', { text: 'Close' })
                close.addEventListener('click', () => {
                    center.closeFailure()
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
        // The deploy runs apart from the activities (issue 32): the view stays usable.
        if (state.deployment?.running === true) {
            line.createSpan({ cls: 'vault-publish-deploying', text: ' · Deploying the site…' })
        }
        if (state.takedownWaits === true) {
            const waits = this.#header.createDiv({ cls: 'vault-publish-behind' })
            waits.createSpan({
                text: 'A takedown waits for a deploy that succeeds: its notes can still be live. Every deploy runs with --takedown until then.'
            })
            const again = waits.createEl('button', { text: 'Deploy again' })
            again.disabled = state.deployment?.running === true
            again.addEventListener('click', () => {
                void center.deploy()
            })
        }
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
        this.#renderProposals(queue.proposals)
        const guarded = center.plan()?.guardedAttachments ?? []
        if (guarded.length > 0) {
            const box = this.#section(
                this.#sections,
                'guarded',
                `Notes that lose a file under a guard: ${guarded.length.toLocaleString()} (the next publication deletes the file, and the note shows it as missing)`,
                'vault-publish-moves',
                true
            )
            for (const path of guarded.slice(0, SECTION_LINES)) {
                box.createDiv({ cls: 'vault-publish-name', text: path, attr: { dir: 'auto' } })
            }
            if (guarded.length > SECTION_LINES) {
                box.createDiv({
                    text: `and ${(guarded.length - SECTION_LINES).toLocaleString()} more`
                })
            }
        }
        const edits = center.plan()?.edits ?? []
        if (edits.length > 0) {
            const box = this.#section(
                this.#sections,
                'edits',
                `Edits of the guards since the last publication: ${edits.length.toLocaleString()} (the next publication shows them as published)`,
                'vault-publish-moves'
            )
            for (const event of edits.slice(0, SECTION_LINES)) {
                eventLine(box.createDiv({ cls: 'vault-publish-event' }), event)
            }
            if (edits.length > SECTION_LINES) {
                box.createDiv({
                    text: `and ${(edits.length - SECTION_LINES).toLocaleString()} more`
                })
            }
        }
    }

    /**
     * The open proposals of the edits of the guards (R69): only the author
     * confirms or rejects them, here. A proposal that takes notes off the
     * site opens a dialog that names them first.
     */
    #renderProposals(proposals: readonly EditEvent[]): void {
        if (proposals.length === 0) {
            return
        }
        const { center } = this.host
        const busy = center.state.activity !== 'idle'
        const box = this.#section(
            this.#sections,
            'proposals',
            `Proposals: ${proposals.length.toLocaleString()}. An agent asked for these edits of the guards, and only you decide.`,
            'vault-publish-moves vault-publish-proposals',
            true
        )
        for (const proposal of proposals.slice(0, SECTION_LINES)) {
            const line = box.createDiv({
                cls: 'vault-publish-proposal',
                attr: { 'data-proposal': proposal.id }
            })
            eventLine(line.createSpan({ cls: 'vault-publish-event' }), proposal)
            const actions = line.createSpan({ cls: 'vault-publish-proposal-actions' })
            const confirm = actions.createEl('button', {
                text: 'Confirm',
                attr: {
                    'aria-label': `Confirm: ${ACTION_TEXT[proposal.action]} ${isolated(proposal.path)}`,
                    'data-focus': `confirm\n${proposal.id}`
                }
            })
            confirm.disabled = busy
            confirm.addEventListener('click', () => {
                // Every confirmation opens a dialog, with the entries that the
                // edit takes away computed again now (rule 7).
                void center.reviewProposal(proposal).then((review) => {
                    if (review === undefined) {
                        return
                    }
                    new ConfirmProposalModal(this.app, review, () => {
                        void center.confirmProposal(review)
                    }).open()
                })
            })
            const reject = actions.createEl('button', {
                text: 'Reject',
                attr: {
                    'aria-label': `Reject: ${ACTION_TEXT[proposal.action]} ${isolated(proposal.path)}`,
                    'data-focus': `reject\n${proposal.id}`
                }
            })
            reject.disabled = busy
            reject.addEventListener('click', () => {
                void center.rejectProposal(proposal)
            })
        }
        if (proposals.length > SECTION_LINES) {
            box.createDiv({
                text: `and ${(proposals.length - SECTION_LINES).toLocaleString()} more: decide these first`
            })
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
        if (plan.guardedAttachments.length > 0) {
            const part = parent.createEl('details', { attr: { open: '' } })
            part.createEl('summary', {
                text: `Notes that lose a file under a guard: ${plan.guardedAttachments.length.toLocaleString()} (the publication deletes the file, and the note shows it as missing)`
            })
            for (const path of plan.guardedAttachments.slice(0, 500)) {
                part.createDiv({ cls: 'vault-publish-name', text: path, attr: { dir: 'auto' } })
            }
            if (plan.guardedAttachments.length > 500) {
                part.createDiv({ text: `and ${String(plan.guardedAttachments.length - 500)} more` })
            }
        }
        if (plan.edits.length > 0) {
            const part = parent.createEl('details')
            part.createEl('summary', {
                text: `Edits of the guards: ${plan.edits.length.toLocaleString()}`
            })
            for (const event of plan.edits.slice(0, 500)) {
                eventLine(part.createDiv({ cls: 'vault-publish-event' }), event)
            }
            if (plan.edits.length > 500) {
                part.createDiv({ text: `and ${String(plan.edits.length - 500)} more` })
            }
        }
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
            // The frozen lists of the plan (R71, REN-14).
            const reasons = new Map(dryRun.refreshProblems.map((one) => [one.path, one.message]))
            const lists: [string, readonly string[]][] = [
                [
                    'Lists not refreshed (published as they are in the note now)',
                    dryRun.listsNotRefreshed.map(
                        (path) =>
                            `${path}: ${reasons.get(path) ?? 'the Dataview Serializer did not refresh it'}`
                    )
                ],
                ['Live query blocks (not on the page)', dryRun.liveQueries],
                // The rows that the refresh added can come from any note (ADR 0011).
                [
                    'Lists refreshed by the Dataview Serializer (check their rows)',
                    dryRun.listsRefreshed
                ]
            ]
            for (const [title, items] of lists) {
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
        if (report !== undefined) {
            this.#renderReport(report)
        }
        this.#renderDeployment()
    }

    /** The report of the last run (PUB-43). */
    #renderReport(report: Report): void {
        const { center } = this.host
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

    /**
     * The deploy after the last push (issue 32, PUB-42), after the report:
     * the push, the build and the deploy apart, live with the URL, the
     * warnings, the error, and the whole output of the deploy on demand.
     */
    #renderDeployment(): void {
        const { center } = this.host
        const { deployment } = center.state
        if (deployment === undefined) {
            return
        }
        const panel = this.#panels.createDiv({
            cls: 'vault-publish-panel vault-publish-deployment'
        })
        const head = panel.createDiv({ cls: 'vault-publish-section-title' })
        if (deployment.running) {
            head.createSpan({ text: 'Deploy: it runs. You can go on working.' })
            const stop = head.createEl('button', { text: 'Stop the deploy' })
            stop.addEventListener('click', () => {
                center.stopDeploy()
            })
            return
        }
        const { report, output } = deployment
        head.createSpan({ text: 'Deploy report' })
        const again = head.createEl('button', { text: 'Deploy again' })
        again.addEventListener('click', () => {
            void center.deploy()
        })
        const close = head.createEl('button', { text: 'Close' })
        close.addEventListener('click', () => {
            center.closeDeployment()
        })
        const steps = panel.createDiv()
        steps.createDiv({
            text: `Push: ${report.push === 'ok' ? 'done' : 'none (a deploy again)'}`
        })
        steps.createDiv({ text: `Build: ${report.build}` })
        steps.createDiv({
            text: `Deploy: ${report.deploy}${report.takedown ? ', with --takedown' : ''} (${String(report.uploaded)} files uploaded, ${String(report.deleted)} deleted)`
        })
        const liveLine = steps.createDiv()
        if (report.live && report.url !== undefined) {
            liveLine.createSpan({ text: 'Live: ' })
            liveLine.createEl('a', { text: report.url, href: report.url })
        } else {
            liveLine.setText(
                report.deploy === 'ok'
                    ? 'Live: not yet (the host does not show the new revision yet)'
                    : 'Live: no, the release before stays'
            )
        }
        if (report.error !== undefined) {
            panel.createDiv({ cls: 'vault-publish-error', text: isolateNames(report.error) })
        }
        if (report.warnings.length > 0) {
            const part = panel.createEl('details', { attr: { open: '' } })
            part.createEl('summary', {
                text: `Warnings: ${report.warnings.length.toLocaleString()}`
            })
            for (const warning of report.warnings) {
                part.createDiv({ text: warning })
            }
        }
        if (output !== '') {
            // On demand only: it can name the address of a removed note.
            const part = panel.createEl('details')
            part.createEl('summary', { text: 'Output of the deploy' })
            part.createEl('pre', { cls: 'vault-publish-output', text: output })
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
            text: last === undefined ? 'Run log: empty' : `Run log: ${isolateNames(last.text)}`
        })
        for (const line of [...log].reverse()) {
            this.#log.createDiv({ text: `${line.time} ${isolateNames(line.text)}` })
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

/**
 * The dialog of the confirmation of a proposal (R69, rule 7): the edit, what
 * opens for a looser edit, or the entries that would leave the content store,
 * computed again when the dialog opens, and one button. Escape and the close
 * button of the dialog cancel it.
 */
export class ConfirmProposalModal extends Modal {
    constructor(
        app: App,
        private readonly review: ProposalReview,
        private readonly confirm: () => void
    ) {
        super(app)
    }

    /** A list of vault paths, in full, in a box that scrolls: each path isolated. */
    #paths(paths: readonly string[]): void {
        const list = this.contentEl.createDiv({
            cls: 'vault-publish-moves vault-publish-dialog-list'
        })
        for (const path of paths) {
            list.createDiv({ cls: 'vault-publish-name', text: path, attr: { dir: 'auto' } })
        }
    }

    override onOpen(): void {
        const { proposal, removes, affects } = this.review
        this.setTitle('Confirm this edit of the guards?')
        const { contentEl } = this
        eventLine(contentEl.createEl('p'), proposal)
        if (proposal.action === 'allow') {
            const { opens, candidates } = this.review
            contentEl.createEl('p', {
                text: `${candidates === 1 ? '1 note of this folder becomes a candidate' : `${candidates.toLocaleString()} notes of this folder become candidates`}: ${candidates === 1 ? 'it shows' : 'they show'} in the list New, and a new note is published only when a plan includes it.`
            })
            if (opens.length > 0) {
                contentEl.createEl('p', {
                    text: `${opens.length === 1 ? 'This published note links' : `These ${opens.length.toLocaleString()} published notes link`} to a file of the folder: the next update of ${opens.length === 1 ? 'it' : 'each'}, often a technical update that a plan without paths holds and an agent publishes alone, uploads that file and makes it public:`
                })
                this.#paths(opens)
                contentEl.createEl('p', {
                    text: 'When other published notes link to the folder when you confirm, nothing is applied: open this dialog again.'
                })
            }
            const { inside } = this.review
            if (inside.length > 0) {
                contentEl.createEl('p', {
                    text: `${inside.length === 1 ? 'This note of the folder is' : `These ${inside.length.toLocaleString()} notes of the folder are`} still published (a deny that no publication applied yet): after the allow, ${inside.length === 1 ? 'it stays' : 'they stay'} published, and ${inside.length === 1 ? 'its changes publish' : 'their changes publish'} as for every published note:`
                })
                this.#paths(inside)
            }
        } else if (proposal.action === 'unignore') {
            contentEl.createEl('p', {
                text: 'The note becomes a candidate: it shows in the list New. Nothing is published until a plan includes it.'
            })
        } else if (removes.length === 0 && affects.length === 0) {
            contentEl.createEl('p', {
                text: 'No entry of the content store leaves with this edit now, and no published note loses an attachment.'
            })
        }
        if (removes.length > 0) {
            contentEl.createEl('p', {
                text: `${removes.length === 1 ? 'This entry leaves' : `These ${removes.length.toLocaleString()} entries leave`} the content store at the next publication, as forced removals that no plan can hold. After the next build, the address of a published note answers 404, with no redirect, and the address of an unpublished note goes from 410 to 404:`
            })
            this.#paths(removes)
        }
        if (affects.length > 0) {
            contentEl.createEl('p', {
                text: `${affects.length === 1 ? 'This published note stays, but loses' : `These ${affects.length.toLocaleString()} published notes stay, but lose`} an attachment: the next publication deletes the file from the attachment storage, and the note shows it as missing:`
            })
            this.#paths(affects)
        }
        if (removes.length > 0 || affects.length > 0) {
            contentEl.createEl('p', {
                text: 'When the edit would take other entries or attachments away when you confirm, nothing is applied: open this dialog again.'
            })
        }
        const taken = removes.length + affects.length
        new Setting(contentEl).addButton((button) => {
            button
                .setButtonText(
                    removes.length > 0
                        ? `Confirm: ${removes.length.toLocaleString()} ${removes.length === 1 ? 'entry leaves' : 'entries leave'}`
                        : affects.length > 0
                          ? `Confirm: ${affects.length.toLocaleString()} ${affects.length === 1 ? 'note loses' : 'notes lose'} an attachment`
                          : 'Confirm'
                )
                .setCta()
                .onClick(() => {
                    this.close()
                    this.confirm()
                })
            if (taken > 0) {
                button.setDestructive()
            }
        })
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
