//! The operations of the publishing tool. The commands of the program call
//! these. The TypeScript twin is `apps/plugin/src/publishing/tool.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

use serde::Serialize;
use serde_json::{Value, json};

use crate::attachments::attachments_of;
use crate::attachments::{
    Attachment, MAX_ATTACHMENT_SIZE, RemovedAttachment, TooLarge, key_of, removed_attachments,
};
use crate::canonical::to_canonical_json;
use crate::clean::{CLEANING_VERSION, STATE_PROPERTY, clean_note, source_of};
use crate::configuration::{CONFIGURATION_FILE, Configuration, is_vault_path, parse_configuration};
use crate::device::{
    AttachmentStorage, ContentStore, Fetch, Lock, Recovery, Vault, crash_point, overwrite_point,
    steal_point,
};
use crate::edits::{
    ACTIONS, EDITS_FILE, EditLog, Event, EventFacts, edit_output, event_value, is_looser,
    parse_edits,
};
use crate::frontmatter::{
    Aliases, aliases_of, has_flow_properties, names_in_properties, remove_property, set_property,
};
use crate::frozen::{has_list_to_refresh, has_live_query};
use crate::guards::{IGNORE_PROPERTY, in_deny_list};
use crate::hash::{bytes_hash, content_hash, sha256_hex};
use crate::json::parse_json;
use crate::links::{NoteLink, links_of};
use crate::manifest::{
    MANIFEST_FOLDER, ManifestEntry, NOTES_FOLDER, State, manifest_file, note_id, read_manifest,
};
use crate::names::folded_form;
use crate::note_types::{NoteType, StarterKit, note_type_of_entry, note_types_of};
use crate::order::sort_by_code_point;
use crate::originals::{CheckResult, CheckedNote, MainSite, Original};
use crate::plan::{
    PublicationPlan, Selection, attachments_after_plan, forced_removals, plan_with_sizes,
};
use crate::queue::{GuardChange, Move, Scan, compute_guard_queues, compute_queue, moved_entry};
use crate::renames::{
    JournalState, RENAMES_FILE, RenameJournals, fold_moves, moved_folder, parse_markers,
    read_journals,
};
use crate::seal::{SealCheck, SealSource, TreeFile, check_seal, difference_text, seal_of};
use crate::withdrawn::{WITHDRAWN_FILE, parse_withdrawn, withdrawn_keys, withdrawn_text};

/// Everything that a publication needs on one device.
pub struct Device {
    pub vault: Vault,
    pub store: ContentStore,
    /// The rename journals of the vault (decision R66).
    pub renames: RenameJournals,
    /// The Obsidian Starter Kit of the vault, which knows the note type of
    /// each note (decision R61).
    pub note_types: StarterKit,
    /// The main site, for the check of the original of a note (PUB-100).
    pub main_site: MainSite,
    /// Where the seal key of the content store comes from (R104).
    pub seal: SealSource,
}

/// The faces of the tool that can start a publication.
pub const FACES: [&str; 3] = ["plugin", "command-line", "mcp-server"];

/// What a face gives to a publication. The logic reads no clock and no name of
/// the system.
pub struct Run<'a> {
    /// The time of the run, in the canonical form.
    pub time: &'a str,
    /// The name of the device, for the message of the commit. One line of text.
    pub device: &'a str,
    /// The face that started the publication.
    pub face: &'a str,
}

/// The result of a command: what it writes, and whether a part of its work
/// failed.
pub struct Outcome {
    /// The output of the command, in the canonical form.
    pub output: String,
    /// What failed in a command that still wrote its output: notes of the
    /// plan that were left out, or files that a takedown could not delete.
    pub failure: Option<String>,
}

impl Outcome {
    /// The outcome of a command that wrote its output and failed in nothing.
    pub fn of(output: String) -> Self {
        Self {
            output,
            failure: None,
        }
    }
}

