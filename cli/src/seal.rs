//! The seal of the content store (decision R104, `documentation/Canonical
//! Form.md`, "The seal of the content store"). Every commit that the tool
//! writes carries a seal: an HMAC with the seal key of the vault over its
//! parent and the state that the tool trusts. Before a run, the tool checks
//! that the state of the last commit is the sealed state. The TypeScript twin
//! is `apps/plugin/src/publishing/seal.ts`; the shared cases are in
//! `fixtures/canonical/seal.json`.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt::Write;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::configuration::{CONFIGURATION_FILE, parse_configuration};
use crate::edits::EDITS_FILE;
use crate::hash::sha256_hex;
use crate::json::parse_json;
use crate::manifest::{MANIFEST_FOLDER, NOTES_FOLDER};
use crate::order::sort_by_code_point;
use crate::renames::RENAMES_FILE;
use crate::withdrawn::WITHDRAWN_FILE;

/// The name of the seal key, in the environment or in the `.env` file at the
/// root of the vault.
pub const SEAL_KEY_VARIABLE: &str = "VAULT_PUBLISH_SEAL_KEY";

/// The files and folders of the content store that the seal covers.
pub const SEALED_PATHS: [&str; 6] = [
    CONFIGURATION_FILE,
    EDITS_FILE,
    MANIFEST_FOLDER,
    NOTES_FOLDER,
    RENAMES_FILE,
    WITHDRAWN_FILE,
];

/// How many commits of the first-parent chain the check reads, from the last
/// one.
pub const SEAL_HISTORY: usize = 100;

/// The most entries of each list of a difference that its text names.
pub const NAMED_IN_TEXT: usize = 20;

/// One file of a commit, as `git ls-tree -r` gives it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TreeFile {
    pub mode: String,
    /// The object id of git.
    pub object: String,
    pub path: String,
}

/// One commit of the first-parent chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
    pub id: String,
    /// The first parent, or `None` for a first commit.
    pub parent: Option<String>,
    pub message: String,
}

/// The way a seal is made for a commit: from its parent and its sealed files,
/// the seal in small hexadecimal digits.
pub type Sealer<'a> = &'a dyn Fn(Option<&str>, &[TreeFile]) -> String;

/// The value of a variable in the text of a `.env` file: lines `NAME=value`,
/// with an optional `export `, white space around the name and the value, and
/// one pair of single or double quotes around the value. A line that starts
/// with `#` is a comment. The last line of the name wins.
pub fn env_value(text: &str, name: &str) -> Option<String> {
    let blank = |character: char| character.is_whitespace() || character == '\u{feff}';
    let mut found = None;
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim_matches(blank);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export ")
            .map_or(line, |rest| rest.trim_start_matches(blank));
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim_matches(blank) != name {
            continue;
        }
        let value = value.trim_matches(blank);
        let bytes = value.as_bytes();
        let quoted = bytes.len() >= 2
            && (bytes[0] == b'"' || bytes[0] == b'\'')
            && bytes[bytes.len() - 1] == bytes[0];
        found = Some(if quoted {
            value[1..value.len() - 1].to_owned()
        } else {
            value.to_owned()
        });
    }
    found
}

/// The message of a missing seal key: how to make one and where to put it.
pub fn missing_key() -> String {
    format!(
        "the seal key of the content store is missing: every commit of the tool carries a seal, and nothing is planned, published or edited without it (R104). Put the line {SEAL_KEY_VARIABLE}=<64 hexadecimal digits> in the .env file at the root of the vault, or set {SEAL_KEY_VARIABLE} in the environment. Make the key one time with openssl rand -hex 32, and give the same key to every device that publishes. Never put it into the content store or a repository"
    )
}

/// The bytes of 64 hexadecimal digits, small or capital letters.
fn key_bytes(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let digits = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(digits, 16).ok()
        })
        .collect()
}

