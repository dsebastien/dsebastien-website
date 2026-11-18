import { marksOf, withoutProperty } from './frontmatter.ts'

// The cleaning step: a selected note becomes one cleaned note (MOD-03 of the
// spec). The Rust twin is `cli/src/clean.rs`.

/** The version of the cleaning step. A new version makes a technical update of every note (PUB-24). */
export const CLEANING_VERSION = 2

/** The property that records in the vault that a note is published. Only the tool writes it. */
export const STATE_PROPERTY = 'public_note'

/**
 * The source of a note: its text in the vault without its byte order marks,
 * with Unix line ends, without the state property and without properties that
 * hold no line. The property is the state in the vault, not content, so a
 * correction of the property never makes a note "changed" (PUB-14), also when
 * the tool had to add the properties to write it.
 */
export function sourceOf(text: string): string {
    const unmarked = text.slice(marksOf(text).length)
    return withoutProperty(unmarked.replaceAll('\r\n', '\n'), STATE_PROPERTY)
}

/**
 * The cleaned note of a source. It changes nothing: a selected note is
 * published as it is in the vault (ADR 0011). Version 2 resolves the links of
 * the note with no change of its text: the result is the list `links` of the
 * manifest entry (`links.ts`). Later slices remove what is not for rendering.
 */
export function cleanNote(source: string): string {
    return source
}
