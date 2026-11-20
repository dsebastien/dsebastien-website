import { smallLetters } from '@dsebastien-website/resolver'
import { compareCodePoints } from '../../plugin/src/publishing/order.ts'
import { PAGE_BUDGET } from './budgets.ts'
import type { LinkContext } from './rendering/backlinks.ts'
import type { Backlink } from './rendering/page.ts'

// The list of the backlinks of a note, as a page shows it (issue 48, PAGE-03).
// The author decided the order (R59): the notes with the newest update first,
// so a reader sees what the author worked on last, then by title. A note page
// holds the first backlinks only, within its budget (R57); a note with more
// has them all on a page of its own.

/** How many backlinks a note page holds, at most (PERF-20). */
export const BACKLINKS_ON_PAGE = PAGE_BUDGET.backlinks

/** A backlink as a page shows it. */
export interface ShownBacklink {
    /** The display title of the note that links. */
    title: string
    /** The canonical path of its page. */
    href: string
    /** The sentence around each of its links. */
    contexts: LinkContext[]
}

/**
 * The backlinks of a note in the order of a page: the newest update first,
 * then the titles with the letter case ignored, then the titles and the paths
 * as they are. Every text is compared by its code points, so two builds of one
 * content store give the same page on every system.
 *
 * @param noteOf the display title of a note and the day of its last update
 * (`2031-03-09`), as its title band shows them
 */
export function backlinkList(
    backlinks: readonly Backlink[],
    noteOf: (vaultPath: string) => { title: string; updated: string }
): ShownBacklink[] {
    return backlinks
        .map((backlink) => {
            const note = noteOf(backlink.vaultPath)
            return { backlink, ...note, small: smallLetters(note.title) }
        })
        .sort(
            (one, two) =>
                compareCodePoints(two.updated, one.updated) ||
                compareCodePoints(one.small, two.small) ||
                compareCodePoints(one.title, two.title) ||
                compareCodePoints(one.backlink.vaultPath, two.backlink.vaultPath)
        )
        .map(({ backlink, title }) => ({
            title,
            href: backlink.path,
            contexts: backlink.contexts
        }))
}
