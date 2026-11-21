//! The note type of a note (decision R61, issue 49): the type that the
//! Obsidian Starter Kit plugin of the vault gives it. The rules are in
//! `documentation/Canonical Form.md`, section "The note type of a note". The
//! TypeScript twin is `apps/plugin/src/publishing/note-types.ts`. Change both
//! in the same commit.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use serde::Serialize;
use serde_json::Value;

use crate::json::parse_json;

/// The note type of a note, as the manifest entry and the record of a plan
/// hold it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteType {
    /// The display name of the type in the Starter Kit: `Movies`.
    pub display_name: String,
    /// The canonical name of the type: `movies`, `permanent-notes`.
    pub name: String,
    /// The prefix of the file names of the type, as the Starter Kit gives
    /// it, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    /// The suffix of the file names of the type, as the Starter Kit gives
    /// it, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
}

/// The message of every answer that the tool refuses.
const REFUSED: &str = "the Obsidian Starter Kit gave an answer that the tool cannot read";

/// True when the text is a canonical name of a note type: a small letter,
/// then small letters, digits, `-` and `_`, 64 characters at most.
fn is_canonical_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && name.len() <= 64
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
}

/// A text that is not empty, or `None` for an empty text.
fn affix(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

/// The note type of each path of a question, from the answer of the Starter
/// Kit. A path with no type is not in the result.
///
/// # Errors
///
/// The answer is not the document of the Starter Kit for exactly this
/// question.
pub fn read_note_types(
    question: &[String],
    answer: &Value,
) -> Result<BTreeMap<String, NoteType>, String> {
    let refuse = |why: String| Err(format!("{REFUSED}: {why}"));
    let Some(answer) = answer.as_object() else {
        return refuse("it is not an object".to_owned());
    };
    let (Some(note_types), Some(notes)) = (
        answer.get("noteTypes").and_then(Value::as_array),
        answer.get("notes").and_then(Value::as_array),
    ) else {
        return refuse("it has no list \"noteTypes\" or no list \"notes\"".to_owned());
    };
    let mut definitions: BTreeMap<String, NoteType> = BTreeMap::new();
    for item in note_types {
        let Some(item) = item.as_object() else {
            return refuse("a type is not an object".to_owned());
        };
        let Some(name) = item
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| is_canonical_name(name))
        else {
            return refuse(format!(
                "a type has the name {}",
                item.get("name").unwrap_or(&Value::Null)
            ));
        };
        let Some(display_name) = item
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|display_name| !display_name.is_empty())
        else {
            return refuse(format!("the type \"{name}\" has no display name"));
        };
        let (Some(prefix), Some(suffix)) = (
            item.get("prefix").and_then(Value::as_str),
            item.get("suffix").and_then(Value::as_str),
        ) else {
            return refuse(format!(
                "the type \"{name}\" has no text \"prefix\" or \"suffix\""
            ));
        };
        if definitions.contains_key(name) {
            return refuse(format!("the type \"{name}\" is there two times"));
        }
        definitions.insert(
            name.to_owned(),
            NoteType {
                display_name: display_name.to_owned(),
                name: name.to_owned(),
                prefix: affix(prefix),
                suffix: affix(suffix),
            },
        );
    }
    if notes.len() != question.len() {
        return refuse(format!(
            "it names {} note(s) for a question of {}",
            notes.len(),
            question.len()
        ));
    }
    let mut types = BTreeMap::new();
    for (index, (item, path)) in notes.iter().zip(question).enumerate() {
        let Some(item) = item
            .as_object()
            .filter(|item| item.get("path").and_then(Value::as_str) == Some(path.as_str()))
        else {
            return refuse(format!("its note {} is not \"{path}\"", index + 1));
        };
        match item.get("noteType") {
            Some(Value::Null) => {}
            Some(Value::String(name)) => {
                let Some(definition) = definitions.get(name) else {
                    return refuse(format!(
                        "the type \"{name}\" of \"{path}\" is not in its list of types"
                    ));
                };
                types.insert(path.clone(), definition.clone());
            }
            _ => return refuse(format!("the type of \"{path}\" is not a text")),
        }
    }
    Ok(types)
}

/// The `noteType` of a manifest entry. `None` for every other value.
pub fn note_type_of_entry(value: &Value) -> Option<NoteType> {
    const KEYS: [&str; 4] = ["displayName", "name", "prefix", "suffix"];
    let item = value.as_object()?;
    if !item.keys().all(|key| KEYS.contains(&key.as_str())) {
        return None;
    }
    let name = item
        .get("name")?
        .as_str()
        .filter(|name| is_canonical_name(name))?;
    let display_name = item
        .get("displayName")?
        .as_str()
        .filter(|display_name| !display_name.is_empty())?;
    // An affix that is there is a text that is not empty.
    let affix_of = |key: &str| -> Option<Option<String>> {
        match item.get(key) {
            None => Some(None),
            Some(value) => value
                .as_str()
                .filter(|text| !text.is_empty())
                .map(|text| Some(text.to_owned())),
        }
    };
    Some(NoteType {
        display_name: display_name.to_owned(),
        name: name.to_owned(),
        prefix: affix_of("prefix")?,
        suffix: affix_of("suffix")?,
    })
}

/// The Obsidian Starter Kit of the vault, which knows the note type of each
/// note: its command line program, `osk-cli recognize`.
pub struct StarterKit {
    /// The program of the Starter Kit.
    program: PathBuf,
    /// The folder of the vault.
    vault: PathBuf,
}

