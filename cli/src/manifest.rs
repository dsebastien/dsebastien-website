//! The manifest: the record of each published note, one file per note
//! (STORE-03 to STORE-05 of the spec). The TypeScript twin is
//! `apps/plugin/src/publishing/manifest.ts`.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::attachments::{Attachment, is_attachment_hash};
use crate::configuration::is_vault_path;
use crate::device::ContentStore;
use crate::hash::sha256_hex;
use crate::json::parse_json;
use crate::links::NoteLink;
use crate::note_types::{NoteType, note_type_of_entry};

/// The folder of the manifest in the content store.
pub const MANIFEST_FOLDER: &str = "manifest";

/// The folder of the cleaned notes in the content store.
pub const NOTES_FOLDER: &str = "notes";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// The aliases of the note that get a URL, each one time, in the order of
    /// the code points.
    pub aliases: Vec<String>,
    /// The links of the note that lead to a file that is not a note, with the
    /// facts of the file, sorted by their link path.
    pub attachments: Vec<Attachment>,
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
    /// The links of the note that lead to a note, sorted by their link path.
    pub links: Vec<NoteLink>,
    /// The note type of the note, when it has one (decision R61).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_type: Option<NoteType>,
    /// The vault path of the note.
    pub path: String,
    pub source_hash: String,
    pub state: State,
    /// True when a move of a rename journal put the note at a path whose note
    /// had another source: its update waits until a selection includes it
    /// (decision R67). An entry with no held update has no such key.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub update_held: bool,
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
const LARGEST_EXACT_FLOAT: f64 = 9_007_199_254_740_991.0;

/// A whole number from 0, as the TypeScript twin reads it: every number is a
/// floating point number there, so `1.0`, `1e0` and `-0` are whole numbers
/// too.
fn whole_number(value: &Value) -> Option<u64> {
    if value.is_u64() || value.is_i64() {
        return value.as_u64().filter(|number| *number <= LARGEST_EXACT);
    }
    let number = value.as_f64()?;
    let whole = number.fract() == 0.0 && (0.0..=LARGEST_EXACT_FLOAT).contains(&number);
    // The number is whole, not negative and small enough: the cast is exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let converted = number as u64;
    whole.then_some(converted)
}

/// The list `links` of an entry: each item is an object with exactly a link
/// path and the vault path of a note. `None` for every other value.
fn link_list(value: &Value) -> Option<Vec<NoteLink>> {
    value
        .as_array()?
        .iter()
        .map(|item| {
            let item = item.as_object()?;
            let link = item.get("link")?.as_str()?;
            let path = item.get("path")?.as_str()?;
            (item.len() == 2 && is_note_path(path)).then(|| NoteLink {
                link: link.to_owned(),
                path: path.to_owned(),
            })
        })
        .collect()
}

/// True when the name of a path ends in `.md` in any letter case.
fn ends_in_md(path: &str) -> bool {
    path.len() >= 3
        && path.is_char_boundary(path.len() - 3)
        && path[path.len() - 3..].eq_ignore_ascii_case(".md")
}

/// The list `attachments` of an entry. `None` for every other value.
fn attachment_list(value: &Value) -> Option<Vec<Attachment>> {
    const KEYS: [&str; 6] = ["hash", "height", "link", "path", "size", "width"];
    value
        .as_array()?
        .iter()
        .map(|item| {
            let item = item.as_object()?;
            if !item.keys().all(|key| KEYS.contains(&key.as_str())) {
                return None;
            }
            let hash = item
                .get("hash")?
                .as_str()
                .filter(|hash| is_attachment_hash(hash))?;
            let link = item.get("link")?.as_str()?;
            let path = item
                .get("path")?
                .as_str()
                .filter(|path| is_vault_path(path) && !ends_in_md(path))?;
            let size = whole_number(item.get("size")?)?;
            let (width, height) = match (item.get("width"), item.get("height")) {
                (None, None) => (None, None),
                (Some(width), Some(height)) => {
                    let width = whole_number(width).filter(|width| *width > 0)?;
                    let height = whole_number(height).filter(|height| *height > 0)?;
                    (Some(width), Some(height))
                }
                _ => return None,
            };
            Some(Attachment {
                hash: hash.to_owned(),
                height,
                link: link.to_owned(),
                path: path.to_owned(),
                size,
                width,
            })
        })
        .collect()
}

/// Reads one entry from the text of its file. The text is read as a JSON value
/// and checked by hand, as the TypeScript twin does, so that both accept and
/// refuse the same texts. The path and the id are checked, because the tool
/// makes paths of the content store from them.
fn parse_manifest_entry(text: &str) -> Option<ManifestEntry> {
    let value = parse_json(text).ok()?;
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
    let cleaning_version = whole_number(entry.get("cleaningVersion")?)?;
    let state = match text_of("state")?.as_str() {
        "published" => State::Published,
        "unpublished" => State::Unpublished,
        _ => return None,
    };
    // Texts, each one time, in the order of the code points.
    let aliases =
        list_of("aliases").filter(|aliases| aliases.windows(2).all(|pair| pair[0] < pair[1]))?;
    // No key: the note has no type.
    let note_type = match entry.get("noteType") {
        None => None,
        Some(value) => Some(note_type_of_entry(value)?),
    };
    // No key: no held update. The key holds `true` only.
    let update_held = match entry.get("updateHeld") {
        None => false,
        Some(value) if value.as_bool() == Some(true) => true,
        Some(_) => return None,
    };
    Some(ManifestEntry {
        aliases,
        attachments: attachment_list(entry.get("attachments")?)?,
        cleaned_hash: text_of("cleanedHash")?,
        cleaning_version,
        first_published: text_of("firstPublished")?,
        former_paths: list_of("formerPaths")?,
        id: text_of("id").filter(|id| is_note_id(id))?,
        last_published: text_of("lastPublished")?,
        links: link_list(entry.get("links")?)?,
        note_type,
        path: text_of("path").filter(|path| is_note_path(path))?,
        source_hash: text_of("sourceHash")?,
        state,
        update_held,
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
    for file in store.list(MANIFEST_FOLDER)? {
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

#[cfg(test)]
mod tests {
    use super::parse_manifest_entry;
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/json.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/cases.json");

    /// A manifest entry whose `cleaningVersion` is the number as it is
    /// written.
    fn entry_with(cleaning_version: &str) -> String {
        format!(
            r#"{{"aliases":[],"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":{cleaning_version},"firstPublished":"2031-04-01T08:00:00Z","formerPaths":[],"id":"00000000000000aa","lastPublished":"2031-04-01T08:00:00Z","links":[],"path":"A.md","sourceHash":"sha256:00","state":"published"}}"#
        )
    }

    #[test]
    fn reads_the_version_of_the_cleaning_step_as_the_file_states() {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let cases = cases["cleaningVersions"]["cases"]
            .as_array()
            .expect("the cases file has the list");
        assert!(cases.len() > 5);
        for case in cases {
            let text = case["text"].as_str().expect("a text");
            assert_eq!(
                Some(parse_manifest_entry(&entry_with(text)).is_some()),
                case["valid"].as_bool(),
                "{text}"
            );
        }
    }
}
