import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import type { FullTextHit, Search } from '../search/engine.ts'
import type { Timer } from '../search/session.ts'
import type { TitleMatch } from '../search/titles.ts'
import type { PageActions } from './commands.ts'
import { createPalette, type Palette } from './palette.ts'

// The command palette (SRCH-05 to SRCH-09, issue 122): one dialog with the
// search first (the titles, then the full text) and the commands. A DOM test
// (issue 100, point 10): the opening, the focus, the keys, the mouse, the
// closing, and the roles of a combobox and a listbox. The search is a fake
// and the clock of the full text is driven by the test.

let window: Window
let document: Document

const PAGE = `
    <header><a href="/-/search" data-palette>Search</a><button data-mode-switch>Mode</button></header>
    <main><p id="text" tabindex="-1">Text</p></main>`

const TITLES: Record<string, TitleMatch[]> = {
    co: [
        { text: 'Compost basics', path: '/10+Garden/Compost+basics', type: 'Permanent note' },
        {
            text: 'Compost tea',
            path: '/10+Garden/Compost+tea',
            aliasOf: 'Liquid fertiliser'
        }
    ]
}
const HITS: FullTextHit[] = [
    {
        path: '/10+Garden/Rain+barrel',
        title: 'Rain barrel',
        excerpt: [
            { text: 'Water for the ', marked: false },
            { text: 'compost', marked: true }
        ]
    },
    // A note that the titles show already: the full text leaves it out.
    { path: '/10+Garden/Compost+basics', title: 'Compost basics', excerpt: [] }
]

/** A search that answers at once: titles for queries that start with "co", the full text for "com". */
const search: Search = {
    titles: (query) => Promise.resolve(TITLES[query.slice(0, 2)] ?? []),
    fullText: (query) =>
        Promise.resolve(
            query.startsWith('com')
                ? {
                      total: HITS.length,
                      hits: (from, count) => Promise.resolve(HITS.slice(from, from + count))
                  }
                : { total: 0, hits: () => Promise.resolve([]) }
        )
}

/** A clock that runs its callbacks when the test says. */
function manualTimer(): Timer & { run(): void } {
    let waiting: (() => void)[] = []
    return {
        set: (callback) => {
            waiting.push(callback)
            return waiting.length
        },
        clear: () => undefined,
        run: () => {
            const now = waiting
            waiting = []
            for (const callback of now) callback()
        }
    }
}

let done: string[]
let timer: ReturnType<typeof manualTimer>
let palette: Palette

const actions: PageActions = {
    go: (path, newTab) => done.push(`go ${path}${newTab ? ' (new tab)' : ''}`),
    copy: (text) => {
        done.push(`copy ${text}`)
        return Promise.resolve()
    },
    switchMode: () => done.push('mode'),
    toggleProperties: () => done.push('properties'),
    randomNote: () => Promise.resolve('/20+Library/Seed+catalogue')
}

beforeEach(() => {
    window = new Window({ url: 'https://notes.dsebastien.net/' })
    document = window.document as unknown as Document
    document.body.innerHTML = PAGE
    done = []
    timer = manualTimer()
    palette = createPalette(document, { search, actions, timer })
})

afterEach(async () => {
    await window.happyDOM.close()
})

/** Lets the promises of the fake search settle. */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
}

function dialog(): HTMLDialogElement {
    const element = document.querySelector('dialog')
    if (element === null) throw new Error('no dialog')
    return element
}

function field(): HTMLInputElement {
    const element = dialog().querySelector<HTMLInputElement>('input')
    if (element === null) throw new Error('no field')
    return element
}

function key(init: {
    key: string
    ctrlKey?: boolean
    metaKey?: boolean
    shiftKey?: boolean
}): boolean {
    const target = document.activeElement ?? document.body
    const event = new window.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
    target.dispatchEvent(event as unknown as Event)
    return event.defaultPrevented
}

async function type(text: string): Promise<void> {
    field().value = text
    field().dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event)
    await settle()
}

