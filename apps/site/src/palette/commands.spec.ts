import { describe, expect, test } from 'bun:test'
import { commandsOf, matchCommands, type PageActions, type PageFacts } from './commands.ts'

// The command registry of the palette (SRCH-05, SRCH-07, issue 122): which
// commands a page offers, how a query finds them, and what each one does.

const NOTE: PageFacts = {
    canonical: 'https://notes.dsebastien.net/10+Garden/Rain+barrel',
    notePath: '/10+Garden/Rain+barrel',
    mode: 'dark',
    properties: true
}
const PLAIN: PageFacts = { mode: 'light', properties: false }

/** Actions that record what the commands ask for. */
function recorder(): { actions: PageActions; done: string[] } {
    const done: string[] = []
    return {
        done,
        actions: {
            go: (path, newTab) => done.push(`go ${path}${newTab ? ' (new tab)' : ''}`),
            copy: (text) => {
                done.push(`copy ${text}`)
                return Promise.resolve()
            },
            switchMode: () => done.push('mode'),
            toggleProperties: () => done.push('properties'),
            randomNote: () => Promise.resolve('/20+Library/Seed+catalogue')
        }
    }
}

describe('the commands of a page', () => {
    test('a note page offers every command, the navigation first', () => {
        expect(commandsOf(NOTE).map((command) => command.id)).toEqual([
            'home',
            'search',
            'recent-added',
            'recent-updated',
            'library',
            'random',
            'mode',
            'copy-link',
            'markdown',
            'properties'
        ])
    })

    test('a page that is not a note leaves out the commands of a note', () => {
        expect(commandsOf(PLAIN).map((command) => command.id)).toEqual([
            'home',
            'search',
            'recent-added',
            'recent-updated',
            'library',
            'random',
            'mode'
        ])
        expect(commandsOf({ properties: false }).map((command) => command.id)).not.toContain('mode')
    })

    test('the switch of the mode names the mode that it gives', () => {
        const title = (facts: PageFacts): string | undefined =>
            commandsOf(facts).find((command) => command.id === 'mode')?.title
        expect(title(NOTE)).toBe('Switch to the light mode')
        expect(title(PLAIN)).toBe('Switch to the dark mode')
    })

    test('a command names its key when it has one', () => {
        const properties = commandsOf(NOTE).find((command) => command.id === 'properties')
        expect(properties?.keys).toEqual(['p'])
    })

    test('each command does what it says', async () => {
        const { actions, done } = recorder()
        const messages: (string | undefined)[] = []
        for (const command of commandsOf(NOTE)) {
            messages.push(await command.run(actions, { newTab: false }))
        }
        expect(done).toEqual([
            'go /',
            'go /-/search',
            'go /-/recent/added',
            'go /-/recent/updated',
            'go /-/library',
            'go /20+Library/Seed+catalogue',
            'mode',
            'copy https://notes.dsebastien.net/10+Garden/Rain+barrel',
            'go /-/md/10+Garden/Rain+barrel.md',
            'properties'
        ])
        // Only the copy keeps the palette open, with a message.
        expect(messages.filter((message) => message !== undefined)).toEqual([
            'The link of the page is copied.'
        ])
    })

    test('a command that opens a page can open it in a new tab', async () => {
        const { actions, done } = recorder()
        await commandsOf(NOTE)
            .find((command) => command.id === 'library')
            ?.run(actions, { newTab: true })
        expect(done).toEqual(['go /-/library (new tab)'])
    })

    test('a random note that cannot be found and a copy that fails give a message', async () => {
        const { actions } = recorder()
        const failing: PageActions = {
            ...actions,
            randomNote: () => Promise.resolve(undefined),
            copy: () => Promise.reject(new Error('denied'))
        }
        const run = (id: string): Promise<string | undefined> | undefined =>
            commandsOf(NOTE)
                .find((command) => command.id === id)
                ?.run(failing, { newTab: false }) ?? undefined
        expect(await run('random')).toBe('No note could be picked. Try again.')
        expect(await run('copy-link')).toBe('The link could not be copied.')
    })
})

describe('the commands that a query finds', () => {
    const commands = commandsOf(NOTE)
    const ids = (query: string): string[] =>
        matchCommands(query, commands).map((command) => command.id)

    test('an empty query finds every command, in the order of the registry', () => {
        expect(ids('')).toEqual(commands.map((command) => command.id))
        expect(ids('   ')).toEqual(commands.map((command) => command.id))
    })

    test('each word starts a word of the title or of a keyword, without accents or case', () => {
        expect(ids('home')).toEqual(['home'])
        expect(ids('GO HO')).toEqual(['home'])
        expect(ids('dark')).toEqual(['mode'])
        expect(ids('thème')).toEqual(['mode'])
        expect(ids('copy')).toEqual(['copy-link'])
        expect(ids('recent')).toEqual(['recent-added', 'recent-updated'])
        expect(ids('md')).toEqual(['markdown'])
    })

    test('a word that starts no word finds nothing', () => {
        expect(ids('compost')).toEqual([])
        expect(ids('home compost')).toEqual([])
    })
})