/// The seal key: the variable of the environment when it is set and not
/// empty, else the variable of the `.env` file at the root of the vault. The
/// error is the message of a key that is missing or not valid: it never holds
/// the value that it refuses.
///
/// # Errors
///
/// There is no key, or it is not 64 hexadecimal digits.
pub fn seal_key_of(environment: Option<&str>, env_file: Option<&str>) -> Result<Vec<u8>, String> {
    let from_environment = environment.map_or("", |value| {
        value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
    });
    let (value, source) = if from_environment.is_empty() {
        (
            env_file
                .and_then(|text| env_value(text, SEAL_KEY_VARIABLE))
                .unwrap_or_default(),
            "the .env file of the vault",
        )
    } else {
        (from_environment.to_owned(), "the environment")
    };
    if value.is_empty() {
        return Err(missing_key());
    }
    key_bytes(&value).ok_or_else(|| {
        format!(
            "{SEAL_KEY_VARIABLE} of {source} is not 64 hexadecimal digits, so no seal can be checked or written (R104). Make a key with openssl rand -hex 32, and give the same key to every device that publishes"
        )
    })
}

/// Where the seal key of a device comes from: the variable of the
/// environment, read at each check, and the `.env` file at the root of the
/// vault.
pub struct SealSource {
    env_file: PathBuf,
}

impl SealSource {
    pub fn new(vault: &Path) -> Self {
        Self {
            env_file: vault.join(".env"),
        }
    }

    /// The seal key, or the message that says why there is none.
    ///
    /// # Errors
    ///
    /// The key is missing or not valid, or the `.env` file cannot be read.
    pub fn key(&self) -> Result<Vec<u8>, String> {
        let environment = env::var_os(SEAL_KEY_VARIABLE)
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.trim().is_empty());
        // The file is read only when the environment gives no key.
        let file = if environment.is_some() {
            None
        } else {
            match fs::read(&self.env_file) {
                Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
                Err(error) if error.kind() == ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(format!(
                        "the .env file of the vault cannot be read ({error}), so the seal key of the content store is unknown: {}",
                        self.env_file.display()
                    ));
                }
            }
        };
        seal_key_of(environment.as_deref(), file.as_deref())
    }
}

/// The block of SHA-256 in bytes.
const BLOCK: usize = 64;

