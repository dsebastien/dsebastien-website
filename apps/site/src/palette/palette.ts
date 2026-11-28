import { createSearch, type ExcerptPart, type FullTextHit, type Search } from '../search/engine.ts'
import { createSession, type SearchView, type Timer } from '../search/session.ts'
import { siteSources } from '../search/site-sources.ts'
import type { TitleMatch } from '../search/titles.ts'
import {
    commandsOf,
    matchCommands,
    type Command,
    type PageActions,
    type PageFacts
} from './commands.ts'
import { elementOf, type PaletteHandle } from './loader.ts'
import { randomNote } from './random.ts'
import { FULL_TEXT, SEARCH_PAGE, TITLES } from './site-paths.ts'

// The command palette (SRCH-05 to SRCH-09, issue 122): one native dialog,
// modal, with a field and a list of results. The search comes first: the
// titles at each key, then the full text after a pause (the session of the
// search page, `search/session.ts`), then the commands of the registry that
// the query finds. With no query the list holds the commands; with `>` in
// front of the query, the commands alone.
//
// The field is a combobox and the list a listbox (the ARIA pattern of a
// combobox with a list): the focus stays in the field, and the selected row
// is its active descendant. The arrows move the selection, Enter opens it
// (Ctrl or Cmd with Enter: in a new tab), the pointer selects a row and a
// click opens it. Escape clears the query, then closes; the dialog gives the
// focus back to the element that opened it. On a phone the dialog fills the
// screen, with the field at the top, so the keyboard never hides it, and a
// close button. Every text of a result goes into the page as text.

/** The palette of a page. */
export interface Palette extends PaletteHandle {
    close(): void
}

/** What the tests give in place of the site and the browser. */
export interface PaletteOptions {
    readonly search?: Search
    readonly actions?: PageActions
    readonly timer?: Timer
}

/** The prefix of a query that asks for the commands alone. */
export const COMMANDS_PREFIX = '>'

type Group = 'titles' | 'text' | 'commands'

const GROUP_LABELS: Readonly<Record<Group, string>> = {
    titles: 'Titles',
    text: 'In the text',
    commands: 'Commands'
}

/** A row of the list. */
interface Row {
    /** The same row keeps its key from one answer to the next, so the selection stays on it. */
    readonly key: string
    readonly group: Group
    readonly title: string
    readonly badge?: string
    readonly under?: string
    readonly excerpt?: readonly ExcerptPart[]
    readonly keys?: readonly string[]
    run(newTab: boolean): Promise<string | undefined> | undefined
}

const FIELD_NAME = 'Search the notes or run a command'

/** An id that no element of the page has. */
function freeId(document: Document, base: string): string {
    let id = base
    for (let number = 2; document.getElementById(id) !== null; number += 1) {
        id = `${base}-${String(number)}`
    }
    return id
}

function element<K extends keyof HTMLElementTagNameMap>(
    document: Document,
    tag: K,
    className: string,
    text?: string
): HTMLElementTagNameMap[K] {
    const made = document.createElement(tag)
    made.className = className
    if (text !== undefined) made.textContent = text
    return made
}

/** The magnifier of the field, as the one of the header. */
function magnifier(document: Document): SVGSVGElement {
    const svg = 'http://www.w3.org/2000/svg'
    const icon = document.createElementNS(svg, 'svg')
    for (const [name, value] of Object.entries({
        'class': 'palette-icon',
        'viewBox': '0 0 24 24',
        'fill': 'none',
        'stroke': 'currentColor',
        'stroke-width': '2',
        'aria-hidden': 'true'
    })) {
        icon.setAttribute(name, value)
    }
    const circle = document.createElementNS(svg, 'circle')
    circle.setAttribute('cx', '11')
    circle.setAttribute('cy', '11')
    circle.setAttribute('r', '7')
    const line = document.createElementNS(svg, 'path')
    line.setAttribute('d', 'm20 20-3.5-3.5')
    icon.append(circle, line)
    return icon
}

