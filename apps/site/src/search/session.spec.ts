import { describe, expect, test } from 'bun:test'
import type { FullTextHit, FullTextResults, Search } from './engine.ts'
import { createSession, type SearchView, type Timer } from './session.ts'
import type { TitleMatch } from './titles.ts'

// The behaviour of the search page without the page (issue 51, R63): what it
// shows for each query, in which order, and what it drops. The search and
// the clock are fakes that the test drives.

/** A promise that the test resolves or rejects when it wants. */
function later<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
    let resolve: (value: T) => void = () => undefined
    let reject: (error: Error) => void = () => undefined
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}

/** Lets every settled promise run its callbacks. */
async function settle(): Promise<void> {
    for (let round = 0; round < 10; round += 1) await Promise.resolve()
}

function hit(path: string): FullTextHit {
    return { path, title: path.slice(1), excerpt: [] }
}

function title(path: string): TitleMatch {
    return { text: path.slice(1), path }
}

/** Full-text results over these paths. */
function resultsOf(paths: string[], asked: [number, number][] = []): FullTextResults {
    return {
        total: paths.length,
        hits: (from, count) => {
            asked.push([from, count])
            return Promise.resolve(paths.slice(from, from + count).map(hit))
        }
    }
}

/** A view that records what the session shows. */
function recordingView(): SearchView & { log: string[]; text: string[]; titles: string[] } {
    const view = {
        log: [] as string[],
        text: [] as string[],
        titles: [] as string[],
        showTitles(matches: readonly TitleMatch[]) {
            view.titles = matches.map((match) => match.path)
            view.log.push(`titles ${view.titles.join(',')}`)
        },
        showText(hits: readonly FullTextHit[], options: { append: boolean; more: boolean }) {
            const paths = hits.map((one) => one.path)
            view.text = options.append ? [...view.text, ...paths] : paths
            view.log.push(
                `text ${paths.join(',')}${options.append ? ' (added)' : ''}${options.more ? ' +more' : ''}`
            )
        },
        clearText() {
            view.text = []
            view.log.push('text cleared')
        },
        textPending(pending: boolean) {
            view.log.push(pending ? 'text pending' : 'text current')
        },
        say(message: string) {
            view.log.push(`say ${message}`)
        },
        setQuery(query: string) {
            view.log.push(`query ${query}`)
        }
    }
    return view
}

/** A clock that runs a timer only when the test says so. */
function manualTimer(): Timer & { run(): void; waits: number[] } {
    let next: (() => void) | undefined
    const timer = {
        waits: [] as number[],
        set(callback: () => void, wait: number) {
            timer.waits.push(wait)
            next = callback
            return 1
        },
        clear() {
            next = undefined
        },
        run() {
            const callback = next
            next = undefined
            callback?.()
        }
    }
    return timer
}

function fakeSearch(answers: {
    titles?: (query: string) => Promise<TitleMatch[]>
    fullText?: (query: string) => Promise<FullTextResults>
}): Search {
    return {
        titles: answers.titles ?? (() => Promise.resolve([])),
        fullText: answers.fullText ?? (() => Promise.resolve(resultsOf([])))
    }
}