fn canonical(value: &Value) -> Result<String, String> {
    to_canonical_json(value).map_err(|error| error.to_string())
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

/// The text of the configuration. `Err` when the copy has none.
fn configuration_text(device: &Device) -> Result<String, String> {
    device.store.read(CONFIGURATION_FILE)?.ok_or_else(|| {
        // A wrong folder must never read as a content store with an empty
        // deny list: every private folder would be a candidate (R67).
        format!(
            "the copy of the content store has no {CONFIGURATION_FILE} in its last commit: the folder is not the copy of the content store, or the content store has no configuration yet. Add {CONFIGURATION_FILE} with the deny list (\"denyList\"), commit it and push it"
        )
    })
}

/// Reads the configuration and checks it against the vault. It gives the
/// configuration and the hash of its text, or `none`.
fn read_configuration(
    device: &Device,
    journals: &JournalState,
) -> Result<(Configuration, String), String> {
    let text = configuration_text(device)?;
    let configuration = parse_configuration(Some(&text))?;
    // A deny list entry that names no folder would exclude nothing: a renamed
    // folder, or another letter case, would make its notes candidates
    // (GATE-38).
    for folder in &configuration.deny_list {
        if !device.vault.has_folder(folder) {
            // The rename journals can say where the folder went (PUB-91).
            let proposal = moved_folder(folder, &journals.all)
                .filter(|moved| device.vault.has_folder(moved))
                .map_or_else(String::new, |moved| {
                    format!(
                        ". The rename journal says that it was renamed to \"{moved}\": put \"{moved}\" in the deny list"
                    )
                });
            return Err(format!(
                "the deny list names \"{folder}\", which is not a folder of the vault. No publication is possible until the deny list is corrected{proposal}"
            ));
        }
    }
    let hash = content_hash(&text);
    Ok((configuration, hash))
}

/// The hash of the manifest: each file with the hash of its text.
fn manifest_hash(device: &Device) -> Result<String, String> {
    let mut lines = String::new();
    for file in device.store.list(MANIFEST_FOLDER)? {
        let text = device.store.read(&file)?.unwrap_or_default();
        // Writing to a `String` cannot fail.
        let _ = write!(lines, "{file}\n{}\n", content_hash(&text));
    }
    Ok(content_hash(&lines))
}

/// The state of the device that the queue is computed from.
struct DeviceState {
    scan: Scan,
    configuration_hash: String,
    /// The hash of `renames.json`, or `none`.
    renames_hash: String,
    /// False when the run tried to fetch and the content store could not be
    /// reached.
    reached: bool,
}

/// Checks the content store, reads the configuration and the manifest, and
/// scans the vault. With a fetch (for `plan` and `publish`), it fetches the
/// content store first and stops when the copy is behind it: a copy that did
/// not pull reads an older manifest, and a note that came under a guard since
/// would stay live (issue 70). A copy that was behind at the last fetch stops
/// a plan also without a network.
fn read_state(device: &Device, fetch: Fetch) -> Result<DeviceState, String> {
    let verified = device.store.verify(fetch)?;
    let behind = verified.behind;
    if fetch != Fetch::None {
        refuse_when_behind(behind)?;
    }
    let renames = device.store.read(RENAMES_FILE)?;
    let journals = read_journals(&device.renames, &parse_markers(renames.as_deref())?)?;
    let (configuration, configuration_hash) = read_configuration(device, &journals)?;
    let edits = read_edits(device)?;
    // So does a list of withdrawn keys that is not valid (issue 120).
    parse_withdrawn(device.store.read(WITHDRAWN_FILE)?.as_deref())?;
    // The state of the last commit must be the state that a commit of the tool
    // sealed, before the manifest is trusted (R104).
    refuse_unsealed_state(device)?;
    let manifest = read_manifest(&device.store)?;
    let mut scan = compute_queue(
        &device.vault,
        &manifest,
        journals,
        configuration,
        &device.note_types,
    )?;
    scan.queue.behind = behind;
    scan.queue.proposals = edits.open_proposals();
    scan.edits = edits;
    Ok(DeviceState {
        scan,
        configuration_hash,
        renames_hash: renames.map_or_else(|| "none".to_owned(), |text| content_hash(&text)),
        reached: verified.reached,
    })
}

/// Checks the seal of the copy (R104): the key must be there, and the state of
/// the last commit must be the state that a commit of the tool sealed. A copy
/// with no commit passes.
fn refuse_unsealed_state(device: &Device) -> Result<(), String> {
    let key = device.seal.key()?;
    match check_seal(&device.store, &key, None)? {
        SealCheck::Differs(difference) => Err(difference_text(&difference)),
        SealCheck::Empty | SealCheck::Sealed => Ok(()),
    }
}

/// The log of the edits of the guards, read strictly: a log that is not
/// valid stops every run (R69).
fn read_edits(device: &Device) -> Result<EditLog, String> {
    parse_edits(device.store.read(EDITS_FILE)?.as_deref())
}

/// `Err` when the copy is behind the content store: a copy that did not pull
/// reads an older manifest, and its push would be refused. The tool never
/// pulls by itself (R46, R65).
fn refuse_when_behind(behind: u64) -> Result<(), String> {
    if behind > 0 {
        return Err(format!(
            "the copy of the content store is {behind} commit(s) behind the content store: another device changed the content store since the last pull. Nothing can be planned, published or taken down until the copy is up to date: pull first (git pull --ff-only origin main)"
        ));
    }
    Ok(())
}

/// What the lock of the device holds, for a message: one line.
fn lock_message(text: &str) -> String {
    format!(
        "a publication runs on this device, or one stopped halfway (the lock holds {}). When no publication runs, remove the lock with the unlock command: the next plan, publish or takedown then puts the copy back",
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    )
}

/// `Err` when the lock of the device is taken: the files of the copy can be
/// half written.
fn refuse_when_locked(device: &Device) -> Result<(), String> {
    match device.store.read_lock()? {
        Some(text) => Err(lock_message(&text)),
        None => Ok(()),
    }
}

/// The message of a run whose lock was removed while it ran.
const LOCK_LOST: &str = "the lock of this publication was removed while it ran (unlock while a publication runs), and another run can have taken the copy. This run stops here and corrects no property: make a new plan when no other run runs";

/// Runs the work with the lock of the device (TOOL-09, PUB-27), and removes
/// the lock at its end when it is still the lock of this run. The work gets a
/// check that fails with `LOCK_LOST` when the lock is not its own any more:
/// the author ran unlock while it ran.
fn with_lock<T>(
    device: &Device,
    holder: &Value,
    work: impl FnOnce(&dyn Fn() -> Result<(), String>) -> Result<T, String>,
) -> Result<T, String> {
    let text = match device.store.lock(holder)? {
        Lock::Taken(text) => text,
        Lock::Held(text) => return Err(lock_message(&text)),
    };
    let own_lock = || -> Result<(), String> {
        if device.store.read_lock()?.as_deref() == Some(text.as_str()) {
            Ok(())
        } else {
            Err(LOCK_LOST.to_owned())
        }
    };
    let result = work(&own_lock);
    let released = device.store.release(&text);
    let value = result?;
    released?;
    Ok(value)
}

/// Removes the lock of the device that a run left when it stopped halfway.
/// The next plan, publish or takedown puts the copy back. The result says whether a
/// lock was there, in the canonical form.
///
/// # Errors
///
/// The lock cannot be removed.
pub fn unlock(store: &ContentStore) -> Result<String, String> {
    canonical(&json!({ "removed": store.unlock()? }))
}

/// The run journal of a publication (`documentation/Canonical Form.md`,
/// "Failure cases").
enum RunJournal {
    Write {
        /// True when an earlier publication stopped after its push, and its
        /// correction is owed.
        correction_owed: bool,
        /// The commit of the copy before the run, or `None` when the copy had
        /// no commit.
        head: Option<String>,
        /// The paths of the content store that the run can write or remove.
        paths: Vec<String>,
        plan: String,
    },
    Correct,
}

fn journal_text(journal: &RunJournal) -> Result<String, String> {
    match journal {
        RunJournal::Correct => canonical(&json!({ "step": "correct" })),
        RunJournal::Write {
            correction_owed,
            head,
            paths,
            plan,
        } => {
            let mut value = json!({
                "correctionOwed": correction_owed,
                "paths": paths,
                "plan": plan,
                "step": "write",
            });
            if let Some(head) = head {
                value["head"] = json!(head);
            }
            canonical(&value)
        }
    }
}

/// True when the path is a path of a note or of a manifest entry in the
/// content store.
fn is_store_path(path: &str) -> bool {
    is_vault_path(path)
        && (path == RENAMES_FILE
            || path == CONFIGURATION_FILE
            || path == EDITS_FILE
            || path == WITHDRAWN_FILE
            || path.starts_with(&format!("{NOTES_FOLDER}/"))
            || (path.starts_with(&format!("{MANIFEST_FOLDER}/")) && path.split('/').count() == 2))
}

/// True when the text is the hash of a commit.
fn is_commit(text: &str) -> bool {
    (40..=64).contains(&text.len())
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Reads the run journal of the device.
fn read_journal(device: &Device) -> Result<Option<RunJournal>, String> {
    let Some(text) = device.store.load_journal()? else {
        return Ok(None);
    };
    let unreadable = || {
        "the run journal of this device cannot be read (.git/vault-publish/journal.json of the copy): correct the copy by hand, then remove the journal".to_owned()
    };
    let value = parse_json(&text).map_err(|_| unreadable())?;
    let object = value.as_object().ok_or_else(unreadable)?;
    if value["step"] == "correct" && object.len() == 1 {
        return Ok(Some(RunJournal::Correct));
    }
    let head = match object.get("head") {
        None => None,
        Some(Value::String(head)) if is_commit(head) => Some(head.clone()),
        Some(_) => return Err(unreadable()),
    };
    let paths: Option<Vec<String>> = value["paths"].as_array().and_then(|list| {
        list.iter()
            .map(|path| {
                path.as_str()
                    .filter(|path| is_store_path(path))
                    .map(str::to_owned)
            })
            .collect()
    });
    match (
        value["step"].as_str(),
        value["correctionOwed"].as_bool(),
        paths,
        value["plan"].as_str(),
    ) {
        (Some("write"), Some(correction_owed), Some(paths), Some(plan)) => {
            Ok(Some(RunJournal::Write {
                correction_owed,
                head,
                paths,
                plan: plan.to_owned(),
            }))
        }
        _ => Err(unreadable()),
    }
}

/// Puts back what a publication that stopped halfway left (R46). The result
/// is true when the correction of the property is owed: the journal is then
/// `correct`.
fn recover(device: &Device, own_lock: &dyn Fn() -> Result<(), String>) -> Result<bool, String> {
    match read_journal(device)? {
        None => Ok(false),
        Some(RunJournal::Correct) => Ok(true),
        Some(RunJournal::Write {
            correction_owed,
            head,
            paths,
            plan,
        }) => {
            let result = device
                .store
                .recover(head.as_deref(), &paths, &plan, own_lock)?;
            // The journal is the one of the run only while the lock is its own
            // (issue 75).
            steal_point("journal", &device.store);
            own_lock()?;
            if result == Recovery::Pushed || correction_owed {
                device
                    .store
                    .save_journal(&journal_text(&RunJournal::Correct)?)?;
                Ok(true)
            } else {
                device.store.remove_journal()?;
                Ok(false)
            }
        }
    }
}

/// The publication queue: the four lists of what waits for a publication, in
/// the canonical form. It writes nothing into the vault and nothing into the
/// content store.
///
/// # Errors
///
/// The content store, the configuration or the manifest cannot be trusted, or
/// a note cannot be read.
pub fn status(device: &Device) -> Result<String, String> {
    refuse_when_locked(device)?;
    if matches!(read_journal(device)?, Some(RunJournal::Write { .. })) {
        return Err("a publication stopped halfway on this device. status writes nothing, so it does not put the copy back: the next plan, publish, takedown or edit puts it back".to_owned());
    }
    canonical(&to_value(&read_state(device, Fetch::None)?.scan.queue)?)
}

/// The source, the cleaned note, the links and the attachments of one note of
/// a plan.
struct NoteTexts {
    source: String,
    aliases: Aliases,
    cleaned: String,
    links: Vec<NoteLink>,
    attachments: Vec<Attachment>,
    note_type: Option<NoteType>,
}

/// A plan with everything that its publication needs.
struct Computed {
    plan: PublicationPlan,
    /// The attachments that the publication of the plan takes off the site
    /// (issue 135).
    attachments_removed: Vec<RemovedAttachment>,
    /// False when the content store could not be reached and the plan uses
    /// the last fetch.
    reached: bool,
    /// The record of the plan, in the canonical form.
    record: String,
    scan: Scan,
    /// The texts of the notes to publish and to update, as the record names
    /// them by their hashes.
    texts: BTreeMap<String, NoteTexts>,
    /// The selection that gave the plan.
    selection: Selection,
    /// The notes that the plan holds for the size limit of an attachment
    /// (issue 72).
    too_large: Vec<TooLarge>,
    /// The hash of the configuration that the plan read, as the record holds
    /// it.
    configuration_hash: String,
}

/// Computes the plan of a selection and its record: the plan, the selection,
/// and the state that the plan was computed from, in the canonical form.
fn record_for(
    device: &Device,
    selection_of: &dyn Fn(&Scan) -> Selection,
    fetch: Fetch,
) -> Result<Computed, String> {
    let DeviceState {
        scan,
        configuration_hash,
        renames_hash,
        reached,
    } = read_state(device, fetch)?;
    // An unpublish holds every changed note that it does not name: its
    // selection comes from the queue of the same scan.
    let selection = &selection_of(&scan);
    let (mut plan, too_large) = plan_with_sizes(&device.vault, &scan, selection)?;
    // The sources and the attachments of the notes to publish and to update
    // come first: guardedAttachments reads the entries after the plan.
    let (read, open) = read_planned(device, &scan, &plan)?;
    // Before the question to the Starter Kit: a path of accept that the plan
    // does not name stops the plan (rule 8 of the selection).
    plan.set_guarded_attachments(guarded_attachments(device, &scan, &plan, selection, &open));
    refuse_accept(&plan, selection)?;
    // The published notes got their type in the scan. The new ones of the
    // plan get theirs in one more question.
    // The candidates of the pairings get theirs in the same question (R66).
    let mut question: Vec<String> = plan
        .publish()
        .iter()
        .chain(selection.pair().iter().map(|pairing| &pairing.to))
        .cloned()
        .collect();
    sort_by_code_point(&mut question);
    let new_types = note_types_of(&device.note_types, &question)?;
    let mut texts = BTreeMap::new();
    for (path, source, links, attachments) in read {
        let cleaned = clean_note(&source);
        let note_type = new_types
            .get(&path)
            .or_else(|| scan.note_types.get(&path))
            .cloned();
        texts.insert(
            path,
            NoteTexts {
                aliases: aliases_of(&source),
                source,
                cleaned,
                links,
                attachments,
                note_type,
            },
        );
    }
    // The map gives the notes in the order of their paths.
    let notes = texts
        .iter()
        .map(|(path, texts)| {
            let mut note = json!({
                "aliases": texts.aliases.aliases,
                "attachments": to_value(&texts.attachments)?,
                "cleanedHash": content_hash(&texts.cleaned),
                "links": to_value(&texts.links)?,
                "path": path,
                "sourceHash": content_hash(&texts.source),
            });
            if let Some(note_type) = &texts.note_type {
                note["noteType"] = to_value(note_type)?;
            }
            Ok(note)
        })
        .collect::<Result<Vec<Value>, String>>()?;
    let record = canonical(&json!({
        "plan": to_value(&plan)?,
        "selection": to_value(selection)?,
        "state": {
            "configuration": &configuration_hash,
            "journals": scan.journals.hash,
            "manifest": manifest_hash(device)?,
            "notes": notes,
            "renames": renames_hash,
        },
    }))?;
    let planned: BTreeMap<String, &[Attachment]> = texts
        .iter()
        .map(|(path, texts)| (path.clone(), texts.attachments.as_slice()))
        .collect();
    let attachments_removed = removed_attachments(
        published_attachments(&scan.manifest),
        attachments_after_plan(&scan.manifest, &plan, &planned).into_iter(),
    );
    Ok(Computed {
        plan,
        attachments_removed,
        reached,
        record,
        scan,
        selection: selection.clone(),
        texts,
        too_large,
        configuration_hash,
    })
}

/// A note of `publish` or `update` as the plan reads it: its path, its
/// source, its links and its attachments.
type ReadNote = (String, String, Vec<NoteLink>, Vec<Attachment>);

/// The hashes that each note of `publish` or `update` lists from a file under
/// no guard, by its path.
type OpenHashes = BTreeMap<String, BTreeSet<String>>;

/// Reads the notes to publish and to update, and gives with them, for each
/// note, the hashes that it lists from a file under no guard (issue 108).
fn read_planned(
    device: &Device,
    scan: &Scan,
    plan: &PublicationPlan,
) -> Result<(Vec<ReadNote>, OpenHashes), String> {
    let mut read = Vec::new();
    let mut open = OpenHashes::new();
    for path in plan.publish().iter().chain(plan.update()) {
        let text = device
            .vault
            .read(path)
            .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?
            .ok_or_else(|| format!("\"{path}\" does not exist in the vault any more"))?;
        let source = source_of(&text);
        let targets = links_of(&source, path, &scan.index, &scan.guarded);
        let attachments = attachments_of(&targets.files, &device.vault, &scan.files)?;
        open.insert(
            path.clone(),
            attachments
                .iter()
                .filter(|attachment| {
                    !scan.is_guarded_file(&device.vault, &attachment.path, &attachment.hash)
                })
                .map(|attachment| attachment.hash.clone())
                .collect(),
        );
        read.push((path.clone(), source, targets.links, attachments));
    }
    Ok((read, open))
}

/// The attachments of the published entries of a manifest, one list per
/// entry.
fn published_attachments(
    manifest: &BTreeMap<String, ManifestEntry>,
) -> impl Iterator<Item = &[Attachment]> {
    manifest
        .values()
        .filter(|entry| entry.state == State::Published)
        .map(|entry| entry.attachments.as_slice())
}

/// The published entries after the plan whose attachments list a file that
/// is under a guard now (rule 8 of "A publication"): the publication would
/// delete the file, and the note would show it as missing, also after its
/// update. They are the published entries after the moves whose attachments
/// list such a file, without the forced removals and the notes to unpublish,
/// at the new path of a pairing, and without the entries whose every such
/// file has the hash of a file under no guard of a published entry after the
/// plan. `open` holds, for each note of `publish` and of `update`, the hashes
/// that its record lists from a file under no guard: an entry that the plan
/// updates counts only through its record. Sorted by path.
fn guarded_attachments(
    device: &Device,
    scan: &Scan,
    plan: &PublicationPlan,
    selection: &Selection,
    open: &OpenHashes,
) -> Vec<String> {
    let leaving: BTreeSet<&String> = plan.forced_remove().iter().chain(plan.remove()).collect();
    let now = |path: &String| -> String {
        selection
            .pair()
            .iter()
            .find(|pairing| &pairing.from == path)
            .map_or_else(|| path.clone(), |pairing| pairing.to.clone())
    };
    // The hashes that a published entry after the plan lists from a file
    // under no guard: the cleanup keeps their keys, so a guarded file with
    // such a hash takes nothing from its note (issue 108, point 2).
    let kept: BTreeSet<&String> = scan
        .manifest
        .iter()
        .filter(|(path, entry)| {
            entry.state == State::Published
                && !leaving.contains(path)
                && !open.contains_key(&now(path))
        })
        .flat_map(|(_, entry)| &entry.attachments)
        .filter(|attachment| {
            !scan.is_guarded_file(&device.vault, &attachment.path, &attachment.hash)
        })
        .map(|attachment| &attachment.hash)
        .chain(open.values().flatten())
        .collect();
    scan.manifest
        .iter()
        .filter(|(path, entry)| {
            entry.state == State::Published
                && !leaving.contains(path)
                && entry.attachments.iter().any(|attachment| {
                    !kept.contains(&attachment.hash)
                        && scan.is_guarded_file(&device.vault, &attachment.path, &attachment.hash)
                })
        })
        .map(|(path, _)| now(path))
        .collect()
}

/// Rule 8 of the selection: a path of `accept` is a forced removal or a note
/// of `guardedAttachments` of the plan.
fn refuse_accept(plan: &PublicationPlan, selection: &Selection) -> Result<(), String> {
    for path in selection.accept() {
        let named = |list: &[String]| list.binary_search(path).is_ok();
        if !named(plan.forced_remove()) && !named(plan.guarded_attachments()) {
            return Err(format!(
                "\"{path}\" is in accept, but it is neither a forced removal nor a note of guardedAttachments of the plan: accept names only those"
            ));
        }
    }
    Ok(())
}

/// Rule 10 of "The edits of the guards": a publication from the faces
/// `command-line` and `mcp-server` stops, and publishes nothing, when its
/// plan has a path of `forcedRemove` or of `guardedAttachments` that `accept`
/// of its selection does not name. So an agent never takes an entry away,
/// and never makes a published note lose a file, unless the author named
/// that note. The face `plugin` never stops for this: the author sees the
/// plan in the view.
fn refuse_unaccepted(current: &Computed, run: &Run) -> Result<(), String> {
    if run.face == "plugin" {
        return Ok(());
    }
    let accepted = |path: &&String| current.selection.accept().binary_search(path).is_ok();
    let quoted = |paths: Vec<&String>| {
        paths
            .iter()
            .map(|path| format!("\"{path}\""))
            .collect::<Vec<String>>()
            .join(", ")
    };
    let removed: Vec<&String> = current
        .plan
        .forced_remove()
        .iter()
        .filter(|path| !accepted(path))
        .collect();
    let losing: Vec<&String> = current
        .plan
        .guarded_attachments()
        .iter()
        .filter(|path| !accepted(path))
        .collect();
    if removed.is_empty() && losing.is_empty() {
        return Ok(());
    }
    let mut what = Vec::new();
    if !removed.is_empty() {
        what.push(format!(
            "takes these entries off the site (forcedRemove): {}",
            quoted(removed)
        ));
    }
    if !losing.is_empty() {
        what.push(format!(
            "makes these published notes lose a file under a guard (guardedAttachments): {}",
            quoted(losing)
        ));
    }
    Err(format!(
        "the plan {}, and accept does not name them. Nothing is published: ask the author, who names them in the request (accept), or publishes the plan in the publication center of Obsidian",
        what.join("; and ")
    ))
}

/// Computes a publication plan and stores it on the device. It writes nothing
/// into the vault and nothing into the content of the store. The result is the
/// plan with its id, in the canonical form.
///
/// # Errors
///
/// The selection cannot become a plan, or the plan cannot be stored.
pub fn plan(device: &Device, selection: &Selection) -> Result<String, String> {
    let (id, computed) = store_plan(device, &|_| selection.clone())?;
    let paths = || computed.plan.publish().iter().chain(computed.plan.update());
    let not_refreshed = lists_not_refreshed(&computed.texts, paths());
    // Why each list is not refreshed, outside the record and outside the
    // parity rule (issue 111): an agent cannot read the error output.
    let reasons: Vec<Value> = not_refreshed
        .iter()
        .map(|path| json!({ "path": path, "reason": NO_REFRESH }))
        .collect();
    canonical(&json!({
        "attachmentsRemoved": to_value(&computed.attachments_removed)?,
        "configurationChanged": computed.scan.edits.configuration_changed(&computed.configuration_hash),
        "id": id,
        "listsNotRefreshed": not_refreshed,
        "listsNotRefreshedReasons": reasons,
        "liveQueries": live_queries(&computed.texts, paths()),
        "offline": !computed.reached,
        "plan": to_value(&computed.plan)?,
        "tooLarge": to_value(&computed.too_large)?,
    }))
}

/// Computes the plan of a selection and stores it on the device. The result is
/// its id and the plan.
fn store_plan(
    device: &Device,
    selection: &dyn Fn(&Scan) -> Selection,
) -> Result<(String, Computed), String> {
    refuse_when_locked(device)?;
    // A publication that stopped halfway left files in the copy: they are
    // put back first, with the lock, so that no publication starts in the
    // middle.
    if matches!(read_journal(device)?, Some(RunJournal::Write { .. })) {
        with_lock(device, &json!({ "command": "plan" }), |own_lock| {
            recover(device, own_lock)
        })?;
    }
    let computed = record_for(device, selection, Fetch::Try)?;
    Ok((store_record(device, &computed)?, computed))
}

/// Stores the record of a plan on the device. The result is its id, which
/// names the record. It is outside the parity rule (TOOL-30).
fn store_record(device: &Device, computed: &Computed) -> Result<String, String> {
    let id = sha256_hex(&computed.record)[..16].to_owned();
    device.store.save_plan(&id, &computed.record)?;
    Ok(id)
}

/// Reads the selection of a stored record.
fn selection_of(record: &str, id: &str) -> Result<Selection, String> {
    let unreadable = || format!("the stored plan {id} cannot be read");
    let value = parse_json(record).map_err(|_| unreadable())?;
    let list = |key: &str| -> Result<Vec<String>, String> {
        value["selection"][key]
            .as_array()
            .ok_or_else(unreadable)?
            .iter()
            .map(|path| path.as_str().map(str::to_owned).ok_or_else(unreadable))
            .collect()
    };
    let pair = value["selection"]["pair"]
        .as_array()
        .ok_or_else(unreadable)?
        .iter()
        .map(|item| Move::of(item).ok_or_else(unreadable))
        .collect::<Result<Vec<Move>, String>>()?;
    Ok(Selection::new(
        &list("include")?,
        &list("hold")?,
        &list("remove")?,
        &pair,
        &list("accept")?,
    ))
}

/// The number of a text of ASCII digits.
fn number(digits: &str) -> u32 {
    digits.parse().unwrap_or(u32::MAX)
}

/// True when the text is a real date and time in the canonical form: UTC, to
/// the second.
pub(crate) fn is_canonical_time(time: &str) -> bool {
    let pattern = b"dddd-dd-ddTdd:dd:ddZ";
    let formed = time.len() == pattern.len()
        && time
            .bytes()
            .zip(pattern)
            .all(|(byte, expected)| match expected {
                b'd' => byte.is_ascii_digit(),
                other => byte == *other,
            });
    if !formed {
        return false;
    }
    let (year, month, day) = (
        number(&time[..4]),
        number(&time[5..7]),
        number(&time[8..10]),
    );
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
        && number(&time[11..13]) < 24
        && number(&time[14..16]) < 60
        && number(&time[17..19]) < 60
}

/// True when the text has the form of the id of a plan: 16 hexadecimal digits,
/// in small letters. An id is never used as a path in another form.
fn is_plan_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// True when the text is one line with something to read: no control
/// character, and not only spaces (U+0020).
pub(crate) fn is_one_line(text: &str) -> bool {
    !text.chars().any(char::is_control) && text.chars().any(|character| character != ' ')
}

/// One file of the content store to write, or to remove when it has no text.
struct StoreFile {
    path: String,
    text: Option<String>,
}

/// The files of the copy as they were before a publication touched them. A
/// failure puts them back from here, not from a commit of the copy: a copy can
/// have no commit, and a file of it can be in no commit.
/// Puts back the files of the copy after a run that failed before its push
/// arrived, and then settles the journal of the run, but only when every
/// file is back and git took the commit back: else the journal stays, so the
/// next run puts the copy back. The result is the end of the message of the
/// failure, which names the runs that put back a file that stayed. A run
/// that lost the lock never calls it: it would put its files back over the
/// work of the other run.
fn put_copy_back(
    device: &Device,
    journal: &mut Backup,
    head: Option<&String>,
    settle: impl FnOnce() -> Result<(), String>,
    next_runs: &str,
) -> Result<String, String> {
    let stayed = journal.put_all_back();
    if stayed.is_empty() && device.store.head().as_ref() == head {
        settle()?;
    }
    Ok(if stayed.is_empty() {
        "and the files of the copy are as they were before".to_owned()
    } else {
        format!(
            "and these files of the copy could not be put back: {}. The next {next_runs} puts them back",
            stayed.join(", ")
        )
    })
}

struct Backup<'a> {
    store: &'a ContentStore,
    /// The text of each file before the run (`None` for no file), or `Err`
    /// for a file that could not be read as text before its removal.
    before: BTreeMap<String, Result<Option<String>, ()>>,
}

impl<'a> Backup<'a> {
    fn new(store: &'a ContentStore) -> Self {
        Self {
            store,
            before: BTreeMap::new(),
        }
    }

    /// Writes a file, or removes it when there is no text. `Ok(true)` when the
    /// file changed.
    fn apply(&mut self, file: &StoreFile) -> Result<bool, String> {
        if !self.before.contains_key(&file.path) {
            let text = match self.store.read(&file.path) {
                Ok(text) => Ok(text),
                // A removal needs no text: a cleaned note under a guard that
                // is not valid UTF-8, or a link, must still leave the store.
                // An undo leaves such a file to the run journal, and the next
                // run puts it back from git.
                Err(_) if file.text.is_none() => Err(()),
                Err(error) => return Err(error),
            };
            self.before.insert(file.path.clone(), text);
        }
        match &file.text {
            // A file that already has the text is no change: the commit must
            // hold exactly the paths that changed. A copy that converts line
            // ends writes the files of its commit with Windows line ends.
            Some(text)
                if self
                    .before
                    .get(&file.path)
                    .and_then(|before| before.as_ref().ok())
                    .and_then(Option::as_ref)
                    .is_some_and(|before| before.replace("\r\n", "\n") == *text) =>
            {
                Ok(false)
            }
            Some(text) => self.store.write(&file.path, text).map(|()| true),
            None => self.store.remove(&file.path),
        }
    }

    /// Puts these files back as they were. Every file is tried, also when one
    /// fails. The result is the paths that could not be put back.
    fn put_back(&mut self, paths: &[String]) -> Vec<String> {
        let mut failed = Vec::new();
        for path in paths {
            let Some(text) = self.before.get(path) else {
                continue;
            };
            let result = match text {
                Ok(Some(text)) => self.store.write(path, text),
                Ok(None) => self.store.remove(path).map(|_| ()),
                Err(()) => Err(String::new()),
            };
            if result.is_ok() {
                self.before.remove(path);
            } else {
                failed.push(path.clone());
            }
        }
        failed
    }

    /// Puts every file back that the publication touched.
    fn put_all_back(&mut self) -> Vec<String> {
        let paths: Vec<String> = self.before.keys().cloned().collect();
        self.put_back(&paths)
    }
}

/// Why the files of a plan were not all written.
enum Failure {
    /// One note is left out (PUB-26).
    Note(String),
    /// The whole publication stops.
    Stop(String),
}

/// Writes the files of one note. They are one unit: when a write fails, the
/// files are put back as they were, and the error goes to the caller. When
/// they cannot be put back, the whole publication stops: a file that stayed
/// would be read as published at the next run. The result is the paths that
/// changed.
fn apply_unit(journal: &mut Backup, files: &[StoreFile]) -> Result<Vec<String>, Failure> {
    let mut changed = Vec::new();
    for file in files {
        match journal.apply(file) {
            Ok(true) => changed.push(file.path.clone()),
            Ok(false) => {}
            Err(error) => {
                let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
                let stayed = journal.put_back(&paths);
                return Err(if stayed.is_empty() {
                    Failure::Note(error)
                } else {
                    Failure::Stop(format!(
                        "the files of a note could not be written, and {} could not be put back: {error}",
                        stayed.join(", ")
                    ))
                });
            }
        }
    }
    Ok(changed)
}

/// The manifest entry of a note after its publication or its update.
fn entry_of(
    path: &str,
    texts: &NoteTexts,
    before: Option<&ManifestEntry>,
    time: &str,
    original: Option<&Original>,
) -> ManifestEntry {
    let cleaned_hash = content_hash(&texts.cleaned);
    let source_hash = content_hash(&texts.source);
    let Some(before) = before else {
        return ManifestEntry {
            aliases: texts.aliases.aliases.clone(),
            attachments: texts.attachments.clone(),
            cleaned_hash,
            cleaning_version: CLEANING_VERSION,
            first_published: time.to_owned(),
            former_paths: Vec::new(),
            id: note_id(path, time),
            last_published: time.to_owned(),
            links: texts.links.clone(),
            note_type: texts.note_type.clone(),
            original: original.cloned(),
            path: path.to_owned(),
            source_hash,
            state: State::Published,
            update_held: false,
        };
    };
    // The identity and the first date stay. A technical update does not move
    // the last date, nor a publication again of a text that did not change:
    // the author did not edit the note (PUB-24, PUB-71).
    let edited = before.source_hash != source_hash;
    ManifestEntry {
        aliases: texts.aliases.aliases.clone(),
        attachments: texts.attachments.clone(),
        cleaned_hash,
        cleaning_version: CLEANING_VERSION,
        last_published: if edited {
            time.to_owned()
        } else {
            before.last_published.clone()
        },
        links: texts.links.clone(),
        // A note that has no type now loses the type of its entry.
        note_type: texts.note_type.clone(),
        // Only the check of this run gives an original (PUB-100).
        original: original.cloned(),
        source_hash,
        state: State::Published,
        // An update ends a held update (R67).
        update_held: false,
        ..before.clone()
    }
}

/// The files of one note to write or to remove, its entry after the write,
/// and the attachments to upload before the files are written.
struct Unit {
    files: Vec<StoreFile>,
    entry: ManifestEntry,
    attachments: Vec<Attachment>,
}

/// The unit of a note to publish or to update.
fn note_unit(
    path: &str,
    texts: &BTreeMap<String, NoteTexts>,
    before: Option<&ManifestEntry>,
    time: &str,
    originals: &BTreeMap<String, CheckResult>,
) -> Result<Unit, String> {
    let texts = texts.get(path).ok_or("the plan has no text for the note")?;
    let original = originals.get(path).and_then(|result| result.as_ref().ok());
    let entry = entry_of(path, texts, before, time, original);
    Ok(Unit {
        files: vec![
            StoreFile {
                path: format!("{NOTES_FOLDER}/{path}"),
                text: Some(texts.cleaned.clone()),
            },
            StoreFile {
                path: manifest_file(&entry.id),
                text: Some(canonical(&to_value(&entry)?)?),
            },
        ],
        entry,
        attachments: texts.attachments.clone(),
    })
}

/// The unit of a note to unpublish: its cleaned note goes, and its entry
/// stays with another state.
fn removal_unit(path: &str, before: Option<&ManifestEntry>) -> Result<Unit, String> {
    let entry = before.ok_or("the note has no manifest entry")?;
    let unpublished = ManifestEntry {
        state: State::Unpublished,
        ..entry.clone()
    };
    Ok(Unit {
        files: vec![
            StoreFile {
                path: format!("{NOTES_FOLDER}/{path}"),
                text: None,
            },
            StoreFile {
                path: manifest_file(&entry.id),
                text: Some(canonical(&to_value(&unpublished)?)?),
            },
        ],
        entry: unpublished,
        attachments: Vec::new(),
    })
}

/// Which files under a guard a cleanup of the attachment storage keeps (rule
/// 10 of "The edits of the guards"). A run of the face `plugin` keeps none:
/// the author saw the plan. A run of an agent face (`command-line`,
/// `mcp-server`) keeps every file that a published entry lists and that a
/// guard covers, unless `accept` of the selection of the run names the
/// entry: a run that publishes nothing never deletes such a file.
#[derive(Clone, Copy)]
enum Guarded<'a> {
    /// Every file under a guard is used by no note.
    Deleted,
    /// The files under a guard of the entries that `accept` does not name
    /// stay used.
    KeptUnless(&'a [String]),
}

impl<'a> Guarded<'a> {
    /// What a cleanup of a run from this face, with this selection, keeps.
    fn of(run: &Run, selection: &'a Selection) -> Self {
        if run.face == "plugin" {
            Self::Deleted
        } else {
            Self::KeptUnless(selection.accept())
        }
    }

    /// True when the files under a guard of the entry at this path still
    /// count as used.
    fn keeps(self, path: &str) -> bool {
        match self {
            Self::Deleted => false,
            Self::KeptUnless(accept) => !accept.iter().any(|named| named == path),
        }
    }
}

/// The keys of the files of the attachment storage that the published notes
/// of a manifest use. An attachment whose file is under a guard now is used
/// by no note, also when an entry that the plan held still lists it, but for
/// the entries that a run of an agent face keeps (rule 10 of "The edits of
/// the guards").
fn used_keys(
    manifest: &BTreeMap<String, ManifestEntry>,
    scan: &Scan,
    vault: &Vault,
    guarded: Guarded,
) -> BTreeSet<String> {
    manifest
        .iter()
        .filter(|(_, entry)| entry.state == State::Published)
        .flat_map(|(path, entry)| {
            let kept = guarded.keeps(path);
            entry.attachments.iter().filter(move |attachment| {
                kept || !scan.is_guarded_file(vault, &attachment.path, &attachment.hash)
            })
        })
        .map(|attachment| key_of(&attachment.hash).to_owned())
        .collect()
}

/// The text of `withdrawn.json` after a publication whose manifest is
/// `after`, or `None` for no file (issue 120, rule 8 of a publication): the
/// earlier withdrawn keys and the keys that the guards withdraw from the
/// manifest before and after the run, less the keys that a published entry
/// after the run lists from a file under no guard. The guard alone decides
/// (decision of the author of 2026-11-26): a run of an agent face keeps such
/// a file in the folder of its device (rule 10), but its key is withdrawn
/// all the same, so it leaves the object storage of the host.
fn withdrawn_after(
    device: &Device,
    scan: &Scan,
    after: &BTreeMap<String, ManifestEntry>,
) -> Result<Option<String>, String> {
    let withdrawn_of = |manifest: &BTreeMap<String, ManifestEntry>| -> BTreeSet<String> {
        let used = used_keys(manifest, scan, &device.vault, Guarded::Deleted);
        published_keys(manifest)
            .into_iter()
            .filter(|key| !used.contains(key))
            .collect()
    };
    let earlier = parse_withdrawn(device.store.read(WITHDRAWN_FILE)?.as_deref())?;
    Ok(withdrawn_text(&withdrawn_keys(
        &earlier,
        &withdrawn_of(&scan.manifest),
        &withdrawn_of(after),
        &used_keys(after, scan, &device.vault, Guarded::Deleted),
    )))
}

/// Writes `withdrawn.json` into the copy, in the commit of the publication
/// (issue 120): every deployment deletes those keys from the object storage
/// of the host. It gives the path when the file changed.
fn write_withdrawn(
    device: &Device,
    journal: &mut Backup,
    computed: &Computed,
    after: &BTreeMap<String, ManifestEntry>,
) -> Result<Option<String>, String> {
    let file = StoreFile {
        path: WITHDRAWN_FILE.to_owned(),
        text: withdrawn_after(device, &computed.scan, after)?,
    };
    Ok(journal.apply(&file)?.then_some(file.path))
}

/// The paths of the content store that the journal of a publication names:
/// the paths of its plan, and `withdrawn.json` when the plan has one, or
/// when the withdrawn keys change: a plan with no note still writes them
/// (issue 120).
fn journal_paths(device: &Device, current: &Computed, run: &Run) -> Result<Vec<String>, String> {
    let mut paths = store_paths_of(
        &current.plan,
        &current.scan,
        run.time,
        &current.configuration_hash,
    );
    if !paths.is_empty()
        || withdrawn_after(device, &current.scan, &current.scan.manifest)?
            != device.store.read(WITHDRAWN_FILE)?
    {
        paths.push(WITHDRAWN_FILE.to_owned());
        paths.sort();
    }
    Ok(paths)
}

/// True when a name has the form of a file of the attachment storage: a key,
/// or a key that is being written (`.<key>.part`).
fn is_storage_name(name: &str) -> bool {
    let key = name
        .strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(".part"))
        .unwrap_or(name);
    key.len() == 64
        && key
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The uploads of one publication to the attachment storage (PUB-39).
struct Uploads<'a> {
    vault: &'a Vault,
    storage: &'a AttachmentStorage,
    /// The keys of the storage, listed before the first upload.
    present: Option<BTreeSet<String>>,
    /// The keys that this run uploaded, in the order of the uploads.
    uploaded: Vec<String>,
}

