//! The manifest: the record of each published note, one file per note
//! (STORE-03 to STORE-05 of the spec). The TypeScript twin is
//! `apps/plugin/src/publishing/manifest.ts`.

use serde::{Deserialize, Serialize};

use crate::device::ContentStore;
use crate::hash::sha256_hex;

/// The folder of the manifest in the content store.
pub const MANIFEST_FOLDER: &str = "manifest";

/// The folder of the cleaned notes in the content store.
pub const NOTES_FOLDER: &str = "notes";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// The attachments of the note. A later slice fills it.
    pub attachments: Vec<String>,
    pub cleaned_hash: String,
    pub cleaning_version: u32,
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

#[derive(Debug, Serialize, Deserialize)]
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

/// Reads every entry of the manifest of a content store.
///
/// # Errors
///
/// A file of the manifest is not an entry.
pub fn read_manifest(store: &ContentStore) -> Result<Vec<ManifestEntry>, String> {
    let mut entries = Vec::new();
    for file in store.list(MANIFEST_FOLDER) {
        if let Some(text) = store.read(&file) {
            let entry = serde_json::from_str(&text)
                .map_err(|_| format!("{file} is not a manifest entry"))?;
            entries.push(entry);
        }
    }
    Ok(entries)
}
