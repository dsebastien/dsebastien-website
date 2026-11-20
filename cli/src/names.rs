//! The root names of the site (`documentation/Canonical Form.md`, section
//! "The root names of the site"). The site answers some names at its root
//! itself, and a note must never take one of them (URL-08, URL-09 of the
//! spec). The TypeScript twin is `apps/plugin/src/publishing/names.ts`.
//! Change both in the same commit.

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

#[cfg(test)]
mod tests {
    use super::{folded_form, is_reserved_root_name};
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
}