impl<'a> Uploads<'a> {
    fn new(vault: &'a Vault, storage: &'a AttachmentStorage) -> Self {
        Self {
            vault,
            storage,
            present: None,
            uploaded: Vec::new(),
        }
    }

    /// Uploads each attachment whose key the storage does not have yet. The
    /// bytes are read from the vault again, and must have the hash of the
    /// record: a file that changed since the plan is not uploaded.
    fn upload(&mut self, attachments: &[Attachment]) -> Result<(), String> {
        for attachment in attachments {
            let key = key_of(&attachment.hash);
            // The storage is listed one time, before the first upload: a
            // publication with no upload, a takedown for example, never needs
            // the storage.
            if self.present.is_none() {
                self.present = Some(self.storage.list()?.into_iter().collect());
            }
            if self
                .present
                .as_ref()
                .is_some_and(|present| present.contains(key))
            {
                continue;
            }
            // A file of another size, or above the size limit, is not read
            // (issue 72).
            let bytes = if attachment.size <= MAX_ATTACHMENT_SIZE
                && self.vault.size(&attachment.path)? == Some(attachment.size)
            {
                self.vault.read_bytes(&attachment.path)?
            } else {
                None
            };
            let Some(bytes) = bytes.filter(|bytes| bytes_hash(bytes) == attachment.hash) else {
                return Err(format!(
                    "the file \"{}\" changed since the plan, and it is not uploaded",
                    attachment.path
                ));
            };
            self.storage.put(key, &bytes)?;
            if let Some(present) = self.present.as_mut() {
                present.insert(key.to_owned());
            }
            self.uploaded.push(key.to_owned());
        }
        Ok(())
    }

    /// Deletes the uploads of this run that no published entry of the
    /// manifest lists (PUB-93). Every upload is tried. The result is the keys
    /// that could not be deleted.
    fn take_back(
        &self,
        manifest: &BTreeMap<String, ManifestEntry>,
        scan: &Scan,
        guarded: Guarded,
    ) -> Vec<String> {
        let used = used_keys(manifest, scan, self.vault, guarded);
        self.uploaded
            .iter()
            .filter(|key| !used.contains(*key) && self.storage.remove(key).is_err())
            .cloned()
            .collect()
    }
}

/// What the cleanup of the attachment storage did.
struct Cleanup {
    deleted: Vec<String>,
    /// The keys that the cleanup uploaded again.
    uploaded: Vec<String>,
    warnings: Vec<Value>,
}

/// Cleans the attachment storage: every file whose name is not the key of an
/// attachment of a published entry goes (PUB-82, PUB-84, PUB-93). It reads no
/// file of the storage. A name that is not in the form of a key is not a file
/// of the storage: it stays, with a warning, so a folder given by mistake loses
/// no file. A deletion that fails gives a warning, and the next publication
/// tries again.
fn clean_storage(
    storage: &AttachmentStorage,
    manifest: &BTreeMap<String, ManifestEntry>,
    scan: &Scan,
    vault: &Vault,
    guarded: Guarded,
) -> Cleanup {
    let (mut cleanup, present) = delete_unused(storage, &used_keys(manifest, scan, vault, guarded));
    if let Some(present) = present {
        repair_storage(storage, manifest, scan, vault, &present, &mut cleanup);
    }
    cleanup
}

