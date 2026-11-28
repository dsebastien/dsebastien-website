import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { startSearchPage } from './search-page.ts'

// The view of the search page in a DOM (issue 100, point 10; issue 122): the
// focus at the arrival. The session under the view has its own tests.

/** The parts of `pages/-/search.astro` that the script reads. */
const PAGE = `
    <form data-search-form>
        <input type="search" name="q" data-search-input data-titles="/nowhere/titles" data-full-text="/nowhere/">
    </form>
    <p data-search-status></p>
    <p aria-live="polite" data-search-announce></p>
    <section data-search-titles hidden><ol data-search-list></ol></section>
    <section data-search-text hidden>
        <span data-search-updating hidden></span>
        <ol data-search-list></ol>
        <button type="button" data-search-more hidden>More results</button>
    </section>`

let window: Window

beforeEach(() => {
    window = new Window({ url: 'https://notes.dsebastien.net/-/search' })
})

afterEach(async () => {
    await window.happyDOM.close()
})

describe('the arrival on the search page', () => {
    test('with no query, the field has the focus, so the reader types at once', () => {
        const document = window.document as unknown as Document
        document.body.innerHTML = PAGE
        startSearchPage(document)
        expect(document.activeElement).toBe(document.querySelector('[data-search-input]'))
    })

    test('with a query, the field holds it and the focus stays where the browser puts it', () => {
        window.happyDOM.setURL('https://notes.dsebastien.net/-/search?q=compost')
        const document = window.document as unknown as Document
        document.body.innerHTML = PAGE
        startSearchPage(document)
        const field = document.querySelector<HTMLInputElement>('[data-search-input]')
        expect(field?.value).toBe('compost')
        expect(document.activeElement).not.toBe(field)
    })
})
