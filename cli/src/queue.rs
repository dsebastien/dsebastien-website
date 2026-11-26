//! The publication queue: what waits for a publication (PUB-18 of the spec).
//! The rules are in `documentation/Canonical Form.md`, sections "The notes of
//! the vault" and "The publication queue". The TypeScript twin is
//! `apps/plugin/src/publishing/queue.ts`. Change both in the same commit.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::attachments::{FileReader, TooLarge, attachments_of, sort_too_large, too_large_of};
use crate::clean::{CLEANING_VERSION, STATE_PROPERTY, source_of};
use crate::configuration::Configuration;
use crate::device::{Entry, Vault};
use crate::edits::{EditLog, Event};
use crate::frontmatter::{remove_property, set_property};
use crate::guards::{guard_of, in_deny_list};
use crate::hash::content_hash;
use crate::links::{LinkIndex, link_paths_of, resolve_links, same_links};
use crate::manifest::{ManifestEntry, State};
use crate::names::{
    first_part, folded_form, is_changed_by_obsidian, is_refused_by_windows, is_reserved_root_name,
    obsidian_path, obsidian_twins,
};
use crate::note_types::{NoteType, StarterKit, note_types_of};
use crate::renames::{Fold, JournalState, RenameWarning, fold_moves, former_paths_after};
use crate::small_letters::guard_name;

/// A move of a manifest entry: from its path to its new path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Move {
    pub from: String,
    pub to: String,
}

impl Move {
    /// Reads a move from data: an object with exactly a text `from` and a text
    /// `to`. `None` in every other case.
    pub fn of(value: &serde_json::Value) -> Option<Self> {
        let object = value.as_object().filter(|object| object.len() == 2)?;
        Some(Self {
            from: object.get("from")?.as_str()?.to_owned(),
            to: object.get("to")?.as_str()?.to_owned(),
        })
    }
}

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
    /// The notes of `changed` at the new path of a move of `renamed` whose
    /// source is not the published source: an edit after the rename, or
    /// another note at that path. Their update waits until the selection
    /// includes them (decision R67).
    pub moved_edited: Vec<String>,
    /// The candidates.
    pub new: Vec<String>,
    /// The pairings to confirm: a published note that is missing and a
    /// candidate with no manifest entry, with the same source (PUB-62).
    pub pairings: Vec<Move>,
    /// The open proposals of the log of the edits of the guards, in the order
    /// of the log (R69). Apart from the four lists: they are not counted.
    pub proposals: Vec<Event>,
    /// The moves of the new lines of the rename journals that the next
    /// publication applies.
    pub renamed: Vec<Move>,
    /// The notes of `changed` that the author did not edit: the cleaning step
    /// gives another result.
    pub technical_updates: Vec<String>,
    /// The published notes that cannot stay published as they are.
    pub to_remove: Vec<String>,
    /// The published notes of `changed` and `unchanged` that link to a file
    /// above the size limit of an attachment, each with the file and its size
    /// (issue 72): their update waits, and no plan updates them. Sorted by
    /// path, then by file.
    pub too_large: Vec<TooLarge>,
    pub unchanged: Vec<String>,
    /// The paths of the unpublished entries of the manifest, as the content
    /// store has them: the exact paths that a takedown takes (issue 104).
    /// Also an entry whose file this device does not have. Apart from the
    /// four lists: they are not counted.
    pub unpublished: Vec<String>,
    /// The unpublished notes that a guard excludes: forced removals of the
    /// next plan, so that their addresses answer 404 and no more 410
    /// (decision R64). Apart from the four lists: they are not counted.
    pub unpublished_under_guard: Vec<String>,
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
            moved_edited: Vec::new(),
            new: Vec::new(),
            pairings: Vec::new(),
            proposals: Vec::new(),
            renamed: Vec::new(),
            technical_updates: Vec::new(),
            to_remove: Vec::new(),
            too_large: Vec::new(),
            unchanged: Vec::new(),
            unpublished: Vec::new(),
            unpublished_under_guard: Vec::new(),
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
#[derive(Clone)]
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
    /// Every entry of the manifest after the moves of the rename journals, by
    /// the vault path of its note.
    pub manifest: BTreeMap<String, ManifestEntry>,
    /// The unpublished entries that leave the manifest because another entry
    /// moved into their paths (rule 6 of the moves).
    pub displaced: Vec<ManifestEntry>,
    /// The entries whose held update ended: their notes have their sources
    /// again, and the next publication writes them without `updateHeld`.
    pub released: Vec<ManifestEntry>,
    /// The journals that the scan read: the plan writes their read marker.
    pub journals: JournalState,
    /// The warnings of the journals and of the moves, for the report.
    pub rename_warnings: Vec<RenameWarning>,
    pub configuration: Configuration,
    /// The log of the edits of the guards (R69): the queue shows its open
    /// proposals, and the plan its events since the last publication.
    pub edits: EditLog,
    /// The note type of each published note that the scan found and that no
    /// guard excludes, when it has one.
    pub note_types: BTreeMap<String, NoteType>,
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
        let name = guard_name(path.rsplit('/').next().unwrap_or(path));
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

    /// The files above the size limit that the notes at these paths link to
    /// (`tooLarge` of a plan): for the candidates of a plan, whose links the
    /// scan does not read. Sorted by path, then by file.
    ///
    /// # Errors
    ///
    /// A note or the size of a file cannot be read.
    pub fn too_large_of(&self, vault: &Vault, paths: &[String]) -> Result<Vec<TooLarge>, String> {
        let mut found = Vec::new();
        for path in paths {
            let text = vault
                .read(path)
                .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?;
            if let Some(text) = text {
                let source = source_of(&text);
                let targets =
                    resolve_links(&link_paths_of(&source), path, &self.index, &self.guarded);
                found.extend(too_large_of(path, &targets.files, vault, &self.files)?);
            }
        }
        sort_too_large(&mut found);
        Ok(found)
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
                names.insert(guard_name(&name));
                if !hidden {
                    files.push(path);
                }
            }
        }
    }
    Ok((files, names))
}

