//! The publication queue: what waits for a publication (PUB-18 of the spec).
//! The rules are in `documentation/Canonical Form.md`, sections "The notes of
//! the vault" and "The publication queue". The TypeScript twin is
//! `apps/plugin/src/publishing/queue.ts`. Change both in the same commit.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::attachments::{FileReader, attachments_of};
use crate::clean::{CLEANING_VERSION, STATE_PROPERTY, source_of};
use crate::configuration::Configuration;
use crate::device::{Entry, Vault};
use crate::frontmatter::{remove_property, set_property};
use crate::guards::{guard_of, in_deny_list};
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
    /// The notes of `to_remove` whose file this device does not have and that
    /// no guard excludes: missing from this vault. Never selected by default
    /// (PUB-95).
    pub missing: Vec<String>,
    /// The candidates.
    pub new: Vec<String>,
    /// The notes of `changed` that the author did not edit: the cleaning step
    /// gives another result.
    pub technical_updates: Vec<String>,
    /// The published notes that cannot stay published as they are.
    pub to_remove: Vec<String>,
    pub unchanged: Vec<String>,
}

impl PublicationQueue {
    /// A queue with four empty lists.
    fn empty() -> Self {
        Self {
            behind: 0,
            changed: Vec::new(),
            counts: Counts {
                changed: 0,
                new: 0,
                to_remove: 0,
                unchanged: 0,
            },
            missing: Vec::new(),
            new: Vec::new(),
            technical_updates: Vec::new(),
            to_remove: Vec::new(),
            unchanged: Vec::new(),
        }
    }

    /// Counts the paths of each of the four lists.
    fn count(&mut self) {
        self.counts = Counts {
            changed: self.changed.len(),
            new: self.new.len(),
            to_remove: self.to_remove.len(),
            unchanged: self.unchanged.len(),
        };
    }
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
    /// The files of the scan and of the folders of the deny list, by their
    /// names: what a link is resolved against.
    pub index: LinkIndex,
    /// The files that a guard excludes: a link to one of them gives no item.
    pub guarded: BTreeSet<String>,
    /// The files that the notes link to, each one read one time per run.
    pub files: FileReader,
    /// The other files of the scan: the files that are not notes.
    pub others: BTreeSet<String>,
    /// The names of every file in the folders of the deny list, in small
    /// letters, hidden ones included.
    pub denied_file_names: BTreeSet<String>,
    /// Every entry of the manifest, by the vault path of its note.
    pub manifest: BTreeMap<String, ManifestEntry>,
    pub configuration: Configuration,
}

impl Scan {
    /// True when the file of an attachment of a manifest entry is under a
    /// guard now: its path is in a folder of the deny list, or a file of its
    /// name is in such a folder, hidden names included, and the scan has no
    /// file at its path with the hash of the entry (the file may have moved
    /// there, and another file may have its old path: names only, so it fails
    /// closed). Such an attachment leaves the attachment storage, whatever the
    /// plan holds.
    pub fn is_guarded_file(&self, vault: &Vault, path: &str, hash: &str) -> bool {
        if self
            .configuration
            .deny_list
            .iter()
            .any(|folder| path.starts_with(&format!("{folder}/")))
        {
            return true;
        }
        let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
        if !self.denied_file_names.contains(&name) {
            return false;
        }
        // A file that cannot be read now is taken for a moved one.
        !self.others.contains(path)
            || self
                .files
                .facts(vault, path)
                .map_or(true, |facts| facts.hash != hash)
    }

    /// True when the note has a manifest entry whose state is `published`.
    pub fn is_published(&self, path: &str) -> bool {
        self.manifest
            .get(path)
            .is_some_and(|entry| entry.state == State::Published)
    }
}

/// The vault paths of the files of the vault, outside the folders of the deny
/// list: its notes, and its other files, which a note can link to. The caller
/// gets the notes in the order of the canonical form through the map that it
/// fills.
fn scan_vault(
    vault: &Vault,
    configuration: &Configuration,
) -> Result<(Vec<String>, Vec<String>), String> {
    let mut notes = Vec::new();
    let mut others = Vec::new();
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
                } else {
                    others.push(path);
                }
            }
        }
    }
    Ok((notes, others))
}

