import styles from '@dsebastien/music-notation/music-notation.css?url'
import {
    blocksSelector,
    MUSIC_LANGUAGES,
    musicOfBlocks,
    TAB_LANGUAGES,
    type CodeBlock
} from './languages.ts'

// The script of a note page with music blocks (REN-07, PERF-21, issue 53).
// Only such a page has it: the page of the note names it when its body holds
// a music block (`Music.astro`), so a page without music loads no music code.
// It links the style sheet of the library, and draws each block when it comes
// near the screen: the part of the library that the block needs (the
// diagrams or the tabs) loads at the first such block, and the blocks draw one
// at a time, each in a task of its own, so that the page stays responsive on
// a slow phone (the blocking time of PERF-20).

/** The id that the library looks for before it adds its own `<style>` element. */
export const STYLES_ID = 'music-notation-styles'

/** How far from the screen a block starts to draw: one screen above and below. */
export const DRAW_MARGIN = '100% 0px'

/** Draws one block. */
type Drawer = (code: Element) => void | Promise<void>

/** Links the style sheet of the library, one time. */
export function linkStyles(doc: Document): void {
    if (doc.getElementById(STYLES_ID) !== null) return
    const link = doc.createElement('link')
    link.id = STYLES_ID
    link.rel = 'stylesheet'
    link.href = styles
    doc.head.append(link)
}

function blockOf(code: Element): CodeBlock {
    return { classes: [...code.classList], text: code.textContent }
}

/** True when an element is within the margin of `DRAW_MARGIN`: one screen above or below. */
function isNear(element: Element, win: Window): boolean {
    const box = element.getBoundingClientRect()
    return box.top < 2 * win.innerHeight && box.bottom > -win.innerHeight
}

/** Waits for the next task: what the page has to do comes first. */
function nextTask(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Starts the music of the page. */
export function startMusic(doc: Document, win: Window): void {
    const selector = blocksSelector(MUSIC_LANGUAGES)
    const codes = [...doc.querySelectorAll(selector)]
    const { diagrams, tabs } = musicOfBlocks(codes.map(blockOf))
    if (!diagrams && !tabs) return
    linkStyles(doc)
    let diagramPart: Promise<Drawer> | undefined
    let tabPart: Promise<Drawer> | undefined
    const drawerOf = (code: Element): Promise<Drawer> =>
        TAB_LANGUAGES.some((language) => code.classList.contains(`language-${language}`))
            ? (tabPart ??= import('./tabs.ts').then((part) => part.tabDrawer(doc)))
            : (diagramPart ??= import('./diagrams.ts').then((part) => part.diagramDrawer(doc, win)))
    const queue: Element[] = []
    let running = false
    const run = async (): Promise<void> => {
        if (running) return
        running = true
        // In the order of the page: the first block that a reader sees comes first.
        const first = (): Element | undefined =>
            queue
                .sort((one, two) =>
                    one.compareDocumentPosition(two) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
                )
                .shift()
        for (let code = first(); code !== undefined; code = first()) {
            const pre = code.parentElement
            // The blocks drawn before it can have pushed it away from the screen: it waits.
            if (pre !== null && !isNear(pre, win)) {
                near.observe(pre)
                continue
            }
            try {
                const draw = await drawerOf(code)
                await draw(code)
            } catch {
                // A part that cannot load (no network): the source stays, and the next block tries.
                if (pre !== null) pre.dataset['mpRendered'] = 'error'
            }
            await nextTask()
        }
        running = false
    }
    // The source of each block, until it draws: what the observer sees.
    const near = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue
                near.unobserve(entry.target)
                const code = codeOf.get(entry.target)
                if (code !== undefined) queue.push(code)
            }
            void run()
        },
        { rootMargin: DRAW_MARGIN }
    )
    /** The code element of each source that the page watches. */
    const codeOf = new WeakMap<Element, Element>()
    const watch = (code: Element): void => {
        const pre = code.parentElement
        if (pre === null || codeOf.has(pre)) return
        codeOf.set(pre, code)
        near.observe(pre)
    }
    codes.forEach(watch)
    // A fretboard with an exercise writes its tab as a block once it is drawn.
    new MutationObserver(() => {
        doc.querySelectorAll(blocksSelector(TAB_LANGUAGES)).forEach(watch)
    }).observe(doc.body, { childList: true, subtree: true })
}