/** What the palette reads of the page at each opening. */
function factsOf(document: Document): PageFacts {
    const canonical =
        document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined
    const notePath =
        canonical !== undefined && document.querySelector('[data-note-body]') !== null
            ? new URL(canonical).pathname
            : undefined
    const mode = document.querySelector('[data-mode-switch]')
        ? document.documentElement.dataset['theme'] === 'light'
            ? 'light'
            : 'dark'
        : undefined
    return {
        ...(canonical === undefined ? {} : { canonical }),
        ...(notePath === undefined ? {} : { notePath }),
        ...(mode === undefined ? {} : { mode }),
        properties: document.querySelector('details[data-properties]') !== null
    }
}

/** The actions of the commands in the browser. */
function pageActions(document: Document, sources: Parameters<typeof randomNote>[0]): PageActions {
    return {
        go: (path, newTab) => {
            if (newTab) {
                document.defaultView?.open(path, '_blank', 'noopener')
            } else {
                document.location.assign(path)
            }
        },
        copy: async (text) => {
            const clipboard = document.defaultView?.navigator.clipboard
            if (clipboard === undefined) throw new Error('no clipboard')
            await clipboard.writeText(text)
        },
        switchMode: () => {
            document.querySelector<HTMLElement>('[data-mode-switch]')?.click()
        },
        toggleProperties: () => {
            const panel = document.querySelector<HTMLDetailsElement>('details[data-properties]')
            if (panel === null) return
            panel.open = !panel.open
            if (panel.open) panel.scrollIntoView({ block: 'nearest' })
        },
        randomNote: () => randomNote(sources)
    }
}

function counted(value: number, one: string, many: string): string {
    return `${value.toLocaleString('en')} ${value === 1 ? one : many}`
}

