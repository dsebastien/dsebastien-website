//! The root names of the site (`documentation/Canonical Form.md`, section
//! "The root names of the site"). The site answers some names at its root
//! itself, and a note must never take one of them (URL-08, URL-09 of the
//! spec). The TypeScript twin is `apps/plugin/src/publishing/names.ts`.
//! Change both in the same commit.

use std::collections::{BTreeMap, BTreeSet};

use crate::small_letters::small_letters;
use unicode_normalization::UnicodeNormalization;

/// The ends of the names of the files that the site answers at its root.
const RESERVED_ENDS: [&str; 5] = [".html", ".ico", ".json", ".txt", ".xml"];

/// True when a name at the root of the site is reserved: `-` (the prefix of
/// the generated pages), a name that starts with a dot, or the name of a file
/// of the site (`robots.txt`, a sitemap, `llms.txt`, a file of a search
/// engine).
pub fn is_reserved_root_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "-" || lower.starts_with('.') || RESERVED_ENDS.iter().any(|end| lower.ends_with(end))
}

/// The first part of a path: the text before its first slash, or the whole
/// text when it has none.
pub fn first_part(text: &str) -> &str {
    text.split('/').next().unwrap_or(text)
}

/// The folded form of a text: the composed Unicode form, then small letters.
/// Two texts with one folded form are one URL for the resolver.
pub fn folded_form(text: &str) -> String {
    // NFC again: a small letter can make a pair that NFC composes (J and U+030C).
    small_letters(&text.nfc().collect::<String>())
        .nfc()
        .collect()
}

/// The path that Obsidian gives a vault path: what its `normalizePath` does
/// (Obsidian 1.15.1). Each run of slashes and backslashes becomes one slash,
/// the slashes at the two ends go (an empty path is `/`), each no-break space
/// (U+00A0, U+202F) becomes a space, then the composed Unicode form (NFC).
/// Obsidian lists the files of the disk with this path (section "Paths" of
/// the canonical form, issue 110).
pub fn obsidian_path(path: &str) -> String {
    let mut plain = String::with_capacity(path.len());
    for character in path.chars() {
        if character == '/' || character == '\\' {
            if !plain.ends_with('/') {
                plain.push('/');
            }
        } else {
            plain.push(character);
        }
    }
    let trimmed = plain.trim_matches('/');
    let rooted = if trimmed.is_empty() { "/" } else { trimmed };
    rooted
        .chars()
        .map(|character| match character {
            '\u{a0}' | '\u{202f}' => ' ',
            other => other,
        })
        .nfc()
        .collect()
}

/// True when Windows cannot hold the path (decision of the author R82): a
/// part holds one of `<>:"|?*\` or a control character, ends with a dot or a
/// space, or is a reserved name of Windows (`CON`, `NUL`, `CONIN$`, `COM1`,
/// also with spaces after it, and any end). Git cannot write such a path into
/// a copy on Windows, so such a note is never published and no move takes a
/// note to it.
pub fn is_refused_by_windows(path: &str) -> bool {
    let refused = |part: &str| {
        is_changed_by_windows(part)
            || part
                .chars()
                .any(|letter| "<>:\"|?*\\".contains(letter) || u32::from(letter) < 0x20)
    };
    path.split('/').any(refused)
}

/// True when Windows opens another entry for this name of a file or a folder
/// (issue 79): the name ends with a dot or a space, which Windows drops, or it
/// is a reserved name of a device (`CON`, `NUL`, `CONIN$`, `COM1`, also with
/// spaces after it, and any end), which Windows opens as the device. A folder
/// `Private.` would else open the folder `Private`. The vault holds no entry
/// with such a name, on every system, so that both implementations agree.
pub fn is_changed_by_windows(name: &str) -> bool {
    // Spaces after the name still name the device.
    let base = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(' ')
        .to_ascii_lowercase();
    let reserved = ["con", "prn", "aux", "nul", "conin$", "conout$"].contains(&base.as_str())
        || ((base.starts_with("com") || base.starts_with("lpt"))
            && base.chars().count() == 4
            && base
                .chars()
                .last()
                .is_some_and(|last| last.is_ascii_digit() || "\u{b9}\u{b2}\u{b3}".contains(last)));
    reserved || name.ends_with('.') || name.ends_with(' ')
}

