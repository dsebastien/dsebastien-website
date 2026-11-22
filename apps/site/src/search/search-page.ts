import { createSearch, type FullTextHit, type FullTextResults, type Search } from './engine.ts'
import { pagefindEngine } from './full-text.ts'
import { partFile, type TitleMatch, type TitleRow } from './titles.ts'

// The script of the search page (SRCH-01, SRCH-02, decision R63). The titles
// answer at each key, from the title index; the full text answers when the
// reader stops typing for a short time, or at once on Enter. A late answer
// of an older query never replaces the answer of a newer one. Every text of
// a result goes into the page as text, never as HTML.

/** The time without a key before the full text answers. */
const PAUSE = 250
/** The full-text results per step of "More results". */
const STEP = 10
/** The fewest characters that the full text answers. */
const SHORTEST_QUERY = 2

function counted(value: number, one: string, many: string): string {
    return `${value.toLocaleString('en')} ${value === 1 ? one : many}`
}

async function fetchJson(url: string): Promise<unknown> {
    const answer = await fetch(url)
    if (!answer.ok) {
        throw new Error(`${url}: ${String(answer.status)}`)
    }
    return answer.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The search over the files of the site. */
function siteSearch(titles: string, fullText: string): Search {
    return createSearch({
        async keys() {
            const index = await fetchJson(`${titles}.json`)
            if (!isRecord(index) || !isRecord(index['keys'])) {
                throw new Error('the title index has no keys')
            }
            const keys: Record<string, boolean> = {}
            for (const [key, complete] of Object.entries(index['keys'])) {
                keys[key] = complete === true
            }
            return keys
        },
        async part(key) {
            const rows = await fetchJson(`${titles}/${partFile(key)}.json`)
            if (!Array.isArray(rows)) {
                throw new Error(`the part "${key}" of the title index is not a list`)
            }
            return rows.filter(
                (row): row is TitleRow =>
                    Array.isArray(row) &&
                    (row.length === 3 || row.length === 4) &&
                    row.every((cell) => typeof cell === 'string')
            )
        },
        fullText: pagefindEngine(fullText)
    })
}

/** An element of the page, of its kind; the page is broken without it. */
function part<T extends Element>(
    root: ParentNode,
    selector: string,
    kind: abstract new () => T
): T {
    const element = root.querySelector(selector)
    if (!(element instanceof kind)) {
        throw new Error(`the search page has no ${selector}`)
    }
    return element
}

/** A row of a list of results: a link with a title, a type badge and a line under it. */
function resultRow(
    document: Document,
    path: string,
    title: string,
    type: string | undefined,
    under: Node | undefined
): HTMLLIElement {
    const item = document.createElement('li')
    const link = document.createElement('a')
    link.className = 'search-result'
    link.href = path
    const head = document.createElement('span')
    head.className = 'flex flex-wrap items-baseline gap-x-3 gap-y-1'
    const name = document.createElement('span')
    name.className = 'font-semibold break-words'
    name.textContent = title
    head.append(name)
    if (type !== undefined) {
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = type
        head.append(badge)
    }
    link.append(head)
    if (under !== undefined) {
        link.append(under)
    }
    item.append(link)
    return item
}

function titleRow(document: Document, match: TitleMatch): HTMLLIElement {
    let under: Node | undefined
    if (match.aliasOf !== undefined) {
        const line = document.createElement('span')
        line.className = 'mt-1 block text-sm text-muted'
        line.textContent = `Alias of ${match.aliasOf}`
        under = line
    }
    return resultRow(document, match.path, match.text, match.type, under)
}

function textRow(document: Document, hit: FullTextHit): HTMLLIElement {
    const line = document.createElement('span')
    line.className = 'search-excerpt'
    for (const piece of hit.excerpt) {
        if (piece.marked) {
            const mark = document.createElement('mark')
            mark.textContent = piece.text
            line.append(mark)
        } else {
            line.append(document.createTextNode(piece.text))
        }
    }
    return resultRow(document, hit.path, hit.title, hit.type, line)
}

/** Starts the search of the search page. */
export function startSearchPage(document: Document): void {
    const form = part(document, '[data-search-form]', HTMLFormElement)
    const input = part(document, '[data-search-input]', HTMLInputElement)
    const status = part(document, '[data-search-status]', HTMLElement)
    const titlesBlock = part(document, '[data-search-titles]', HTMLElement)
    const titlesList = part(titlesBlock, '[data-search-list]', HTMLElement)
    const textBlock = part(document, '[data-search-text]', HTMLElement)
    const textList = part(textBlock, '[data-search-list]', HTMLElement)
    const more = part(textBlock, '[data-search-more]', HTMLButtonElement)
    const search = siteSearch(input.dataset['titles'] ?? '', input.dataset['fullText'] ?? '')

    /** The number of the newest query: an answer of an older one is dropped. */
    let turn = 0
    let pause: ReturnType<typeof setTimeout> | undefined
    let titleCount = 0
    let shownTitles = new Set<string>()
    let text: { results: FullTextResults; next: number; shown: number } | undefined

    const say = (message: string): void => {
        status.textContent = message
    }
    const failed = (mine: number): void => {
        if (mine === turn) {
            say('The search could not load. Check the connection, then try again.')
        }
    }
    const summary = (): void => {
        if (text === undefined) return
        const total = text.results.total
        if (titleCount === 0 && total === 0) {
            say('No note matches.')
            return
        }
        const parts = []
        if (titleCount > 0) parts.push(counted(titleCount, 'title', 'titles'))
        parts.push(`${counted(total, 'note', 'notes')} with these words in the text`)
        say(parts.join(', '))
    }

    /** Adds the next full-text results, without the notes that the titles show. */
    const showMore = async (mine: number): Promise<void> => {
        if (text === undefined) return
        const added: FullTextHit[] = []
        while (added.length < STEP && text.next < text.results.total) {
            const hits = await text.results.hits(text.next, STEP)
            if (mine !== turn) return
            text.next += STEP
            added.push(...hits.filter((hit) => !shownTitles.has(hit.path)))
        }
        for (const hit of added) textList.append(textRow(document, hit))
        text.shown += added.length
        textBlock.hidden = text.shown === 0
        more.hidden = text.next >= text.results.total
    }

    const runFullText = async (
        query: string,
        mine: number,
        titles: Promise<void>
    ): Promise<void> => {
        const results = await search.fullText(query)
        // The titles answer first, so the full text leaves out the notes that they show.
        await titles
        if (mine !== turn) return
        text = { results, next: 0, shown: 0 }
        textList.replaceChildren()
        await showMore(mine)
        if (mine === turn) summary()
    }

    const run = (query: string, at: 'key' | 'enter'): void => {
        turn += 1
        const mine = turn
        clearTimeout(pause)
        text = undefined
        const url = new URL(document.location.href)
        if (query.trim() === '') {
            url.searchParams.delete('q')
        } else {
            url.searchParams.set('q', query)
        }
        history.replaceState(null, '', url)
        if (query.trim().length < SHORTEST_QUERY) {
            titlesBlock.hidden = true
            textBlock.hidden = true
            say(query.trim() === '' ? '' : 'Type two letters or more.')
            return
        }
        const titles = search.titles(query).then(
            (matches) => {
                if (mine !== turn) return
                titleCount = matches.length
                shownTitles = new Set(matches.map((match) => match.path))
                titlesList.replaceChildren(...matches.map((match) => titleRow(document, match)))
                titlesBlock.hidden = matches.length === 0
            },
            () => {
                // The full text can still answer.
                if (mine !== turn) return
                titleCount = 0
                shownTitles = new Set()
                titlesBlock.hidden = true
            }
        )
        pause = setTimeout(
            () => {
                runFullText(query, mine, titles).catch(() => {
                    failed(mine)
                })
            },
            at === 'enter' ? 0 : PAUSE
        )
    }

    input.addEventListener('input', () => {
        run(input.value, 'key')
    })
    form.addEventListener('submit', (event) => {
        event.preventDefault()
        run(input.value, 'enter')
    })
    more.addEventListener('click', () => {
        showMore(turn).catch(() => {
            failed(turn)
        })
    })
    const query = new URL(document.location.href).searchParams.get('q') ?? ''
    if (query !== '') {
        input.value = query
        run(query, 'enter')
    }
}