/// The program of the Starter Kit in a vault, where the plugin installs it.
pub fn default_program(vault: &Path) -> PathBuf {
    let folder = vault.join(".obsidian/plugins/obsidian-starter-kit-plugin");
    if cfg!(windows) {
        folder.join("osk-cli-windows-x64.exe")
    } else {
        folder.join("osk-cli")
    }
}

impl StarterKit {
    pub fn new(program: &Path, vault: &Path) -> Self {
        Self {
            program: program.to_path_buf(),
            vault: vault.to_path_buf(),
        }
    }

    /// The answer of the Starter Kit for these vault paths, as data.
    ///
    /// # Errors
    ///
    /// The program cannot be started, ends with an error, or writes no JSON.
    fn recognize(&self, paths: &[String]) -> Result<Value, String> {
        #[cfg(debug_assertions)]
        if let Some(file) = std::env::var_os("DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES") {
            return answer_of_file(Path::new(&file), paths);
        }
        let mut command = Command::new(&self.program);
        command
            .arg("recognize")
            .arg("--vault")
            .arg(&self.vault)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            format!(
                "its program {} cannot be started ({error})",
                self.program.display()
            )
        })?;
        let mut input = String::new();
        for path in paths {
            input.push_str(path);
            input.push('\n');
        }
        let output = thread::scope(|scope| {
            // The input is written while the program runs, so that a full
            // pipe of its output never blocks it.
            if let Some(mut stdin) = child.stdin.take() {
                scope.spawn(move || {
                    let _ = stdin.write_all(input.as_bytes());
                });
            }
            child.wait_with_output()
        })
        .map_err(|error| format!("its program could not run: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "its program ended with an error: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let text = String::from_utf8(output.stdout)
            .map_err(|_| "its program wrote a text that is not UTF-8".to_owned())?;
        parse_json(&text).map_err(|_| "its program wrote no JSON".to_owned())
    }
}

/// The Starter Kit of the tests, in the debug build: it answers from a file
/// (`documentation/Canonical Form.md`, "The note type of a note"). `none`:
/// no note has a type. The file is read again at each question. A missing
/// file is a missing Starter Kit. The TypeScript twin is `fileNoteTypes()`.
#[cfg(debug_assertions)]
fn answer_of_file(file: &Path, paths: &[String]) -> Result<Value, String> {
    use serde_json::{Map, json};
    use std::collections::BTreeSet;

    let data = if file == Path::new("none") {
        Value::Null
    } else {
        let text = std::fs::read_to_string(file)
            .map_err(|error| format!("its test file cannot be read ({error})"))?;
        serde_json::from_str(&text).map_err(|_| "its test file is not JSON".to_owned())?
    };
    let empty = Map::new();
    let named = data
        .get("notes")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let notes: Vec<Value> = paths
        .iter()
        .map(|path| json!({ "path": path, "noteType": named.get(path).and_then(Value::as_str) }))
        .collect();
    let used: BTreeSet<&str> = notes
        .iter()
        .filter_map(|note| note["noteType"].as_str())
        .collect();
    let note_types: Vec<Value> =
        data.get("noteTypes")
            .and_then(Value::as_array)
            .map_or_else(Vec::new, |types| {
                types
                    .iter()
                    .filter(|item| {
                        item["name"]
                            .as_str()
                            .is_some_and(|name| used.contains(name))
                    })
                    .cloned()
                    .collect()
            });
    Ok(json!({ "noteTypes": note_types, "notes": notes }))
}

/// The note type of each of these notes, from the Starter Kit, in one
/// question (decision R61). A note with no type is not in the result.
///
/// # Errors
///
/// The Starter Kit is missing, fails or gives an answer that the tool cannot
/// read: every type would else leave the site.
pub fn note_types_of(
    kit: &StarterKit,
    paths: &[String],
) -> Result<BTreeMap<String, NoteType>, String> {
    let answer = kit.recognize(paths).map_err(|error| {
        format!(
            "the Obsidian Starter Kit cannot give the note types: {error}. Nothing can be planned or published without it"
        )
    })?;
    read_note_types(paths, &answer)
}

#[cfg(test)]
mod tests {
    use super::{note_type_of_entry, read_note_types};
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/note-types.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/note-types.json");

    fn cases(list: &str) -> Vec<Value> {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        cases[list]
            .as_array()
            .expect("the cases file has the list")
            .clone()
    }

    fn question_of(case: &Value) -> Vec<String> {
        case["question"]
            .as_array()
            .expect("a question")
            .iter()
            .map(|path| path.as_str().expect("a path").to_owned())
            .collect()
    }

    #[test]
    fn reads_the_answers_as_the_file_states() {
        let read = cases("read");
        assert!(read.len() >= 5);
        for case in read {
            let types = read_note_types(&question_of(&case), &case["answer"])
                .unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
            let types = serde_json::to_value(types).expect("the types are data");
            assert_eq!(types, case["types"], "{}", case["name"]);
        }
    }

    #[test]
    fn refuses_the_answers_that_the_file_refuses() {
        let refused = cases("refused");
        assert!(refused.len() >= 15);
        for case in refused {
            let error = read_note_types(&question_of(&case), &case["answer"])
                .expect_err(case["name"].as_str().expect("a name"));
            assert!(
                error.starts_with(
                    "the Obsidian Starter Kit gave an answer that the tool cannot read"
                ),
                "{error}"
            );
        }
    }

    #[test]
    fn reads_the_note_type_of_a_manifest_entry_as_the_file_states() {
        let manifest = cases("manifest");
        assert!(manifest.len() >= 8);
        for case in manifest {
            assert_eq!(
                Some(note_type_of_entry(&case["noteType"]).is_some()),
                case["valid"].as_bool(),
                "{}",
                case["name"]
            );
        }
    }
}