/// True when Obsidian gives this vault path another path: any change of the
/// Obsidian path (a no-break space, a backslash, a slash too many, a name that is
/// not in the composed Unicode form). Obsidian, its links and the APIs of its
/// plugins then name another file than the disk.
pub fn is_changed_by_obsidian(path: &str) -> bool {
    obsidian_path(path) != path
}

/// The twins among these paths: each path whose Obsidian path is the Obsidian
/// path of another one, with the first such other path in the order of the
/// code points. Obsidian lists one file for such an Obsidian path, so it can
/// take one twin for the other (decision R72).
pub fn obsidian_twins<'a>(paths: impl IntoIterator<Item = &'a String>) -> BTreeMap<String, String> {
    let mut groups: BTreeMap<String, BTreeSet<&String>> = BTreeMap::new();
    for path in paths {
        groups.entry(obsidian_path(path)).or_default().insert(path);
    }
    let mut twins = BTreeMap::new();
    for group in groups.values().filter(|group| group.len() > 1) {
        for path in group {
            if let Some(other) = group.iter().find(|one| *one != path) {
                twins.insert((*path).clone(), (*other).clone());
            }
        }
    }
    twins
}

#[cfg(test)]
mod tests {
    use super::{
        folded_form, is_changed_by_obsidian, is_changed_by_windows, is_refused_by_windows,
        is_reserved_root_name, obsidian_path, obsidian_twins,
    };
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/names.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/names.json");

    fn cases(kind: &str) -> Vec<Value> {
        let all: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        all[kind]
            .as_array()
            .expect("the cases file has the list")
            .clone()
    }

    fn text<'a>(case: &'a Value, key: &str) -> &'a str {
        case[key].as_str().expect("a case has the text")
    }

    #[test]
    fn finds_the_reserved_root_names_as_the_file_states() {
        let cases = cases("reserved");
        assert!(cases.len() > 10);
        for case in &cases {
            assert_eq!(
                Some(is_reserved_root_name(text(case, "text"))),
                case["reserved"].as_bool(),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn folds_texts_as_the_file_states() {
        let cases = cases("folded");
        assert!(cases.len() > 5);
        for case in &cases {
            assert_eq!(
                Some(folded_form(text(case, "one")) == folded_form(text(case, "two"))),
                case["equal"].as_bool(),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn gives_the_paths_of_obsidian_as_the_file_states() {
        let cases = cases("obsidian");
        assert!(cases.len() > 10);
        for case in &cases {
            let path = text(case, "path");
            assert_eq!(
                obsidian_path(text(case, "text")),
                path,
                "{}",
                text(case, "name")
            );
            assert_eq!(
                is_changed_by_obsidian(text(case, "text")),
                path != text(case, "text"),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn finds_the_names_that_windows_opens_as_another_entry_as_the_file_states() {
        let cases = cases("windowsNames");
        assert!(cases.len() > 10);
        for case in &cases {
            assert_eq!(
                is_changed_by_windows(text(case, "text")),
                case["changed"]
                    .as_bool()
                    .expect("a case says if it is changed"),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn finds_the_paths_that_windows_cannot_hold_as_the_file_states() {
        let cases = cases("windows");
        assert!(cases.len() > 10);
        for case in &cases {
            assert_eq!(
                is_refused_by_windows(text(case, "text")),
                case["refused"]
                    .as_bool()
                    .expect("a case says if it is refused"),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn finds_the_paths_with_one_obsidian_path_as_the_file_states() {
        for case in &cases("twins") {
            let paths: Vec<String> = case["paths"]
                .as_array()
                .expect("a case has paths")
                .iter()
                .map(|path| path.as_str().expect("a path is a text").to_owned())
                .collect();
            let twins = serde_json::to_value(obsidian_twins(&paths)).expect("data");
            assert_eq!(twins, case["twins"], "{}", text(case, "name"));
        }
    }
}
