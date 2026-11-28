import { createSearch, type FullTextHit } from './engine.ts'
import { createSession, type SearchView } from './session.ts'
import { siteSources } from './site-sources.ts'
import type { TitleMatch } from './titles.ts'

// The script of the search page (SRCH-01, SRCH-02, decision R63): the page
// part of the search. `session.ts` decides what shows for each query; this
// module reads the files of the site and writes the results into the page.
// Every text of a result goes into the page as text, never as HTML.

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

/**
 * A row of a list of results. The link holds the title only, so its name
 * stays short; it covers the whole row (`search-result-link`), so a finger
 * can tap any part of it. The badge and the line under it are text of the row.
 */
function resultRow(
    document: Document,
    path: string,
    title: string,
    type: string | undefined,
    under: HTMLElement | undefined
): HTMLLIElement {
    const item = document.createElement('li')
    item.className = 'search-result'
    const head = document.createElement('span')
    head.className = 'flex flex-wrap items-baseline gap-x-3 gap-y-1'
    const link = document.createElement('a')
    link.className = 'search-result-link font-semibold break-words'
    link.href = path
    link.textContent = title
    head.append(link)
    if (type !== undefined) {
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = type
        head.append(badge)
    }
    item.append(head)
    if (under !== undefined) {
        item.append(under)
    }
    return item
}

function titleRow(document: Document, match: TitleMatch): HTMLLIElement {
    let under: HTMLElement | undefined
    if (match.aliasOf !== undefined) {
        under = document.createElement('span')
        under.className = 'mt-1 block text-sm text-muted'
        under.textContent = `Alias of ${match.aliasOf}`
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
    // The kinds of the elements come from the window of the page, so a test runs the page in its own DOM.
    const window = document.defaultView
    if (window === null) {
        throw new Error('the search page has no window')
    }
    const form = part(document, '[data-search-form]', window.HTMLFormElement)
    const input = part(document, '[data-search-input]', window.HTMLInputElement)
    const status = part(document, '[data-search-status]', window.HTMLElement)
    const announcer = part(document, '[data-search-announce]', window.HTMLElement)
    const titlesBlock = part(document, '[data-search-titles]', window.HTMLElement)
    const titlesList = part(titlesBlock, '[data-search-list]', window.HTMLElement)
    const textBlock = part(document, '[data-search-text]', window.HTMLElement)
    const textList = part(textBlock, '[data-search-list]', window.HTMLElement)
    const more = part(textBlock, '[data-search-more]', window.HTMLButtonElement)
    const updating = part(textBlock, '[data-search-updating]', window.HTMLElement)

    const view: SearchView = {
        showTitles(matches) {
            titlesList.replaceChildren(...matches.map((match) => titleRow(document, match)))
            titlesBlock.hidden = matches.length === 0
        },
        showText(hits, { append, more: hasMore }) {
            const rows = hits.map((hit) => textRow(document, hit))
            const moved = append && document.activeElement === more
            if (append) {
                textList.append(...rows)
            } else {
                textList.replaceChildren(...rows)
            }
            textBlock.hidden = textList.childElementCount === 0
            more.hidden = !hasMore
            // A reader who tapped "More results" goes on with the first new
            // result, or with the last one when the step added none.
            if (moved) {
                const links = textList.querySelectorAll('a')
                ;(rows[0]?.querySelector('a') ?? links[links.length - 1])?.focus()
            }
        },
        clearText() {
            textList.replaceChildren()
            textBlock.hidden = true
            more.hidden = true
        },
        textPending(pending) {
            // The old results stay readable, with a mark that new ones come.
            updating.hidden = !pending
            textBlock.setAttribute('aria-busy', String(pending))
            if (pending) more.hidden = true
        },
        say(message, announcement = message) {
            // The line shows; the hidden live region speaks, one time per change.
            status.textContent = message
            announcer.textContent = announcement
        },
        setQuery(query) {
            const url = new URL(document.location.href)
            if (query.trim() === '') {
                url.searchParams.delete('q')
            } else {
                url.searchParams.set('q', query)
            }
            window.history.replaceState(null, '', url)
        }
    }
    const session = createSession(
        createSearch(siteSources(input.dataset['titles'] ?? '', input.dataset['fullText'] ?? '')),
        view
    )
    // Every input event counts, also while a word is composed: Android
    // keyboards compose each Latin word until the space. The pause of the
    // session holds the full text back while the reader types.
    input.addEventListener('input', () => {
        session.type(input.value)
    })
    form.addEventListener('submit', (event) => {
        event.preventDefault()
        session.submit(input.value)
    })
    more.addEventListener('click', () => {
        void session.more()
    })
    const query = new URL(document.location.href).searchParams.get('q') ?? ''
    if (query !== '') {
        input.value = query
        session.submit(query)
    } else {
        // A reader who arrives with no query types at once (issue 122).
        input.focus()
    }
}