/// Deletes every file of the attachment storage whose name is a key, or a key
/// that is being written, and is not one of the used keys. A name that is not
/// in the form of a key stays, with a warning. The result has the names of
/// the storage, or `None` when it could not be listed.
fn delete_unused(
    storage: &AttachmentStorage,
    used: &BTreeSet<String>,
) -> (Cleanup, Option<BTreeSet<String>>) {
    let mut cleanup = Cleanup {
        deleted: Vec::new(),
        uploaded: Vec::new(),
        warnings: Vec::new(),
    };
    let mut names = match storage.list() {
        Ok(names) => names,
        Err(error) => {
            cleanup.warnings.push(json!({
                "message": format!("the attachment storage could not be listed, and it is cleaned at the next publication: {error}"),
                "path": "",
            }));
            return (cleanup, None);
        }
    };
    sort_by_code_point(&mut names);
    let present: BTreeSet<String> = names.iter().cloned().collect();
    for name in names {
        // The files that macOS and Windows put into a folder by themselves
        // stay with no warning (decision of the author R82).
        if used.contains(&name) || SYSTEM_FILES.contains(&name.as_str()) {
            continue;
        }
        if !is_storage_name(&name) {
            cleanup.warnings.push(json!({
                "message": "the attachment storage holds a file whose name is not a key, and the tool leaves it: is the folder of the storage the right one?",
                "path": name,
            }));
            continue;
        }
        match storage.remove(&name) {
            Ok(true) => cleanup.deleted.push(name),
            Ok(false) => {}
            Err(error) => cleanup.warnings.push(json!({
                "message": format!("the file could not be deleted from the attachment storage, and the next publication tries again: {error}"),
                "path": name,
            })),
        }
    }
    (cleanup, Some(present))
}

/// Uploads again every file that a published entry uses and that the storage
/// does not have (R46): the cleanup of another device can delete an upload
/// that this device made before its push. The bytes come from the vault path
/// of an attachment with that key, and must have its hash. The attachments
/// are tried in the order of the paths of the notes, then in the order of
/// each list. A file under a guard now is never uploaded again.
fn repair_storage(
    storage: &AttachmentStorage,
    manifest: &BTreeMap<String, ManifestEntry>,
    scan: &Scan,
    vault: &Vault,
    present: &BTreeSet<String>,
    cleanup: &mut Cleanup,
) {
    // The map gives the keys in the order of the code points.
    let mut wanted: BTreeMap<&str, Vec<&Attachment>> = BTreeMap::new();
    for entry in manifest
        .values()
        .filter(|entry| entry.state == State::Published)
    {
        for attachment in &entry.attachments {
            let key = key_of(&attachment.hash);
            if present.contains(key)
                || scan.is_guarded_file(vault, &attachment.path, &attachment.hash)
            {
                continue;
            }
            wanted.entry(key).or_default().push(attachment);
        }
    }
    for (key, attachments) in wanted {
        let found = attachments.iter().find_map(|attachment| {
            // A file of another size, or above the size limit, is not read
            // (issue 72).
            if attachment.size > MAX_ATTACHMENT_SIZE {
                return None;
            }
            vault
                .size(&attachment.path)
                .ok()
                .flatten()
                .filter(|size| *size == attachment.size)?;
            vault
                .read_bytes(&attachment.path)
                .ok()
                .flatten()
                .filter(|bytes| bytes_hash(bytes) == attachment.hash)
                .map(|bytes| (attachment.path.as_str(), bytes))
        });
        let Some((path, bytes)) = found else {
            cleanup.warnings.push(json!({
                "message": "the file is missing from the attachment storage, and the vault does not have its bytes any more: its note shows it as missing until its next update",
                "path": attachments.first().map_or("", |attachment| attachment.path.as_str()),
            }));
            continue;
        };
        match storage.put(key, &bytes) {
            Ok(()) => {
                cleanup.uploaded.push(key.to_owned());
                cleanup.warnings.push(json!({
                    "message": "the file was missing from the attachment storage (the cleanup of another device can delete it), and it is uploaded again",
                    "path": path,
                }));
            }
            Err(error) => cleanup.warnings.push(json!({
                "message": format!("the file is missing from the attachment storage, and it could not be uploaded again: {error}"),
                "path": path,
            })),
        }
    }
}

/// Every path of the content store that the publication of a plan can write
/// or remove: the cleaned note and the manifest entry of each of its notes.
/// The two files of a note in the content store: its cleaned note and its
/// manifest entry. A forced removal and a takedown remove both (PUB-84).
fn files_of_note(path: &str, id: &str) -> [String; 2] {
    [format!("{NOTES_FOLDER}/{path}"), manifest_file(id)]
}

/// The keys of the attachments of the published entries of a manifest, with
/// no guard check: a takedown reads no file of the vault.
fn published_keys(manifest: &BTreeMap<String, ManifestEntry>) -> BTreeSet<String> {
    manifest
        .values()
        .filter(|entry| entry.state == State::Published)
        .flat_map(|entry| &entry.attachments)
        .map(|attachment| key_of(&attachment.hash).to_owned())
        .collect()
}

fn store_paths_of(
    plan: &PublicationPlan,
    scan: &Scan,
    time: &str,
    configuration_hash: &str,
) -> Vec<String> {
    let mut paths = BTreeSet::new();
    // The entry of a pairing is still at its old path in the scan.
    let mut ids: BTreeMap<&str, String> = scan
        .manifest
        .iter()
        .map(|(path, entry)| (path.as_str(), entry.id.clone()))
        .collect();
    for one in plan.moves() {
        // The entry of a move of a journal is at its new path in the scan,
        // and the entry of a pairing is still at its old path.
        let id = if scan.queue.renamed.contains(one) {
            ids.get(one.to.as_str())
        } else {
            ids.get(one.from.as_str())
        }
        .cloned();
        if let Some(id) = id {
            paths.extend(files_of_note(&one.from, &id));
            paths.insert(format!("{NOTES_FOLDER}/{}", one.to));
            ids.insert(one.to.as_str(), id);
        }
    }
    for path in plan
        .forced_remove()
        .iter()
        .chain(plan.publish())
        .chain(plan.update())
        .chain(plan.remove())
    {
        let id = ids
            .get(path.as_str())
            .cloned()
            .unwrap_or_else(|| note_id(path, time));
        paths.extend(files_of_note(path, &id));
    }
    for entry in scan.displaced.iter().chain(&scan.released) {
        paths.insert(manifest_file(&entry.id));
    }
    if scan.journals.read {
        paths.insert(RENAMES_FILE.to_owned());
    }
    // The publication marks the events of the plan as shown (R69), and keeps
    // the hash of the configuration (issue 108).
    if scan
        .edits
        .after_publication(plan.edits().len(), configuration_hash, !paths.is_empty())
        .is_some()
    {
        paths.insert(EDITS_FILE.to_owned());
    }
    // The set gives its texts in the order of the code points.
    paths.into_iter().collect()
}

/// Removes the manifest files of the unpublished entries whose paths a move
/// took (rule 6 of the moves): they leave the manifest with the move. Their
/// notes have no cleaned note in the store. The result is the paths that
/// changed.
fn remove_displaced(journal: &mut Backup, scan: &Scan) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    for entry in &scan.displaced {
        let removal = StoreFile {
            path: manifest_file(&entry.id),
            text: None,
        };
        if journal.apply(&removal).map_err(|error| {
            format!(
                "the entry of the unpublished note \"{}\" could not leave the manifest: {error}",
                entry.path
            )
        })? {
            changed.push(removal.path);
        }
    }
    Ok(changed)
}

/// Writes the entries whose held update ended without their mark (issue
/// 106). The result is the paths that changed.
fn write_released(journal: &mut Backup, scan: &Scan) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    for entry in &scan.released {
        let fail = |error: String| {
            format!(
                "the entry of the note \"{}\" could not be written without its held update: {error}",
                entry.path
            )
        };
        let file = StoreFile {
            path: manifest_file(&entry.id),
            text: Some(canonical(&to_value(entry).map_err(fail)?).map_err(fail)?),
        };
        if journal.apply(&file).map_err(fail)? {
            changed.push(file.path);
        }
    }
    Ok(changed)
}

/// Applies the forced removals of a plan: the cleaned note and the manifest
/// entry of each note that a guard excludes leave the content store. This is
/// the takedown rule (PUB-21, PUB-84). The result is the paths that changed.
///
/// When one removal fails, the error goes to the caller, which puts every
/// file back: no note is published while a note under a guard stays live.
fn remove_forced(
    journal: &mut Backup,
    plan: &PublicationPlan,
    manifest: &BTreeMap<String, ManifestEntry>,
) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    for path in plan.forced_remove() {
        let mut remove = || -> Result<(), String> {
            let entry = manifest.get(path).ok_or("the note has no manifest entry")?;
            for file in files_of_note(path, &entry.id) {
                let removal = StoreFile {
                    path: file.clone(),
                    text: None,
                };
                if journal.apply(&removal)? {
                    changed.push(file);
                }
            }
            Ok(())
        };
        remove().map_err(|error| {
            format!(
                "a guard excludes \"{path}\", and it could not be removed from the content store: {error}"
            )
        })?;
    }
    Ok(changed)
}

/// What the correction of the state property did.
#[derive(Default)]
struct Correction {
    property_removed: Vec<String>,
    property_set: Vec<String>,
    warnings: Vec<Value>,
}

/// Corrects the state property of the notes of the scan, after a push that
/// succeeded (PUB-13): a published note has it with the value true, and every
/// other note of the scan does not have it. A note is written only when its
/// text changes, and never when it changed since the scan.
fn correct_state(device: &Device, scan: &Scan, published: &BTreeSet<String>) -> Correction {
    let mut correction = Correction::default();
    for (path, note) in &scan.notes {
        let is_published = published.contains(path);
        let is_right = if is_published {
            note.state_is_set
        } else {
            !note.names_state
        };
        if is_right {
            continue;
        }
        let mut warn = |message: String| {
            correction
                .warnings
                .push(json!({ "message": message, "path": path }));
        };
        let text = match device.vault.read(path) {
            Ok(Some(text)) if content_hash(&text) == note.text_hash => text,
            Ok(_) => {
                warn(changed_during_run());
                continue;
            }
            Err(error) => {
                warn(format!(
                    "the {STATE_PROPERTY} property could not be corrected: the note {error}"
                ));
                continue;
            }
        };
        match write_state(device, path, &text, is_published) {
            Ok(StateWrite::Written) if is_published => correction.property_set.push(path.clone()),
            Ok(StateWrite::Written) => correction.property_removed.push(path.clone()),
            Ok(StateWrite::Left(warning)) => warn(warning),
            Err(error) => warn(format!(
                "the {STATE_PROPERTY} property could not be corrected: {error}"
            )),
        }
    }
    correction
}

/// What `write_state` did with a note.
enum StateWrite {
    /// The note was written.
    Written,
    /// The note was not written, with the warning that says why.
    Left(String),
}

/// Sets the state property of a note to true, or removes it. `Err` when the
/// write failed.
fn write_state(
    device: &Device,
    path: &str,
    text: &str,
    is_published: bool,
) -> Result<StateWrite, String> {
    // A new line below a line in the flow form of YAML (`{ }`, `[ ]`) is not
    // valid YAML. The note stays as the author wrote it.
    if has_flow_properties(text) {
        return Ok(StateWrite::Left(format!(
            "the properties of the note are in the flow form of YAML ({{ }} or [ ]), and the tool does not write into that form: correct the {STATE_PROPERTY} property by hand"
        )));
    }
    let wanted = if is_published {
        set_property(text, STATE_PROPERTY, "true")
    } else {
        remove_property(text, STATE_PROPERTY)
    };
    // The write must not change what the guard reads. In an odd form of the
    // properties, a line of the ignore property can belong to the state
    // property, or the new lines can close properties that were open. Such a
    // note is never written.
    if names_in_properties(&wanted, IGNORE_PROPERTY) != names_in_properties(text, IGNORE_PROPERTY) {
        return Ok(StateWrite::Left(format!(
            "the {STATE_PROPERTY} property cannot be corrected with no change to what the ignore property says: correct it by hand"
        )));
    }
    // The note is read again right before the write, as the TypeScript
    // face does (issue 106): a note that changed since the read is not
    // written.
    if device.vault.read(path)?.as_deref() != Some(text) {
        return Ok(StateWrite::Left(changed_during_run()));
    }
    device.vault.write(path, &wanted)?;
    Ok(StateWrite::Written)
}

/// The warning of a note that changed between the read of the tool and its
/// write.
fn changed_during_run() -> String {
    format!(
        "the note changed during the publication: its {STATE_PROPERTY} property is corrected at the next publication"
    )
}

/// Checks the inputs of a publication: the time, the name of the device, the
/// face and the id of the plan.
fn check_inputs(id: &str, run: &Run) -> Result<(), String> {
    check_run(run)?;
    if !is_plan_id(id) {
        return Err(format!(
            "\"{id}\" is not the id of a plan: an id is 16 hexadecimal digits"
        ));
    }
    Ok(())
}

/// Checks what a face gives to a run: the time, the name of the device and
/// the face.
fn check_run(run: &Run) -> Result<(), String> {
    if !is_canonical_time(run.time) {
        return Err(format!(
            "the time of the run must be a real date and time in UTC, to the second: \"{}\" is not",
            run.time
        ));
    }
    if !is_one_line(run.device) {
        return Err("the name of the device must be one line of text".to_owned());
    }
    if !FACES.contains(&run.face) {
        return Err(format!("\"{}\" is not a face of the tool", run.face));
    }
    Ok(())
}

/// What the writes of a plan did.
struct Written {
    failed: Vec<Value>,
    /// The published and updated notes whose original is not verified, each
    /// with its `path` and a `reason` (IDX-13).
    originals_not_verified: Vec<Value>,
    published: Vec<String>,
    updated: Vec<String>,
    removed: Vec<String>,
    skipped: Vec<String>,
    /// The paths of the content store that changed.
    paths: Vec<String>,
    /// The manifest after the writes, by the vault path of each note.
    manifest: BTreeMap<String, ManifestEntry>,
}

/// The lists of the notes of a plan that were written.
#[derive(Default)]
struct Done {
    published: Vec<String>,
    updated: Vec<String>,
    removed: Vec<String>,
}

/// What the commit of a publication needs besides the run.
struct Commit<'a> {
    /// The id of the plan, for the message of the commit.
    plan: &'a str,
    /// Fails when the lock of the run is not its own any more.
    own_lock: &'a dyn Fn() -> Result<(), String>,
}

