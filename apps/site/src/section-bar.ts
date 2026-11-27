// The "current section" bar of a note page on a small screen (story 8,
// PAGE-04, issue 91). Below the `lg` breakpoint the outline is a folding
// block above the text, out of view once the reader scrolls. The bar, fixed
// under the header, then names the section that the reader is in; a tap on it
// opens the outline and shows it. It is hidden in the HTML: without a script
// it could do nothing, and a fixed bar moves no text when it shows (CLS, R57).
//
// A heading is the current one when its top is at or above the line where a
// link to a heading puts it: the scroll padding of the page, which leaves
// room for the header and the bar (`components.css`).

/** The script of the bar. It is one block, so it declares no global name. */
export const sectionBarScript = `{
    const bar = document.querySelector('[data-section-bar]')
    const text = bar.querySelector('[data-section-bar-text]')
    const fold = document.querySelector('[data-outline="fold"]')
    const wide = matchMedia('(min-width: 64rem)')
    const headings = [...fold.querySelectorAll('a[href^="#"]')]
        .map((link) => [document.getElementById(decodeURIComponent(link.hash.slice(1))), link.textContent.trim()])
        .filter(([heading]) => heading)
    let queued = false
    const update = () => {
        queued = false
        const line = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) + 1
        let current
        for (const [heading, name] of headings) {
            if (heading.getBoundingClientRect().top > line) break
            current = name
        }
        const show = !wide.matches && current !== undefined && fold.getBoundingClientRect().bottom < line
        bar.hidden = !show
        if (show) text.textContent = current
    }
    const queue = () => {
        if (queued) return
        queued = true
        requestAnimationFrame(update)
    }
    addEventListener('scroll', queue, { passive: true })
    addEventListener('resize', queue)
    bar.addEventListener('click', () => {
        fold.open = true
        fold.scrollIntoView({ block: 'start' })
        fold.querySelector('summary').focus({ preventScroll: true })
    })
    update()
}`
