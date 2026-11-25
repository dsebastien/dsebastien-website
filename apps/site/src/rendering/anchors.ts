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
// The frame of every page (`layouts/Page.astro`) has ids of its own: a heading
// never takes one of them (issue 88). A heading "Content" takes `content-2`,
// as a repeated slug does.

/** The id of the main element of every page: the target of the skip link. */
export const MAIN_ID = 'content'

/** The ids of the frame of a page, which no heading of a note takes. */
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
 * The ids of the headings of a note, in their order. No id is one of the
 * frame of the page (`FRAME_IDS`).
 *
 * @param headings the level and the text of each heading
 * @param taken ids that the note already uses for something else
 */
export function headingIds(
    headings: readonly { depth: number; text: string }[],
    taken: ReadonlySet<string> = new Set()
): string[] {
    const used = new Set([...FRAME_IDS, ...taken])
    const ids: string[] = []
    const parents: { depth: number; slug: string }[] = []
    for (const heading of headings) {
        while (parents.length > 0 && (parents.at(-1)?.depth ?? 0) >= heading.depth) {
            parents.pop()
        }
        const slug = slugOf(heading.text)
        const parent = parents.at(-1)
        let id = slug
        if (used.has(id) && parent !== undefined) {
            id = `${parent.slug}-${slug}`
        }
        const base = id
        for (let number = 2; used.has(id); number += 1) {
            id = `${base}-${String(number)}`
        }
        used.add(id)
        ids.push(id)
        parents.push({ depth: heading.depth, slug })
    }
    return ids
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
 * is one block, so it declares no global name.
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