/// Applies the moves of a plan to the copy (R66): the published version moves
/// as it is, and a move that fails stops the whole publication, as a forced
/// removal does. The entry of a move of a journal is at its new path in the
/// scan, and the entry of a pairing is still at its old path. The result is
/// the new paths of the moves.
fn apply_store_moves(
    device: &Device,
    journal: &mut Backup,
    plan: &PublicationPlan,
    scan: &Scan,
    manifest: &mut BTreeMap<String, ManifestEntry>,
    paths: &mut Vec<String>,
) -> Result<BTreeSet<String>, String> {
    let mut targets = BTreeSet::new();
    let fail = |one: &Move, error: String| {
        format!(
            "the note \"{}\" could not be moved to \"{}\" in the content store: {error}",
            one.from, one.to
        )
    };
    let keeps =
        |one: &Move| !plan.remove().contains(&one.to) && !plan.forced_remove().contains(&one.to);
    // In three phases, so that a move into a path that another move leaves,
    // and a swap, lose no text: every old text is read first, then the old
    // files that no move writes again are removed, then the new files are
    // written.
    let mut steps: Vec<(&Move, ManifestEntry, Option<String>)> = Vec::new();
    for one in plan.moves() {
        let mut read = || -> Result<(ManifestEntry, Option<String>), String> {
            let entry = if scan.queue.renamed.contains(one) {
                manifest.get(&one.to).cloned()
            } else {
                manifest
                    .remove(&one.from)
                    .map(|before| moved_entry(&before, &one.to))
            }
            .ok_or("the note has no manifest entry")?;
            manifest.insert(one.to.clone(), entry.clone());
            let text = if entry.state == State::Published {
                let from = format!("{NOTES_FOLDER}/{}", one.from);
                Some(
                    device
                        .store
                        .read(&from)?
                        .ok_or_else(|| format!("the copy has no {from}"))?,
                )
            } else {
                None
            };
            Ok((entry, text))
        };
        let (entry, text) = read().map_err(|error| fail(one, error))?;
        targets.insert(one.to.clone());
        steps.push((one, entry, text));
    }
    let rewritten: BTreeSet<&String> = steps
        .iter()
        .filter(|(one, _, text)| text.is_some() && keeps(one))
        .map(|(one, _, _)| &one.to)
        .collect();
    for (one, _, text) in &steps {
        if text.is_some() && !rewritten.contains(&one.from) {
            let removal = StoreFile {
                path: format!("{NOTES_FOLDER}/{}", one.from),
                text: None,
            };
            if journal.apply(&removal).map_err(|error| fail(one, error))? {
                paths.push(removal.path);
            }
        }
    }
    for (one, entry, text) in &steps {
        let mut write = || -> Result<(), String> {
            let mut files = vec![StoreFile {
                path: manifest_file(&entry.id),
                text: Some(canonical(&to_value(entry)?)?),
            }];
            if let Some(text) = text.as_ref().filter(|_| keeps(one)) {
                files.push(StoreFile {
                    path: format!("{NOTES_FOLDER}/{}", one.to),
                    text: Some(text.clone()),
                });
            }
            for file in &files {
                if journal.apply(file)? {
                    paths.push(file.path.clone());
                }
            }
            Ok(())
        };
        write().map_err(|error| fail(one, error))?;
    }
    Ok(targets)
}

/// Writes the two markers of a publication, in its commit: the read marker of
/// the rename journals (R66), and the log of the edits of the guards with the
/// events that the plan showed (R69), so that the next plan shows only the
/// newer ones. A publication never makes the log. The result is the paths
/// that changed.
fn write_markers(
    journal: &mut Backup,
    computed: &Computed,
    commits: bool,
) -> Result<Vec<String>, String> {
    let Computed {
        plan,
        scan,
        configuration_hash,
        ..
    } = computed;
    let mut changed = Vec::new();
    if scan.journals.read {
        let file = StoreFile {
            path: RENAMES_FILE.to_owned(),
            text: Some(canonical(&to_value(&scan.journals.markers)?)?),
        };
        if journal.apply(&file)? {
            changed.push(file.path);
        }
    }
    // A log with no hash of the configuration yet gets one only with a
    // commit that the publication makes anyway (issue 108).
    let commits = commits || !changed.is_empty();
    if let Some(log) = scan
        .edits
        .after_publication(plan.edits().len(), configuration_hash, commits)
    {
        let file = StoreFile {
            path: EDITS_FILE.to_owned(),
            text: Some(log.text()?),
        };
        if journal.apply(&file)? {
            changed.push(file.path);
        }
    }
    Ok(changed)
}

/// The message of the commit of a publication: the counts, the device, the
/// face and the plan (PUB-29).
fn publish_message(
    plan: &PublicationPlan,
    done: &Done,
    skipped: usize,
    run: &Run,
    id: &str,
) -> String {
    format!(
        "Publish: {} new, {} updated, {} removed, {} forced, {} skipped, {} moved\n\nDevice: {}\nFace: {}\nPlan: {id}",
        done.published.len(),
        done.updated.len(),
        done.removed.len(),
        plan.forced_remove().len(),
        skipped,
        plan.moves().len(),
        run.device,
        run.face,
    )
}

/// Commits and pushes these paths with the seal of the vault (R104).
fn commit_sealed(device: &Device, message: &str, paths: &[String]) -> Result<(), String> {
    let key = device.seal.key()?;
    device.store.commit_and_push(
        message,
        paths,
        Some(&|parents: &[String], files: &[TreeFile]| seal_of(&key, parents, files)),
    )
}

/// Writes the files of a plan into the copy, and commits and pushes them.
/// The moves come first, then the forced removals: when one fails, the whole
/// publication stops. A note whose uploads or files fail is left out and reported
/// (PUB-26).
fn write_all(
    device: &Device,
    journal: &mut Backup,
    uploads: &mut Uploads,
    computed: &Computed,
    run: &Run,
    commit: &Commit,
    originals: &BTreeMap<String, CheckResult>,
) -> Result<Written, String> {
    let Computed {
        plan, scan, texts, ..
    } = computed;
    // The moves and the forced removals are no unit of one note: a failure
    // stops the whole publication.
    // The moves come first (R66): a forced removal can take the new path of a
    // move. Then the forced removals.
    let mut paths = Vec::new();
    let mut manifest = scan.manifest.clone();
    let targets = apply_store_moves(device, journal, plan, scan, &mut manifest, &mut paths)?;
    paths.extend(remove_displaced(journal, scan)?);
    paths.extend(write_released(journal, scan)?);
    paths.extend(remove_forced(journal, plan, &manifest)?);
    for path in plan.forced_remove() {
        manifest.remove(path);
    }
    // The entries after the moves: each unit of a note starts from its entry.
    let moved = manifest.clone();
    let mut failed = Vec::new();
    let mut done = Done::default();
    let mut apply = |path: &String, unit: Result<Unit, String>| -> Result<bool, String> {
        // The uploads come first: a note whose file is not in the storage is
        // never published.
        let result = unit.map_err(Failure::Note).and_then(|unit| {
            uploads.upload(&unit.attachments).map_err(Failure::Note)?;
            let changed = apply_unit(journal, &unit.files)?;
            Ok((changed, unit.entry))
        });
        match result {
            Ok((changed, entry)) => {
                paths.extend(changed);
                manifest.insert(path.clone(), entry);
                Ok(true)
            }
            // The move of the note already changed its files (rule 4 of a
            // publication).
            Err(Failure::Note(reason)) if targets.contains(path) => Err(format!(
                "the note \"{path}\" moved, and its update failed: {reason}"
            )),
            // A failure of one note leaves that note out (PUB-26).
            Err(Failure::Note(reason)) => {
                failed.push(json!({ "path": path, "reason": reason }));
                Ok(false)
            }
            Err(Failure::Stop(reason)) => Err(reason),
        }
    };
    for path in plan.publish() {
        if apply(
            path,
            note_unit(path, texts, moved.get(path), run.time, originals),
        )? {
            done.published.push(path.clone());
        }
    }
    for path in plan.update() {
        if apply(
            path,
            note_unit(path, texts, moved.get(path), run.time, originals),
        )? {
            done.updated.push(path.clone());
        }
    }
    for path in plan.remove() {
        if apply(path, removal_unit(path, moved.get(path)))? {
            done.removed.push(path.clone());
        }
    }
    paths.extend(write_markers(journal, computed, !paths.is_empty())?);
    paths.extend(write_withdrawn(device, journal, computed, &manifest)?);
    // Each path one time, in the order of the writes.
    let mut seen = BTreeSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    let skipped: Vec<String> = scan
        .queue
        .changed
        .iter()
        .filter(|path| !plan.update().contains(path) && !plan.remove().contains(path))
        .cloned()
        .collect();
    if !paths.is_empty() {
        crash_point("write");
        steal_point("commit", &device.store);
        (commit.own_lock)()?;
        // The recovery of a run that stopped halfway finds its commit by the
        // line `Plan:`.
        let message = publish_message(plan, &done, skipped.len(), run, commit.plan);
        commit_sealed(device, &message, &paths)?;
    }
    // Sorted by path, like every list of the report. A stable sort.
    failed.sort_by(|one: &Value, two: &Value| one["path"].as_str().cmp(&two["path"].as_str()));
    Ok(Written {
        failed,
        originals_not_verified: not_verified(&done, originals),
        published: done.published,
        updated: done.updated,
        removed: done.removed,
        skipped,
        paths,
        manifest,
    })
}

/// The published and updated notes of a run whose original is not verified,
/// each with its `path` and a `reason`, sorted by path (IDX-13).
fn not_verified(done: &Done, originals: &BTreeMap<String, CheckResult>) -> Vec<Value> {
    let mut checked: Vec<&String> = done.published.iter().chain(&done.updated).collect();
    // As `String`: the order of the code points.
    checked.sort();
    checked
        .into_iter()
        .filter_map(|path| match originals.get(path) {
            Some(Err(reason)) => Some(json!({ "path": path, "reason": reason })),
            _ => None,
        })
        .collect()
}

/// The checks of the posts on the main site of the notes to publish and to
/// update (PUB-100). A check never stops the publication: a note without a
/// verified post is noindex (IDX-13).
fn check_originals(
    device: &Device,
    current: &Computed,
    time: &str,
) -> BTreeMap<String, CheckResult> {
    let notes: Vec<CheckedNote> = current
        .plan
        .publish()
        .iter()
        .chain(current.plan.update())
        .map(|path| {
            let texts = current.texts.get(path);
            CheckedNote {
                path,
                note_type: texts.and_then(|texts| texts.note_type.as_ref()),
                source: texts.map_or("", |texts| texts.source.as_str()),
            }
        })
        .collect();
    device.main_site.check(&notes, time)
}

/// Applies exactly one plan, by its id.
///
/// It takes the lock of the device, and puts back what a publication that
/// stopped halfway left. It computes the record of the plan again: when the
/// new record is not the stored one, the plan is stale and nothing is
/// published. The run journal is written before the first write into the
/// copy. The moves and the forced removals come first: when one fails, nothing is
/// published. Then the attachments go to the attachment storage, and the
/// cleaned notes and the manifest entries go to the content store in one
/// commit, which is pushed. A note whose uploads or files fail is left out and
/// reported. Only after the push, the state property is corrected in the
/// vault. Then every file of the attachment storage that no published note
/// uses is deleted, and every file that one uses and that is missing is
/// uploaded again. The result is the report of the publication, in the
/// canonical form.
///
/// # Errors
///
/// An input of the run is wrong, the lock is taken, the plan is unknown or
/// stale, a forced removal failed, or the commit or the push failed.
pub fn publish(
    device: &Device,
    storage: &AttachmentStorage,
    id: &str,
    run: &Run,
) -> Result<Outcome, String> {
    check_inputs(id, run)?;
    let holder = json!({
        "command": "publish",
        "device": run.device,
        "face": run.face,
        "time": run.time,
    });
    with_lock(device, &holder, |own_lock| {
        apply(device, storage, id, run, own_lock)
    })
}

/// The warnings of a cleanup of the attachment storage, as the end of the
/// message of a refusal: nothing when there is none (issue 77).
fn warning_lines(warnings: &[Value]) -> String {
    if warnings.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = warnings
        .iter()
        .map(|warning| {
            let path = warning["path"].as_str().unwrap_or_default();
            let message = warning["message"].as_str().unwrap_or_default();
            if path.is_empty() {
                format!("- {message}")
            } else {
                // A line break of a name of the storage is written as \\n: one
                // warning, one line.
                format!("- {}: {message}", path.replace('\n', "\\n"))
            }
        })
        .collect();
    format!(
        "\nThe cleanup of the attachment storage gave these warnings:\n{}",
        lines.join("\n")
    )
}

/// `Err` when the plan is stale. The run fetched and the copy follows the
/// content store, so the storage is cleaned first: a file that came under a
/// guard leaves it also when the plan is stale.
fn refuse_stale(
    device: &Device,
    storage: &AttachmentStorage,
    current: &Computed,
    record: &str,
    id: &str,
    run: &Run,
) -> Result<(), String> {
    if current.record == record {
        return Ok(());
    }
    // A run of an agent face keeps the files under a guard of the entries
    // that its accept does not name (rule 10 of "The edits of the guards").
    let cleanup = clean_storage(
        storage,
        &current.scan.manifest,
        &current.scan,
        &device.vault,
        Guarded::of(run, &current.selection),
    );
    let types = note_type_changes(record, &current.record);
    Err(if types.is_empty() {
        format!(
            "the plan {id} is stale: a note of the plan, the publication queue, a rename journal, the configuration or the content store changed. Make a new plan{}",
            warning_lines(&cleanup.warnings)
        )
    } else {
        format!(
            "the plan {id} is stale: the note type of a note of the plan changed since the plan was made. Make a new plan\n{}\nOther changes can also make the plan stale.{}",
            types.join("\n"),
            warning_lines(&cleanup.warnings)
        )
    })
}

/// The note types of the notes of a record, by their paths.
fn record_types(record: &str) -> BTreeMap<String, Option<NoteType>> {
    let Ok(value) = parse_json(record) else {
        return BTreeMap::new();
    };
    value["state"]["notes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|note| {
            let path = note["path"].as_str()?;
            Some((path.to_owned(), note_type_of_entry(&note["noteType"])))
        })
        .collect()
}

/// The type of a note as a line of a refusal: its name, or `no type`.
fn type_text(note_type: Option<&NoteType>) -> String {
    note_type.map_or_else(
        || "no type".to_owned(),
        |note_type| format!("\"{}\"", note_type.name),
    )
}

/// The notes of both records whose note type is another one in the new
/// record (issue 96, R83): one line each, `- <path>: <type in the plan> in
/// the plan, <type now> now`, in the order of the records. A line break of a
/// path is written `\n`.
fn note_type_changes(stored: &str, current: &str) -> Vec<String> {
    let before = record_types(stored);
    record_types(current)
        .into_iter()
        .filter_map(|(path, now)| {
            let was = before.get(&path)?;
            if *was == now {
                return None;
            }
            let other = match (was, &now) {
                (Some(was), Some(now)) if was.name == now.name => {
                    ", with another display name, prefix or suffix"
                }
                _ => "",
            };
            Some(format!(
                "- {}: {} in the plan, {} now{other}",
                path.replace('\n', "\\n"),
                type_text(was.as_ref()),
                type_text(now.as_ref())
            ))
        })
        .collect()
}

/// The publication of a plan, with the lock of the device.
fn apply(
    device: &Device,
    storage: &AttachmentStorage,
    id: &str,
    run: &Run,
    own_lock: &dyn Fn() -> Result<(), String>,
) -> Result<Outcome, String> {
    // A publication that stopped halfway is put back first. When it stopped
    // after its push, the correction of the property is owed.
    let owed = recover(device, own_lock)?;
    let record = device
        .store
        .load_plan(id)
        .ok_or_else(|| format!("there is no plan with the id {id} on this device"))?;
    let selection = selection_of(&record, id)?;
    let current = record_for(device, &|_| selection.clone(), Fetch::Must)?;
    refuse_stale(device, storage, &current, &record, id, run)?;
    apply_current(
        device,
        storage,
        &Commit { plan: id, own_lock },
        run,
        owed,
        &current,
    )
}

