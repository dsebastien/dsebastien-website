//! The seal of the content store (decision R104, `documentation/Canonical
//! Form.md`, "The seal of the content store"). Every commit that the tool
//! writes carries a seal: an HMAC with the seal key of the vault over its
//! parents and the state that the tool trusts. Before a run, the tool checks
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
use crate::hash::sha256_hex;
use crate::json::parse_json;
use crate::manifest::{MANIFEST_FOLDER, NOTES_FOLDER};
use crate::order::sort_by_code_point;

/// The name of the seal key, in the environment or in the `.env` file at the
/// root of the vault.
pub const SEAL_KEY_VARIABLE: &str = "VAULT_PUBLISH_SEAL_KEY";

/// The one file of the content store that the seal does not cover: the
/// redirect list, which only the author writes, at the root, by its exact
/// name, as a regular file (mode 100644). Every other file of a commit is
/// sealed, also a link or an executable file at that path.
pub const UNSEALED_FILE: &str = "redirects.json";

/// The mode of git of a regular file.
const REGULAR_FILE: &str = "100644";

/// True when the seal covers this file of the content store.
pub fn is_sealed_file(file: &TreeFile) -> bool {
    file.path != UNSEALED_FILE || file.mode != REGULAR_FILE
}

/// The files of a commit that the seal covers.
pub fn sealed_files(files: Vec<TreeFile>) -> Vec<TreeFile> {
    files
        .into_iter()
        .filter(is_sealed_file)
        .collect()
}

/// How many commits of the first-parent chain the check reads, from the last
/// one.
pub const SEAL_HISTORY: usize = 100;

/// The most entries of each list of a difference that its text names, but
/// the published ones.
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
    /// Every parent of the commit, in the order of git: none for a first
    /// commit.
    pub parents: Vec<String>,
    pub message: String,
}

/// The way a seal is made for a commit: from its parents and its sealed
/// files, the seal in small hexadecimal digits.
pub type Sealer<'a> = &'a dyn Fn(&[String], &[TreeFile]) -> String;

/// True for what `trimmed` takes away: the white space of ASCII (space, tab,
/// line feed, carriage return, form feed, vertical tab) and the byte order
/// mark, and nothing else: the TypeScript twin takes away the same.
fn is_trimmed(character: char) -> bool {
    matches!(
        character,
        ' ' | '\t' | '\n' | '\r' | '\u{c}' | '\u{b}' | '\u{feff}'
    )
}

/// The text without the characters of `is_trimmed` at its two ends.
pub fn trimmed(text: &str) -> &str {
    text.trim_matches(is_trimmed)
}