/// The published notes that the scan found and that no guard excludes, in
/// the order of the code points: the question to the Starter Kit. A note
/// under a guard is never in it.
fn published_question(
    notes: &BTreeMap<String, ScannedNote>,
    manifest: &BTreeMap<String, ManifestEntry>,
    ignored: &BTreeSet<String>,
) -> Vec<String> {
    // Never a note with a twin: Obsidian can answer for the twin (R72).
    let twins = obsidian_twins(notes.keys());
    notes
        .keys()
        .filter(|path| {
            manifest
                .get(*path)
                .is_some_and(|entry| entry.state == State::Published)
                && !ignored.contains(*path)
                && !twins.contains_key(*path)
        })
        .cloned()
        .collect()
}

/// What the guards of a scan exclude: the deny list, the notes with the
/// ignore property, and the names of the files in the folders of the deny list.
struct Guards<'a> {
    configuration: &'a Configuration,
    ignored: &'a BTreeSet<String>,
    denied_file_names: &'a BTreeSet<String>,
    /// The entries that a line of a journal moved under a guard: the exact move.
    moved_under: &'a BTreeSet<String>,
    /// The unpublished entries that a line of a journal moved to a path with
    /// no guard: the exact move, so no note of their name moved under a guard.
    moved_elsewhere: &'a BTreeSet<String>,
}

/// The paths of `to_remove` that are only missing from this vault: no
/// guard excludes them.
fn missing_of(to_remove: &[String], guards: &Guards) -> Vec<String> {
    let Guards {
        configuration,
        ignored,
        denied_file_names,
        moved_under,
        moved_elsewhere: _,
    } = guards;
    // A published note waits for its removal under a guard when its path is
    // in a folder of the deny list, it has the ignore property, or its file is
    // missing and a note of its name is in a folder of the deny list (it moved
    // there: the names in small letters, hidden ones included). Every other
    // one is only missing from this vault. The list stays sorted.
    to_remove
        .iter()
        .filter(|path| {
            !in_deny_list(path, configuration)
                && !ignored.contains(*path)
                && !moved_under.contains(*path)
                && !moved_under_guard(path, denied_file_names)
        })
        .cloned()
        .collect()
}

/// True when a note of the name of this path is in a folder of the deny list
/// (the names in small letters, hidden ones included): the note may have
/// moved there.
fn moved_under_guard(path: &str, denied_file_names: &BTreeSet<String>) -> bool {
    let name = guard_name(path.rsplit('/').next().unwrap_or(path));
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let is_note = name.ends_with(".md");
    is_note && denied_file_names.contains(&name)
}