/// The writes of a plan whose record was just computed, with the lock of the
/// device: the journal, the files, the commit and the push, the correction of
/// the property and the cleanup of the storage. `owed` is true when an earlier
/// publication still owes its correction.
fn apply_current(
    device: &Device,
    storage: &AttachmentStorage,
    commit: &Commit,
    run: &Run,
    owed: bool,
    current: &Computed,
) -> Result<Outcome, String> {
    let (id, own_lock) = (commit.plan, commit.own_lock);
    refuse_unaccepted(current, run)?;
    // The journal comes before the first write into the copy: a run that
    // stops halfway is put back by the next one.
    let paths = journal_paths(device, current, run)?;
    // The posts are checked before the first write (PUB-100).
    let originals = check_originals(device, current, run.time);
    let head = device.store.head();
    own_lock()?;
    if !paths.is_empty() {
        device
            .store
            .save_journal(&journal_text(&RunJournal::Write {
                correction_owed: owed,
                head: head.clone(),
                paths: paths.clone(),
                plan: id.to_owned(),
            })?)?;
    }
    // The journal after the run: `correct` while a correction is owed, else
    // none.
    let settle = |correct: bool| -> Result<(), String> {
        if correct {
            device
                .store
                .save_journal(&journal_text(&RunJournal::Correct)?)
        } else if paths.is_empty() {
            Ok(())
        } else {
            device.store.remove_journal()
        }
    };

    let mut journal = Backup::new(&device.store);
    let mut uploads = Uploads::new(&device.vault, storage);
    let written = match write_all(
        device,
        &mut journal,
        &mut uploads,
        current,
        run,
        commit,
        &originals,
    ) {
        Ok(written) => written,
        // Another run took the copy: this run touches nothing of it any more,
        // or it would put its files back over the work of the other run.
        Err(error) if error == LOCK_LOST => return Err(error),
        Err(error) => {
            // An upload that stays would be public with no entry.
            let kept = uploads.take_back(
                &current.scan.manifest,
                &current.scan,
                Guarded::of(run, &current.selection),
            );
            let files = put_copy_back(
                device,
                &mut journal,
                head.as_ref(),
                || settle(owed),
                "plan, publish or takedown",
            )?;
            let storage = if kept.is_empty() {
                String::new()
            } else {
                format!(
                    ". These uploads could not be deleted from the attachment storage, and the next publication deletes them: {}",
                    kept.join(", ")
                )
            };
            return Err(format!("{error}. Nothing is published, {files}{storage}"));
        }
    };
    crash_point("push");
    // The push arrived, but when another run took the copy, this run changes
    // nothing more: the other run owns the journal.
    own_lock()?;
    // With nothing to commit there is no push, and without a push no property
    // is corrected, unless an earlier run pushed and stopped before its
    // correction.
    let correct = !written.paths.is_empty() || owed;
    settle(correct)?;
    let mut correction = Correction::default();
    if correct {
        // The push succeeded: the manifest of the copy is the manifest of the
        // content store. The vault now says the same.
        let now_published: BTreeSet<String> = written
            .manifest
            .iter()
            .filter(|(_, entry)| entry.state == State::Published)
            .map(|(path, _)| path.clone())
            .collect();
        correction = correct_state(device, &current.scan, &now_published);
    }
    // The copy follows the content store: the run fetched it and was not
    // behind, and a push, when there was one, succeeded.
    let cleanup = clean_storage(
        storage,
        &written.manifest,
        &current.scan,
        &device.vault,
        Guarded::of(run, &current.selection),
    );
    if correct {
        device.store.remove_journal()?;
    }
    let notes = || written.published.iter().chain(&written.updated);
    let mut reserved = reserved_alias_warnings(&current.texts, notes());
    reserved.extend(live_query_warnings(&current.texts, notes()));
    report_of(
        &written,
        &current.plan,
        &current.scan,
        &uploads.uploaded,
        reserved,
        correction,
        cleanup,
    )
}

/// One warning for each published or updated note with a live query (rule 8
/// of "The frozen lists of a note"), sorted by path.
fn live_query_warnings<'a>(
    texts: &BTreeMap<String, NoteTexts>,
    paths: impl Iterator<Item = &'a String>,
) -> Vec<Value> {
    live_queries(texts, paths)
        .into_iter()
        .map(|path| {
            json!({
                "path": path,
                "message": "the note has a live Dataview or Bases block with no frozen form: the page does not show it (REN-14)",
            })
        })
        .collect()
}

/// `liveQueries` (rule 5 of "The frozen lists of a note"): the paths of the
/// notes with a live query, sorted by path.
fn live_queries<'a>(
    texts: &BTreeMap<String, NoteTexts>,
    paths: impl Iterator<Item = &'a String>,
) -> Vec<String> {
    let mut found: Vec<String> = paths
        .filter(|path| {
            texts
                .get(*path)
                .is_some_and(|note| has_live_query(&note.source))
        })
        .cloned()
        .collect();
    sort_by_code_point(&mut found);
    found
}

/// The reason of each note of `listsNotRefreshed` in this face.
const NO_REFRESH: &str = "the command line program refreshes no list";

/// `listsNotRefreshed` (rule 6 of "The frozen lists of a note"): the paths of
/// the notes with a list to refresh, sorted by path. The Rust program
/// refreshes nothing: with Obsidian closed, each list is published as saved
/// (PUB-101).
fn lists_not_refreshed<'a>(
    texts: &BTreeMap<String, NoteTexts>,
    paths: impl Iterator<Item = &'a String>,
) -> Vec<String> {
    let mut found: Vec<String> = paths
        .filter(|path| {
            texts
                .get(*path)
                .is_some_and(|note| has_list_to_refresh(&note.source))
        })
        .cloned()
        .collect();
    sort_by_code_point(&mut found);
    found
}

/// A warning for each reserved alias of each note that the publication
/// published or updated: the alias gets no URL, because the file of the site
/// wins (decision R47).
fn reserved_alias_warnings<'a>(
    texts: &BTreeMap<String, NoteTexts>,
    paths: impl Iterator<Item = &'a String>,
) -> Vec<Value> {
    paths
        .flat_map(|path| {
            texts
                .get(path)
                .map_or(&[][..], |texts| texts.aliases.reserved.as_slice())
                .iter()
                .map(move |alias| {
                    json!({
                        "path": path,
                        "message": format!("the alias \"{alias}\" is a reserved root name of the site: it gets no URL"),
                    })
                })
        })
        .collect()
}

/// The report of a publication, in the canonical form.
fn report_of(
    written: &Written,
    plan: &PublicationPlan,
    scan: &Scan,
    uploads: &[String],
    reserved: Vec<Value>,
    correction: Correction,
    cleanup: Cleanup,
) -> Result<Outcome, String> {
    let mut uploaded = uploads.to_vec();
    uploaded.extend(cleanup.uploaded);
    sort_by_code_point(&mut uploaded);
    // In the order of the TypeScript twin: the moves first.
    let mut warnings: Vec<Value> = scan
        .rename_warnings
        .iter()
        .map(|warning| json!({ "message": warning.message, "path": warning.path }))
        .collect();
    warnings.extend(reserved);
    warnings.extend(correction.warnings);
    warnings.extend(cleanup.warnings);
    // A stable sort, by the path of each warning.
    warnings.sort_by(|one, two| one["path"].as_str().cmp(&two["path"].as_str()));
    // The same rule as the plan, on the manifest as the run left it (issue
    // 135).
    let removed = removed_attachments(
        published_attachments(&scan.manifest),
        published_attachments(&written.manifest),
    );
    let output = canonical(&json!({
        "attachmentsDeleted": cleanup.deleted,
        "attachmentsRemoved": to_value(&removed)?,
        "attachmentsUploaded": uploaded,
        "failed": written.failed,
        "forcedRemoved": plan.forced_remove(),
        "moved": to_value(&plan.moves())?,
        "originalsNotVerified": written.originals_not_verified,
        "propertyRemoved": correction.property_removed,
        "propertySet": correction.property_set,
        "published": written.published,
        "removed": written.removed,
        "skipped": written.skipped,
        "updated": written.updated,
        "warnings": warnings,
    }))?;
    Ok(Outcome {
        output,
        // The failure names each note with its reason: a client can cut the
        // middle of a long report (issue 41).
        failure: match written.failed.len() {
            0 => None,
            1 => Some(format!(
                "1 note of the plan was left out: {}",
                listed(&written.failed, "reason")
            )),
            count => Some(format!(
                "{count} notes of the plan were left out: {}",
                listed(&written.failed, "reason")
            )),
        },
    })
}