/** Makes the palette of a page. Nothing shows until the first opening. */
export function createPalette(document: Document, options: PaletteOptions = {}): Palette {
    const sources = siteSources(TITLES, FULL_TEXT)
    const search = options.search ?? createSearch(sources)
    const actions = options.actions ?? pageActions(document, sources)

    const dialog = element(document, 'dialog', 'palette')
    dialog.setAttribute('aria-label', 'Search and commands')
    const panel = element(document, 'div', 'palette-panel')
    const bar = element(document, 'div', 'palette-bar')
    const input = element(document, 'input', 'palette-field')
    const listId = freeId(document, 'palette-results')
    Object.entries({
        'type': 'text',
        'role': 'combobox',
        'aria-label': FIELD_NAME,
        'aria-autocomplete': 'list',
        'aria-controls': listId,
        'aria-expanded': 'false',
        'placeholder': 'Search the notes, or type > for the commands',
        'enterkeyhint': 'go',
        'autocomplete': 'off',
        'autocapitalize': 'off',
        'spellcheck': 'false'
    }).forEach(([name, value]) => {
        input.setAttribute(name, value)
    })
    const close = element(document, 'button', 'button-quiet palette-close', 'Close')
    close.type = 'button'
    close.setAttribute('data-palette-close', '')
    bar.append(magnifier(document), input, close)
    const status = element(document, 'p', 'palette-status')
    status.setAttribute('aria-live', 'polite')
    const list = element(document, 'div', 'palette-list')
    list.id = listId
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Results')
    const hints = element(document, 'p', 'palette-hints')
    for (const [keys, text] of [
        [['↑', '↓'], 'to move'],
        [['Enter'], 'to open'],
        [['Esc'], 'to close'],
        [[COMMANDS_PREFIX], 'for the commands alone']
    ] as const) {
        const hint = element(document, 'span', 'palette-hint')
        for (const key of keys) hint.append(element(document, 'kbd', 'key', key))
        hint.append(document.createTextNode(` ${text}`))
        hints.append(hint)
    }
    panel.append(bar, status, list, hints)
    dialog.append(panel)
    const idBase = freeId(document, 'palette-option')

    let opener: HTMLElement | null = null
    let commands: Command[] = []
    let titles: readonly TitleMatch[] = []
    let hits: FullTextHit[] = []
    let said = ''
    /** The message of a command, until the next key. */
    let notice = ''
    let rows: Row[] = []
    let activeKey: string | undefined
    /** True when the reader moved the selection: it stays on its row as the answers come. */
    let chosen = false

    const query = (): string => input.value.trim()
    const commandsOnly = (): boolean => query().startsWith(COMMANDS_PREFIX)

    const goTo = (path: string): Row['run'] => {
        return (newTab) => {
            actions.go(path, newTab)
            return undefined
        }
    }

    const rowsNow = (): Row[] => {
        const commandRows = (text: string): Row[] =>
            matchCommands(text, commands).map((command) => ({
                key: `command ${command.id}`,
                group: 'commands',
                title: command.title,
                ...(command.keys === undefined ? {} : { keys: command.keys }),
                run: (newTab) => command.run(actions, { newTab })
            }))
        if (commandsOnly()) return commandRows(query().slice(COMMANDS_PREFIX.length))
        const text = query()
        if (text === '') return commandRows('')
        const found: Row[] = titles.map((match) => ({
            key: `note ${match.path}`,
            group: 'titles',
            title: match.text,
            ...(match.type === undefined ? {} : { badge: match.type }),
            ...(match.aliasOf === undefined ? {} : { under: `Alias of ${match.aliasOf}` }),
            run: goTo(match.path)
        }))
        for (const hit of hits) {
            found.push({
                key: `note ${hit.path}`,
                group: 'text',
                title: hit.title,
                ...(hit.type === undefined ? {} : { badge: hit.type }),
                excerpt: hit.excerpt,
                run: goTo(hit.path)
            })
        }
        if (Array.from(text).length >= 2) {
            found.push({
                key: 'all results',
                group: 'text',
                title: `All results for “${text}”`,
                run: goTo(`${SEARCH_PAGE}?${new URLSearchParams({ q: text }).toString()}`)
            })
        }
        return [...found, ...commandRows(text)]
    }

    const optionOf = (row: Row, index: number): HTMLElement => {
        const option = element(document, 'div', 'palette-option')
        option.id = `${idBase}-${String(index)}`
        option.setAttribute('role', 'option')
        option.dataset['index'] = String(index)
        const head = element(document, 'span', 'palette-option-head')
        const title = element(document, 'span', 'palette-option-title', row.title)
        title.setAttribute('data-palette-title', '')
        head.append(title)
        if (row.badge !== undefined) head.append(element(document, 'span', 'badge', row.badge))
        for (const key of row.keys ?? []) head.append(element(document, 'kbd', 'key', key))
        option.append(head)
        if (row.under !== undefined) {
            option.append(element(document, 'span', 'palette-option-under', row.under))
        }
        if (row.excerpt !== undefined && row.excerpt.length > 0) {
            const line = element(document, 'span', 'palette-option-under')
            for (const piece of row.excerpt) {
                if (piece.marked) {
                    line.append(element(document, 'mark', '', piece.text))
                } else {
                    line.append(document.createTextNode(piece.text))
                }
            }
            option.append(line)
        }
        return option
    }

    const select = (index: number): void => {
        const options = list.querySelectorAll<HTMLElement>('[role="option"]')
        options.forEach((option, at) => {
            option.setAttribute('aria-selected', String(at === index))
        })
        const chosen = options[index]
        activeKey = rows[index]?.key
        if (chosen === undefined) {
            input.removeAttribute('aria-activedescendant')
            return
        }
        input.setAttribute('aria-activedescendant', chosen.id)
        chosen.scrollIntoView({ block: 'nearest' })
    }

    const render = (): void => {
        rows = rowsNow()
        const groups: HTMLElement[] = []
        let current: { name: Group; box: HTMLElement } | undefined
        rows.forEach((row, index) => {
            if (current?.name !== row.group) {
                const box = element(document, 'div', 'palette-group')
                box.setAttribute('role', 'group')
                const label = element(
                    document,
                    'div',
                    'palette-group-label',
                    GROUP_LABELS[row.group]
                )
                label.id = `${idBase}-${row.group}`
                label.setAttribute('role', 'presentation')
                box.setAttribute('aria-labelledby', label.id)
                box.append(label)
                groups.push(box)
                current = { name: row.group, box }
            }
            current.box.append(optionOf(row, index))
        })
        list.replaceChildren(...groups)
        input.setAttribute('aria-expanded', String(rows.length > 0))
        const kept = chosen ? rows.findIndex((row) => row.key === activeKey) : 0
        select(Math.max(kept, 0))
        const count = rows.length
        const line =
            notice !== ''
                ? notice
                : commandsOnly()
                  ? count === 0
                      ? 'No command matches.'
                      : counted(count, 'command', 'commands')
                  : said
        // The live region speaks at each write: only a new text is written.
        if (status.textContent !== line) status.textContent = line
    }

    const view: SearchView = {
        showTitles(matches) {
            titles = matches
            render()
        },
        showText(found, { append }) {
            hits = append ? [...hits, ...found] : [...found]
            render()
        },
        clearText() {
            hits = []
            render()
        },
        textPending(pending) {
            list.setAttribute('aria-busy', String(pending))
        },
        // The palette has no "More results": the session gives it no shorter announcement.
        say(message) {
            said = message
            render()
        },
        setQuery() {
            // The palette leaves the address of the page as it is.
        }
    }
    const session = createSession(search, view, options.timer)

    const changed = (): void => {
        notice = ''
        chosen = false
        session.type(commandsOnly() ? '' : query())
        render()
    }

    const run = async (row: Row, newTab: boolean): Promise<void> => {
        const message = await row.run(newTab)
        if (message !== undefined) {
            notice = message
            render()
            return
        }
        if (!newTab) palette.close()
    }

    input.addEventListener('input', changed)
    close.addEventListener('click', () => {
        palette.close()
    })
    list.addEventListener('pointermove', (event) => {
        const option = elementOf(event.target)?.closest('[role="option"]')
        const index = Number(option?.getAttribute('data-index') ?? -1)
        if (index >= 0 && rows[index]?.key !== activeKey) {
            chosen = true
            select(index)
        }
    })
    // A press on a row keeps the focus in the field.
    list.addEventListener('mousedown', (event) => {
        event.preventDefault()
    })
    list.addEventListener('click', (event) => {
        const option = elementOf(event.target)?.closest('[role="option"]')
        const row = rows[Number(option?.getAttribute('data-index') ?? -1)]
        if (row !== undefined) void run(row, event.ctrlKey || event.metaKey)
    })
    // A click on the backdrop closes the palette: the panel fills the dialog. A
    // press that starts in the panel (a selection of the field) and ends on the
    // backdrop closes nothing.
    let pressedBackdrop = false
    dialog.addEventListener('pointerdown', (event) => {
        pressedBackdrop = event.target === dialog
    })
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog && pressedBackdrop) palette.close()
        pressedBackdrop = false
    })
    dialog.addEventListener('keydown', (event) => {
        // A key of a composition (an input method) belongs to the field.
        if (event.isComposing) return
        const index = rows.findIndex((row) => row.key === activeKey)
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowUp': {
                event.preventDefault()
                if (rows.length === 0) return
                const step = event.key === 'ArrowDown' ? 1 : -1
                chosen = true
                select((index + step + rows.length) % rows.length)
                return
            }
            case 'Enter': {
                if (event.target !== input) return
                event.preventDefault()
                const row = rows[index]
                if (row !== undefined) void run(row, event.ctrlKey || event.metaKey)
                return
            }
            case 'Escape': {
                event.preventDefault()
                if (input.value !== '') {
                    input.value = ''
                    changed()
                } else {
                    palette.close()
                }
                return
            }
            case 'Tab': {
                // The focus stays in the dialog: the field and the close button.
                event.preventDefault()
                ;(document.activeElement === input ? close : input).focus()
                return
            }
        }
    })
    dialog.addEventListener('close', () => {
        document.documentElement.classList.remove('palette-open')
        if (opener?.isConnected === true) opener.focus()
        opener = null
    })

    const palette: Palette = {
        open(from, typed) {
            if (!dialog.open) {
                opener = from
                commands = commandsOf(factsOf(document))
                if (!dialog.isConnected) document.body.append(dialog)
                input.value = typed
                document.documentElement.classList.add('palette-open')
                dialog.showModal()
                changed()
            }
            input.focus()
            if (typed === '') {
                input.select()
            } else {
                // The text typed while the palette loaded: the next letter adds to it.
                input.setSelectionRange(input.value.length, input.value.length)
            }
        },
        close() {
            if (dialog.open) dialog.close()
        }
    }
    return palette
}
