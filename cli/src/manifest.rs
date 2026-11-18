//! The manifest: the record of each published note, one file per note
//! (STORE-03 to STORE-05 of the spec). The TypeScript twin is
//! `apps/plugin/src/publishing/manifest.ts`.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::configuration::is_vault_path;
use crate::device::ContentStore;
use crate::hash::sha256_hex;

/// The folder of the manifest in the content store.
pub const MANIFEST_FOLDER: &str = "manifest";

/// The folder of the cleaned notes in the content store.
pub const NOTES_FOLDER: &str = "notes";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// The attachments of the note. A later slice fills it.
    pub attachments: Vec<String>,
    pub cleaned_hash: String,
    pub cleaning_version: u64,
    /// The time of the run of the first publication.
    pub first_published: String,
    /// The paths that the note had before, in the order in which they were
    /// added.
    pub former_paths: Vec<String>,
    /// The identity of the note. Nothing writes it into the note.
    pub id: String,
    /// The time of the run of the last publication.
    pub last_published: String,
    /// The vault path of the note.
    pub path: String,
    pub source_hash: String,
    pub state: State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Published,
    /// After a publication removed the note. The entry stays: it keeps the
    /// identity of the note.
    Unpublished,
}

/// True when the path is the vault path of a note: its name ends in `.md`, in
/// small letters. Letter case is never ignored in the logic
/// (`documentation/Canonical Form.md`), and the TypeScript twin compares in
/// the same way.
pub fn is_note_path(path: &str) -> bool {
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let is_note = path.ends_with(".md");
    is_vault_path(path) && is_note
}

/// True when the text has the form of the identity of a note: 16 hexadecimal
/// digits, in small letters. It names the file of the entry.
fn is_note_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The path of the entry of a note in the content store.
pub fn manifest_file(id: &str) -> String {
    format!("{MANIFEST_FOLDER}/{id}.json")
}

/// The identity of a note that is published for the first time: 16 digits of
/// the hash of its path and of the time of the run. Both are inputs, so both
/// implementations give the same identity.
pub fn note_id(path: &str, first_published: &str) -> String {
    sha256_hex(&format!("{path}\n{first_published}"))[..16].to_owned()
}

/// The largest whole number that the TypeScript twin holds exactly.
const LARGEST_EXACT: u64 = 9_007_199_254_740_991;

/// Reads one entry from the text of its file. The text is read as a JSON value
/// and checked by hand, as the TypeScript twin does, so that both accept and
/// refuse the same texts. The path and the id are checked, because the tool
/// makes paths of the content store from them.
fn parse_manifest_entry(text: &str) -> Option<ManifestEntry> {
    let value: Value = serde_json::from_str(text).ok()?;
    let entry = value.as_object()?;
    let text_of = |key: &str| entry.get(key)?.as_str().map(str::to_owned);
    let list_of = |key: &str| {
        entry
            .get(key)?
            .as_array()?
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<String>>>()
    };
    let cleaning_version = entry
        .get("cleaningVersion")?
        .as_u64()
        .filter(|version| *version <= LARGEST_EXACT)?;
    let state = match text_of("state")?.as_str() {
        "published" => State::Published,
        "unpublished" => State::Unpublished,
        _ => return None,
    };
    Some(ManifestEntry {
        attachments: list_of("attachments")?,
        cleaned_hash: text_of("cleanedHash")?,
        cleaning_version,
        first_published: text_of("firstPublished")?,
        former_paths: list_of("formerPaths")?,
        id: text_of("id").filter(|id| is_note_id(id))?,
        last_published: text_of("lastPublished")?,
        path: text_of("path").filter(|path| is_note_path(path))?,
        source_hash: text_of("sourceHash")?,
        state,
    })
}

/// Reads every entry of the manifest of a content store, by the vault path of
/// its note.
///
/// # Errors
///
/// A file of the manifest cannot be read or is not an entry, a file does not
/// have the name of its entry, or two entries have the same path.
pub fn read_manifest(store: &ContentStore) -> Result<BTreeMap<String, ManifestEntry>, String> {
    let mut entries = BTreeMap::new();
    for file in store.list(MANIFEST_FOLDER) {
        let Some(text) = store.read(&file)? else {
            continue;
        };
        let entry =
            parse_manifest_entry(&text).ok_or_else(|| format!("{file} is not a manifest entry"))?;
        if file != manifest_file(&entry.id) {
            return Err(format!(
                "{file} does not have the name of its manifest entry"
            ));
        }
        if entries.contains_key(&entry.path) {
            return Err(format!(
                "two manifest entries have the path \"{}\"",
                entry.path
            ));
        }
        entries.insert(entry.path.clone(), entry);
    }
    Ok(entries)
}
