//! The cleaning step: a selected note becomes one cleaned note (MOD-03 of the
//! spec). The TypeScript twin is `apps/plugin/src/publishing/clean.ts`.

use crate::frontmatter::{without_marks, without_property};

/// The version of the cleaning step. A new version makes a technical update of
/// every note (PUB-24).
pub const CLEANING_VERSION: u64 = 4;

/// The property that records in the vault that a note is published. Only the
/// tool writes it.
pub const STATE_PROPERTY: &str = "public_note";

/// The source of a note: its text in the vault without its byte order marks,
/// with Unix line ends, without the state property and without properties that
/// hold no line. The property is the state in the vault, not content, so a
/// correction of the property never makes a note "changed" (PUB-14), also when
/// the tool had to add the properties to write it.
pub fn source_of(text: &str) -> String {
    // The property is removed from the text as the vault has it, as the guard
    // and the write read it. The line ends are converted after: a first line
    // `---` with two carriage returns must not open properties here.
    let source = without_property(without_marks(text), STATE_PROPERTY).replace("\r\n", "\n");
    // The text below removed properties can start with a mark too.
    without_marks(&source).to_owned()
}

/// The cleaned note of a source. It changes nothing: a selected note is
/// published as it is in the vault (ADR 0011). Version 2 resolves the links of
/// the note with no change of its text: the result is the list `links` of the
/// manifest entry (`links.rs`). Later slices remove what is not for rendering.
pub fn clean_note(source: &str) -> String {
    source.to_owned()
}