/** The groups and the options of the list, as the reader sees them. */
function shown(): string[] {
    const lines: string[] = []
    for (const group of dialog().querySelectorAll('[role="group"]')) {
        const label = document.getElementById(group.getAttribute('aria-labelledby') ?? '')
        lines.push(`# ${label?.textContent ?? ''}`)
        for (const option of group.querySelectorAll('[role="option"]')) {
            lines.push(option.querySelector('[data-palette-title]')?.textContent ?? '')
        }
    }
    return lines
}

function active(): string {
    const id = field().getAttribute('aria-activedescendant') ?? ''
    const option = id === '' ? null : document.getElementById(id)
    return option?.querySelector('[data-palette-title]')?.textContent ?? ''
}

function status(): string {
    return dialog().querySelector('[aria-live="polite"]')?.textContent ?? ''
}

describe('the opening (SRCH-08)', () => {
    test('opens a modal dialog with the focus in the field, and the commands of the page', () => {
        document.getElementById('text')?.focus()
        palette.open(document.getElementById('text'), '')

        expect(dialog().open).toBe(true)
        expect(dialog().getAttribute('aria-label')).toBe('Search and commands')
        expect(document.activeElement).toBe(field())
        expect(shown()).toEqual([
            '# Commands',
            'Go to the home page',
            'Go to the search page',
            'Go to the notes added recently',
            'Go to the notes updated recently',
            'Go to the library',
            'Open a random note',
            'Switch to the light mode'
        ])
        expect(active()).toBe('Go to the home page')
    })

    test('the field is a combobox that controls a listbox of options', () => {
        palette.open(null, '')
        const input = field()
        const list = document.getElementById(input.getAttribute('aria-controls') ?? '')

        expect(input.getAttribute('role')).toBe('combobox')
        expect(input.getAttribute('aria-autocomplete')).toBe('list')
        expect(input.getAttribute('aria-expanded')).toBe('true')
        expect(input.getAttribute('aria-label')).toBe('Search the notes or run a command')
        expect(input.getAttribute('enterkeyhint')).toBe('go')
        expect(list?.getAttribute('role')).toBe('listbox')
        const options = [...(list?.querySelectorAll('[role="option"]') ?? [])]
        expect(options.length).toBeGreaterThan(0)
        expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
            'true',
            ...options.slice(1).map(() => 'false')
        ])
    })

    test('the text typed while the palette loaded is in the field and searched', async () => {
        palette.open(null, 'co')
        await settle()
        expect(field().value).toBe('co')
        // The caret goes after the text, so the next letter adds to it.
        expect(field().selectionStart).toBe(2)
        expect(field().selectionEnd).toBe(2)
        expect(shown().slice(0, 3)).toEqual(['# Titles', 'Compost basics', 'Compost tea'])
    })

    test('a second opening keeps one dialog and selects the text of the field', async () => {
        palette.open(null, '')
        await type('compost')
        palette.open(null, '')
        expect(document.querySelectorAll('dialog')).toHaveLength(1)
        expect(field().selectionStart).toBe(0)
        expect(field().selectionEnd).toBe('compost'.length)
    })
})

describe('the results as the reader types (SRCH-01)', () => {
    test('the titles answer at each key, then the full text after the pause, without the notes of the titles', async () => {
        palette.open(null, '')
        await type('com')
        expect(shown()).toEqual([
            '# Titles',
            'Compost basics',
            'Compost tea',
            '# In the text',
            'All results for “com”'
        ])
        expect(active()).toBe('Compost basics')

        timer.run()
        await settle()
        expect(shown()).toEqual([
            '# Titles',
            'Compost basics',
            'Compost tea',
            '# In the text',
            'Rain barrel',
            'All results for “com”'
        ])
        expect(status()).toBe('2 titles, 2 notes with these words in the text')
    })

    test('a row shows the type, the alias and the excerpt, with the words of the query marked', async () => {
        palette.open(null, '')
        await type('com')
        timer.run()
        await settle()
        const rows = [...dialog().querySelectorAll('[role="option"]')]
        expect(rows[0]?.querySelector('.badge')?.textContent).toBe('Permanent note')
        expect(rows[1]?.textContent).toContain('Alias of Liquid fertiliser')
        expect(rows[2]?.querySelector('mark')?.textContent).toBe('compost')
    })

    test('a query of one letter asks for one more, and still finds the commands', async () => {
        palette.open(null, '')
        await type('h')
        expect(status()).toBe('Type two letters or more.')
        expect(shown()).toEqual(['# Commands', 'Go to the home page'])
    })

    test('the commands that the query names come after the notes', async () => {
        palette.open(null, '')
        await type('home')
        timer.run()
        await settle()
        expect(shown()).toEqual([
            '# In the text',
            'All results for “home”',
            '# Commands',
            'Go to the home page'
        ])
    })

    test('`>` in front shows the commands alone', async () => {
        palette.open(null, '')
        await type('>mode')
        timer.run()
        await settle()
        expect(shown()).toEqual(['# Commands', 'Switch to the light mode'])
        expect(status()).toBe('1 command')
    })

    test('nothing that matches says so', async () => {
        palette.open(null, '')
        await type('zz')
        timer.run()
        await settle()
        expect(status()).toBe('No note matches.')
        expect(shown()).toEqual(['# In the text', 'All results for “zz”'])
    })
})