describe('the search session of the search page', () => {
    test('shows the titles before the full text answers', async () => {
        const text = later<FullTextResults>()
        const view = recordingView()
        const timer = manualTimer()
        const session = createSession(
            fakeSearch({
                titles: () => Promise.resolve([title('/Compost')]),
                fullText: () => text.promise
            }),
            view,
            timer
        )
        session.type('comp')
        await settle()
        expect(view.titles).toEqual(['/Compost'])
        timer.run()
        await settle()
        expect(view.text).toEqual([])
        text.resolve(resultsOf(['/Compost', '/Tea']))
        await settle()
        // The full text leaves out the note that the titles show.
        expect(view.text).toEqual(['/Tea'])
        expect(view.log.at(-1)).toBe('say 1 title, 2 notes with these words in the text')
    })

    test('waits for a pause before the full text, and runs it at once on Enter', async () => {
        const view = recordingView()
        const timer = manualTimer()
        const asked: string[] = []
        const session = createSession(
            fakeSearch({
                fullText: (query) => {
                    asked.push(query)
                    return Promise.resolve(resultsOf(['/A']))
                }
            }),
            view,
            timer
        )
        session.type('co')
        session.type('com')
        session.type('comp')
        timer.run()
        await settle()
        expect(asked).toEqual(['comp'])
        session.submit('compost')
        timer.run()
        await settle()
        expect(timer.waits).toEqual([250, 250, 250, 0])
        expect(asked).toEqual(['comp', 'compost'])
    })

    test('drops a late answer of an older query', async () => {
        const oldTitles = later<TitleMatch[]>()
        const oldText = later<FullTextResults>()
        const view = recordingView()
        const timer = manualTimer()
        const session = createSession(
            fakeSearch({
                titles: (query) =>
                    query === 'co' ? oldTitles.promise : Promise.resolve([title('/Tomato')]),
                fullText: (query) =>
                    query === 'co' ? oldText.promise : Promise.resolve(resultsOf(['/Tomato']))
            }),
            view,
            timer
        )
        session.submit('co')
        timer.run()
        session.submit('tomato')
        timer.run()
        await settle()
        oldTitles.resolve([title('/Compost')])
        oldText.resolve(resultsOf(['/Compost']))
        await settle()
        expect(view.titles).toEqual(['/Tomato'])
        expect(view.text).toEqual([])
        expect(view.log.filter((line) => line.includes('Compost'))).toEqual([])
    })

    test('adds the next results once for two fast taps on "More results"', async () => {
        const paths = Array.from({ length: 35 }, (_, index) => `/n${String(index)}`)
        const asked: [number, number][] = []
        const view = recordingView()
        const timer = manualTimer()
        const session = createSession(
            fakeSearch({ fullText: () => Promise.resolve(resultsOf(paths, asked)) }),
            view,
            timer
        )
        session.submit('note')
        timer.run()
        await settle()
        expect(view.text).toEqual(paths.slice(0, 10))
        const first = session.more()
        const second = session.more()
        await Promise.all([first, second])
        expect(view.text).toEqual(paths.slice(0, 20))
        expect(asked).toEqual([
            [0, 10],
            [10, 10]
        ])
        await session.more()
        await session.more()
        expect(view.text).toEqual(paths)
        expect(view.log.at(-1)).toBe(`text ${paths.slice(30).join(',')} (added)`)
    })

    test('fills a step of 10 results when the titles show some of them', async () => {
        const paths = Array.from({ length: 30 }, (_, index) => `/n${String(index)}`)
        const view = recordingView()
        const timer = manualTimer()
        const session = createSession(
            fakeSearch({
                titles: () => Promise.resolve(paths.slice(0, 4).map(title)),
                fullText: () => Promise.resolve(resultsOf(paths))
            }),
            view,
            timer
        )
        session.submit('note')
        timer.run()
        await settle()
        expect(view.text).toHaveLength(10)
        expect(view.text[0]).toBe('/n4')
    })

    test('marks the old results while a new query loads, and clears them when it fails', async () => {
        const view = recordingView()
        const timer = manualTimer()
        let fail = false
        const session = createSession(
            fakeSearch({
                fullText: () =>
                    fail ? Promise.reject(new Error('offline')) : Promise.resolve(resultsOf(['/A']))
            }),
            view,
            timer
        )
        session.submit('apple')
        timer.run()
        await settle()
        expect(view.text).toEqual(['/A'])
        fail = true
        view.log.length = 0
        session.type('apples')
        expect(view.log).toContain('text pending')
        timer.run()
        await settle()
        expect(view.text).toEqual([])
        expect(view.log.at(-1)).toBe(
            'say The search could not load. Check the connection, then try again.'
        )
    })

    test('asks for two letters, counted as characters, and clears the results for an empty query', () => {
        const view = recordingView()
        const timer = manualTimer()
        const session = createSession(fakeSearch({}), view, timer)
        session.type('🌱')
        expect(view.log.at(-1)).toBe('say Type two letters or more.')
        session.type('')
        expect(view.log.at(-1)).toBe('say ')
        expect(view.titles).toEqual([])
        expect(view.text).toEqual([])
        expect(timer.waits).toEqual([])
    })

    test('says when no note matches, and writes each query into the address', async () => {
        const view = recordingView()
        const timer = manualTimer()
        const session = createSession(fakeSearch({}), view, timer)
        session.submit('zzqx')
        timer.run()
        await settle()
        expect(view.log[0]).toBe('query zzqx')
        expect(view.log.at(-1)).toBe('say No note matches.')
    })
})