/// The unpublished notes that a guard excludes, in the three cases of a
/// published note; for the third, the scan did not find the file (decision
/// R64), and no line of a journal moved the note elsewhere (issue 105). The
/// map gives its paths in the order of the code points.
fn unpublished_under_guard(
    manifest: &BTreeMap<String, ManifestEntry>,
    notes: &BTreeMap<String, ScannedNote>,
    guards: &Guards,
) -> Vec<String> {
    let Guards {
        configuration,
        ignored,
        denied_file_names,
        moved_under,
        moved_elsewhere,
    } = guards;
    manifest
        .iter()
        .filter(|(path, entry)| {
            entry.state == State::Unpublished
                && (in_deny_list(path, configuration)
                    || ignored.contains(*path)
                    || moved_under.contains(*path)
                    || (!notes.contains_key(*path)
                        && !moved_elsewhere.contains(*path)
                        && moved_under_guard(path, denied_file_names)))
        })
        .map(|(path, _)| path.clone())
        .collect()
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
    entries: &BTreeMap<String, ManifestEntry>,
    journals: JournalState,
    configuration: Configuration,
    kit: &StarterKit,
) -> Result<Scan, String> {
    let read = read_vault(vault, entries, &journals, &configuration)?;
    queue_of(
        vault,
        entries,
        journals,
        configuration,
        kit,
        read,
        FileReader::default(),
    )
}

/// What one read of the vault gives for one set of guards: the notes of the
/// scan, the other files, and the files of the folders of the deny list.
#[derive(Clone)]
pub struct VaultRead {
    notes: BTreeMap<String, ScannedNote>,
    ignored: BTreeSet<String>,
    link_paths: BTreeMap<String, Vec<String>>,
    others: Vec<String>,
    denied: Vec<String>,
    denied_file_names: BTreeSet<String>,
}

/// Reads the vault one time for these guards.
fn read_vault(
    vault: &Vault,
    entries: &BTreeMap<String, ManifestEntry>,
    journals: &JournalState,
    configuration: &Configuration,
) -> Result<VaultRead, String> {
    let folded = fold_moves(
        entries.keys().cloned(),
        &journals.lines,
        &unpublished_paths(entries),
    );
    let published_paths = published_paths_of(entries, &folded.positions);
    let (scanned, others) = scan_vault(vault, configuration)?;
    let ScannedNotes {
        notes,
        ignored,
        link_paths,
    } = read_notes(vault, scanned, configuration, &published_paths)?;
    // A link that Obsidian leads to a file under a guard must not lead to
    // another file of the same name. So the files of the deny list folders
    // are candidates too, by their paths alone, and such a target gives no
    // item.
    let (denied, denied_file_names) = scan_denied(vault, configuration)?;
    Ok(VaultRead {
        notes,
        ignored,
        link_paths,
        others,
        denied,
        denied_file_names,
    })
}