describe('the keys and the mouse in the palette (SRCH-06)', () => {
    test('the arrows move the selection and wrap; the field keeps the focus', async () => {
        palette.open(null, '')
        await type('com')
        timer.run()
        await settle()
        expect(active()).toBe('Compost basics')
        expect(key({ key: 'ArrowDown' })).toBe(true)
        expect(active()).toBe('Compost tea')
        key({ key: 'ArrowDown' })
        key({ key: 'ArrowDown' })
        expect(active()).toBe('All results for “com”')
        key({ key: 'ArrowDown' })
        expect(active()).toBe('Compost basics')
        key({ key: 'ArrowUp' })
        expect(active()).toBe('All results for “com”')
        expect(document.activeElement).toBe(field())
        const selected = dialog().querySelectorAll('[aria-selected="true"]')
        expect(selected).toHaveLength(1)
    })

    test('the selection stays on its row when the full text arrives', async () => {
        palette.open(null, '')
        await type('com')
        key({ key: 'ArrowDown' })
        expect(active()).toBe('Compost tea')
        timer.run()
        await settle()
        expect(active()).toBe('Compost tea')
    })

    test('Enter opens the selected note; Ctrl+Enter opens it in a new tab', async () => {
        palette.open(null, '')
        await type('com')
        key({ key: 'ArrowDown' })
        expect(key({ key: 'Enter', ctrlKey: true })).toBe(true)
        expect(done).toEqual(['go /10+Garden/Compost+tea (new tab)'])
        key({ key: 'Enter' })
        await settle()
        expect(done).toEqual(['go /10+Garden/Compost+tea (new tab)', 'go /10+Garden/Compost+tea'])
        expect(dialog().open).toBe(false)
    })

    test('Enter on "All results" opens the search page with the query', async () => {
        palette.open(null, '')
        await type('rain water')
        timer.run()
        await settle()
        key({ key: 'Enter' })
        await settle()
        expect(done).toEqual(['go /-/search?q=rain+water'])
    })

    test('Enter runs a command; a command with a message keeps the palette open and says it', async () => {
        document.head.innerHTML =
            '<link rel="canonical" href="https://notes.dsebastien.net/10+Garden/Rain+barrel">'
        palette.open(null, '')
        await type('>copy')
        key({ key: 'Enter' })
        await settle()
        expect(done).toEqual(['copy https://notes.dsebastien.net/10+Garden/Rain+barrel'])
        expect(dialog().open).toBe(true)
        expect(status()).toBe('The link of the page is copied.')

        await type('>light')
        key({ key: 'Enter' })
        await settle()
        expect(done.at(-1)).toBe('mode')
        expect(dialog().open).toBe(false)
    })

    test('the pointer selects a row and a click opens it, and the field keeps the focus', async () => {
        palette.open(null, '')
        await type('com')
        const rows = [...dialog().querySelectorAll('[role="option"]')]
        rows[1]?.dispatchEvent(
            new window.MouseEvent('pointermove', { bubbles: true }) as unknown as Event
        )
        expect(active()).toBe('Compost tea')
        const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
        rows[0]?.dispatchEvent(press as unknown as Event)
        expect(press.defaultPrevented).toBe(true)
        ;(rows[0] as HTMLElement | undefined)?.click()
        await settle()
        expect(done).toEqual(['go /10+Garden/Compost+basics'])
    })
})

