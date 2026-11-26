//! The keys that the guards withdrew (issue 120, decision of the author R78, after R45),
//! as `apps/plugin/src/publishing/withdrawn.ts` reads and writes them: a
//! published entry can still list an attachment whose file came under a
//! guard. The tool deletes that file from the attachment folder of its device
//! and writes its key into `withdrawn.json` of the content store, in the
//! commit of each publication, so that every deployment deletes it from the
//! object storage of the host and never uploads it again. The file holds keys
//! only: never a vault path or a name.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::canonical::to_canonical_json;
use crate::json::parse_json;

/// The file of the withdrawn keys in the content store.
pub const WITHDRAWN_FILE: &str = "withdrawn.json";

/// True when the text is a key of the attachment storage: 64 small hexadecimal digits.
fn is_key(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Reads the withdrawn keys from the text of `withdrawn.json`: an object with
/// the one field `keys`, a list of keys, each one time, in the order of the
/// code points, at least one. A content store without the file has none. It
/// fails for any other text: a list that the tool cannot read could put a
/// file under a guard back on the host.
pub fn parse_withdrawn(text: Option<&str>) -> Result<Vec<String>, String> {
    let Some(text) = text else {
        return Ok(Vec::new());
    };
    let value = parse_json(text).map_err(|error| {
        format!(
            "{WITHDRAWN_FILE} of the content store is not JSON: {error}. No run is possible until it is corrected"
        )
    })?;
    let refuse = |why: &str| {
        format!(
            "{WITHDRAWN_FILE} of the content store cannot be read: {why}. No run is possible until it is corrected"
        )
    };
    let Value::Object(object) = value else {
        return Err(refuse("it is not an object"));
    };
    if object.len() != 1 {
        return Err(refuse("its only field is not \"keys\""));
    }
    let Some(keys) = object.get("keys") else {
        return Err(refuse("its only field is not \"keys\""));
    };
    let Some(keys) = keys.as_array().filter(|keys| !keys.is_empty()) else {
        return Err(refuse("\"keys\" is not a list with at least one key"));
    };
    let mut read: Vec<String> = Vec::new();
    for key in keys {
        let Some(key) = key.as_str().filter(|key| is_key(key)) else {
            return Err(refuse(
                "an item of \"keys\" is not a key of the attachment storage",
            ));
        };
        if read.last().is_some_and(|last| last.as_str() >= key) {
            return Err(refuse("the keys are not each one time in their order"));
        }
        read.push(key.to_owned());
    }
    Ok(read)
}

/// The text of `withdrawn.json` with these keys, or `None` when there is
/// none: then the file is removed. A key is ASCII, so the order of its bytes
/// is the order of its code points.
pub fn withdrawn_text(keys: &BTreeSet<String>) -> Option<String> {
    if keys.is_empty() {
        return None;
    }
    let value = json!({ "keys": keys.iter().collect::<Vec<_>>() });
    Some(to_canonical_json(&value).expect("keys have a canonical form"))
}

/// The withdrawn keys after a publication (rule 8 of a publication): the
/// earlier withdrawn keys, and the keys that the guards withdraw in the
/// manifest before and after the run, less every key that a published entry
/// after the run lists from a file under no guard. So a key leaves the list
/// only when a note uses its bytes openly again: a key that no entry lists
/// any more stays, because the release before can still list it.
pub fn withdrawn_keys(
    earlier: &[String],
    guarded_before: &BTreeSet<String>,
    guarded_after: &BTreeSet<String>,
    used_after: &BTreeSet<String>,
) -> BTreeSet<String> {
    earlier
        .iter()
        .chain(guarded_before)
        .chain(guarded_after)
        .filter(|key| !used_after.contains(*key))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/withdrawn.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/cases.json");

    #[test]
    fn reads_the_file_as_the_shared_cases_state() {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let cases = cases["withdrawn"]
            .as_array()
            .expect("the cases file has the list");
        assert!(cases.len() > 6);
        for case in cases {
            let name = case["name"].as_str().expect("a name");
            let text = case["text"].as_str().expect("a text");
            let result = parse_withdrawn(Some(text));
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().expect("a verdict"),
                "{name}"
            );
            if let Err(error) = result {
                assert!(error.contains(WITHDRAWN_FILE), "{name}: {error}");
            }
        }
    }

    #[test]
    fn writes_the_keys_sorted_each_one_time_and_no_file_without_a_key() {
        let one = "1".repeat(64);
        let two = "2".repeat(64);
        let keys: BTreeSet<String> = [two.clone(), one.clone()].into_iter().collect();
        assert_eq!(
            withdrawn_text(&keys).as_deref(),
            Some(format!("{{\n  \"keys\": [\n    \"{one}\",\n    \"{two}\"\n  ]\n}}\n").as_str())
        );
        assert_eq!(withdrawn_text(&BTreeSet::new()), None);
        assert_eq!(
            parse_withdrawn(withdrawn_text(&keys).as_deref()),
            Ok(vec![one, two])
        );
    }

    #[test]
    fn keeps_the_earlier_and_the_guarded_keys_that_no_open_file_uses() {
        let key = |digit: &str| digit.repeat(64);
        let set = |keys: &[String]| keys.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            withdrawn_keys(
                &[key("1"), key("a")],
                &set(&[key("2")]),
                &set(&[key("b")]),
                &set(&[key("a")])
            ),
            set(&[key("1"), key("2"), key("b")])
        );
    }
}
