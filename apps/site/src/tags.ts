import { foldedForm } from '@dsebastien-website/resolver'

// The one reader of the tags of the site (NAV-04, decision R61): the tag
// links of the markup, the tags of the properties panel and the tag pages
// of the lists accept the same tags, so that no tag link leads to a page
// that the lists do not build. The markup uses it: a change of what it
// accepts raises `MARKUP_VERSION` (`rendering/markup.ts`), as does a change of
// `tagPath()`, `foldedForm()` or `smallLetters()` of the resolver.

/**
 * The form of a tag: levels of letters, digits, marks, pictographs,
 * underscores and hyphens, with a slash between two levels. A tag of the
 * text of a note is read by the parser; a tag of the properties is any
 * text, and only this form becomes a link, so no text of a note writes a
 * path of the site.
 */
const TAG =
    /^[\p{L}\p{N}\p{M}\p{Extended_Pictographic}_-]+(?:\/[\p{L}\p{N}\p{M}\p{Extended_Pictographic}_-]+)*$/u

/** A text of digits only, with or without levels: Obsidian reads no such tag. */
const DIGITS_ONLY = /^[\p{Nd}/]+$/u

/** The tag of a text, without its `#`, or `undefined` when the text is no tag that has a page. */
export function tagOfText(text: string): string | undefined {
    const tag = text.trim().replace(/^#/u, '')
    return TAG.test(tag) && !DIGITS_ONLY.test(tag) ? tag : undefined
}

/**
 * A tag and each of its parent levels: the folded form of each level (the
 * key of its page), with the form that the note writes, composed.
 * `Media/Movie` gives `media` with `Media`, and `media/movie` with `Media/Movie`.
 */
export function tagLevels(tag: string): [folded: string, written: string][] {
    const levels = tag.normalize('NFC').split('/')
    return levels.map((_level, index) => {
        const written = levels.slice(0, index + 1).join('/')
        return [foldedForm(written), written]
    })
}
