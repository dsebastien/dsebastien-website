//! The small letters of the canonical form (`documentation/Canonical
//! Form.md`, section "Small letters", issue 73): one table that the Rust
//! logic, the TypeScript logic and the resolver all read, so a new version of
//! Rust or of Bun changes no small letter. Never use `to_lowercase` on a text
//! that a rule compares with the letter case ignored: use `small_letters`. The
//! TypeScript twin is `packages/resolver/src/small-letters.ts`.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// The table, made by `scripts/small-letters.ts`.
const FILE: &str = include_str!("../../packages/resolver/src/small-letters.json");

const CAPITAL_SIGMA: char = '\u{3a3}';

struct Letters {
    table: HashMap<char, String>,
    cased: Vec<(u32, u32)>,
    case_ignorable: Vec<(u32, u32)>,
}

fn ranges(value: &Value) -> Option<Vec<(u32, u32)>> {
    value
        .as_array()?
        .iter()
        .map(|range| {
            let pair = range.as_array()?;
            let first = u32::try_from(pair.first()?.as_u64()?).ok()?;
            let last = u32::try_from(pair.get(1)?.as_u64()?).ok()?;
            Some((first, last))
        })
        .collect()
}

fn read() -> Option<Letters> {
    let file: Value = serde_json::from_str(FILE).ok()?;
    let mut table = HashMap::new();
    for (code, small) in file.get("table")?.as_object()? {
        let letter = char::from_u32(u32::from_str_radix(code, 16).ok()?)?;
        table.insert(letter, small.as_str()?.to_owned());
    }
    Some(Letters {
        table,
        cased: ranges(file.get("cased")?)?,
        case_ignorable: ranges(file.get("caseIgnorable")?)?,
    })
}

fn letters() -> &'static Letters {
    static LETTERS: OnceLock<Letters> = OnceLock::new();
    LETTERS.get_or_init(|| read().expect("the table of small letters is valid"))
}

fn in_ranges(ranges: &[(u32, u32)], letter: char) -> bool {
    let code = u32::from(letter);
    ranges
        .binary_search_by(|&(first, last)| {
            if code < first {
                std::cmp::Ordering::Greater
            } else if code > last {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// True when the capital sigma at `index` is at the end of a word: the rule of
/// the final sigma.
fn is_final_sigma(letters: &Letters, text: &[char], index: usize) -> bool {
    let ignorable = |letter: char| in_ranges(&letters.case_ignorable, letter);
    let cased = |letter: char| in_ranges(&letters.cased, letter);
    let before = text[..index]
        .iter()
        .rev()
        .find(|&&letter| !ignorable(letter));
    if !before.is_some_and(|&letter| cased(letter)) {
        return false;
    }
    let after = text[index + 1..].iter().find(|&&letter| !ignorable(letter));
    !after.is_some_and(|&letter| cased(letter))
}

/// A text in small letters, by the table of the canonical form.
///
/// # Panics
///
/// When the table that the program holds is not valid, which a test checks.
pub fn small_letters(text: &str) -> String {
    let letters = letters();
    let chars: Vec<char> = text.chars().collect();
    let mut result = String::with_capacity(text.len());
    for (index, &letter) in chars.iter().enumerate() {
        if letter == CAPITAL_SIGMA {
            result.push(if is_final_sigma(letters, &chars, index) {
                '\u{3c2}'
            } else {
                '\u{3c3}'
            });
        } else if let Some(small) = letters.table.get(&letter) {
            result.push_str(small);
        } else {
            result.push(letter);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{read, small_letters};

    #[test]
    fn the_table_is_valid_and_gives_each_code_point_its_small_letters() {
        let letters = read().expect("the table is valid");
        assert_eq!(letters.table.len(), 1488);
        for code in 0..=0x0010_FFFF_u32 {
            let Some(letter) = char::from_u32(code) else {
                continue;
            };
            let expected = letters.table.get(&letter).cloned().unwrap_or_else(|| {
                if letter == '\u{3a3}' {
                    "σ".to_owned()
                } else {
                    letter.to_string()
                }
            });
            assert_eq!(small_letters(&letter.to_string()), expected, "U+{code:04X}");
        }
    }

    #[test]
    fn follows_the_rule_of_the_final_sigma_as_javascript() {
        // The values come from toLowerCase of JavaScript (Bun 1.4.4).
        for (text, small) in [
            ("ΟΔΟΣ", "οδος"),
            ("ΟΔΟΣ.md", "οδοσ.md"),
            ("ΣΑ", "σα"),
            ("Σ", "σ"),
            ("ΑΣ ΒΣ", "ας βς"),
            ("ΑΣ'", "ας'"),
            ("ΑΣ'Β", "ασ'β"),
            ("Α\u{301}Σ", "α\u{301}ς"),
            ("1Σ", "1σ"),
        ] {
            assert_eq!(small_letters(text), small, "{text}");
        }
    }

    #[test]
    fn leaves_a_letter_that_a_newer_unicode_makes_small_as_it_is() {
        assert_eq!(small_letters("\u{A7DD}"), "\u{A7DD}");
        assert_eq!(small_letters("Élan"), "élan");
        assert_eq!(small_letters("\u{130}"), "i\u{307}");
    }
}
