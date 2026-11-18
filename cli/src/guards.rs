//! The two guards (ADR 0011): a note under a guard is never published,
//! whatever is selected. The TypeScript twin is
//! `apps/plugin/src/publishing/guards.ts`.

use crate::configuration::Configuration;
use crate::frontmatter::names_in_properties;

/// The property that says that the tool must never publish a note.
pub const IGNORE_PROPERTY: &str = "publish_ignore";

#[derive(Debug, PartialEq, Eq)]
pub enum Guard {
    DenyList,
    IgnoreProperty,
}

/// True when the path alone is under a guard: a folder of the deny list covers
/// every file below it.
pub fn in_deny_list(path: &str, configuration: &Configuration) -> bool {
    configuration.deny_list.iter().any(|folder| {
        path.strip_prefix(folder.as_str())
            .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// The guard that excludes the note, or `None` when no guard does.
pub fn guard_of(path: &str, text: &str, configuration: &Configuration) -> Option<Guard> {
    if in_deny_list(path, configuration) {
        return Some(Guard::DenyList);
    }
    // The reading fails closed: every form of the key excludes the note,
    // unless its value is exactly `false`.
    if names_in_properties(text, IGNORE_PROPERTY) {
        return Some(Guard::IgnoreProperty);
    }
    None
}