/// One change of the guards, for the two queues of an edit (rule 2 of "The
/// edits of the guards").
#[derive(Clone, Copy)]
pub enum GuardChange<'a> {
    /// The folder goes on the deny list.
    Deny(&'a str),
    /// The note is read as excluded by the ignore property.
    Ignore(&'a str),
}

impl VaultRead {
    /// The same read with the guards changed: a folder on the deny list,
    /// whose notes and files leave the scan and become files under the guard,
    /// or a note read as excluded by the ignore property. No note is read again: the listings of the vault are the
    /// ones of the run, and only the names below a hidden folder of the new
    /// folder are listed for the first time.
    fn changed(&self, vault: &Vault, change: GuardChange) -> Result<Self, String> {
        let mut read = self.clone();
        match change {
            GuardChange::Ignore(path) => {
                if read.notes.contains_key(path) {
                    read.ignored.insert(path.to_owned());
                }
            }
            GuardChange::Deny(folder) => {
                let below = format!("{folder}/");
                read.notes.retain(|path, _| !path.starts_with(&below));
                read.ignored.retain(|path| !path.starts_with(&below));
                read.link_paths.retain(|path, _| !path.starts_with(&below));
                read.others.retain(|path| !path.starts_with(&below));
                let (files, names) = scan_denied(
                    vault,
                    &Configuration {
                        deny_list: vec![folder.to_owned()],
                    },
                )?;
                let mut denied: BTreeSet<String> = read.denied.into_iter().collect();
                denied.extend(files);
                read.denied = denied.into_iter().collect();
                read.denied_file_names.extend(names);
            }
        }
        Ok(read)
    }
}

/// Two queues from one read of the vault, of the journals and of the
/// manifest: with these guards, and with the guards changed (rule 2 of "The
/// edits of the guards"). A write during the run cannot make the two
/// see other states. The second one reads the facts of the attachments that
/// the first one read. The Starter Kit is not asked: what a change of the
/// guards takes away does not depend on the note types.
///
/// # Errors
///
/// As `compute_queue`.
pub fn compute_guard_queues(
    vault: &Vault,
    entries: &BTreeMap<String, ManifestEntry>,
    journals: JournalState,
    configuration: &Configuration,
    change: GuardChange,
) -> Result<(Scan, Scan), String> {
    let kit = StarterKit::none();
    let read = read_vault(vault, entries, &journals, configuration)?;
    let edited = read.changed(vault, change)?;
    let mut changed = configuration.clone();
    if let GuardChange::Deny(folder) = change {
        changed.deny_list.push(folder.to_owned());
    }
    let base = queue_of(
        vault,
        entries,
        journals.clone(),
        configuration.clone(),
        &kit,
        read,
        FileReader::default(),
    )?;
    let files = base.files.clone();
    let after = queue_of(vault, entries, journals, changed, &kit, edited, files)?;
    Ok((base, after))
}

/// The paths of the unpublished entries of the manifest, as the content store
/// has them: the exact paths that a takedown takes (issue 104). The map gives
/// its paths in the order of the code points.
fn unpublished_of(entries: &BTreeMap<String, ManifestEntry>) -> Vec<String> {
    entries
        .iter()
        .filter(|(_, entry)| entry.state == State::Unpublished)
        .map(|(path, _)| path.clone())
        .collect()
}

/// Computes the queue from one read of the vault.
fn queue_of(
    vault: &Vault,
    entries: &BTreeMap<String, ManifestEntry>,
    journals: JournalState,
    configuration: Configuration,
    kit: &StarterKit,
    read: VaultRead,
    files: FileReader,
) -> Result<Scan, String> {
    let VaultRead {
        notes,
        ignored,
        link_paths,
        others,
        denied,
        denied_file_names,
    } = read;
    let folded = fold_moves(
        entries.keys().cloned(),
        &journals.lines,
        &unpublished_paths(entries),
    );
    let moves = apply_moves(
        entries,
        folded,
        |path| in_deny_list(path, &configuration) || ignored.contains(path),
        |path| notes.contains_key(path),
        |path| notes.get(path).map(|note| note.source_hash.clone()),
    );
    let mut manifest = moves.manifest;
    let index = LinkIndex::new(notes.keys().chain(others.iter()).chain(denied.iter()));
    let guarded: BTreeSet<String> = ignored.iter().chain(denied.iter()).cloned().collect();
    // The type that each published note has now, in one question.
    let note_types = note_types_of(kit, &published_question(&notes, &manifest, &ignored))?;
    // True when the cleaning step gives another result for a published note:
    // it has another version, or a target was made, moved or removed, or a
    // file was added, changed, moved or removed, or a guard now excludes one.
    // The files above the size limit that a published note links to: only
    // their sizes are read (issue 72).
    let targets_of = |path: &String| {
        let link_paths = link_paths.get(path).map_or(&[][..], Vec::as_slice);
        resolve_links(link_paths, path, &index, &guarded)
    };
    let is_technical_update = |path: &String, entry: &ManifestEntry| -> Result<bool, String> {
        if entry.cleaning_version != CLEANING_VERSION {
            return Ok(true);
        }
        let targets = targets_of(path);
        Ok(!same_links(&targets.links, &entry.links)
            || attachments_of(&targets.files, vault, &files)? != entry.attachments
            // The Starter Kit gives the note another type, or the type
            // changed.
            || note_types.get(path) != entry.note_type.as_ref())
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
            // With the ignore property, or moved under a guard by a line of a
            // journal, also when this device still has the file (the guards
            // win).
            Some(_) if ignored.contains(path) || moves.under_guard.contains(path) => {
                queue.to_remove.push(path.clone());
            }
            Some(note) => {
                let too_large = too_large_of(path, &targets_of(path).files, vault, &files)?;
                // The attachments cannot be compared without a read of the
                // file.
                let held = !too_large.is_empty();
                queue.too_large.extend(too_large);
                if note.source_hash != entry.source_hash {
                    queue.changed.push(path.clone());
                } else if held || is_technical_update(path, entry)? {
                    queue.changed.push(path.clone());
                    queue.technical_updates.push(path.clone());
                } else {
                    queue.unchanged.push(path.clone());
                }
            }
        }
    }
    queue.new = candidates_of(&notes, &manifest, &ignored);
    queue.count();
    let guards = Guards {
        configuration: &configuration,
        ignored: &ignored,
        denied_file_names: &denied_file_names,
        moved_under: &moves.under_guard,
        moved_elsewhere: &moves.moved_elsewhere,
    };
    queue.missing = missing_of(&queue.to_remove, &guards);
    queue.unpublished_under_guard = unpublished_under_guard(&manifest, &notes, &guards);
    queue.unpublished = unpublished_of(entries);
    let waiting = waiting_for_moves(&queue.missing, &moves.applied);
    queue.pairings = pairings_of(&waiting, &queue.new, &manifest, &notes);
    queue.moved_edited = hold_moved_edited(&moves.applied, &queue.changed, &notes, &mut manifest);
    let released = release_held(&moves.applied, &notes, &mut manifest);
    queue.renamed = moves.applied;
    let mut rename_warnings = journals.warnings.clone();
    rename_warnings.extend(moves.warnings);
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
        displaced: moves.displaced,
        released,
        journals,
        rename_warnings,
        configuration,
        edits: EditLog::default(),
        note_types,
    })
}

