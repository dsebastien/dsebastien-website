//! The canonical form of data (`documentation/Canonical Form.md`).
//!
//! The parity rule compares the output of this implementation with the output
//! of the TypeScript implementation (`apps/plugin/src/publishing/canonical.ts`)
//! byte by byte, so every rule here exists there too. Change both in the same
//! commit.

use std::fmt;

use serde_json::Value;

/// The largest whole number that the TypeScript implementation holds exactly.
const LARGEST_EXACT: u64 = 9_007_199_254_740_991;

/// A value that has no canonical form, and where it is.
#[derive(Debug, PartialEq, Eq)]
pub struct NotCanonical(String);

impl fmt::Display for NotCanonical {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for NotCanonical {}

fn check(value: &Value, place: &str) -> Result<(), NotCanonical> {
    match value {
        Value::Null => Err(NotCanonical(format!("{place}: null has no canonical form"))),
        Value::Bool(_) | Value::String(_) => Ok(()),
        Value::Number(number) => {
            let exact = number
                .as_u64()
                .or_else(|| number.as_i64().map(i64::unsigned_abs))
                .is_some_and(|size| size <= LARGEST_EXACT);
            if exact {
                Ok(())
            } else {
                Err(NotCanonical(format!(
                    "{place}: {number} is not a whole number that is exact"
                )))
            }
        }
        Value::Array(items) => items
            .iter()
            .enumerate()
            .try_for_each(|(index, item)| check(item, &format!("{place}[{index}]"))),
        Value::Object(members) => members.iter().try_for_each(|(key, member)| {
            // Keys are plain ASCII, so that both implementations sort them in
            // the same order.
            if key.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
                check(member, &format!("{place}.{key}"))
            } else {
                Err(NotCanonical(format!(
                    "{place}: the key {key:?} is not plain ASCII"
                )))
            }
        }),
    }
}

/// Writes data in the canonical form: JSON with two spaces per level, the keys
/// of each object sorted, and one line end at the end.
///
/// The keys are sorted because `serde_json` keeps the members of an object in
/// a sorted map. The feature `preserve_order` of that crate must stay off: the
/// shared cases fail when a dependency switches it on.
///
/// # Errors
///
/// A value has no canonical form when it holds `null`, a number with a
/// fraction or too large to be exact, or a key outside ASCII.
pub fn to_canonical_json(value: &Value) -> Result<String, NotCanonical> {
    check(value, "value")?;
    let mut text = serde_json::to_string_pretty(value)
        .map_err(|error| NotCanonical(format!("value: {error}")))?;
    text.push('\n');
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::to_canonical_json;
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/canonical.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/cases.json");

    fn list<'a>(cases: &'a Value, name: &str) -> &'a Vec<Value> {
        cases[name].as_array().expect("the cases file has the list")
    }

    #[test]
    fn writes_each_shared_case_as_the_file_states() {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let cases = list(&cases, "cases");

        assert!(cases.len() > 5);
        for case in cases {
            let name = case["name"].as_str().expect("a case has a name");
            let expected = case["canonical"].as_str().expect("a case has a text");
            assert_eq!(
                to_canonical_json(&case["value"]).as_deref(),
                Ok(expected),
                "{name}"
            );
        }
    }

    #[test]
    fn refuses_each_shared_value_that_has_no_canonical_form() {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let refused = list(&cases, "refused");

        assert!(refused.len() >= 4);
        for case in refused {
            let name = case["name"].as_str().expect("a case has a name");
            assert!(to_canonical_json(&case["value"]).is_err(), "{name}");
        }
    }

    #[test]
    fn refuses_a_number_that_is_too_large_to_be_exact() {
        let value: Value = serde_json::from_str("9007199254740992").expect("the text is JSON");

        assert!(to_canonical_json(&value).is_err());
    }
}
