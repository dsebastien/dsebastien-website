//! Reading of JSON files of the content store and of the device. The
//! TypeScript twin is `apps/plugin/src/publishing/json.ts`, and both must
//! accept and refuse the same texts. The shared cases are the list `json` of
//! `fixtures/canonical/cases.json`.

use std::collections::HashSet;

use serde_json::Value;

/// The most levels that data has (rule 10 of the data in the canonical form).
const MAX_LEVELS: usize = 64;

/// Checks what `serde_json` does not: a key that is two times in one object
/// (a second key can hide a value that the TypeScript reader takes), and more
/// than 64 levels. A value alone is level 1, and each list or object adds
/// one. The text is valid JSON.
fn check_structure(text: &str) -> Result<(), String> {
    /// An object (with its keys so far) or a list.
    struct Open {
        keys: Option<HashSet<String>>,
        expects_key: bool,
    }
    let too_deep = || format!("the data has more than {MAX_LEVELS} levels");
    let bytes = text.as_bytes();
    let mut open: Vec<Open> = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte == b'"' {
            let mut end = at + 1;
            while end < bytes.len() && bytes[end] != b'"' {
                end += if bytes[end] == b'\\' { 2 } else { 1 };
            }
            let depth = open.len();
            match open.last_mut() {
                Some(Open {
                    keys: Some(keys),
                    expects_key: expects_key @ true,
                }) => {
                    // The text is valid JSON, so the key is one text of JSON.
                    let key: String = serde_json::from_str(&text[at..=end])
                        .map_err(|_| "a key cannot be read".to_owned())?;
                    if !keys.insert(key.clone()) {
                        return Err(format!("the key \"{key}\" is two times in one object"));
                    }
                    *expects_key = false;
                }
                _ if depth >= MAX_LEVELS => return Err(too_deep()),
                _ => {}
            }
            at = end + 1;
            continue;
        }
        match byte {
            b'{' | b'[' => {
                if open.len() >= MAX_LEVELS {
                    return Err(too_deep());
                }
                open.push(Open {
                    keys: (byte == b'{').then(HashSet::new),
                    expects_key: byte == b'{',
                });
            }
            b'}' | b']' => {
                open.pop();
            }
            b',' => {
                if let Some(inside) = open.last_mut()
                    && inside.keys.is_some()
                {
                    inside.expects_key = true;
                }
            }
            b':' | b' ' | b'\t' | b'\n' | b'\r' => {}
            // The start of a number, or of `true`, `false` or `null`.
            _ if open.len() >= MAX_LEVELS => return Err(too_deep()),
            _ => {}
        }
        at += 1;
    }
    Ok(())
}

/// Reads a JSON text. A number is read as the nearest floating point number,
/// as in TypeScript (the feature `float_roundtrip` of `serde_json`).
///
/// # Errors
///
/// The text is not JSON, or it has a form that the two readers would read in
/// other ways: a text with half of a surrogate pair, a number too large to
/// hold, a key that is two times in one object, or more than 64 levels.
pub fn parse_json(text: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    check_structure(text)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::parse_json;
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/json.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/cases.json");

    #[test]
    fn reads_a_json_file_as_the_file_states() {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let cases = cases["json"]
            .as_array()
            .expect("the cases file has the list");
        assert!(cases.len() > 10);
        for case in cases {
            assert_eq!(
                Some(parse_json(case["text"].as_str().expect("a text")).is_ok()),
                case["valid"].as_bool(),
                "{}",
                case["name"]
            );
        }
    }
}
