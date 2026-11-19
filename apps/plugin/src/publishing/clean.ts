import { marksOf, withoutProperty } from './frontmatter.ts'

// The cleaning step: a selected note becomes one cleaned note (MOD-03 of the
// spec). The Rust twin is `cli/src/clean.rs`.

/** The version of the cleaning step. A new version makes a technical update of every note (PUB-24). */
export const CLEANING_VERSION = 4

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
    // The property is removed from the text as the vault has it, as the guard
    // and the write read it. The line ends are converted after: a first
    // line `---` with two carriage returns must not open properties here.
    const unmarked = text.slice(marksOf(text).length)
    const source = withoutProperty(unmarked, STATE_PROPERTY).replaceAll('\r\n', '\n')
    // The text below removed properties can start with a mark too.
    return source.slice(marksOf(source).length)
}

/**
 * The cleaned note of a source. It changes nothing: a selected note is
 * published as it is in the vault (ADR 0011). Version 2 resolves the links of
 * the note with no change of its text: the result is the list `links` of the
 * manifest entry (`links.ts`). Version 3 adds the attachments, and version 4
 * the aliases (`aliasesOf`). Later slices remove what is not for rendering.
 */
export function cleanNote(source: string): string {
    return source
}
