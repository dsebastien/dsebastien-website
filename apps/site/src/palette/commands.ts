import { PROPERTIES_SHORTCUT } from '../properties-panel.ts'
import { foldedWords } from '../search/titles.ts'
import {
    HOME,
    LIBRARY,
    markdownOf,
    RECENT_ADDED,
    RECENT_UPDATED,
    SEARCH_PAGE
} from './site-paths.ts'

// The command registry (SRCH-05, SRCH-07, issue 122): the one list of the
// commands of the palette, with the facts of the page that decide which ones
// it offers, and the key of a command that has one. Each command does its
// work through `PageActions`, so a test runs it without a browser. The first
// set: the features that the site has today.

/** What the palette knows of the page that it opens on. */
export interface PageFacts {
    /** The canonical URL of the page, when it has one. */
    readonly canonical?: string
    /** The canonical path of the note, on a note page. */
    readonly notePath?: string
    /** The mode of the page, when the page has the switch of the mode. */
    readonly mode?: 'dark' | 'light'
    /** True when the page has the properties panel of a note. */
    readonly properties: boolean
}

/** What a command can do on the page. */
export interface PageActions {
    /** Opens a path of the site, in this tab or in a new one. */
    go(path: string, newTab: boolean): void
    /** Writes a text into the clipboard. */
    copy(text: string): Promise<void>
    switchMode(): void
    toggleProperties(): void
    /** The canonical path of a published note, picked by chance; `undefined` when none could be. */
    randomNote(): Promise<string | undefined>
}

/** A command of the palette. */
export interface Command {
    readonly id: string
    readonly title: string
    /** More words that find the command. */
    readonly keywords: readonly string[]
    /** The key that runs the command outside the palette, when it has one. */
    readonly keys?: readonly string[]
    /**
     * Runs the command. A message keeps the palette open and says it; with
     * no message the palette closes.
     */
    run(actions: PageActions, options: { newTab: boolean }): Promise<string | undefined> | undefined
}

/** A command that opens a path of the site. */
function page(id: string, title: string, path: string, keywords: readonly string[]): Command {
    return {
        id,
        title,
        keywords,
        run: (actions, { newTab }) => {
            actions.go(path, newTab)
            return undefined
        }
    }
}

/** The commands that this page offers, in the order of the palette: the navigation first. */
export function commandsOf(facts: PageFacts): Command[] {
    const commands: Command[] = [
        page('home', 'Go to the home page', HOME, ['start']),
        page('search', 'Go to the search page', SEARCH_PAGE, ['find', 'full', 'text']),
        page('recent-added', 'Go to the notes added recently', RECENT_ADDED, ['new', 'latest']),
        page('recent-updated', 'Go to the notes updated recently', RECENT_UPDATED, [
            'changed',
            'latest'
        ]),
        page('library', 'Go to the library', LIBRARY, ['books', 'media', 'films']),
        {
            id: 'random',
            title: 'Open a random note',
            keywords: ['chance', 'surprise', 'discover'],
            run: async (actions, { newTab }) => {
                const path = await actions.randomNote()
                if (path === undefined) return 'No note could be picked. Try again.'
                actions.go(path, newTab)
                return undefined
            }
        }
    ]
    if (facts.mode !== undefined) {
        commands.push({
            id: 'mode',
            title: facts.mode === 'dark' ? 'Switch to the light mode' : 'Switch to the dark mode',
            keywords: ['theme', 'dark', 'light', 'colors'],
            run: (actions) => {
                actions.switchMode()
                return undefined
            }
        })
    }
    const { canonical, notePath } = facts
    if (canonical !== undefined) {
        commands.push({
            id: 'copy-link',
            title: 'Copy the link of this page',
            keywords: ['address', 'url', 'share'],
            run: async (actions) => {
                try {
                    await actions.copy(canonical)
                    return 'The link of the page is copied.'
                } catch {
                    return 'The link could not be copied.'
                }
            }
        })
    }
    if (notePath !== undefined) {
        commands.push(
            page('markdown', 'Open the Markdown of this note', markdownOf(notePath), [
                'md',
                'source',
                'text'
            ])
        )
    }
    if (facts.properties) {
        commands.push({
            id: 'properties',
            title: 'Show or hide the properties of this note',
            keywords: ['metadata', 'tags'],
            keys: [PROPERTIES_SHORTCUT],
            run: (actions) => {
                actions.toggleProperties()
                return undefined
            }
        })
    }
    return commands
}

/**
 * The commands that a query finds, in the order of the registry: each word
 * of the query starts a word of the title or of a keyword, without accents
 * or case. An empty query finds them all.
 */
export function matchCommands(query: string, commands: readonly Command[]): Command[] {
    const words = foldedWords(query)
    return commands.filter((command) => {
        const own = foldedWords([command.title, ...command.keywords].join(' '))
        return words.every((word) => own.some((part) => part.startsWith(word)))
    })
}