/// The candidates: the notes of the scan that are not published and that
/// the ignore property does not exclude, in the order of the code points.
fn candidates_of(
    notes: &BTreeMap<String, ScannedNote>,
    manifest: &BTreeMap<String, ManifestEntry>,
    ignored: &BTreeSet<String>,
) -> Vec<String> {
    notes
        .keys()
        .filter(|path| {
            !manifest
                .get(*path)
                .is_some_and(|entry| entry.state == State::Published)
                && !ignored.contains(*path)
        })
        .cloned()
        .collect()
}

/// The notes of a scan, read one time.
struct ScannedNotes {
    /// Every note of the scan, by its vault path. A `BTreeMap` of `String`
    /// keeps the order of the code points.
    notes: BTreeMap<String, ScannedNote>,
    /// The notes that the ignore property excludes.
    ignored: BTreeSet<String>,
    /// The link paths of the published notes: their links are computed again
    /// at each scan.
    link_paths: BTreeMap<String, Vec<String>>,
}

/// Reads every note of the scan. A note that cannot be read stops the run.
fn read_notes(
    vault: &Vault,
    scanned: Vec<String>,
    configuration: &Configuration,
    published_paths: &BTreeSet<String>,
) -> Result<ScannedNotes, String> {
    let mut notes = BTreeMap::new();
    let mut ignored = BTreeSet::new();
    let mut link_paths: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for path in scanned {
        let text = vault
            .read(&path)
            .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?;
        // `None`: the file went away during the scan.
        let Some(text) = text else { continue };
        // The scan left the folders of the deny list out, so only the ignore
        // property is left.
        if guard_of(&path, &text, configuration).is_some() {
            ignored.insert(path.clone());
        }
        let source = source_of(&text);
        if published_paths.contains(&path) {
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
    Ok(ScannedNotes {
        notes,
        ignored,
        link_paths,
    })
}

/// The paths that a published entry can have after the moves: its path and
/// its last path of the fold.
fn published_paths_of(
    entries: &BTreeMap<String, ManifestEntry>,
    positions: &BTreeMap<String, String>,
) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    for (path, entry) in entries {
        if entry.state == State::Published {
            paths.insert(path.clone());
            paths.insert(positions.get(path).unwrap_or(path).clone());
        }
    }
    paths
}

/// The pairings of the queue (PUB-62): a source hash of exactly one published
/// note of `missing` and of exactly one candidate that has no manifest entry.
fn pairings_of(
    missing: &[String],
    candidates: &[String],
    manifest: &BTreeMap<String, ManifestEntry>,
    notes: &BTreeMap<String, ScannedNote>,
) -> Vec<Move> {
    let mut gone: BTreeMap<&str, Vec<&String>> = BTreeMap::new();
    for path in missing {
        if let Some(entry) = manifest.get(path) {
            gone.entry(entry.source_hash.as_str())
                .or_default()
                .push(path);
        }
    }
    let mut found: BTreeMap<&str, Vec<&String>> = BTreeMap::new();
    for path in candidates {
        if let Some(note) = notes.get(path).filter(|_| !manifest.contains_key(path)) {
            found
                .entry(note.source_hash.as_str())
                .or_default()
                .push(path);
        }
    }
    let mut pairings: Vec<Move> = gone
        .iter()
        .filter_map(
            |(hash, from)| match (from.as_slice(), found.get(hash).map(Vec::as_slice)) {
                ([from], Some([to])) => Some(Move {
                    from: (*from).clone(),
                    to: (*to).clone(),
                }),
                _ => None,
            },
        )
        .collect();
    pairings.sort_by(|one, two| one.from.cmp(&two.from));
    pairings
}

/// The vault path of a note without `.md`: the text of its URL.
fn without_suffix(path: &str) -> &str {
    path.strip_suffix(".md").unwrap_or(path)
}

/// The missing notes that can show as pairings: a note at the new path of a
/// move waits for the publication of the move.
fn waiting_for_moves(missing: &[String], applied: &[Move]) -> Vec<String> {
    missing
        .iter()
        .filter(|path| !applied.iter().any(|one| &one.to == *path))
        .cloned()
        .collect()
}

/// A held update whose note has the source of its entry again loses its
/// mark: the next publication writes the entry without it, so a later edit
/// is no held update (decision of the author of 2026-11-26, issue 106). The
/// result is the entries to write, by path; a moved entry is written by its
/// move.
fn release_held(
    applied: &[Move],
    notes: &BTreeMap<String, ScannedNote>,
    manifest: &mut BTreeMap<String, ManifestEntry>,
) -> Vec<ManifestEntry> {
    let moved: BTreeSet<&String> = applied.iter().map(|one| &one.to).collect();
    let mut released = Vec::new();
    for (path, entry) in manifest.iter_mut() {
        if entry.update_held
            && notes
                .get(path)
                .is_some_and(|note| note.source_hash == entry.source_hash)
        {
            entry.update_held = false;
            if !moved.contains(path) {
                released.push(entry.clone());
            }
        }
    }
    released
}

/// The moved notes whose text changed (R67): a note of `changed` at the new
/// path of a move whose source is not the published source gets the mark of
/// a held update, which the publication of the move writes, so the hold
/// lasts until a selection includes the note. The result is the paths of
/// `changed` whose entry has the mark, in the order of `changed`.
fn hold_moved_edited(
    applied: &[Move],
    changed: &[String],
    notes: &BTreeMap<String, ScannedNote>,
    manifest: &mut BTreeMap<String, ManifestEntry>,
) -> Vec<String> {
    let listed: BTreeSet<&String> = changed.iter().collect();
    for one in applied {
        let differs = notes.get(&one.to).map(|note| &note.source_hash)
            != manifest.get(&one.to).map(|entry| &entry.source_hash);
        if listed.contains(&one.to)
            && differs
            && let Some(entry) = manifest.get_mut(&one.to)
        {
            entry.update_held = true;
        }
    }
    changed
        .iter()
        .filter(|path| manifest.get(*path).is_some_and(|entry| entry.update_held))
        .cloned()
        .collect()
}

/// The paths of the unpublished entries of the manifest.
fn unpublished_paths(entries: &BTreeMap<String, ManifestEntry>) -> BTreeSet<String> {
    entries
        .iter()
        .filter(|(_, entry)| entry.state != State::Published)
        .map(|(path, _)| path.clone())
        .collect()
}

/// True when an unpublished entry that stays at its path, moved away by a
/// line or not, gives its path to a published note that moved into it: exactly one other entry is at its
/// path, that entry is published, and the note of the scan at that path has
/// its source (rules 5 and 6 of the moves).
fn yields(
    entries: &BTreeMap<String, ManifestEntry>,
    left_behind: &BTreeSet<String>,
    source_hash_at: &impl Fn(&str) -> Option<String>,
    last: &BTreeMap<String, String>,
    from: &String,
) -> bool {
    if !left_behind.contains(from) {
        return false;
    }
    let mut holders = last
        .iter()
        .filter(|(other, to)| *to == from && *other != from);
    let (Some((holder, _)), None) = (holders.next(), holders.next()) else {
        return false;
    };
    entries.get(holder).is_some_and(|entry| {
        entry.state == State::Published
            && source_hash_at(from).as_deref() == Some(entry.source_hash.as_str())
    })
}

/// True when the path is a path of the vault: no part starts with a dot or
/// holds U+FFFD.
fn is_vault_name(path: &str) -> bool {
    !path
        .split('/')
        .any(|part| part.starts_with('.') || part.contains('\u{fffd}'))
}

/// True when the vault of this device shows the move of the entry from
/// `from` to `to` (rule 2 of the moves): `to` is a path of the vault, and the
/// note at `to` has the source of the entry, or the vault has no note at
/// `from` any more, or a note at both paths with neither of them the source
/// of the entry. In the last two cases the note at `to` can have another
/// source: its update waits for a tick (`moved_edited`, decision R67).
fn shows_move(
    in_vault: &impl Fn(&str) -> bool,
    source_hash_at: &impl Fn(&str) -> Option<String>,
    entry: &ManifestEntry,
    from: &str,
    to: &str,
) -> bool {
    if !is_vault_name(to) {
        return false;
    }
    let published = Some(entry.source_hash.as_str());
    if source_hash_at(to).as_deref() == published || !in_vault(from) {
        return true;
    }
    // The old file is still there: it is the note when it has its source, or
    // when the vault has no note at the new path yet.
    source_hash_at(from).as_deref() != published && in_vault(to)
}

/// The moves of the rename journals.
struct Moves {
    /// The entries at their last paths.
    manifest: BTreeMap<String, ManifestEntry>,
    applied: Vec<Move>,
    /// The entries that moved under a guard: they stay, and are forced
    /// removals.
    under_guard: BTreeSet<String>,
    /// The unpublished entries that a line moved to a path with no guard
    /// where the vault has a file.
    moved_elsewhere: BTreeSet<String>,
    /// The unpublished entries that leave the manifest: another entry moved
    /// into the path that their note left (rule 6 of the moves).
    displaced: Vec<ManifestEntry>,
    warnings: Vec<RenameWarning>,
}

/// Why a move of the rename journal cannot take a note to `to`, when it
/// cannot: the file or the first folder of `to` is a reserved root name, or
/// Obsidian changes the path (rule 3 of the moves, R72).
fn refused_target(to: &str) -> Option<String> {
    let name = without_suffix(to.rsplit('/').next().unwrap_or(to));
    if is_reserved_root_name(name) || (to.contains('/') && is_reserved_root_name(first_part(to))) {
        return Some("whose name is a reserved root name of the site: it does not move".to_owned());
    }
    if is_refused_by_windows(to) {
        return Some(
            "a path that Windows cannot hold: it does not move, and it can show as a pairing"
                .to_owned(),
        );
    }
    is_changed_by_obsidian(to).then(|| {
        format!(
            "whose path Obsidian reads as \"{}\": it does not move, and it can show as a pairing",
            obsidian_path(to)
        )
    })
}

/// True when the entry at this path is not a published entry.
fn is_unpublished(entries: &BTreeMap<String, ManifestEntry>, path: &str) -> bool {
    entries
        .get(path)
        .is_none_or(|entry| entry.state != State::Published)
}

/// The moves of the rename journals (`documentation/Canonical Form.md`, "The
/// rename journal"): the entries at their last paths, the moves, the entries
/// that moved under a guard, and the warnings of the moves that do not happen.
fn apply_moves(
    entries: &BTreeMap<String, ManifestEntry>,
    Fold {
        positions,
        times,
        warnings: fold_warnings,
    }: Fold,
    under_guard_at: impl Fn(&str) -> bool,
    in_vault: impl Fn(&str) -> bool,
    source_hash_at: impl Fn(&str) -> Option<String>,
) -> Moves {
    let mut warnings = fold_warnings;
    let mut under_guard = BTreeSet::new();
    let mut last: BTreeMap<String, String> = BTreeMap::new();
    // The unpublished entries that stay at their paths, moved away by a line
    // or not: they do not count at their paths for the collisions when the
    // published note really moved in (rules 5 and 6).
    let mut left_behind = BTreeSet::new();
    // The exact moves of unpublished entries, out of the name rule (issue 105).
    let mut moved_elsewhere = BTreeSet::new();
    let not_moved = |to: &str, why: &str| -> String {
        format!("the rename journal moves the note to \"{to}\", {why}")
    };
    for from in entries.keys() {
        let to = positions.get(from).unwrap_or(from).clone();
        last.insert(from.clone(), from.clone());
        if &to == from {
            // An unpublished entry that no line moved gives its path too
            // (decision of the author of 2026-11-26, issue 106).
            if is_unpublished(entries, from) {
                left_behind.insert(from.clone());
            }
            continue;
        }
        // The line that moved the entry is older than its first publication.
        let older = times.get(from).is_some_and(|time| {
            entries
                .get(from)
                .is_some_and(|entry| *time < entry.first_published)
        });
        if under_guard_at(&to) {
            // The exact move under a guard: a forced removal (R40, R66), also
            // when this device still has the file (the guards win). But a
            // line that is older than the first publication of a note that
            // this device still has cannot be about that note: a folder line
            // moves every path below the folder, also of a note published
            // later.
            if in_vault(from) && older {
                warnings.push(RenameWarning {
                    path: from.clone(),
                    message: not_moved(&to, "but its line is older than the first publication of the note, and this device still has the note: it does not move"),
                });
                continue;
            }
            under_guard.insert(from.clone());
            continue;
        }
        let shown = entries
            .get(from)
            .is_some_and(|entry| shows_move(&in_vault, &source_hash_at, entry, from, &to));
        // An unpublished entry does not move: its old address stays gone
        // (R64), and a path that it had only while it was unpublished never
        // becomes a public former path. The guard rule above still applies.
        if is_unpublished(entries, from) {
            // A line to a path with no file proves nothing (fails closed).
            left_behind.insert(from.clone());
            if in_vault(&to) {
                moved_elsewhere.insert(from.clone());
            }
            continue;
        }
        if !shown {
            warnings.push(RenameWarning {
                path: from.clone(),
                message: not_moved(&to, "but the vault of this device does not show that move: it does not move, and it can show as a pairing"),
            });
            continue;
        }
        if let Some(why) = refused_target(&to) {
            warnings.push(RenameWarning {
                path: from.clone(),
                message: not_moved(&to, &why),
            });
            continue;
        }
        last.insert(from.clone(), to);
    }
    let yields = |last: &BTreeMap<String, String>, from: &String| {
        yields(entries, &left_behind, &source_hash_at, last, from)
    };
    revert_collisions(entries, &mut last, &yields, &mut warnings, &not_moved);
    // An unpublished entry whose path another entry took leaves the manifest
    // (rule 6 of the moves, issue 105): the published note took the path
    // that the unpublished note left.
    let leaving: BTreeSet<String> = last
        .keys()
        .filter(|from| yields(&last, from))
        .cloned()
        .collect();
    let mut displaced = Vec::new();
    let mut manifest = BTreeMap::new();
    let mut moves = Vec::new();
    for (from, to) in last {
        let Some(entry) = entries.get(&from) else {
            continue;
        };
        if leaving.contains(&from) {
            displaced.push(entry.clone());
            warnings.push(RenameWarning {
                path: from,
                message: "the rename journal moves this unpublished note away, and another note moved into its path: its entry leaves the manifest, so its other old addresses answer 404 instead of 410".to_owned(),
            });
            continue;
        }
        if to == from {
            manifest.insert(from, entry.clone());
        } else {
            manifest.insert(to.clone(), moved_entry(entry, &to));
            moves.push(Move { from, to });
        }
    }
    Moves {
        manifest,
        applied: moves,
        under_guard,
        moved_elsewhere,
        displaced,
        warnings,
    }
}

/// Two entries at one path, or two published entries with one folded form:
/// the entries of the group that moved do not move, until no such group is
/// left (rule 5 of the moves).
fn revert_collisions(
    entries: &BTreeMap<String, ManifestEntry>,
    last: &mut BTreeMap<String, String>,
    yields: &dyn Fn(&BTreeMap<String, String>, &String) -> bool,
    warnings: &mut Vec<RenameWarning>,
    not_moved: &dyn Fn(&str, &str) -> String,
) {
    let mut changed = true;
    while changed {
        changed = false;
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let snapshot = last.clone();
        for (from, to) in last.iter().filter(|(from, _)| !yields(&snapshot, from)) {
            groups
                .entry(format!("path\n{to}"))
                .or_default()
                .push(from.clone());
            if entries
                .get(from)
                .is_some_and(|entry| entry.state == State::Published)
            {
                groups
                    .entry(format!("folded\n{}", folded_form(without_suffix(to))))
                    .or_default()
                    .push(from.clone());
            }
        }
        for group in groups.values().filter(|group| group.len() > 1) {
            for from in group {
                let to = last.get(from).cloned().unwrap_or_default();
                if &to != from {
                    last.insert(from.clone(), from.clone());
                    changed = true;
                    warnings.push(RenameWarning {
                        path: from.clone(),
                        message: not_moved(&to, "where another note of the manifest is, or one that the site gives the same URL: it does not move"),
                    });
                }
            }
        }
    }
}

/// The entry of a note that moves: its new path, and its former paths (rule
/// 4 of the moves).
pub fn moved_entry(entry: &ManifestEntry, to: &str) -> ManifestEntry {
    let mut moved = entry.clone();
    moved.former_paths = former_paths_after(&entry.former_paths, &entry.path, to);
    to.clone_into(&mut moved.path);
    moved
}
