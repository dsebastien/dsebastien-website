// The anchors of the headings of a note (URL-14 of the spec, decision of the
// author in issue 45).
//
// A heading gets the slug of its text as its id: small letters, the letters,
// digits and marks of every script kept, every other character dropped, a
// hyphen for a run of spaces. A heading whose slug an earlier heading of the
// note has takes the slug of its parent heading first (`autumn-tasks`), then a
// number. So an earlier heading with the same text does not change it.
//
// The current site has no id: it reads the hash as the heading text, in any
// letter case and punctuation, with `+` or `%20` for a space, and
// `#Parent#Child` for a heading under a parent. A link of a note names its
// heading in that form too (`[[Note#Autumn#Tasks]]`). `headingFor` reads it,
// in the build for the links and in the page for an old hash.
//
// The frame of every page (`layouts/Page.astro`) has ids of its own: no id of
// a note takes one of them (issue 88). A heading "Content" takes `content-2`,
// as a repeated slug does. A block id starts with `^`, so it never is an id of
// the frame; an id of raw HTML that is an id of the frame or that the build
// writes, and any repeated id, takes the first free number (issue 124).
//
// The order (`noteIds`): first the ids of the frame and the ids that the build
// writes (footnotes, diagrams, math) are taken; then, in the order of the note, the
// first element of each id of the note (a block id, an id of raw HTML, the
// slug of a heading) takes it; then each repeat takes a free id: a heading
// the slug of its parent first, then the first free number. A number never
// takes an id that the note writes later (`^x`, `^x`, `^x-2` gives `^x-3` to
// the second block).

/** The id of the main element of every page: the target of the skip link. */
export const MAIN_ID = 'content'

/**
 * The ids of the frame of a page, which no id of a note takes. A new fixed id
 * of the frame of a note page (`layouts/Page.astro`, its components, the
 * title band of `pages/-/note/[id].astro`) goes into this set: a test of the
 * built site fails when the frame has an id that the set does not hold.
 */
export const FRAME_IDS: ReadonlySet<string> = new Set([MAIN_ID])

/** A heading of a note: its level, its text and its id. */
export interface Heading {
    readonly depth: number
    readonly text: string
    readonly id: string
}

/** The slug of a text. A text with no letter and no digit gives `section`. */
export function slugOf(text: string): string {
    const slug = text
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
        .trim()
        .replace(/\s+/gu, '-')
    return slug === '' ? 'section' : slug
}

/**
 * An id that is not used yet: the id itself, or the id with the first number
 * from 2 that is free (`notes-2`).
 */
export function freeId(id: string, used: ReadonlySet<string>): string {
    let free = id
    for (let number = 2; used.has(free); number += 1) {
        free = `${id}-${String(number)}`
    }
    return free
}

/** An element of a note that has an id: an id that the note writes, or a heading with no id. */
export type IdOfNote = { readonly id: string } | { readonly depth: number; readonly text: string }

/**
 * The ids of the elements of a note, in their order (see the order above). No
 * id is one of the frame of the page (`FRAME_IDS`) or of `taken`.
 *
 * @param items the ids that the note writes and the headings with no id, in the order of the note
 * @param taken ids that the build writes, which win over an id of the note
 */
export function noteIds(
    items: readonly IdOfNote[],
    taken: ReadonlySet<string> = new Set()
): string[] {
    const used = new Set([...FRAME_IDS, ...taken])
    const parents: { depth: number; slug: string }[] = []
    const wanted = items.map((item) => {
        if ('id' in item) return { id: item.id, parent: undefined }
        while (parents.length > 0 && (parents.at(-1)?.depth ?? 0) >= item.depth) {
            parents.pop()
        }
        const slug = slugOf(item.text)
        const parent = parents.at(-1)?.slug
        parents.push({ depth: item.depth, slug })
        return { id: slug, parent }
    })
    const ids: (string | undefined)[] = wanted.map(({ id }) => {
        if (used.has(id)) return undefined
        used.add(id)
        return id
    })
    return wanted.map(({ id, parent }, index) => {
        const first = ids[index]
        if (first !== undefined) return first
        const free = freeId(parent === undefined ? id : `${parent}-${id}`, used)
        used.add(free)
        return free
    })
}

/**
 * The ids of the headings of a note, in their order: `noteIds` with headings only.
 *
 * @param headings the level and the text of each heading
 * @param taken ids that the note already uses for something else
 */
export function headingIds(
    headings: readonly { depth: number; text: string }[],
    taken: ReadonlySet<string> = new Set()
): string[] {
    return noteIds(headings, taken)
}

/**
 * The heading that a heading path names: the last part is the heading, the
 * parts before it are headings above it, in their order (`Autumn#Tasks`), as
 * Obsidian reads them. Each part is read in any letter case and punctuation,
 * with `+` for a space. The first heading that fits wins.
 *
 * The function holds no reference to anything outside it: the page runs its
 * text for an old hash.
 */
export function headingFor(
    headings: readonly { depth: number; text: string; id: string }[],
    path: string
): string | undefined {
    const plain = (text: string): string =>
        text
            .replace(/\+/gu, ' ')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
            .trim()
    const parts = path
        .split('#')
        .map(plain)
        .filter((part) => part !== '')
    const last = parts.at(-1)
    if (last === undefined) {
        return undefined
    }
    const above = parts.slice(0, -1)
    const stack: { depth: number; text: string }[] = []
    for (const heading of headings) {
        while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= heading.depth) {
            stack.pop()
        }
        if (plain(heading.text) === last) {
            let next = 0
            for (const parent of stack) {
                if (next < above.length && parent.text === above[next]) {
                    next += 1
                }
            }
            if (next === above.length) {
                return heading.id
            }
        }
        stack.push({ depth: heading.depth, text: plain(heading.text) })
    }
    return undefined
}

/**
 * The script of a note page for an old hash: when no element has the id of
 * the hash, it reads the hash as a heading path and goes to that heading. It
 * is one block, so it declares no global name. An id of the frame wins too:
 * the skip link sets the hash `#content`, so that hash stays on the main
 * element. The old form of a heading "Content" is `#Content`, which no element
 * has as its id, so it reaches the heading.
 */
export const oldAnchorScript = `{
    const find = ${headingFor.toString()}
    const go = () => {
        const raw = location.hash.slice(1)
        if (raw === '') return
        let hash = raw
        try {
            hash = decodeURIComponent(raw)
        } catch {}
        if (document.getElementById(hash) !== null) return
        // An anchor of raw HTML of a note: the allow list gives its name a prefix.
        const named = document.getElementsByName('user-content-' + hash)[0]
        if (named !== undefined) {
            named.scrollIntoView()
            return
        }
        const headings = [...document.querySelectorAll('[data-note-title][id], [data-note-body] :is(h1, h2, h3, h4, h5, h6)[id]')].map(
            (element) => ({ depth: Number(element.tagName.slice(1)), text: element.dataset?.heading ?? element.textContent ?? '', id: element.id })
        )
        const id = find(headings, hash)
        const target = id === undefined ? null : document.getElementById(id)
        if (target !== null) {
            history.replaceState(null, '', '#' + encodeURIComponent(id))
            target.scrollIntoView()
        }
    }
    go()
    addEventListener('hashchange', go)
}`