/// The items of a list of the report as one text: each `path` with its text,
/// `"<path>": <text>`, in the order of the list.
fn listed(items: &[Value], key: &str) -> String {
    items
        .iter()
        .map(|item| {
            format!(
                "\"{}\": {}",
                item["path"].as_str().unwrap_or(""),
                item[key].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<String>>()
        .join("; ")
}

/// Unpublishes the named published notes in one step (PUB-80, R65): the plan
/// of the selection that removes them and holds every other changed note is
/// stored, then applied as `publish` applies a plan, with one lock of the
/// device for both. Only the named notes leave, with the forced removals that
/// every plan holds.
///
/// # Errors
///
/// No path is named, the selection cannot become a plan, or the publication
/// fails.
pub fn unpublish(
    device: &Device,
    storage: &AttachmentStorage,
    paths: &[String],
    accept: &[String],
    run: &Run,
) -> Result<Outcome, String> {
    check_run(run)?;
    if paths.is_empty() {
        return Err("an unpublish names at least one note".to_owned());
    }
    let remove: BTreeSet<&String> = paths.iter().collect();
    let holder = json!({
        "command": "publish",
        "device": run.device,
        "face": run.face,
        "time": run.time,
    });
    with_lock(device, &holder, |own_lock| {
        // A publication that stopped halfway is put back first. When it
        // stopped after its push, the correction of the property is owed.
        let owed = recover(device, own_lock)?;
        let selection = |scan: &Scan| {
            let hold: Vec<String> = scan
                .queue
                .changed
                .iter()
                .filter(|path| !remove.contains(path))
                .cloned()
                .collect();
            Selection::new(&[], &hold, paths, &[], accept)
        };
        // One fetch and one scan: the plan is applied as it was computed, so
        // it cannot be stale.
        let computed = record_for(device, &selection, Fetch::Must)?;
        // Only the author lets an agent take an entry away (rule 10): a
        // refused unpublish stores no plan.
        refuse_unaccepted(&computed, run)?;
        let id = store_record(device, &computed)?;
        apply_current(
            device,
            storage,
            &Commit {
                plan: &id,
                own_lock,
            },
            run,
            owed,
            &computed,
        )
    })
}

/// Takes the named notes down at once (`documentation/Canonical Form.md`, "A
/// takedown"; PUB-81 to PUB-84, PUB-99, business rule 16): each note leaves
/// the content store with its manifest entry, in one commit that is pushed,
/// with no plan. Then the files of the attachment storage that no published
/// note uses go, and the state property leaves the notes. It reads no plan,
/// scans no vault and asks no Starter Kit, so nothing but the copy can stop
/// it. The result is the takedown report, in the canonical form.
///
/// # Errors
///
/// A path is not the path of a manifest entry, the lock is taken, the copy
/// is behind the content store or cannot be trusted, or the commit or the
/// push fails: nothing is taken down.
pub fn takedown(
    device: &Device,
    storage: &AttachmentStorage,
    paths: &[String],
    run: &Run,
) -> Result<Outcome, String> {
    check_run(run)?;
    if paths.is_empty() {
        return Err("a takedown names at least one note".to_owned());
    }
    if let Some(path) = paths.iter().find(|path| !is_vault_path(path)) {
        return Err(format!("\"{path}\" is not a vault path"));
    }
    let named: Vec<String> = paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let holder = json!({
        "command": "takedown",
        "device": run.device,
        "face": run.face,
        "time": run.time,
    });
    with_lock(device, &holder, |own_lock| {
        take_down_locked(device, storage, &named, run, own_lock)
    })
}

/// The takedown of the named notes, with the lock of the device.
fn take_down_locked(
    device: &Device,
    storage: &AttachmentStorage,
    named: &[String],
    run: &Run,
    own_lock: &dyn Fn() -> Result<(), String>,
) -> Result<Outcome, String> {
    // A publication that stopped halfway is put back first. When it stopped
    // after its push, the correction of the property is owed: the next
    // publication makes it.
    let owed = recover(device, own_lock)?;
    // The copy must follow the content store: an older manifest would miss a
    // note, and the push would be refused.
    refuse_when_behind(device.store.verify(Fetch::Must)?.behind)?;
    // A takedown never waits for the seal (rule 16 of the business rules): it
    // seals its commit only when the key is valid and the state before it is
    // sealed, so it never seals a state that the author did not confirm.
    let key = device.seal.key().ok().filter(|key| {
        matches!(
            check_seal(&device.store, key, None),
            Ok(SealCheck::Sealed | SealCheck::Empty)
        )
    });
    let manifest = read_manifest(&device.store)?;
    // First the files of the storage that no published note uses: a takedown
    // that stopped after its push left the files of its notes there, and its
    // notes have no entry any more, so this run stops below when it names
    // them again. No other run could clean the storage when no publication
    // can run (PUB-99).
    own_lock()?;
    let (early, _) = delete_unused(storage, &published_keys(&manifest));
    let mut paths = Vec::new();
    for path in named {
        let entry = manifest.get(path).ok_or_else(|| {
            format!(
                "\"{path}\" is the path of no manifest entry, and a takedown needs the exact path that the manifest names. Nothing is taken down{}{}{}",
                near_paths(path, &manifest),
                moves_to(device, path, &manifest),
                cleanup_lines(&early)
            )
        })?;
        paths.extend(files_of_note(path, &entry.id));
    }
    sort_by_code_point(&mut paths);
    // The id names the takedown in the journal and in the message of its
    // commit, so a recovery finds the commit. It is outside the parity rule.
    let id = sha256_hex(&canonical(
        &json!({ "manifest": manifest_hash(device)?, "takedown": named }),
    )?)[..16]
        .to_owned();
    let head = device.store.head();
    own_lock()?;
    device
        .store
        .save_journal(&journal_text(&RunJournal::Write {
            correction_owed: owed,
            head: head.clone(),
            paths: paths.clone(),
            plan: id.clone(),
        })?)?;
    let mut journal = Backup::new(&device.store);
    let message = format!(
        "Takedown: {}\n\nDevice: {}\nFace: {}\nPlan: {id}",
        if named.len() == 1 {
            "1 note".to_owned()
        } else {
            format!("{} notes", named.len())
        },
        run.device,
        run.face
    );
    if let Err(error) = remove_and_push(
        device,
        &mut journal,
        &paths,
        &message,
        key.as_deref(),
        own_lock,
    ) {
        // Another run took the copy: this run touches nothing of it any more.
        if error == LOCK_LOST {
            return Err(error);
        }
        let files = put_copy_back(
            device,
            &mut journal,
            head.as_ref(),
            || {
                if owed {
                    device
                        .store
                        .save_journal(&journal_text(&RunJournal::Correct)?)
                } else {
                    device.store.remove_journal()
                }
            },
            "plan, publish or takedown",
        )?;
        return Err(format!("{error}. Nothing is taken down, {files}"));
    }
    crash_point("push");
    // The push arrived. When another run took the copy, this run changes
    // nothing more: the other run owns the journal.
    own_lock()?;
    device
        .store
        .save_journal(&journal_text(&RunJournal::Correct)?)?;
    after_push(device, storage, manifest, named, owed, early)
}

/// Removes the files of a takedown from the copy, and commits and pushes the
/// removals. The recovery of a run that stopped halfway finds the commit by
/// the line `Plan:` of its message.
fn remove_and_push(
    device: &Device,
    journal: &mut Backup,
    paths: &[String],
    message: &str,
    key: Option<&[u8]>,
    own_lock: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut written = Vec::new();
    for path in paths {
        let removal = StoreFile {
            path: path.clone(),
            text: None,
        };
        if journal.apply(&removal)? {
            written.push(path.clone());
        }
    }
    crash_point("write");
    own_lock()?;
    match key {
        Some(key) => device.store.commit_and_push(
            message,
            &written,
            Some(&|parents: &[String], files: &[TreeFile]| seal_of(key, parents, files)),
        ),
        None => device.store.commit_and_push(message, &written, None),
    }
}

/// What a takedown does after its push: the files of the attachment storage
/// that no published note uses go, then the state property of the notes. The
/// result is the takedown report, in the canonical form, with a failure when
/// the attachment storage gave a warning: a file that stays there can still
/// be public.
fn after_push(
    device: &Device,
    storage: &AttachmentStorage,
    mut manifest: BTreeMap<String, ManifestEntry>,
    named: &[String],
    owed: bool,
    early: Cleanup,
) -> Result<Outcome, String> {
    for path in named {
        manifest.remove(path);
    }
    // The files go first: they are public. No file of the vault is read, so a
    // file under a guard that a published entry lists waits for the cleanup
    // of the next publication.
    let (cleanup, _) = delete_unused(storage, &published_keys(&manifest));
    let (property_removed, property_warnings) = remove_state(device, named);
    if !owed {
        device.store.remove_journal()?;
    }
    // The two cleanups give the same warning for a name that is not a key:
    // it is written one time.
    let mut storage_warnings = merge_warnings(&early, &cleanup);
    let mut deleted = early.deleted;
    deleted.extend(cleanup.deleted);
    sort_by_code_point(&mut deleted);
    let mut warnings = property_warnings;
    // A stable sort, by the path of each warning.
    for list in [&mut storage_warnings, &mut warnings] {
        list.sort_by(|one, two| one["path"].as_str().cmp(&two["path"].as_str()));
    }
    let count = storage_warnings.len();
    let output = canonical(&json!({
        "attachmentsDeleted": deleted,
        "propertyRemoved": property_removed,
        "storageWarnings": storage_warnings,
        "takenDown": named,
        "warnings": warnings,
    }))?;
    Ok(Outcome {
        output,
        failure: (count > 0).then(|| {
            format!(
                "the notes are taken down, but the attachment storage gave {count} warning(s), and a file that stays there can still be public: {}. Correct the storage, then run a takedown or a publication, which delete the files that no published note uses",
                listed(&storage_warnings, "message")
            )
        }),
    })
}

/// The warnings of the two cleanups of a takedown, each one time. A warning
/// of the first cleanup about a file that the second one deleted is left out.
fn merge_warnings(early: &Cleanup, late: &Cleanup) -> Vec<Value> {
    let deleted: BTreeSet<&str> = late.deleted.iter().map(String::as_str).collect();
    let mut seen = BTreeSet::new();
    let mut merged: Vec<Value> = Vec::new();
    for warning in early.warnings.iter().chain(&late.warnings) {
        let path = warning["path"].as_str().unwrap_or_default();
        let key = (path.to_owned(), warning["message"].to_string());
        if !deleted.contains(path) && seen.insert(key) {
            merged.push(warning.clone());
        }
    }
    merged
}

/// True for a character that the refusal of a takedown removes at the two
/// ends of a named path before it looks for the paths near it: the code
/// points of the Unicode property `White_Space`, and U+FEFF. `trim` is not
/// used: it keeps U+FEFF, and `trim()` of TypeScript removes it but keeps
/// U+0085.
fn is_space(character: char) -> bool {
    matches!(
        u32::from(character),
        0x09..=0x0d
            | 0x20
            | 0x85
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

/// The folded forms that a named path gives, also with the end `.md` added.
fn near_forms(path: &str) -> [String; 2] {
    let typed = path.trim_matches(is_space);
    [folded_form(typed), folded_form(&format!("{typed}.md"))]
}

/// The paths of the manifest that a path names in another letter case or
/// Unicode form, or without its end `.md`, as the end of the message of a
/// refusal. The site resolves such an address to the note, so the refusal
/// must never read as "already gone". A folded form names one published note
/// at most (URL contract, rule 9), but unpublished entries can share it.
fn near_paths(path: &str, manifest: &BTreeMap<String, ManifestEntry>) -> String {
    let forms = near_forms(path);
    // The map gives its keys in the order of the code points.
    let near: Vec<String> = manifest
        .keys()
        .filter(|key| forms.contains(&folded_form(key)))
        .map(|key| format!("\"{key}\""))
        .collect();
    if near.is_empty() {
        String::new()
    } else {
        format!(". The manifest names: {}", near.join(", "))
    }
}

/// The moves of the new lines of the rename journals whose new path a path
/// names, also in another letter case or Unicode form or without its end
/// `.md`, as the end of the message of a refusal (issue 105): until a
/// publication applies the move, the manifest has the note at its old path.
/// A journal or a marker that cannot be read gives nothing: the refusal
/// stays a refusal.
fn moves_to(device: &Device, path: &str, manifest: &BTreeMap<String, ManifestEntry>) -> String {
    let journals = device
        .store
        .read(RENAMES_FILE)
        .and_then(|text| parse_markers(text.as_deref()))
        .and_then(|markers| read_journals(&device.renames, &markers));
    let Ok(journals) = journals else {
        return String::new();
    };
    let forms = near_forms(path);
    // The map gives its keys in the order of the code points.
    // No unpublished paths, as the TypeScript face.
    fold_moves(manifest.keys().cloned(), &journals.lines, &BTreeSet::new())
        .positions
        .iter()
        .filter(|(from, to)| from != to && forms.contains(&folded_form(to)))
        .map(|(from, to)| {
            format!(
                ". A rename journal moves \"{from}\" to \"{to}\", and the next publication applies the move: until then, a takedown names \"{from}\""
            )
        })
        .collect::<Vec<_>>()
        .concat()
}

/// The files that macOS and Windows put into a folder by themselves: a
/// cleanup of the attachment storage leaves them with no warning (decision of
/// the author R82). Only these exact names.
const SYSTEM_FILES: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// The most lines of a list in the message of a refusal.
const MOST_LINES: usize = 20;

/// What the first cleanup of a takedown did, as the end of the message of a
/// refusal.
fn cleanup_lines(early: &Cleanup) -> String {
    let more = |count: usize| {
        if count > MOST_LINES {
            format!(", and {} more", count - MOST_LINES)
        } else {
            String::new()
        }
    };
    let deleted = if early.deleted.is_empty() {
        String::new()
    } else {
        format!(
            "\nThe takedown deleted {} file(s) of the attachment storage that no published note uses: {}{}",
            early.deleted.len(),
            early.deleted[..early.deleted.len().min(MOST_LINES)].join(", "),
            more(early.deleted.len())
        )
    };
    let warnings = warning_lines(&early.warnings[..early.warnings.len().min(MOST_LINES)]);
    let hidden = if early.warnings.len() > MOST_LINES {
        format!(
            "\n- and {} more warnings",
            early.warnings.len() - MOST_LINES
        )
    } else {
        String::new()
    };
    format!("{deleted}{warnings}{hidden}")
}

/// Removes the state property of the notes that were taken down, when the
/// vault has them at exactly their paths. A note in a folder of the deny list
/// is never read or written. Without a configuration that can be read, no
/// note is written. The result is the notes that were written and the
/// warnings.
fn remove_state(device: &Device, paths: &[String]) -> (Vec<String>, Vec<Value>) {
    let mut removed = Vec::new();
    let mut warnings = Vec::new();
    let configuration =
        configuration_text(device).and_then(|text| parse_configuration(Some(&text)));
    let configuration = match configuration {
        Ok(configuration) => configuration,
        Err(error) => {
            warnings.push(json!({
                "message": format!("the configuration of the content store cannot be read, so the {STATE_PROPERTY} property of the notes that were taken down is not removed: remove it by hand ({error})"),
                "path": "",
            }));
            return (removed, warnings);
        }
    };
    for path in paths {
        if in_deny_list(path, &configuration) {
            continue;
        }
        let written = device.vault.read(path).and_then(|text| match text {
            Some(text) if remove_property(&text, STATE_PROPERTY) != text => {
                write_state(device, path, &text, false).map(Some)
            }
            _ => Ok(None),
        });
        match written {
            Ok(Some(StateWrite::Written)) => removed.push(path.clone()),
            Ok(Some(StateWrite::Left(warning))) => {
                warnings.push(json!({ "message": warning, "path": path }));
            }
            Ok(None) => {}
            Err(error) => warnings.push(json!({
                "message": format!("the {STATE_PROPERTY} property could not be removed: {error}"),
                "path": path,
            })),
        }
    }
    (removed, warnings)
}

/// Reads the configuration without the check of GATE-38: an entry that names
/// no folder does not stop the reading command `guards` nor an edit, because
/// an edit is how an agent corrects it (PUB-91, R69). It gives the
/// configuration and its text as data, to keep its other keys.
fn read_raw_configuration(device: &Device) -> Result<(Configuration, Value, String), String> {
    let text = configuration_text(device)?;
    let configuration = parse_configuration(Some(&text))?;
    let value = parse_json(&text).map_err(|_| format!("{CONFIGURATION_FILE} is not JSON"))?;
    Ok((configuration, value, text))
}

/// The events of the log as data, as the file holds them.
fn events_of(events: &[Event]) -> Result<Vec<Value>, String> {
    events.iter().map(event_value).collect()
}

/// The guards, as data in the canonical form (R69): the deny list, the open
/// proposals and the events since the last publication. It reads no network,
/// takes no lock (it stops while the lock of the device is taken, as `status`
/// does) and writes nothing, and it reads the configuration without
/// the check of GATE-38, so that an agent can read a deny list that stops
/// every publication, and correct it with an edit (PUB-91).
///
/// # Errors
///
/// The copy, the configuration or the log cannot be trusted.
pub fn guards(device: &Device) -> Result<String, String> {
    // The files of the copy can be half written while a run holds the lock.
    refuse_when_locked(device)?;
    device.store.verify(Fetch::None)?;
    let (configuration, _, _) = read_raw_configuration(device)?;
    let log = read_edits(device)?;
    canonical(&json!({
        "denyList": configuration.deny_list,
        "edits": events_of(log.since())?,
        "proposals": events_of(&log.open_proposals())?,
    }))
}

/// True when a part of the path is a name that is not part of the vault:
/// hidden, or not valid Unicode.
fn is_outside_vault(path: &str) -> bool {
    path.split('/')
        .any(|part| part.starts_with('.') || part.contains('\u{fffd}'))
}

/// Edits the guards (`documentation/Canonical Form.md`, "The edits of the
/// guards"; GATE-40, R69): `deny` adds a folder to the deny list, `allow`
/// removes one, `ignore` sets the ignore property of a note, `unignore`
/// removes it. A stricter edit that takes no manifest entry away applies at
/// once; every other edit is a proposal, which only the author confirms, in
/// the view. The event goes into the log `edits.json` of the content store,
/// with `configuration.json` for a `deny` that applies, in one commit that is
/// pushed. An `ignore` that applies writes the property into the note first.
/// The result is the event, in the canonical form.
///
/// # Errors
///
/// An input is wrong, the edit breaks a rule of rule 3, the lock is taken,
/// the copy is behind the content store or cannot be reached or trusted, or
/// the commit or the push fails: then nothing is applied.
pub fn edit(device: &Device, action: &str, path: &str, run: &Run) -> Result<String, String> {
    check_run(run)?;
    if !ACTIONS.contains(&action) {
        return Err(format!(
            "\"{action}\" is not an edit of the guards: the edits are deny, allow, ignore and unignore"
        ));
    }
    let holder = json!({
        "command": "edit",
        "device": run.device,
        "face": run.face,
        "time": run.time,
    });
    with_lock(device, &holder, |own_lock| {
        edit_locked(device, action, path, run, own_lock)
    })
}

/// What an edit reads of the copy, with the lock.
struct EditContext {
    configuration: Configuration,
    /// The configuration as data, to keep its other keys.
    value: Value,
    /// The text of the configuration.
    text: String,
    log: EditLog,
}

/// The note of an `ignore` or an `unignore`: its text as the check read it,
/// and its text after the write.
struct NoteEdit {
    before: String,
    after: String,
}

/// The edit of the guards, with the lock of the device.
fn edit_locked(
    device: &Device,
    action: &str,
    path: &str,
    run: &Run,
    own_lock: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    // A run that stopped halfway is put back first. When it stopped after its
    // push, the correction of the property is owed: the next publication
    // makes it.
    let owed = recover(device, own_lock)?;
    // The copy must follow the content store: the edit reads the deny list,
    // the manifest and the log, and its push would be refused.
    refuse_when_behind(device.store.verify(Fetch::Must)?.behind)?;
    let (configuration, value, text) = read_raw_configuration(device)?;
    let context = EditContext {
        configuration,
        value,
        text,
        log: read_edits(device)?,
    };
    refuse_unsealed_state(device)?;
    let (TakenAway { removes, affects }, note) = check_edit(device, &context, action, path)?;
    let applies = !is_looser(action) && removes.is_empty() && affects.is_empty();
    let event = Event::new(EventFacts {
        action,
        path,
        state: if applies { "applied" } else { "proposed" },
        removes,
        affects,
        time: run.time,
        device: run.device,
        face: run.face,
    })?;
    let mut files = Vec::new();
    let mut log = context.log.clone();
    if applies && action == "deny" {
        // The deny list keeps its order: the folder goes at its end. Every
        // other key of the file stays (rule 8).
        let mut value = context.value.clone();
        if let Some(list) = value.get_mut("denyList").and_then(Value::as_array_mut) {
            list.push(json!(path));
        }
        let text = canonical(&value).map_err(|error| {
            format!("{CONFIGURATION_FILE} cannot be written in the canonical form: {error}")
        })?;
        // A change of the tool moves the hash of the last publication with
        // it, unless the file had changed by hand before (issue 108).
        log = log.with_configuration(&content_hash(&context.text), &content_hash(&text));
        files.push(StoreFile {
            path: CONFIGURATION_FILE.to_owned(),
            text: Some(text),
        });
    }
    files.push(StoreFile {
        path: EDITS_FILE.to_owned(),
        text: Some(log.with_event(event.clone()).text()?),
    });
    // An `ignore` that applies writes the property first (rule 6): a stricter
    // guard is safe, also when the commit fails.
    let note = note.filter(|_| applies && action == "ignore");
    let failed = if let Some(note) = &note {
        own_lock()?;
        write_ignore(device, path, note)?;
        format!(
            "The {IGNORE_PROPERTY} property stays in the note \"{path}\" (a stricter guard is safe), but the log of the edits has no event for it"
        )
    } else {
        "Nothing is applied".to_owned()
    };
    if let Some(note) = &note {
        overwrite_point(&device.vault, path, &note.before);
    }
    commit_edit(device, &event, &files, run, owed, own_lock, &failed)?;
    // Obsidian, open with edits of the note that it did not save, can write
    // its copy over the file: the guard of the note is then gone, and the
    // note is a candidate again (issue 108, point 1).
    if let Some(note) = &note
        && device.vault.read(path).ok().flatten().as_deref() != Some(note.after.as_str())
    {
        eprintln!(
            "warning: the {IGNORE_PROPERTY} property is not in the note \"{path}\" any more: another program (Obsidian, with edits that it did not save) wrote the note after the edit. The note is a candidate again: set the property again in Obsidian, or run the edit again"
        );
    }
    edit_output(&event)
}

/// Confirms the state of the content store (R104, rule 8 of "The seal of the
/// content store"): when the state of the last commit is not the sealed state,
/// and the last commit is `head`, it writes one sealed commit with no change of
/// a file and pushes it. The author confirms a difference that they read, so a
/// content store that changed since then is refused. The result is `confirmed`
/// and, when it is true, the `difference` that it confirmed, in the canonical
/// form.
///
/// # Errors
///
/// The commit to confirm is not a commit hash, the lock is taken, the copy is
/// behind the content store or cannot be reached or trusted, there is no key,
/// the content store has no commit, the last commit is not `head`, or the
/// commit or the push fails.
pub fn confirm_state(device: &Device, head: &str, run: &Run) -> Result<String, String> {
    check_run(run)?;
    if !matches!(head.len(), 40 | 64)
        || !head
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(
            "the commit to confirm must be the 40 or 64 small hexadecimal digits of a commit"
                .to_owned(),
        );
    }
    // The lock of an edit: a confirmation changes the guards' ground, and no
    // publication runs during it.
    let holder = json!({
        "command": "edit",
        "device": run.device,
        "face": run.face,
        "time": run.time,
    });
    with_lock(device, &holder, |own_lock| {
        // A run that stopped halfway is put back first.
        recover(device, own_lock)?;
        refuse_when_behind(device.store.verify(Fetch::Must)?.behind)?;
        let key = device.seal.key()?;
        let difference = match check_seal(&device.store, &key, None)? {
            SealCheck::Empty => {
                return Err(
                    "the content store has no commit: there is no state to confirm".to_owned(),
                );
            }
            SealCheck::Sealed => return canonical(&json!({ "confirmed": false })),
            SealCheck::Differs(difference) => *difference,
        };
        if difference.head != head {
            return Err(format!(
                "the content store changed since the difference that you read: its last commit is now {}, not {head}. Read the difference again (status or plan), then confirm that commit",
                difference.head
            ));
        }
        own_lock()?;
        device.store.commit_and_push(
            &format!(
                "Confirm the state of the content store\n\nConfirmed: {head}\nDevice: {}\nFace: {}",
                run.device, run.face
            ),
            &[],
            Some(&|parents: &[String], files: &[TreeFile]| seal_of(&key, parents, files)),
        )?;
        canonical(&json!({ "confirmed": true, "difference": to_value(&difference)? }))
    })
}

/// The run journal after an edit: `correct` while an earlier publication
/// still owes its correction, else none.
fn settle_edit(device: &Device, owed: bool) -> Result<(), String> {
    if owed {
        device
            .store
            .save_journal(&journal_text(&RunJournal::Correct)?)
    } else {
        device.store.remove_journal()
    }
}

/// Writes the files of an edit into the copy with its run journal (`paths`:
/// `configuration.json` and `edits.json`, `plan`: the id of the event), and
/// commits and pushes them (rule 5). When the commit or the push fails, the
/// files are put back. `failed` is the end of the message after a failure:
/// what is applied, or not.
fn commit_edit(
    device: &Device,
    event: &Event,
    files: &[StoreFile],
    run: &Run,
    owed: bool,
    own_lock: &dyn Fn() -> Result<(), String>,
    failed: &str,
) -> Result<(), String> {
    let head = device.store.head();
    own_lock()?;
    device
        .store
        .save_journal(&journal_text(&RunJournal::Write {
            correction_owed: owed,
            head: head.clone(),
            paths: vec![CONFIGURATION_FILE.to_owned(), EDITS_FILE.to_owned()],
            plan: event.id.clone(),
        })?)?;
    let mut journal = Backup::new(&device.store);
    let message = format!(
        "Edit: {} ({})\n\nDevice: {}\nFace: {}\nPlan: {}",
        event.action, event.state, run.device, run.face, event.id
    );
    if let Err(error) = write_and_push(device, &mut journal, files, &message, own_lock) {
        // Another run took the copy: this run touches nothing of it any more.
        if error == LOCK_LOST {
            return Err(error);
        }
        let files = put_copy_back(
            device,
            &mut journal,
            head.as_ref(),
            || settle_edit(device, owed),
            "plan, publish, takedown or edit",
        )?;
        return Err(format!("{error}. {failed}, {files}"));
    }
    crash_point("push");
    // The push arrived. When another run took the copy, this run changes
    // nothing more: the other run owns the journal.
    own_lock()?;
    settle_edit(device, owed)
}

/// Writes the files of an edit into the copy, and commits and pushes them.
/// The recovery of a run that stopped halfway finds the commit by the line
/// `Plan:` of its message.
fn write_and_push(
    device: &Device,
    journal: &mut Backup,
    files: &[StoreFile],
    message: &str,
    own_lock: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut written = Vec::new();
    for file in files {
        if journal.apply(file)? {
            written.push(file.path.clone());
        }
    }
    crash_point("write");
    steal_point("commit", &device.store);
    own_lock()?;
    commit_sealed(device, message, &written)
}

/// Writes the ignore property into a note (rules 6 and 9 of "The edits of the
/// guards"): the note is read again first, and it is not written when its
/// text is not the text that the check read.
fn write_ignore(device: &Device, path: &str, note: &NoteEdit) -> Result<(), String> {
    let now = device
        .vault
        .read(path)
        .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?;
    if now.as_deref() != Some(note.before.as_str()) {
        return Err(format!(
            "\"{path}\" changed since the check of the edit, and it is not written"
        ));
    }
    device.vault.write(path, &note.after)
}

/// What an edit takes away (rule 2), never guessed: from one read of the
/// vault, of the journals and of the manifest, the queue as it is and with the
/// edit applied (the new deny list, or the note read as excluded by the
/// ignore property). `removes` is the forced removals (rule 3 of the plan) of
/// the second that are not forced removals of the first, sorted by path: a
/// note that a line of a rename journal moves under the new guard, an
/// unpublished entry whose note has a new name there, and a missing note with
/// a name in the new folder count, as the next publication counts them. For
/// a `deny`, `affects` is the published entries, not in `removes`, that use
/// an attachment that the edit puts under the guard (rule 8 of "A
/// publication"): the next publication would delete that file. A deny list
/// entry that names no folder lists no file, so it is left out of the read.
/// The entries do not depend on the note types: the Starter Kit is not
/// asked.
struct TakenAway {
    removes: Vec<String>,
    affects: Vec<String>,
}

fn taken_away(
    device: &Device,
    context: &EditContext,
    action: &str,
    path: &str,
) -> Result<TakenAway, String> {
    let change = match action {
        "deny" => GuardChange::Deny(path),
        "ignore" => GuardChange::Ignore(path),
        _ => {
            return Ok(TakenAway {
                removes: Vec::new(),
                affects: Vec::new(),
            });
        }
    };
    // A deny list entry that names no folder lists no file.
    let deny_list = context
        .configuration
        .deny_list
        .iter()
        .filter(|folder| device.vault.has_folder(folder))
        .cloned()
        .collect();
    let (now, after) = guard_queues(
        device,
        &Configuration {
            deny_list,
            ..Configuration::default()
        },
        change,
    )?;
    Ok(between(device, &after, &now, action == "deny"))
}

/// The two queues of a change of the guards, from one read of the vault, of
/// the journals and of the manifest.
fn guard_queues(
    device: &Device,
    configuration: &Configuration,
    change: GuardChange,
) -> Result<(Scan, Scan), String> {
    let renames = device.store.read(RENAMES_FILE)?;
    let journals = read_journals(&device.renames, &parse_markers(renames.as_deref())?)?;
    compute_guard_queues(
        &device.vault,
        &read_manifest(&device.store)?,
        journals,
        configuration,
        change,
    )
}

/// What the stricter guards take away that the looser ones do not (rule 2):
/// `removes`, the forced removals (rule 3 of the plan) of the stricter queue
/// that are not forced removals of the looser one, sorted by path; and, for
/// a folder of the deny list, `affects`, the published entries that are a
/// forced removal in neither queue and that use an attachment that the
/// stricter guards put under the guard (rule 8 of "A publication").
fn between(device: &Device, stricter: &Scan, looser: &Scan, with_affects: bool) -> TakenAway {
    let forced_looser: BTreeSet<String> = forced_removals(looser).into_iter().collect();
    let forced_stricter: BTreeSet<String> = forced_removals(stricter).into_iter().collect();
    let mut removes: Vec<String> = forced_stricter
        .iter()
        .filter(|forced| !forced_looser.contains(*forced))
        .cloned()
        .collect();
    sort_by_code_point(&mut removes);
    let mut affects = Vec::new();
    if with_affects {
        let vault = &device.vault;
        // The map gives the paths in the order of the code points.
        for (path, entry) in &stricter.manifest {
            let newly_guarded = entry.attachments.iter().any(|attachment| {
                stricter.is_guarded_file(vault, &attachment.path, &attachment.hash)
                    && !looser.is_guarded_file(vault, &attachment.path, &attachment.hash)
            });
            if entry.state == State::Published
                && newly_guarded
                && !forced_stricter.contains(path)
                && !forced_looser.contains(path)
            {
                affects.push(path.clone());
            }
        }
    }
    TakenAway { removes, affects }
}

/// True when the text of a JSON number is a whole number that both
/// implementations write with the same bytes: no fraction, no exponent, no
/// negative zero, and inside the range of rule 6 of the data.
fn is_exact_whole_number(number: &str) -> bool {
    let digits = number.strip_prefix('-').unwrap_or(number);
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && !(number.starts_with('-') && digits.bytes().all(|byte| byte == b'0'))
        && digits
            .parse::<u64>()
            .is_ok_and(|value| value <= 9_007_199_254_740_991)
}

/// `Err` when `configuration.json` has a number that is not such a whole
/// number (rule 8): TypeScript cannot tell `1.0` from `1` or `-0` from `0`,
/// so the two implementations would write other bytes. Only the numbers
/// outside the texts of the file count.
fn refuse_inexact_numbers(text: &str) -> Result<(), String> {
    let mut characters = text.chars().peekable();
    let mut in_text = false;
    while let Some(character) = characters.next() {
        if in_text {
            match character {
                '\\' => {
                    characters.next();
                }
                '"' => in_text = false,
                _ => {}
            }
            continue;
        }
        if character == '"' {
            in_text = true;
            continue;
        }
        if character == '-' || character.is_ascii_digit() {
            let mut number = String::from(character);
            while let Some(next) = characters
                .peek()
                .filter(|next| next.is_ascii_digit() || matches!(next, '.' | 'e' | 'E' | '+' | '-'))
            {
                number.push(*next);
                characters.next();
            }
            if !is_exact_whole_number(&number) {
                return Err(format!(
                    "{CONFIGURATION_FILE} has the number {number}, which is not a whole number that both implementations write with the same bytes (no fraction, no exponent, no -0, from -9,007,199,254,740,991 to 9,007,199,254,740,991), so nothing is applied. Write it as such a whole number, commit {CONFIGURATION_FILE} and push it"
                ));
            }
        }
    }
    Ok(())
}

/// Checks an edit by rule 3 of "The edits of the guards", and computes the
/// entries that it takes away (rule 2), with the note of an `ignore` or an
/// `unignore`. An open proposal with the same action and the same path stops
/// it too.
fn check_edit(
    device: &Device,
    context: &EditContext,
    action: &str,
    path: &str,
) -> Result<(TakenAway, Option<NoteEdit>), String> {
    if !is_vault_path(path) {
        return Err(format!(
            "\"{path}\" is not a vault path: write it as \"Folder/Sub folder\" or \"Folder/Note.md\", relative to the root of the vault"
        ));
    }
    let deny_list = &context.configuration.deny_list;
    let listed = deny_list.iter().any(|folder| folder == path);
    let mut note = None;
    match action {
        "deny" if listed => {
            return Err(format!("\"{path}\" is already in the deny list"));
        }
        "deny" if is_outside_vault(path) || !device.vault.has_folder(path) => {
            return Err(format!(
                "\"{path}\" is not a folder of the vault, with exactly that name (letter case and Unicode form)"
            ));
        }
        // Before any write: the configuration must be written again with the
        // same bytes in both implementations (rule 8).
        "deny" => refuse_inexact_numbers(&context.text)?,
        "allow" if !listed => {
            return Err(format!("\"{path}\" is not an entry of the deny list"));
        }
        "ignore" | "unignore" => note = Some(check_note(device, context, action, path)?),
        _ => {}
    }
    if context
        .log
        .open_proposals()
        .iter()
        .any(|proposal| proposal.action == action && proposal.path == path)
    {
        return Err(format!(
            "there is already an open proposal to {action} \"{path}\": the author confirms or rejects it in the publication center of Obsidian"
        ));
    }
    Ok((taken_away(device, context, action, path)?, note))
}

/// Checks an edit of the ignore property of a note (rule 3), and gives its
/// text and its text after the write (rule 9).
fn check_note(
    device: &Device,
    context: &EditContext,
    action: &str,
    path: &str,
) -> Result<NoteEdit, String> {
    // Letter case is never ignored in the logic.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let is_note = path.ends_with(".md");
    if !is_note {
        return Err(format!(
            "\"{path}\" is not a note: its name does not end in .md"
        ));
    }
    // The tool never reads or writes a file in a folder of the deny list.
    if in_deny_list(path, &context.configuration) {
        return Err(format!(
            "\"{path}\" is in a folder of the deny list: the tool never reads or writes a file there"
        ));
    }
    let text = if is_outside_vault(path) {
        None
    } else {
        device
            .vault
            .read(path)
            .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?
    };
    let Some(text) = text else {
        return Err(format!(
            "there is no note at \"{path}\" in the vault, with exactly that path"
        ));
    };
    let excluded = names_in_properties(&text, IGNORE_PROPERTY);
    if action == "ignore" {
        if excluded {
            return Err(format!(
                "the {IGNORE_PROPERTY} property already excludes \"{path}\""
            ));
        }
        if has_flow_properties(&text) {
            return Err(format!(
                "the properties of \"{path}\" are in the flow form of YAML ({{ }} or [ ]), and the tool does not write into that form: the author sets the {IGNORE_PROPERTY} property by hand"
            ));
        }
        let after = set_property(&text, IGNORE_PROPERTY, "true");
        // A write never leaves a guard in a state that the edit did not state
        // (rule 9).
        if !names_in_properties(&after, IGNORE_PROPERTY) {
            return Err(format!(
                "the {IGNORE_PROPERTY} property cannot be written so that it excludes \"{path}\": the author sets it by hand"
            ));
        }
        return Ok(NoteEdit {
            before: text,
            after,
        });
    }
    if !excluded {
        return Err(format!(
            "the {IGNORE_PROPERTY} property does not exclude \"{path}\""
        ));
    }
    let after = remove_property(&text, IGNORE_PROPERTY);
    if names_in_properties(&after, IGNORE_PROPERTY) {
        return Err(format!(
            "\"{path}\" would still be excluded after the removal of the {IGNORE_PROPERTY} property: the key is in the value of another property, in the flow form, or in a form that the removal does not touch. The author edits the note by hand"
        ));
    }
    Ok(NoteEdit {
        before: text,
        after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    /// A missing configuration is never an empty deny list (R67): after the
    /// push of a takedown, the tool writes no note when it cannot read one.
    #[test]
    fn the_state_of_a_note_that_was_taken_down_stays_without_a_configuration() {
        let root = std::env::temp_dir().join(format!(
            "vault-publish-no-configuration-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let vault = root.join("vault");
        let store = root.join("store");
        fs::create_dir_all(&vault).expect("the folder can be made");
        fs::create_dir_all(&store).expect("the folder can be made");
        let text = "---\npublic_note: true\n---\nA note\n";
        fs::write(vault.join("Note.md"), text).expect("the note is written");
        let device = Device {
            vault: Vault::new(&vault),
            store: ContentStore::new(&store),
            renames: crate::renames::RenameJournals::new(root.join("renames")),
            note_types: StarterKit::new(Path::new("no-such-program"), &vault),
            main_site: MainSite::network(),
            seal: crate::seal::SealSource::new(&vault),
        };

        let (removed, warnings) = remove_state(&device, &["Note.md".to_owned()]);

        let after = fs::read_to_string(vault.join("Note.md"));
        let _ = fs::remove_dir_all(&root);
        assert_eq!(removed, Vec::<String>::new());
        assert_eq!(after.expect("the note stays"), text);
        assert!(
            warnings.iter().any(|warning| warning["message"]
                .as_str()
                .is_some_and(|message| message.contains("has no configuration.json"))),
            "{warnings:?}"
        );
    }
}