/// The HMAC-SHA256 of a text as UTF-8, in small hexadecimal digits (RFC 2104):
/// a key longer than a block is hashed first, and a shorter one is filled with
/// zero bytes.
pub fn hmac_sha256(key: &[u8], text: &str) -> String {
    let mut block = [0_u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner_pad: Vec<u8> = block.iter().map(|byte| byte ^ 0x36).collect();
    let outer_pad: Vec<u8> = block.iter().map(|byte| byte ^ 0x5c).collect();
    let mut inner = Sha256::new();
    inner.update(&inner_pad);
    inner.update(text.as_bytes());
    let mut outer = Sha256::new();
    outer.update(&outer_pad);
    outer.update(inner.finalize());
    let mut hex = String::with_capacity(64);
    for byte in outer.finalize() {
        // Writing to a `String` cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// The digest of the sealed state of a commit: one line per file, in the
/// order of the code points of the paths.
pub fn state_digest(files: &[TreeFile]) -> String {
    let mut sorted: Vec<&TreeFile> = files.iter().collect();
    sorted.sort_by(|one, two| one.path.cmp(&two.path));
    let mut lines = String::new();
    for file in sorted {
        // Writing to a `String` cannot fail.
        let _ = writeln!(lines, "{} {} {}", file.mode, file.object, file.path);
    }
    sha256_hex(&lines)
}

/// The seal of a commit with this parent and these files.
pub fn seal_of(key: &[u8], parent: Option<&str>, files: &[TreeFile]) -> String {
    hmac_sha256(
        key,
        &format!(
            "dsebastien-vault-publish seal 1\nparent {}\nstate {}\n",
            parent.unwrap_or("none"),
            state_digest(files)
        ),
    )
}

/// The seal that the last line of a commit message holds, or `None`.
pub fn seal_line_of(message: &str) -> Option<String> {
    let last = message.split('\n').rfind(|line| !line.trim().is_empty())?;
    let seal = last.strip_prefix("Seal: ")?;
    (seal.len() == 64
        && seal
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    .then(|| seal.to_owned())
}

/// The message with its seal as its last line.
pub fn with_seal(message: &str, seal: &str) -> String {
    format!("{}\nSeal: {seal}\n", message.trim_end_matches('\n'))
}

/// True when the two seals are the same, in a time that does not depend on
/// where they differ.
pub fn same_seal(one: &str, two: &str) -> bool {
    let (left, right) = (one.as_bytes(), two.as_bytes());
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

/// The files of `git ls-tree -r -z --full-tree`: `<mode> <type> <object>\t<path>`,
/// each ended by a NUL. Only blobs and links count. Sorted by the code points of
/// the paths.
///
/// # Errors
///
/// A line that cannot be read.
pub fn parse_tree_listing(text: &str) -> Result<Vec<TreeFile>, String> {
    let mut files = Vec::new();
    for entry in text.split('\0') {
        if entry.is_empty() {
            continue;
        }
        let unreadable = || format!("git gave a line of a tree that cannot be read: {entry}");
        let (facts, path) = entry.split_once('\t').ok_or_else(unreadable)?;
        let mut parts = facts.split(' ');
        let (Some(mode), Some(kind), Some(object)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(unreadable());
        };
        if kind == "blob" || kind == "commit" {
            files.push(TreeFile {
                mode: mode.to_owned(),
                object: object.to_owned(),
                path: path.to_owned(),
            });
        }
    }
    files.sort_by(|one, two| one.path.cmp(&two.path));
    Ok(files)
}

/// One manifest entry that differs from the sealed state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryChange {
    /// `added`, `changed` or `removed`.
    pub change: String,
    pub file: String,
    /// The vault path of the entry: the new one, or the one of the sealed
    /// state for a removal.
    pub path: String,
    /// The state of the entry before and after; `none` for an entry that is
    /// not there, `?` for one that cannot be read.
    pub before: String,
    pub after: String,
}

/// One file of the store that differs, other than a manifest entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub change: String,
}

/// How the state of the last commit differs from the last sealed state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreDifference {
    /// The last commit of the copy: a confirmation names it.
    pub head: String,
    /// The last commit with a valid seal, or `none`.
    pub sealed: String,
    pub entries: Vec<EntryChange>,
    /// The folders that left the deny list: the guards are looser.
    pub deny_list_removed: Vec<String>,
    pub deny_list_added: Vec<String>,
    pub files: Vec<FileChange>,
}

/// The result of the check of the seal.
#[derive(Debug, PartialEq, Eq)]
pub enum SealCheck {
    Empty,
    Sealed,
    Differs(StoreDifference),
}

/// What the check reads of the copy: its first-parent chain, the files of a
/// commit, a file of a commit.
pub trait SealedHistory {
    /// # Errors
    ///
    /// Git fails.
    fn commits(&self, limit: usize) -> Result<Vec<Commit>, String>;
    /// # Errors
    ///
    /// Git fails.
    fn files(&self, commit: &str, paths: &[&str]) -> Result<Vec<TreeFile>, String>;
    /// # Errors
    ///
    /// Git fails.
    fn read_at(&self, commit: &str, path: &str) -> Result<Option<String>, String>;
}

/// Checks the seal of the copy: the newest commit of the first-parent chain
/// (at most `SEAL_HISTORY` commits) whose seal is valid for its parent and its
/// state must hold the state of the last commit. A commit after it that
/// changes no sealed path (the redirect list) is no difference.
///
/// # Errors
///
/// The history cannot be read.
pub fn check_seal(store: &dyn SealedHistory, key: &[u8]) -> Result<SealCheck, String> {
    let commits = store.commits(SEAL_HISTORY)?;
    let Some(head) = commits.first() else {
        return Ok(SealCheck::Empty);
    };
    let head_files = store.files(&head.id, &SEALED_PATHS)?;
    let head_digest = state_digest(&head_files);
    for (index, commit) in commits.iter().enumerate() {
        let Some(seal) = seal_line_of(&commit.message) else {
            continue;
        };
        let files = if index == 0 {
            head_files.clone()
        } else {
            store.files(&commit.id, &SEALED_PATHS)?
        };
        if same_seal(&seal, &seal_of(key, commit.parent.as_deref(), &files)) {
            if state_digest(&files) == head_digest {
                return Ok(SealCheck::Sealed);
            }
            return Ok(SealCheck::Differs(difference_of(
                &head.id,
                Some(&commit.id),
                &files,
                &head_files,
                &|at, path| store.read_at(at, path),
            )?));
        }
    }
    Ok(SealCheck::Differs(difference_of(
        &head.id,
        None,
        &[],
        &head_files,
        &|at, path| store.read_at(at, path),
    )?))
}

/// The state and the vault path of a manifest entry, read leniently: a
/// difference names what it can.
fn entry_facts(text: Option<&str>) -> (String, String) {
    let Some(text) = text else {
        return ("none".to_owned(), String::new());
    };
    if let Ok(value) = parse_json(text)
        && let Some(record) = value.as_object()
    {
        let state = record
            .get("state")
            .and_then(|state| state.as_str())
            .unwrap_or("?");
        let path = record
            .get("path")
            .and_then(|path| path.as_str())
            .unwrap_or("");
        return (state.to_owned(), path.to_owned());
    }
    ("?".to_owned(), String::new())
}

/// The deny list of a configuration text, or `None` when it cannot be read.
fn deny_list_of(text: Option<&str>) -> Option<Vec<String>> {
    match text {
        None => Some(Vec::new()),
        Some(text) => parse_configuration(Some(text))
            .ok()
            .map(|configuration| configuration.deny_list),
    }
}

/// A function that gives the text of a file of a commit.
pub type Reader<'a> = &'a dyn Fn(&str, &str) -> Result<Option<String>, String>;

/// The paths that differ between two lists of files, in the order of the code
/// points, each with `added`, `changed` or `removed`.
fn changed_paths<'a>(
    sealed_files: &'a [TreeFile],
    head_files: &'a [TreeFile],
) -> Vec<(&'a str, &'static str)> {
    let before: BTreeMap<&str, &TreeFile> = sealed_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let after: BTreeMap<&str, &TreeFile> = head_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let paths: BTreeSet<&str> = before.keys().chain(after.keys()).copied().collect();
    let mut changes: Vec<(&str, &'static str)> = Vec::new();
    for path in paths {
        match (before.get(path), after.get(path)) {
            (None, _) => changes.push((path, "added")),
            (_, None) => changes.push((path, "removed")),
            (Some(one), Some(two)) if one.mode != two.mode || one.object != two.object => {
                changes.push((path, "changed"));
            }
            _ => {}
        }
    }
    changes
}

/// The difference between the sealed state (`sealed`, `None` for none, with
/// its files) and the state of the last commit. `read` gives a file of a
/// commit.
///
/// # Errors
///
/// A file cannot be read.
pub fn difference_of(
    head: &str,
    sealed: Option<&str>,
    sealed_files: &[TreeFile],
    head_files: &[TreeFile],
    read: Reader,
) -> Result<StoreDifference, String> {
    let changes = changed_paths(sealed_files, head_files);
    let read_sealed = |path: &str| -> Result<Option<String>, String> {
        sealed.map_or(Ok(None), |sealed| read(sealed, path))
    };
    let manifest_prefix = format!("{MANIFEST_FOLDER}/");
    let mut entries = Vec::new();
    let mut files = Vec::new();
    let mut deny_list_removed = Vec::new();
    let mut deny_list_added = Vec::new();
    // Only the entries that a text names are read: a first check of a large
    // store lists every entry as added.
    let mut named: BTreeMap<&str, usize> = BTreeMap::new();
    for (path, change) in changes {
        if path.starts_with(&manifest_prefix) {
            let count = named.entry(change).or_insert(0);
            *count += 1;
            if *count > NAMED_IN_TEXT {
                entries.push(EntryChange {
                    change: change.to_owned(),
                    file: path.to_owned(),
                    path: String::new(),
                    before: String::new(),
                    after: String::new(),
                });
                continue;
            }
            let old_text = if change == "added" {
                None
            } else {
                read_sealed(path)?
            };
            let new_text = if change == "removed" {
                None
            } else {
                read(head, path)?
            };
            let one = entry_facts(old_text.as_deref());
            let two = entry_facts(new_text.as_deref());
            entries.push(EntryChange {
                change: change.to_owned(),
                file: path.to_owned(),
                path: if two.1.is_empty() { one.1 } else { two.1 },
                before: one.0,
                after: two.0,
            });
            continue;
        }
        if path == CONFIGURATION_FILE {
            let old_text = read_sealed(path)?;
            let new_text = if change == "removed" {
                None
            } else {
                read(head, path)?
            };
            let old = deny_list_of(old_text.as_deref());
            let now = deny_list_of(new_text.as_deref());
            if let (Some(old), Some(now)) = (old, now) {
                deny_list_removed = old
                    .iter()
                    .filter(|folder| !now.contains(folder))
                    .cloned()
                    .collect();
                deny_list_added = now
                    .iter()
                    .filter(|folder| !old.contains(folder))
                    .cloned()
                    .collect();
                sort_by_code_point(&mut deny_list_removed);
                sort_by_code_point(&mut deny_list_added);
            }
        }
        files.push(FileChange {
            path: path.to_owned(),
            change: change.to_owned(),
        });
    }
    Ok(StoreDifference {
        head: head.to_owned(),
        sealed: sealed.unwrap_or("none").to_owned(),
        entries,
        deny_list_removed,
        deny_list_added,
        files,
    })
}

/// A list of a text, with at most `NAMED_IN_TEXT` items and the count of the
/// others.
fn list_text(items: &[String]) -> String {
    let shown = items
        .iter()
        .take(NAMED_IN_TEXT)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if items.len() > NAMED_IN_TEXT {
        format!("{shown} and {} more", items.len() - NAMED_IN_TEXT)
    } else {
        shown
    }
}

/// The message of a difference: what changed since the last sealed state, and
/// how to confirm it.
pub fn difference_text(difference: &StoreDifference) -> String {
    let mut parts: Vec<String> = Vec::new();
    for change in ["added", "changed", "removed"] {
        let entries: Vec<&EntryChange> = difference
            .entries
            .iter()
            .filter(|entry| entry.change == change)
            .collect();
        if !entries.is_empty() {
            // The first entries are the named ones: `difference_of` reads them.
            let items: Vec<String> = entries
                .iter()
                .map(|entry| {
                    format!(
                        "\"{}\" ({} to {})",
                        if entry.path.is_empty() {
                            &entry.file
                        } else {
                            &entry.path
                        },
                        entry.before,
                        entry.after
                    )
                })
                .collect();
            parts.push(format!(
                "manifest entries {change} ({}): {}",
                entries.len(),
                list_text(&items)
            ));
        }
    }
    let quoted = |folders: &[String]| -> Vec<String> {
        folders
            .iter()
            .map(|folder| format!("\"{folder}\""))
            .collect()
    };
    if !difference.deny_list_removed.is_empty() {
        parts.push(format!(
            "folders that left the deny list, so the guards are looser: {}",
            list_text(&quoted(&difference.deny_list_removed))
        ));
    }
    if !difference.deny_list_added.is_empty() {
        parts.push(format!(
            "folders added to the deny list: {}",
            list_text(&quoted(&difference.deny_list_added))
        ));
    }
    let notes_prefix = format!("{NOTES_FOLDER}/");
    let (notes, others): (Vec<&FileChange>, Vec<&FileChange>) = difference
        .files
        .iter()
        .partition(|file| file.path.starts_with(&notes_prefix));
    let shown = |files: &[&FileChange]| -> Vec<String> {
        files
            .iter()
            .map(|file| format!("{} ({})", file.path, file.change))
            .collect()
    };
    if !others.is_empty() {
        parts.push(format!(
            "files of the store: {}",
            list_text(&shown(&others))
        ));
    }
    if !notes.is_empty() {
        parts.push(format!(
            "cleaned notes ({}): {}",
            notes.len(),
            list_text(&shown(&notes))
        ));
    }
    let head = &difference.head;
    let start = if difference.sealed == "none" {
        format!(
            "the content store has no sealed state yet (a store from before R104, or a new one), so the tool does not trust its state: it plans and publishes nothing until you confirm it one time. Its state at {head}"
        )
    } else {
        format!(
            "the state of the content store at {head} is not the state that a commit of the tool sealed ({}): a commit that no tool wrote changed it (a push of someone else, or an edit by hand). Nothing is planned or published until you confirm it. What differs from the sealed state",
            difference.sealed
        )
    };
    format!(
        "{start}: {}. When you made or accept every change, confirm the state of commit {head} (the command confirm-state --head {head}, the action of the publication center, or the MCP tool confirm_store_state); else take the commits back in the content store",
        if parts.is_empty() {
            "no file".to_owned()
        } else {
            parts.join("; ")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/seal.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/seal.json");

    fn cases() -> Value {
        serde_json::from_str(CASES).expect("the cases file is JSON")
    }

    fn list(cases: &Value, name: &str) -> Vec<Value> {
        cases[name]
            .as_array()
            .expect("the cases file has the list")
            .clone()
    }

    /// A key built at run time from the byte that a case gives: never text in a file.
    fn key_of(byte: &str, length: usize) -> Vec<u8> {
        let byte = u8::from_str_radix(byte, 16).expect("a byte in hexadecimal");
        vec![byte; length]
    }

    fn with_key(text: &Value, byte: Option<&str>) -> Option<String> {
        let hex = byte.unwrap_or("00").repeat(32);
        text.as_str().map(|text| {
            text.replace("<key>", &hex)
                .replace("<KEY>", &hex.to_uppercase())
        })
    }

    fn files_of(value: &Value) -> Vec<TreeFile> {
        serde_json::from_value(value.clone()).expect("a list of files")
    }

    #[test]
    fn computes_the_hmac_sha256_of_rfc_4231() {
        for case in list(&cases(), "hmac") {
            let length = usize::try_from(case["keyLength"].as_u64().expect("a length"))
                .expect("a small length");
            let key = key_of(case["keyByte"].as_str().expect("a byte"), length);
            assert_eq!(
                hmac_sha256(&key, case["text"].as_str().expect("a text")),
                case["hmac"].as_str().expect("an HMAC"),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn reads_the_seal_key_of_a_dot_env_text() {
        for case in list(&cases(), "env") {
            assert_eq!(
                env_value(
                    case["text"].as_str().expect("a text"),
                    "VAULT_PUBLISH_SEAL_KEY"
                ),
                case["value"].as_str().map(str::to_owned),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn takes_the_key_of_the_environment_else_of_the_file_and_says_why_there_is_none() {
        for case in list(&cases(), "keys") {
            let byte = case["keyByte"].as_str();
            let environment = with_key(&case["environment"], byte);
            let file = with_key(&case["envFile"], byte);
            let result = seal_key_of(environment.as_deref(), file.as_deref());
            let name = case["name"].as_str().expect("a name");
            if case["result"] == "key" {
                assert_eq!(result, Ok(key_of(byte.expect("a byte"), 32)), "{name}");
            } else {
                let problem = result.expect_err(name);
                let missing = problem == missing_key();
                assert_eq!(
                    if missing { "missing" } else { "invalid" },
                    case["result"].as_str().expect("a result"),
                    "{name}"
                );
                // The message never holds the value that it refuses.
                assert!(
                    !problem.contains(&byte.unwrap_or("abcd").repeat(4)),
                    "{name}"
                );
                assert!(problem.contains("openssl rand -hex 32"), "{name}");
            }
        }
    }

    #[test]
    fn seals_a_parent_and_the_state_of_a_commit() {
        for case in list(&cases(), "seals") {
            let name = case["name"].as_str().expect("a name");
            let files = files_of(&case["files"]);
            let parent = case["parent"].as_str();
            let key = key_of(case["keyByte"].as_str().expect("a byte"), 32);
            assert_eq!(
                state_digest(&files),
                case["digest"].as_str().expect("a digest"),
                "{name}"
            );
            let seal = seal_of(&key, parent, &files);
            assert_eq!(seal, case["seal"].as_str().expect("a seal"), "{name}");
            // Another key gives another seal.
            assert_ne!(seal_of(&key_of("01", 32), parent, &files), seal, "{name}");
        }
    }

    #[test]
    fn reads_the_seal_of_the_last_line_of_a_commit_message_only() {
        for case in list(&cases(), "sealLines") {
            let message = case["message"].as_str().expect("a message");
            assert_eq!(
                seal_line_of(message).as_deref(),
                case["seal"].as_str(),
                "{message}"
            );
        }
        let seal = "ab".repeat(32);
        assert_eq!(
            seal_line_of(&with_seal("Publish\n\nPlan: 0123456789abcdef\n", &seal)),
            Some(seal.clone())
        );
        assert_eq!(
            with_seal("Publish\n\nPlan: x\n", &seal),
            format!("Publish\n\nPlan: x\nSeal: {seal}\n")
        );
    }

    #[test]
    fn compares_two_seals() {
        let seal = "ab".repeat(32);
        assert!(same_seal(&seal, &seal.clone()));
        assert!(!same_seal(&seal, &format!("{}ac", "ab".repeat(31))));
        assert!(!same_seal(&seal, &seal[1..]));
    }

    #[test]
    fn reads_the_files_of_a_listing_of_git() {
        for case in list(&cases(), "listings") {
            assert_eq!(
                parse_tree_listing(case["text"].as_str().expect("a text")),
                Ok(files_of(&case["files"])),
                "{}",
                case["name"]
            );
        }
        assert!(parse_tree_listing("100644 blob abc no tab").is_err());
    }

    #[test]
    fn says_what_differs_from_the_sealed_state() {
        for case in list(&cases(), "differences") {
            let name = case["name"].as_str().expect("a name");
            let texts = case["texts"].as_object().expect("the texts");
            let read = |commit: &str, path: &str| -> Result<Option<String>, String> {
                Ok(texts
                    .get(&format!("{commit}:{path}"))
                    .and_then(Value::as_str)
                    .map(str::to_owned))
            };
            let found = difference_of(
                case["head"].as_str().expect("a head"),
                case["sealed"].as_str(),
                &files_of(&case["sealedFiles"]),
                &files_of(&case["headFiles"]),
                &read,
            )
            .expect("the difference is made");
            assert_eq!(
                serde_json::to_value(&found).expect("data"),
                case["difference"],
                "{name}"
            );
            assert_eq!(
                difference_text(&found),
                case["text"].as_str().expect("a text"),
                "{name}"
            );
        }
    }
}