describe('the closing and the focus', () => {
    test('Escape clears the query first, then closes and gives the focus back', async () => {
        const text = document.getElementById('text')
        text?.focus()
        palette.open(text, '')
        await type('com')

        expect(key({ key: 'Escape' })).toBe(true)
        expect(field().value).toBe('')
        expect(dialog().open).toBe(true)
        expect(shown()[0]).toBe('# Commands')

        key({ key: 'Escape' })
        await settle()
        expect(dialog().open).toBe(false)
        expect(document.activeElement).toBe(text)
    })

    test('the close button closes it, for a phone with no Escape key', async () => {
        const opener = document.querySelector<HTMLElement>('[data-palette]')
        palette.open(opener, '')
        const close = dialog().querySelector<HTMLButtonElement>('[data-palette-close]')
        expect(close?.textContent).toBe('Close')
        close?.click()
        await settle()
        expect(dialog().open).toBe(false)
        expect(document.activeElement).toBe(opener)
    })

    test('a click on the backdrop closes it; a click in the panel or a drag out of it does not', async () => {
        const press = (target: Element): void => {
            target.dispatchEvent(
                new window.MouseEvent('pointerdown', { bubbles: true }) as unknown as Event
            )
        }
        palette.open(null, '')
        const status = dialog().querySelector<HTMLElement>('[aria-live]')
        if (status !== null) press(status)
        status?.click()
        expect(dialog().open).toBe(true)
        // A selection in the field that ends on the backdrop.
        press(field())
        dialog().click()
        expect(dialog().open).toBe(true)
        press(dialog())
        dialog().click()
        await settle()
        expect(dialog().open).toBe(false)
    })

    test('the status line is written only when its text changes', async () => {
        palette.open(null, '')
        await type('h')
        const status = dialog().querySelector('[aria-live]')
        const changes: unknown[] = []
        const observer = new window.MutationObserver((records) => changes.push(...records))
        observer.observe(status as unknown as Parameters<typeof observer.observe>[0], {
            childList: true,
            characterData: true,
            subtree: true
        })
        await type('h')
        await settle()
        observer.disconnect()
        expect(status?.textContent).toBe('Type two letters or more.')
        expect(changes).toEqual([])
    })

    test('Enter in a composition of an input method stays in the field', async () => {
        palette.open(null, '')
        await type('com')
        const event = new window.KeyboardEvent('keydown', {
            key: 'Enter',
            isComposing: true,
            bubbles: true,
            cancelable: true
        })
        field().dispatchEvent(event as unknown as Event)
        await settle()
        expect(event.defaultPrevented).toBe(false)
        expect(done).toEqual([])
    })

    test('a back gesture of a phone (the cancel of the dialog) closes it too', async () => {
        const opener = document.querySelector<HTMLElement>('[data-palette]')
        palette.open(opener, '')
        dialog().dispatchEvent(new window.Event('cancel', { cancelable: true }) as unknown as Event)
        dialog().close()
        await settle()
        expect(document.activeElement).toBe(opener)
    })

    test('Tab keeps the focus in the dialog, between the field and the close button', () => {
        palette.open(null, '')
        const close = dialog().querySelector('[data-palette-close]')
        expect(key({ key: 'Tab' })).toBe(true)
        expect(document.activeElement).toBe(close)
        key({ key: 'Tab' })
        expect(document.activeElement).toBe(field())
        key({ key: 'Tab', shiftKey: true })
        expect(document.activeElement).toBe(close)
    })

    test('a late answer of the search after the closing changes nothing', async () => {
        palette.open(null, '')
        await type('com')
        key({ key: 'Escape' })
        key({ key: 'Escape' })
        timer.run()
        await settle()
        expect(dialog().open).toBe(false)
    })

    test('a new opening starts with an empty query', async () => {
        palette.open(null, '')
        await type('com')
        key({ key: 'Escape' })
        key({ key: 'Escape' })
        palette.open(null, '')
        expect(field().value).toBe('')
        expect(shown()[0]).toBe('# Commands')
    })
})
