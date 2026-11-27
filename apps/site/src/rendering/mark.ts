// The marks that the markup of a note holds until the page step resolves
// them at each build (`page.ts`): a link or an embed depends on the state of
// another note, so it cannot be a part of the markup that Astro keeps.

/** The elements that stand for something that the page step resolves. */
export const MARK = {
    /** A link or an embed of a note or of a file: `data-link`, `data-fragment`, `data-embed`. */
    link: 'note-link',
    /** A block of link cards (CARD-01 to CARD-09). */
    cards: 'link-cards',
    /** One link card: `data-url` (and `data-video`) and its title, or a link mark (and `data-label`). */
    card: 'link-card'
} as const

/**
 * The property that marks the footnotes and the links that the build writes
 * before the raw HTML of a note is read (issue 124): the allow list keeps it,
 * and the HTML step drops it.
 */
export const BUILT_MARK = 'dataBuiltMark'

/** A text as the value of an attribute of a mark: plain ASCII, no quote. */
export function encode(text: string): string {
    return encodeURIComponent(text).replaceAll("'", '%27')
}

/** The text of an attribute of a mark, or `undefined` when it cannot be decoded (a mark of raw HTML). */
export function decode(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }
    try {
        return decodeURIComponent(value)
    } catch {
        return undefined
    }
}
