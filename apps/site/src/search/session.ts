import type { FullTextHit, FullTextResults, Search } from './engine.ts'
import type { TitleMatch } from './titles.ts'

// What the search page does for each query, without the page (issue 51,
// R63). The titles answer at each key; the full text answers when the reader
// stops typing for a short time, or at once on Enter, and leaves out the
// notes that the titles show. A late answer of an older query is dropped.
// While a new query loads, the old full-text results are marked as old; a
// failure clears them. "More results" adds one step at a time, also when the
// reader taps it twice.

/** What the session shows on the page. */
export interface SearchView {
    showTitles(matches: readonly TitleMatch[]): void
    /** The full-text results: in place of the shown ones, or added to them; `more` when more can load. */
    showText(hits: readonly FullTextHit[], options: { append: boolean; more: boolean }): void
    clearText(): void
    /** True while the shown full-text results belong to an older query. */
    textPending(pending: boolean): void
    /** The message of the live region. */
    say(message: string): void
    /** Writes the query into the address of the page. */
    setQuery(query: string): void
}

/** The clock of the session. */
export interface Timer {
    set(callback: () => void, wait: number): unknown
    clear(handle: unknown): void
}

/** The time without a key before the full text answers. */
export const PAUSE = 250
/** The full-text results per step of "More results". */
export const STEP = 10
/** The fewest characters that the search answers. */
export const SHORTEST_QUERY = 2

const FAILED = 'The search could not load. Check the connection, then try again.'
const FAILED_MORE = 'The next results could not load. Check the connection, then try again.'

const clock: Timer = {
    set: (callback, wait) => setTimeout(callback, wait),
    clear: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
}

function counted(value: number, one: string, many: string): string {
    return `${value.toLocaleString('en')} ${value === 1 ? one : many}`
}

/** The search session of one page. */
export function createSession(
    search: Search,
    view: SearchView,
    timer: Timer = clock
): { type(query: string): void; submit(query: string): void; more(): Promise<void> } {
    /** The number of the newest query: an answer of an older one is dropped. */
    let turn = 0
    let pause: unknown
    let titleCount = 0
    let titlePaths = new Set<string>()
    let text:
        | {
              turn: number
              results: FullTextResults
              /** The first result that no step asked for yet. */
              next: number
              /** The hits that a step asked for and did not show yet. */
              kept: FullTextHit[]
              busy: boolean
          }
        | undefined

    const failed = (mine: number): void => {
        if (mine !== turn) return
        text = undefined
        view.clearText()
        view.textPending(false)
        view.say(FAILED)
    }

    /** Shows the next step of the full text, without the notes that the titles show. */
    const step = async (append: boolean): Promise<void> => {
        const current = text
        if (current === undefined || current.busy) return
        current.busy = true
        // A step that fails leaves the list as it was, so a new tap tries the same results again.
        const before = { next: current.next, kept: [...current.kept] }
        try {
            const added: FullTextHit[] = []
            while (added.length < STEP) {
                if (current.kept.length === 0) {
                    if (current.next >= current.results.total) break
                    // The range is taken before the wait, so no other step asks for it.
                    const from = current.next
                    current.next += STEP
                    const hits = await current.results.hits(from, STEP)
                    if (current.turn !== turn) return
                    current.kept = hits.filter((hit) => !titlePaths.has(hit.path))
                    continue
                }
                added.push(...current.kept.splice(0, STEP - added.length))
            }
            view.showText(added, {
                append,
                more: current.kept.length > 0 || current.next < current.results.total
            })
        } catch (error) {
            current.next = before.next
            current.kept = before.kept
            throw error
        } finally {
            current.busy = false
        }
    }

    const summary = (): void => {
        const total = text?.results.total ?? 0
        if (titleCount === 0 && total === 0) {
            view.say('No note matches.')
            return
        }
        const parts = []
        if (titleCount > 0) parts.push(counted(titleCount, 'title', 'titles'))
        parts.push(`${counted(total, 'note', 'notes')} with these words in the text`)
        view.say(parts.join(', '))
    }

    const fullText = async (query: string, mine: number, titles: Promise<void>): Promise<void> => {
        const results = await search.fullText(query)
        // The titles answer first, so the full text leaves out the notes that they show.
        await titles
        if (mine !== turn) return
        text = { turn: mine, results, next: 0, kept: [], busy: false }
        await step(false)
        if (mine !== turn) return
        view.textPending(false)
        summary()
    }

    const run = (query: string, wait: number): void => {
        turn += 1
        const mine = turn
        timer.clear(pause)
        text = undefined
        view.setQuery(query)
        const trimmed = query.trim()
        if (Array.from(trimmed).length < SHORTEST_QUERY) {
            titleCount = 0
            titlePaths = new Set()
            view.showTitles([])
            view.clearText()
            view.textPending(false)
            view.say(trimmed === '' ? '' : 'Type two letters or more.')
            return
        }
        view.textPending(true)
        const titles = search.titles(query).then(
            (matches) => {
                if (mine !== turn) return
                titleCount = matches.length
                titlePaths = new Set(matches.map((match) => match.path))
                view.showTitles(matches)
            },
            () => {
                // The full text can still answer.
                if (mine !== turn) return
                titleCount = 0
                titlePaths = new Set()
                view.showTitles([])
            }
        )
        pause = timer.set(() => {
            fullText(query, mine, titles).catch(() => {
                failed(mine)
            })
        }, wait)
    }

    return {
        type: (query) => {
            run(query, PAUSE)
        },
        submit: (query) => {
            run(query, 0)
        },
        more: async () => {
            const mine = turn
            try {
                await step(true)
            } catch {
                // The shown results stay, and so does the button.
                if (mine === turn) view.say(FAILED_MORE)
            }
        }
    }
}