/// The value of a variable in the text of a `.env` file: lines `NAME=value`,
/// with an optional `export `, white space around the name and the value, and
/// one pair of single or double quotes around the value. A line that starts
/// with `#` is a comment. The last line of the name wins.
pub fn env_value(text: &str, name: &str) -> Option<String> {
    let mut found = None;
    for raw in text.split('\n') {
        let line = trimmed(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export ")
            .map_or(line, |rest| rest.trim_start_matches(is_trimmed));
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if trimmed(key) != name {
            continue;
        }
        let value = trimmed(value);
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
/// empty (after `trimmed`), else the variable of the `.env` file at the root
/// of the vault. The error is the message of a key that is missing or not
/// valid: it never holds the value that it refuses.
///
/// # Errors
///
/// There is no key, or it is not 64 hexadecimal digits.
pub fn seal_key_of(environment: Option<&str>, env_file: Option<&str>) -> Result<Vec<u8>, String> {
    let from_environment = environment.map_or("", trimmed);
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

/// The key in small hexadecimal digits, for the environment of the deploy
/// that the tool starts (rule 10 of the seal). Never for a log.
pub fn key_hex(key: &[u8]) -> String {
    let mut hex = String::with_capacity(key.len() * 2);
    for byte in key {
        // Writing to a `String` cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
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
            .filter(|value| !trimmed(value).is_empty());
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
    key_hex(&outer.finalize())
}

/// The digest of the sealed state of a commit: one record
/// `<mode> <object> <path>` ended by a NUL per file (a path of git never
/// holds a NUL), in the order of the code points of the paths.
pub fn state_digest(files: &[TreeFile]) -> String {
    let mut sorted: Vec<&TreeFile> = files.iter().collect();
    sorted.sort_by(|one, two| one.path.cmp(&two.path));
    let mut records = String::new();
    for file in sorted {
        // Writing to a `String` cannot fail.
        let _ = write!(records, "{} {} {}\0", file.mode, file.object, file.path);
    }
    sha256_hex(&records)
}

/// The seal of a commit with these parents (in the order of git) and these
/// sealed files.
pub fn seal_of(key: &[u8], parents: &[String], files: &[TreeFile]) -> String {
    let mut text = String::from("dsebastien-vault-publish seal 1\n");
    if parents.is_empty() {
        text.push_str("parent none\n");
    }
    for parent in parents {
        // Writing to a `String` cannot fail.
        let _ = writeln!(text, "parent {parent}");
    }
    let _ = writeln!(text, "state {}", state_digest(files));
    hmac_sha256(key, &text)
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

/// What a difference compares with: the last commit with a valid seal that
/// the copy trusts (`seal`), the mark of the copy when the history has no
/// such commit (`mark`), the live content revision of the host when the copy
/// has no mark and no such commit (`live`), or nothing (`none`).
pub const BASE_SEAL: &str = "seal";
pub const BASE_MARK: &str = "mark";
pub const BASE_LIVE: &str = "live";
pub const BASE_NONE: &str = "none";

/// How the state of the last commit differs from the last sealed state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreDifference {
    /// The last commit of the copy: a confirmation names it.
    pub head: String,
    /// What the difference compares with: `seal`, `mark` or `none`.
    pub base: String,
    /// The commit of the base, or `none`.
    pub sealed: String,
    pub entries: Vec<EntryChange>,
    /// The folders that left the deny list: the guards are looser.
    pub deny_list_removed: Vec<String>,
    pub deny_list_added: Vec<String>,
    /// The folders that left the list `noindexFolders` (their notes can be
    /// indexed) and the ones that came in.
    pub noindex_removed: Vec<String>,
    pub noindex_added: Vec<String>,
    pub files: Vec<FileChange>,
}

/// The result of the check of the seal.
#[derive(Debug, PartialEq, Eq)]
pub enum SealCheck {
    Empty,
    Sealed,
    /// Boxed: a difference is much larger than the other results.
    Differs(Box<StoreDifference>),
}

/// What the check reads of the copy: its first-parent chain, the files of a
/// commit, the texts of objects, and the mark of the copy: the last sealed
/// commit that the copy trusted, in its git folder, never in a commit.
pub trait SealedHistory {
    /// # Errors
    ///
    /// Git fails.
    fn commits(&self, limit: usize) -> Result<Vec<Commit>, String>;
    /// Every file of a commit (`git ls-tree -r`), sorted by path.
    ///
    /// # Errors
    ///
    /// Git fails, or the commit is not known.
    fn files(&self, commit: &str) -> Result<Vec<TreeFile>, String>;
    /// The texts of these objects of git, by object id. An object that
    /// cannot be read is not in the result.
    ///
    /// # Errors
    ///
    /// Git fails.
    fn objects(&self, ids: &[String]) -> Result<BTreeMap<String, String>, String>;
    /// The mark of the copy, or `None`.
    ///
    /// # Errors
    ///
    /// The file of the mark cannot be read.
    fn mark(&self) -> Result<Option<String>, String>;
    /// True when `ancestor` is `commit` or one of its ancestors; false also
    /// when one is not known.
    ///
    /// # Errors
    ///
    /// Git fails.
    fn descends(&self, commit: &str, ancestor: &str) -> Result<bool, String>;
}

/// Checks the seal of the copy. It walks the first-parent chain from the last
/// commit (at most `SEAL_HISTORY` commits) and takes the newest commit whose
/// seal is valid for its parents and its state; a commit with more than one
/// parent stops the walk, so no merge lies between the last commit and the
/// sealed one, and the sealed one is no merge. That commit is trusted when
/// it is the mark of the copy or descends from it; a copy with no mark takes
/// the live content revision of the host (`floor`, the deploy only) as its
/// lower bound, and with neither it trusts the commit. The
/// check writes nothing: the mark moves only when the tool pushes a sealed
/// commit (a confirmation included). The check passes when the trusted commit has the sealed
/// state of the last commit: a later commit of the redirect list alone is no
/// difference.
///
/// # Errors
///
/// The history or the mark cannot be read.
pub fn check_seal(
    store: &dyn SealedHistory,
    key: &[u8],
    floor: Option<&str>,
) -> Result<SealCheck, String> {
    let commits = store.commits(SEAL_HISTORY)?;
    let Some(head) = commits.first() else {
        return Ok(SealCheck::Empty);
    };
    let head_files = sealed_files(store.files(&head.id)?);
    let mut found: Option<(&str, Vec<TreeFile>)> = None;
    for (index, commit) in commits.iter().enumerate() {
        if commit.parents.len() > 1 {
            break;
        }
        let Some(seal) = seal_line_of(&commit.message) else {
            continue;
        };
        let files = if index == 0 {
            head_files.clone()
        } else {
            sealed_files(store.files(&commit.id)?)
        };
        if same_seal(&seal, &seal_of(key, &commit.parents, &files)) {
            found = Some((&commit.id, files));
            break;
        }
    }
    let own = store.mark()?;
    let base = if own.is_some() { BASE_MARK } else { BASE_LIVE };
    let mark = own.or_else(|| floor.map(str::to_owned));
    let read = |ids: &[String]| store.objects(ids);
    if let Some((id, files)) = found {
        let trusted = match mark.as_deref() {
            None => true,
            Some(mark) => mark == id || store.descends(id, mark)?,
        };
        if trusted {
            if state_digest(&files) == state_digest(&head_files) {
                return Ok(SealCheck::Sealed);
            }
            return Ok(SealCheck::Differs(Box::new(difference_of(
                &head.id,
                BASE_SEAL,
                Some(id),
                &files,
                &head_files,
                &read,
            )?)));
        }
    }
    if let Some(mark) = mark {
        // The commit of the mark can be gone from the copy: then every file
        // is added.
        let mark_files = store.files(&mark).map_or_else(|_| Vec::new(), sealed_files);
        return Ok(SealCheck::Differs(Box::new(difference_of(
            &head.id,
            base,
            Some(&mark),
            &mark_files,
            &head_files,
            &read,
        )?)));
    }
    Ok(SealCheck::Differs(Box::new(difference_of(
        &head.id,
        BASE_NONE,
        None,
        &[],
        &head_files,
        &read,
    )?)))
}

/// The state and the vault path of a manifest entry, read leniently: a
/// difference names what it can.
fn entry_facts(file: Option<&TreeFile>, text: Option<&str>) -> (String, String) {
    if file.is_none() {
        return ("none".to_owned(), String::new());
    }
    if let Some(text) = text
        && let Ok(value) = parse_json(text)
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

/// The two lists of a configuration (the deny list and the noindex folders),
/// or `None` when it cannot be read.
fn configuration_of(
    file: Option<&TreeFile>,
    text: Option<&str>,
) -> Option<(Vec<String>, Vec<String>)> {
    if file.is_none() {
        return Some((Vec::new(), Vec::new()));
    }
    let configuration = parse_configuration(Some(text?)).ok()?;
    Some((configuration.deny_list, configuration.noindex_folders))
}

/// True for a file of the manifest folder in any letter case: a checkout on
/// Windows reads `Manifest/` as `manifest/`.
fn is_manifest_file(path: &str) -> bool {
    let prefix = format!("{MANIFEST_FOLDER}/");
    path.get(..prefix.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(&prefix))
}

/// The folders of `one` that `two` does not have, sorted.
fn missing_from(one: &[String], two: &[String]) -> Vec<String> {
    let mut missing: Vec<String> = one
        .iter()
        .filter(|folder| !two.contains(folder))
        .cloned()
        .collect();
    sort_by_code_point(&mut missing);
    missing
}

/// A function that gives the texts of objects of git, by object id.
pub type Reader<'a> = &'a dyn Fn(&[String]) -> Result<BTreeMap<String, String>, String>;

/// One path that differs between two lists of files: its change, and its
/// file before and after.
struct Change<'a> {
    path: &'a str,
    kind: &'static str,
    one: Option<&'a TreeFile>,
    two: Option<&'a TreeFile>,
}

/// The paths that differ between two lists of files, in the order of the code
/// points.
fn changed_paths<'a>(sealed_files: &'a [TreeFile], head_files: &'a [TreeFile]) -> Vec<Change<'a>> {
    let before: BTreeMap<&str, &TreeFile> = sealed_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let after: BTreeMap<&str, &TreeFile> = head_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let paths: BTreeSet<&str> = before.keys().chain(after.keys()).copied().collect();
    let mut changes = Vec::new();
    for path in paths {
        let (one, two) = (before.get(path).copied(), after.get(path).copied());
        let change = match (one, two) {
            (None, _) => "added",
            (_, None) => "removed",
            (Some(one), Some(two)) if one.mode != two.mode || one.object != two.object => "changed",
            _ => continue,
        };
        changes.push(Change {
            path,
            kind: change,
            one,
            two,
        });
    }
    changes
}

/// The difference between the files of the base (the commit `sealed`, `None`
/// for none) and the state of the last commit. `read` gives the texts of
/// objects of git.
///
/// # Errors
///
/// The objects cannot be read.
pub fn difference_of(
    head: &str,
    base: &str,
    sealed: Option<&str>,
    sealed_files: &[TreeFile],
    head_files: &[TreeFile],
    read: Reader,
) -> Result<StoreDifference, String> {
    let changes = changed_paths(sealed_files, head_files);
    // Every entry and the configuration are read, in one read of objects:
    // the text names every entry that is published after the change.
    let wanted: Vec<String> = changes
        .iter()
        .filter(|change| is_manifest_file(change.path) || change.path == CONFIGURATION_FILE)
        .flat_map(|change| [change.one, change.two])
        .flatten()
        .map(|file| file.object.clone())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let texts = if wanted.is_empty() {
        BTreeMap::new()
    } else {
        read(&wanted)?
    };
    let text_of = |file: Option<&TreeFile>| file.and_then(|file| texts.get(&file.object));
    let mut difference = StoreDifference {
        head: head.to_owned(),
        base: base.to_owned(),
        sealed: sealed.unwrap_or("none").to_owned(),
        entries: Vec::new(),
        deny_list_removed: Vec::new(),
        deny_list_added: Vec::new(),
        noindex_removed: Vec::new(),
        noindex_added: Vec::new(),
        files: Vec::new(),
    };
    for Change {
        path,
        kind: change,
        one,
        two,
    } in changes
    {
        if is_manifest_file(path) {
            let old = entry_facts(one, text_of(one).map(String::as_str));
            let now = entry_facts(two, text_of(two).map(String::as_str));
            difference.entries.push(EntryChange {
                change: change.to_owned(),
                file: path.to_owned(),
                path: if now.1.is_empty() { old.1 } else { now.1 },
                before: old.0,
                after: now.0,
            });
            continue;
        }
        let mut change = change.to_owned();
        if path == CONFIGURATION_FILE {
            let old = configuration_of(one, text_of(one).map(String::as_str));
            let now = configuration_of(two, text_of(two).map(String::as_str));
            if let (Some(old), Some(now)) = (old, now) {
                difference.deny_list_removed = missing_from(&old.0, &now.0);
                difference.deny_list_added = missing_from(&now.0, &old.0);
                difference.noindex_removed = missing_from(&old.1, &now.1);
                difference.noindex_added = missing_from(&now.1, &old.1);
            } else {
                change = format!("{change}, cannot be read");
            }
        }
        difference.files.push(FileChange {
            path: path.to_owned(),
            change,
        });
    }
    Ok(difference)
}

/// The quoted list of folders.
fn folders_text(folders: &[String]) -> String {
    folders
        .iter()
        .map(|folder| format!("\"{folder}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The beginning of the text of a difference, by its base.
fn start_of(difference: &StoreDifference) -> String {
    let head = &difference.head;
    let sealed = &difference.sealed;
    match difference.base.as_str() {
        BASE_NONE => format!(
            "the content store has no sealed state yet (a store from before R104, or a new one), and this copy trusted none before, so the tool does not trust its state: it plans and publishes nothing until you confirm it one time. Its state at {head}"
        ),
        BASE_MARK => format!(
            "the content store has no sealed state that the tool can trust: no commit of the last {SEAL_HISTORY} (and none before a merge) has a valid seal and descends from {sealed}, the last sealed commit that this copy trusted. More than {SEAL_HISTORY} commits that no tool wrote, a merge, or an older history that a forced push put back can cause it. Nothing is planned or published until you confirm it. What differs from that commit"
        ),
        BASE_LIVE => format!(
            "the content store has no sealed state that the deploy can trust: this copy has no mark yet, and no commit of the last {SEAL_HISTORY} (and none before a merge) has a valid seal and is the live content revision {sealed} of the host or descends from it. An older history that a forced push put back can cause it. Nothing is built until you confirm it. What differs from the live content revision"
        ),
        _ => format!(
            "the state of the content store at {head} is not the state that a commit of the tool sealed ({sealed}): a commit that no tool wrote changed it (a push of someone else, or an edit by hand). Nothing is planned or published until you confirm it. What differs from the sealed state"
        ),
    }
}

/// The text of a list with its count of the items that it does not name.
fn with_more(shown: &[String], more: usize) -> String {
    let shown = shown.join(", ");
    if more > 0 {
        format!("{shown} and {more} more")
    } else {
        shown
    }
}

/// The message of a difference: what changed since the last sealed state, and
/// how to confirm it.
pub fn difference_text(difference: &StoreDifference) -> String {
    let mut parts: Vec<String> = Vec::new();
    let named = |entry: &EntryChange| {
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
    };
    for change in ["added", "changed", "removed"] {
        let entries: Vec<&EntryChange> = difference
            .entries
            .iter()
            .filter(|entry| entry.change == change)
            .collect();
        if entries.is_empty() {
            continue;
        }
        // Every entry that is published after the change is named; of the
        // others, at most `NAMED_IN_TEXT`.
        let (published, others): (Vec<&EntryChange>, Vec<&EntryChange>) =
            entries.iter().partition(|entry| entry.after == "published");
        let shown: Vec<String> = published
            .iter()
            .chain(others.iter().take(NAMED_IN_TEXT))
            .map(|entry| named(entry))
            .collect();
        parts.push(format!(
            "manifest entries {change} ({}): {}",
            entries.len(),
            with_more(&shown, others.len().saturating_sub(NAMED_IN_TEXT))
        ));
    }
    if !difference.deny_list_removed.is_empty() {
        parts.push(format!(
            "folders that left the deny list, so the guards are looser: {}",
            folders_text(&difference.deny_list_removed)
        ));
    }
    if !difference.deny_list_added.is_empty() {
        parts.push(format!(
            "folders added to the deny list: {}",
            folders_text(&difference.deny_list_added)
        ));
    }
    if !difference.noindex_removed.is_empty() {
        parts.push(format!(
            "folders that left the noindex folders, so their notes can be indexed: {}",
            folders_text(&difference.noindex_removed)
        ));
    }
    if !difference.noindex_added.is_empty() {
        parts.push(format!(
            "folders added to the noindex folders: {}",
            folders_text(&difference.noindex_added)
        ));
    }
    let notes_prefix = format!("{NOTES_FOLDER}/");
    let (notes, others): (Vec<&FileChange>, Vec<&FileChange>) = difference
        .files
        .iter()
        .partition(|file| file.path.starts_with(&notes_prefix));
    let shown = |file: &&FileChange| format!("{} ({})", file.path, file.change);
    if !others.is_empty() {
        // Every other file is named: a file of any name can change what the
        // tools read.
        parts.push(format!(
            "files of the store: {}",
            others.iter().map(shown).collect::<Vec<_>>().join(", ")
        ));
    }
    if !notes.is_empty() {
        let named: Vec<String> = notes.iter().take(NAMED_IN_TEXT).map(shown).collect();
        parts.push(format!(
            "cleaned notes ({}): {}",
            notes.len(),
            with_more(&named, notes.len().saturating_sub(NAMED_IN_TEXT))
        ));
    }
    let head = &difference.head;
    format!(
        "{}: {}. When you made or accept every change, confirm the state of commit {head} (the command confirm-state --head {head}, the action of the publication center, or the MCP tool confirm_store_state); else take the commits back in the content store",
        start_of(difference),
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
            let parents: Vec<String> =
                serde_json::from_value(case["parents"].clone()).expect("the parents");
            let key = key_of(case["keyByte"].as_str().expect("a byte"), 32);
            assert_eq!(
                state_digest(&files),
                case["digest"].as_str().expect("a digest"),
                "{name}"
            );
            let seal = seal_of(&key, &parents, &files);
            assert_eq!(seal, case["seal"].as_str().expect("a seal"), "{name}");
            // Another key gives another seal.
            assert_ne!(seal_of(&key_of("01", 32), &parents, &files), seal, "{name}");
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
            let read = |ids: &[String]| -> Result<BTreeMap<String, String>, String> {
                Ok(ids
                    .iter()
                    .filter_map(|id| {
                        texts
                            .get(id)
                            .and_then(Value::as_str)
                            .map(|text| (id.clone(), text.to_owned()))
                    })
                    .collect())
            };
            let found = difference_of(
                case["head"].as_str().expect("a head"),
                case["base"].as_str().expect("a base"),
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

    /// A first-parent chain in memory, as a check case gives it.
    struct History {
        key: Vec<u8>,
        commits: Vec<Value>,
        mark: std::cell::RefCell<Option<String>>,
    }

    impl History {
        fn commit(&self, id: &str) -> Option<&Value> {
            self.commits.iter().find(|commit| commit["id"] == id)
        }

        fn parents(commit: &Value) -> Vec<String> {
            serde_json::from_value(commit["parents"].clone()).expect("the parents")
        }

        fn seal_for(&self, id: &str) -> String {
            let commit = self.commit(id).expect("a commit of the case");
            seal_of(
                &self.key,
                &Self::parents(commit),
                &sealed_files(files_of(&commit["files"])),
            )
        }
    }

    impl SealedHistory for History {
        fn commits(&self, limit: usize) -> Result<Vec<Commit>, String> {
            Ok(self
                .commits
                .iter()
                .take(limit)
                .map(|commit| {
                    let id = commit["id"].as_str().expect("an id");
                    Commit {
                        id: id.to_owned(),
                        parents: Self::parents(commit),
                        message: match commit["seal"].as_str() {
                            None => "A commit by hand\n".to_owned(),
                            Some("own") => with_seal("Publish\n", &self.seal_for(id)),
                            Some(other) => with_seal(
                                "Publish\n",
                                &self.seal_for(other.strip_prefix("of ").expect("of <id>")),
                            ),
                        },
                    }
                })
                .collect())
        }

        fn files(&self, commit: &str) -> Result<Vec<TreeFile>, String> {
            self.commit(commit)
                .map(|commit| files_of(&commit["files"]))
                .ok_or_else(|| format!("no commit {commit}"))
        }

        fn objects(&self, _ids: &[String]) -> Result<BTreeMap<String, String>, String> {
            Ok(BTreeMap::new())
        }

        fn mark(&self) -> Result<Option<String>, String> {
            Ok(self.mark.borrow().clone())
        }

        fn descends(&self, commit: &str, ancestor: &str) -> Result<bool, String> {
            if self.commit(ancestor).is_none() {
                return Ok(false);
            }
            let mut seen = BTreeSet::new();
            let mut open = vec![commit.to_owned()];
            while let Some(id) = open.pop() {
                if id == ancestor {
                    return Ok(true);
                }
                if seen.insert(id.clone())
                    && let Some(one) = self.commit(&id)
                {
                    open.extend(Self::parents(one));
                }
            }
            Ok(false)
        }
    }

    #[test]
    fn trusts_the_newest_sealed_commit_with_no_merge_before_it_that_descends_from_the_mark() {
        for case in list(&cases(), "checks") {
            let name = case["name"].as_str().expect("a name");
            let history = History {
                key: key_of(case["keyByte"].as_str().expect("a byte"), 32),
                commits: case["commits"].as_array().expect("the commits").clone(),
                mark: std::cell::RefCell::new(case["mark"].as_str().map(str::to_owned)),
            };
            let checked =
                check_seal(&history, &history.key.clone(), case["floor"].as_str()).expect(name);
            let (status, base, sealed) = match &checked {
                SealCheck::Empty => ("empty", None, None),
                SealCheck::Sealed => ("sealed", None, None),
                SealCheck::Differs(difference) => (
                    "differs",
                    Some(difference.base.clone()),
                    Some(difference.sealed.clone()),
                ),
            };
            assert_eq!(status, case["result"].as_str().expect("a result"), "{name}");
            assert_eq!(base.as_deref(), case["base"].as_str(), "{name}");
            assert_eq!(sealed.as_deref(), case["sealed"].as_str(), "{name}");
            assert_eq!(
                history.mark.borrow().as_deref(),
                case["markAfter"].as_str(),
                "{name}"
            );
        }
    }
}