/// The vault paths of the files in the folders of the deny list, notes and
/// other files. The tool lists those folders for two reasons: to know that a
/// published note moved into one of them, and to know that a link leads to a
/// file under that guard. It reads none of their files, and it writes none of
/// these paths.
///
/// It also gives the name of every file of those folders, in small letters,
/// also below a name that starts with a dot or that is not valid Unicode: a
/// file moved there is still under the guard. Obsidian does not show them, so
/// they are no candidates of a link.
fn scan_denied(
    vault: &Vault,
    configuration: &Configuration,
) -> Result<(Vec<String>, BTreeSet<String>), String> {
    let mut files = Vec::new();
    let mut names = BTreeSet::new();
    let mut folders: Vec<(String, bool)> = configuration
        .deny_list
        .iter()
        .map(|folder| (folder.clone(), false))
        .collect();
    while let Some((folder, hidden)) = folders.pop() {
        for (name, kind) in vault.list(&folder)? {
            let hidden = hidden || name.starts_with('.') || name.contains('\u{fffd}');
            let path = format!("{folder}/{name}");
            if kind == Entry::Folder {
                folders.push((path, hidden));
            } else {
                names.insert(name.to_lowercase());
                if !hidden {
                    files.push(path);
                }
            }
        }
    }
    Ok((files, names))
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
    let (scanned, others) = scan_vault(vault, &configuration)?;
    for path in scanned {
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

    // A link that Obsidian leads to a file under a guard must not lead to
    // another file of the same name. So the files of the deny list folders
    // are candidates too, by their paths alone, and such a target gives no
    // item.
    let (denied, denied_file_names) = scan_denied(vault, &configuration)?;
    let index = LinkIndex::new(notes.keys().chain(others.iter()).chain(denied.iter()));
    let guarded: BTreeSet<String> = ignored.iter().chain(denied.iter()).cloned().collect();
    let files = FileReader::default();
    // True when the cleaning step gives another result for a published note:
    // it has another version, or a target was made, moved or removed, or a
    // file was added, changed, moved or removed, or a guard now excludes one.
    let is_technical_update = |path: &String, entry: &ManifestEntry| -> Result<bool, String> {
        if entry.cleaning_version != CLEANING_VERSION {
            return Ok(true);
        }
        let link_paths = link_paths.get(path).map_or(&[][..], Vec::as_slice);
        let targets = resolve_links(link_paths, path, &index, &guarded);
        Ok(!same_links(&targets.links, &entry.links)
            || attachments_of(&targets.files, vault, &files)? != entry.attachments)
    };
    let mut queue = PublicationQueue::empty();
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
            Some(_) => {
                if is_technical_update(path, entry)? {
                    queue.changed.push(path.clone());
                    queue.technical_updates.push(path.clone());
                } else {
                    queue.unchanged.push(path.clone());
                }
            }
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
    queue.count();
    // A published note waits for its removal under a guard when its path is
    // in a folder of the deny list, it has the ignore property, or its file is
    // missing and a note of its name is in a folder of the deny list (it moved
    // there: the names in small letters, hidden ones included). Every other
    // one is only missing from this vault. The list stays sorted.
    let moved_under_guard = |path: &String| {
        let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
        #[allow(clippy::case_sensitive_file_extension_comparisons)]
        let is_note = name.ends_with(".md");
        is_note && denied_file_names.contains(&name)
    };
    queue.missing = queue
        .to_remove
        .iter()
        .filter(|path| {
            !in_deny_list(path, &configuration)
                && !ignored.contains(*path)
                && !moved_under_guard(path)
        })
        .cloned()
        .collect();
    Ok(Scan {
        queue,
        notes,
        ignored,
        index,
        guarded,
        files,
        others: others.into_iter().collect(),
        denied_file_names,
        manifest,
        configuration,
    })
}
