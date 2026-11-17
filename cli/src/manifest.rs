//! The manifest: the record of each published note, one file per note
//! (STORE-03 to STORE-05 of the spec). The TypeScript twin is
//! `apps/plugin/src/publishing/manifest.ts`.

use serde::Serialize;
use serde_json::Value;

use crate::device::ContentStore;
use crate::hash::sha256_hex;

/// The folder of the manifest in the content store.
pub const MANIFEST_FOLDER: &str = "manifest";

/// The folder of the cleaned notes in the content store.
pub const NOTES_FOLDER: &str = "notes";

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Published,
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
/// refuse the same texts.
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
    if text_of("state")? != "published" {
        return None;
    }
    Some(ManifestEntry {
        attachments: list_of("attachments")?,
        cleaned_hash: text_of("cleanedHash")?,
        cleaning_version,
        first_published: text_of("firstPublished")?,
        former_paths: list_of("formerPaths")?,
        id: text_of("id")?,
        last_published: text_of("lastPublished")?,
        path: text_of("path")?,
        source_hash: text_of("sourceHash")?,
        state: State::Published,
    })
}

/// Reads every entry of the manifest of a content store.
///
/// # Errors
///
/// A file of the manifest cannot be read or is not an entry.
pub fn read_manifest(store: &ContentStore) -> Result<Vec<ManifestEntry>, String> {
    let mut entries = Vec::new();
    for file in store.list(MANIFEST_FOLDER) {
        if let Some(text) = store.read(&file)? {
            let entry = parse_manifest_entry(&text)
                .ok_or_else(|| format!("{file} is not a manifest entry"))?;
            entries.push(entry);
        }
    }
    Ok(entries)
}
