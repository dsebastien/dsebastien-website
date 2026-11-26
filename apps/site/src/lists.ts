import { compareCodePoints } from '../../plugin/src/publishing/order.ts'
import { tagLevels, tagOfText } from './tags.ts'

// The lists of notes of the generated pages (NAV-03, NAV-04, decision R61):
// the type hub of each note type and the page of each tag, 100 notes per
// page, in the order of their titles from A to Z. Each page of a list links
// to every other page of it, so a note is at most three links from the home
// page (NAV-07).

/** The number of notes of a page of a list. */
export const LIST_PAGE_SIZE = 100

/** The fewest notes of a type hub or a tag page that is indexed (IDX-22). */
export const INDEXED_LIST_NOTES = 5

/** The first levels of the tags of the system, whose pages repeat the type hubs: never indexed. */
const SYSTEM_TAGS = new Set(['type', 'zone'])

/**
 * The order of titles for a reader: letters as a reader sorts them, numbers by
 * their value. It comes from the ICU data of the runtime; a test of
 * `lists.spec.ts` pins it on hard titles, so a runtime that sorts in a new way
 * is seen (issue 97).
 */
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** A note in a list: its title and its vault path, which breaks a tie. */
export interface Listed {
    readonly title: string
    readonly vaultPath: string
}

/** The notes from A to Z by their titles, then by their vault paths, the same at each build. */
export function byTitle<T extends Listed>(notes: readonly T[]): T[] {
    return [...notes].sort(
        (one, two) =>
            COLLATOR.compare(one.title, two.title) ||
            compareCodePoints(one.title, two.title) ||
            compareCodePoints(one.vaultPath, two.vaultPath)
    )
}

/** The pages of a list, `LIST_PAGE_SIZE` items each. An empty list has one empty page. */
export function pagesOf<T>(items: readonly T[], size = LIST_PAGE_SIZE): T[][] {
    const pages: T[][] = []
    for (let start = 0; start < items.length; start += size) {
        pages.push(items.slice(start, start + size))
    }
    return pages.length === 0 ? [[]] : pages
}

/**
 * The tags of the text of a note, from the texts of the tag links that its
 * markup writes. A tag has no character that HTML writes as an entity.
 */
function tagsOfMarkup(markup: string): string[] {
    return [...markup.matchAll(/<a class="tag" href="\/-\/tags\/[^"]*">#([^<]+)<\/a>/gu)].map(
        (match) => match[1] ?? ''
    )
}

/**
 * The tags of a note, each with its parent levels: the folded form of each
 * (the key of its page), with the form that the note writes first. They are
 * the tags of its `tags` property and the tags of its text. A note is on the
 * page of each of them, so the page of a tag lists the notes of its nested
 * tags too, as the search of Obsidian does.
 */
export function tagsOfNote(tagsProperty: unknown, markup: string): Map<string, string> {
    const list = Array.isArray(tagsProperty) ? tagsProperty : [tagsProperty]
    const tags = new Map<string, string>()
    const texts = [
        ...list.filter((item): item is string => typeof item === 'string'),
        ...tagsOfMarkup(markup)
    ]
    for (const text of texts) {
        const tag = tagOfText(text)
        if (tag !== undefined) {
            for (const [folded, written] of tagLevels(tag)) {
                if (!tags.has(folded)) {
                    tags.set(folded, written)
                }
            }
        }
    }
    return tags
}

/** The notes of each tag, by the folded form of the tag, the tags in the order of their code points. */
export function notesByTag<T>(
    notes: readonly { note: T; tags: ReadonlyMap<string, string> }[]
): Map<string, T[]> {
    const byTag = new Map<string, T[]>()
    for (const { note, tags } of notes) {
        for (const tag of tags.keys()) {
            const listed = byTag.get(tag)
            if (listed === undefined) {
                byTag.set(tag, [note])
            } else {
                listed.push(note)
            }
        }
    }
    return new Map([...byTag].sort(([one], [two]) => compareCodePoints(one, two)))
}

/** True for a tag of the system (`type/`, `zone/`) or one of their parent levels. */
export function isSystemTag(tag: string): boolean {
    return SYSTEM_TAGS.has(tag.split('/')[0] ?? '')
}

/** True when the page of a tag is indexed: 5 notes or more, and not a tag of the system (IDX-22, R61). */
export function isIndexedTag(tag: string, notes: number): boolean {
    return notes >= INDEXED_LIST_NOTES && !isSystemTag(tag)
}

/**
 * Stops the build when a tag would take the path of a page of another tag:
 * a tag `x/page/2` has the path of page 2 of `x` (decision R61).
 */
export function refuseTagsThatTakePagePaths(tags: Iterable<string>): void {
    for (const tag of tags) {
        if (/(?:^|\/)page\/[1-9][0-9]*$/u.test(tag)) {
            throw new Error(
                `the tag "${tag}" has the path of a page of the tag "${tag.replace(/\/?page\/[0-9]+$/u, '')}": rename the tag`
            )
        }
    }
}

/** The direct child tags of a tag, among the tags of the site. */
export function childTagsOf(tag: string, tags: Iterable<string>): string[] {
    const depth = tag.split('/').length + 1
    return [...tags].filter(
        (candidate) => candidate.startsWith(`${tag}/`) && candidate.split('/').length === depth
    )
}
