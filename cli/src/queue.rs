//! The publication queue: what waits for a publication (PUB-18 of the spec).
//! The rules are in `documentation/Canonical Form.md`, sections "The notes of
//! the vault" and "The publication queue". The TypeScript twin is
//! `apps/plugin/src/publishing/queue.ts`. Change both in the same commit.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::clean::{CLEANING_VERSION, STATE_PROPERTY, source_of};
use crate::configuration::Configuration;
use crate::device::{Entry, Vault};
use crate::frontmatter::{remove_property, set_property};
use crate::guards::guard_of;
use crate::hash::content_hash;
use crate::links::{LinkIndex, link_paths_of, resolve_links, same_links};
use crate::manifest::{ManifestEntry, State};

/// The number of paths of each of the four lists.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    changed: usize,
    new: usize,
    to_remove: usize,
    unchanged: usize,
}

/// The four lists of the queue, as vault paths. Each list is sorted by path.
/// `status` also says how far the copy is behind the content store.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationQueue {
    /// The number of commits of the content store, at the last fetch, that
    /// the copy does not have. A copy that is behind reads an older manifest.
    pub behind: u64,
    /// The published notes whose content in the vault is not the published
    /// content.
    pub changed: Vec<String>,
    counts: Counts,
    /// The candidates.
    pub new: Vec<String>,
    /// The notes of `changed` that the author did not edit: the cleaning step
    /// gives another result.
    pub technical_updates: Vec<String>,
    /// The published notes that cannot stay published as they are.
    pub to_remove: Vec<String>,
    pub unchanged: Vec<String>,
}

/// What the scan knows of one note. The text itself is not kept.
pub struct ScannedNote {
    /// The hash of the text as the scan read it. A later read with another
    /// hash says that the note changed.
    pub text_hash: String,
    pub source_hash: String,
    /// True when the note has the state property in the exact form that the
    /// tool writes.
    pub state_is_set: bool,
    /// True when the note itself names the state property, in any form.
    pub names_state: bool,
}

/// The result of one scan of the vault against the manifest.
pub struct Scan {
    pub queue: PublicationQueue,
    /// Every note of the scan, by its vault path.
    pub notes: BTreeMap<String, ScannedNote>,
    /// The notes of the scan that the ignore property excludes.
    pub ignored: BTreeSet<String>,
    /// The notes of the scan and of the folders of the deny list, by their
    /// names: what a link is resolved against.
    pub index: LinkIndex,
    /// The notes that a guard excludes: a link to one of them gives no item.
    pub guarded: BTreeSet<String>,
    /// The names of the notes in the folders of the deny list, in small
    /// letters. No file of those folders is read.
    pub denied_names: BTreeSet<String>,
    /// Every entry of the manifest, by the vault path of its note.
    pub manifest: BTreeMap<String, ManifestEntry>,
    pub configuration: Configuration,
}

impl Scan {
    /// True when the note has a manifest entry whose state is `published`.
    pub fn is_published(&self, path: &str) -> bool {
        self.manifest
            .get(path)
            .is_some_and(|entry| entry.state == State::Published)
    }
}

/// The vault paths of the notes of the vault. The caller gets them in the
/// order of the canonical form through the map that it fills.
fn scan_vault(vault: &Vault, configuration: &Configuration) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    let mut folders = vec![String::new()];
    while let Some(folder) = folders.pop() {
        for (name, kind) in vault.list(&folder)? {
            // The replacement character stands for bytes of a name that are
            // not valid Unicode.
            if name.starts_with('.') || name.contains('\u{fffd}') {
                continue;
            }
            let path = if folder.is_empty() {
                name
            } else {
                format!("{folder}/{name}")
            };
            if kind == Entry::Folder {
                // A folder of the deny list is not scanned for notes: none of
                // its files is read.
                if !configuration.deny_list.contains(&path) {
                    folders.push(path);
                }
            } else {
                // Letter case is never ignored in the logic.
                #[allow(clippy::case_sensitive_file_extension_comparisons)]
                let is_note = path.ends_with(".md");
                if is_note {
                    notes.push(path);
                }
            }
        }
    }
    Ok(notes)
}

/// The vault paths of the notes in the folders of the deny list. The tool lists
/// those folders for two reasons: to know that a published note moved into one
/// of them, and to know that a link leads to a note under that guard. It reads
/// none of their files, and it writes none of these paths.
fn scan_denied(vault: &Vault, configuration: &Configuration) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    let mut folders = configuration.deny_list.clone();
    while let Some(folder) = folders.pop() {
        for (name, kind) in vault.list(&folder)? {
            if name.starts_with('.') || name.contains('\u{fffd}') {
                continue;
            }
            let path = format!("{folder}/{name}");
            if kind == Entry::Folder {
                folders.push(path);
            } else {
                // Letter case is never ignored for the end of a name.
                #[allow(clippy::case_sensitive_file_extension_comparisons)]
                let is_note = path.ends_with(".md");
                if is_note {
                    notes.push(path);
                }
            }
        }
    }
    Ok(notes)
}

