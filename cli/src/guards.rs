//! The two guards (ADR 0011): a note under a guard is never published,
//! whatever is selected. The TypeScript twin is
//! `apps/plugin/src/publishing/guards.ts`.

use crate::configuration::Configuration;
use crate::frontmatter::property_value;

/// The property that says that the tool must never publish a note.
pub const IGNORE_PROPERTY: &str = "publish_ignore";

#[derive(Debug, PartialEq, Eq)]
pub enum Guard {
    DenyList,
    IgnoreProperty,
}

/// The guard that excludes the note, or `None` when no guard does.
pub fn guard_of(path: &str, text: &str, configuration: &Configuration) -> Option<Guard> {
    // A folder of the deny list covers every file below it.
    let denied = configuration.deny_list.iter().any(|folder| {
        path.strip_prefix(folder.as_str())
            .is_some_and(|rest| rest.starts_with('/'))
    });
    if denied {
        return Some(Guard::DenyList);
    }
    if property_value(text, IGNORE_PROPERTY).is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return Some(Guard::IgnoreProperty);
    }
    None
}
