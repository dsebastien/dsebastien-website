//! The cleaning step: a selected note becomes one cleaned note (MOD-03 of the
//! spec). The TypeScript twin is `apps/plugin/src/publishing/clean.ts`.

use crate::frontmatter::{MARK, without_property};

/// The version of the cleaning step. A new version makes a technical update of
/// every note (PUB-24).
pub const CLEANING_VERSION: u64 = 1;

/// The property that records in the vault that a note is published. Only the
/// tool writes it.
pub const STATE_PROPERTY: &str = "public_note";

/// The source of a note: its text in the vault without its byte order mark,
/// with Unix line ends, without the state property and without properties that
/// hold no line. The property is the state in the vault, not content, so a
/// correction of the property never makes a note "changed" (PUB-14), also when
/// the tool had to add the properties to write it.
pub fn source_of(text: &str) -> String {
    let marked = text.strip_prefix(MARK).unwrap_or(text);
    without_property(&marked.replace("\r\n", "\n"), STATE_PROPERTY)
}

/// The cleaned note of a source. The first version changes nothing: a selected
/// note is published as it is in the vault (ADR 0011). Later slices resolve
/// the links and remove what is not for rendering.
pub fn clean_note(source: &str) -> String {
    source.to_owned()
}