/// Scans the vault and fills the four lists of the queue. The state property
/// of a note is never an input (PUB-12): it is read only to know which notes
/// the correction after a publication must write.
///
/// # Errors
///
/// A folder cannot be listed, or a note cannot be read: a note that cannot be
/// read is never taken for a note without the ignore property.
pub fn compute_queue(
    vault: &Vault,
    manifest: BTreeMap<String, ManifestEntry>,
    configuration: Configuration,
) -> Result<Scan, String> {
    // A `BTreeMap` of `String` keeps the order of the code points.
    let mut notes = BTreeMap::new();
    let mut ignored = BTreeSet::new();
    // The link paths of the published notes: their links are computed again
    // at each scan.
    let mut link_paths: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for path in scan_vault(vault, &configuration)? {
        let text = vault
            .read(&path)
            .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?;
        // `None`: the file went away during the scan.
        let Some(text) = text else { continue };
        // The scan left the folders of the deny list out, so only the ignore
        // property is left.
        if guard_of(&path, &text, &configuration).is_some() {
            ignored.insert(path.clone());
        }
        let source = source_of(&text);
        let published = manifest
            .get(&path)
            .is_some_and(|entry| entry.state == State::Published);
        if published {
            link_paths.insert(path.clone(), link_paths_of(&source));
        }
        notes.insert(
            path,
            ScannedNote {
                text_hash: content_hash(&text),
                source_hash: content_hash(&source),
                state_is_set: set_property(&text, STATE_PROPERTY, "true") == text,
                names_state: remove_property(&text, STATE_PROPERTY) != text,
            },
        );
    }

    // A link that Obsidian leads to a note under a guard must not lead to
    // another note of the same name. So the notes of the deny list folders
    // are candidates too, by their paths alone, and such a target gives no
    // item.
    let denied = scan_denied(vault, &configuration)?;
    let index = LinkIndex::new(notes.keys().chain(denied.iter()));
    let guarded: BTreeSet<String> = ignored.iter().chain(denied.iter()).cloned().collect();
    // The links that a published note has now, from its link paths.
    let links_now = |path: &String| {
        let link_paths = link_paths.get(path).map_or(&[][..], Vec::as_slice);
        resolve_links(link_paths, path, &index, &guarded)
    };
    let mut queue = PublicationQueue {
        behind: 0,
        changed: Vec::new(),
        counts: Counts {
            changed: 0,
            new: 0,
            to_remove: 0,
            unchanged: 0,
        },
        new: Vec::new(),
        technical_updates: Vec::new(),
        to_remove: Vec::new(),
        unchanged: Vec::new(),
    };
    // Both maps give their paths in the order of the code points, so each list
    // is sorted as it is filled.
    for (path, entry) in &manifest {
        if entry.state != State::Published {
            continue;
        }
        match notes.get(path) {
            // Missing from this vault, in a folder of the deny list, or with
            // the ignore property.
            None => queue.to_remove.push(path.clone()),
            Some(_) if ignored.contains(path) => queue.to_remove.push(path.clone()),
            Some(note) if note.source_hash != entry.source_hash => {
                queue.changed.push(path.clone());
            }
            // The cleaning step would give another result: it has another
            // version, or a target was made, moved or removed, or a guard now
            // excludes it.
            Some(_)
                if entry.cleaning_version != CLEANING_VERSION
                    || !same_links(&links_now(path), &entry.links) =>
            {
                queue.changed.push(path.clone());
                queue.technical_updates.push(path.clone());
            }
            Some(_) => queue.unchanged.push(path.clone()),
        }
    }
    for path in notes.keys() {
        let published = manifest
            .get(path)
            .is_some_and(|entry| entry.state == State::Published);
        if !published && !ignored.contains(path) {
            queue.new.push(path.clone());
        }
    }
    queue.counts = Counts {
        changed: queue.changed.len(),
        new: queue.new.len(),
        to_remove: queue.to_remove.len(),
        unchanged: queue.unchanged.len(),
    };
    let denied_names = denied
        .iter()
        .map(|path| path.rsplit('/').next().unwrap_or(path).to_lowercase())
        .collect();
    Ok(Scan {
        queue,
        notes,
        ignored,
        index,
        guarded,
        denied_names,
        manifest,
        configuration,
    })
}
