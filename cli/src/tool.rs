//! The operations of the publishing tool. The commands of the program call
//! these. The TypeScript twin is `apps/plugin/src/publishing/tool.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

use serde::Serialize;
use serde_json::{Value, json};

use crate::attachments::attachments_of;
use crate::attachments::{Attachment, key_of};
use crate::canonical::to_canonical_json;
use crate::clean::{CLEANING_VERSION, STATE_PROPERTY, clean_note, source_of};
use crate::configuration::{CONFIGURATION_FILE, Configuration, is_vault_path, parse_configuration};
use crate::device::{
    AttachmentStorage, ContentStore, Fetch, Lock, Recovery, Vault, crash_point, steal_point,
};
use crate::frontmatter::{
    Aliases, aliases_of, has_flow_properties, names_in_properties, remove_property, set_property,
};
use crate::guards::IGNORE_PROPERTY;
use crate::hash::{bytes_hash, content_hash, sha256_hex};
use crate::json::parse_json;
use crate::links::{NoteLink, links_of};
use crate::manifest::{
    MANIFEST_FOLDER, ManifestEntry, NOTES_FOLDER, State, manifest_file, note_id, read_manifest,
};
use crate::order::sort_by_code_point;
use crate::plan::{PublicationPlan, Selection, compute_plan};
use crate::queue::{Scan, compute_queue};

/// Everything that a publication needs on one device.
pub struct Device {
    pub vault: Vault,
    pub store: ContentStore,
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
    /// The number of notes of the plan that were left out.
    pub failed: usize,
}

fn canonical(value: &Value) -> Result<String, String> {
    to_canonical_json(value).map_err(|error| error.to_string())
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

/// Reads the configuration and checks it against the vault. It gives the
/// configuration and the hash of its text, or `none`.
fn read_configuration(device: &Device) -> Result<(Configuration, String), String> {
    let text = device.store.read(CONFIGURATION_FILE)?;
    let configuration = parse_configuration(text.as_deref())?;
    // A deny list entry that names no folder would exclude nothing: a renamed
    // folder, or another letter case, would make its notes candidates
    // (GATE-38).
    for folder in &configuration.deny_list {
        if !device.vault.has_folder(folder) {
            return Err(format!(
                "the deny list names \"{folder}\", which is not a folder of the vault. No publication is possible until the deny list is corrected"
            ));
        }
    }
    let hash = text.map_or_else(|| "none".to_owned(), |text| content_hash(&text));
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
    if fetch != Fetch::None && behind > 0 {
        return Err(format!(
            "the copy of the content store is {behind} commit(s) behind the content store: another device published since the last pull. Nothing can be planned or published until the copy is up to date: pull first (git pull --ff-only origin main)"
        ));
    }
    let (configuration, configuration_hash) = read_configuration(device)?;
    let manifest = read_manifest(&device.store)?;
    let mut scan = compute_queue(&device.vault, manifest, configuration)?;
    scan.queue.behind = behind;
    Ok(DeviceState {
        scan,
        configuration_hash,
        reached: verified.reached,
    })
}

/// What the lock of the device holds, for a message: one line.
fn lock_message(text: &str) -> String {
    format!(
        "a publication runs on this device, or one stopped halfway (the lock holds {}). When no publication runs, remove the lock with the unlock command: the next plan or publish then puts the copy back",
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
/// The next plan or publish puts the copy back. The result says whether a
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
        && (path.starts_with(&format!("{NOTES_FOLDER}/"))
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
        return Err("a publication stopped halfway on this device. status writes nothing, so it does not put the copy back: the next plan or publish puts it back".to_owned());
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
}

/// A plan with everything that its publication needs.
struct Computed {
    plan: PublicationPlan,
    /// False when the content store could not be reached and the plan uses
    /// the last fetch.
    reached: bool,
    /// The record of the plan, in the canonical form.
    record: String,
    scan: Scan,
    /// The texts of the notes to publish and to update, as the record names
    /// them by their hashes.
    texts: BTreeMap<String, NoteTexts>,
}

/// Computes the plan of a selection and its record: the plan, the selection,
/// and the state that the plan was computed from, in the canonical form.
fn record_for(device: &Device, selection: &Selection, fetch: Fetch) -> Result<Computed, String> {
    let DeviceState {
        scan,
        configuration_hash,
        reached,
    } = read_state(device, fetch)?;
    let plan = compute_plan(&scan, selection)?;
    let mut texts = BTreeMap::new();
    for path in plan.publish().iter().chain(plan.update()) {
        let text = device
            .vault
            .read(path)
            .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?
            .ok_or_else(|| format!("\"{path}\" does not exist in the vault any more"))?;
        let source = source_of(&text);
        let cleaned = clean_note(&source);
        let targets = links_of(&source, path, &scan.index, &scan.guarded);
        let attachments = attachments_of(&targets.files, &device.vault, &scan.files)?;
        texts.insert(
            path.clone(),
            NoteTexts {
                aliases: aliases_of(&source),
                source,
                cleaned,
                links: targets.links,
                attachments,
            },
        );
    }
    // The map gives the notes in the order of their paths.
    let notes = texts
        .iter()
        .map(|(path, texts)| {
            Ok(json!({
                "aliases": texts.aliases.aliases,
                "attachments": to_value(&texts.attachments)?,
                "cleanedHash": content_hash(&texts.cleaned),
                "links": to_value(&texts.links)?,
                "path": path,
                "sourceHash": content_hash(&texts.source),
            }))
        })
        .collect::<Result<Vec<Value>, String>>()?;
    let record = canonical(&json!({
        "plan": to_value(&plan)?,
        "selection": to_value(selection)?,
        "state": {
            "configuration": configuration_hash,
            "manifest": manifest_hash(device)?,
            "notes": notes,
        },
    }))?;
    Ok(Computed {
        plan,
        reached,
        record,
        scan,
        texts,
    })
}

/// Computes a publication plan and stores it on the device. It writes nothing
/// into the vault and nothing into the content of the store. The result is the
/// plan with its id, in the canonical form.
///
/// # Errors
///
/// The selection cannot become a plan, or the plan cannot be stored.
pub fn plan(device: &Device, selection: &Selection) -> Result<String, String> {
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
    // The id names the record. It is outside the parity rule (TOOL-30).
    let id = sha256_hex(&computed.record)[..16].to_owned();
    device.store.save_plan(&id, &computed.record)?;
    canonical(&json!({
        "id": id,
        "offline": !computed.reached,
        "plan": to_value(&computed.plan)?,
    }))
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
    Ok(Selection::new(
        &list("include")?,
        &list("hold")?,
        &list("remove")?,
    ))
}

/// The number of a text of ASCII digits.
fn number(digits: &str) -> u32 {
    digits.parse().unwrap_or(u32::MAX)
}

/// True when the text is a real date and time in the canonical form: UTC, to
/// the second.
fn is_canonical_time(time: &str) -> bool {
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
fn is_one_line(text: &str) -> bool {
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
            path: path.to_owned(),
            source_hash,
            state: State::Published,
        };
    };
    // The identity and the first date stay. A technical update does not move
    // the last date: the author did not edit the note (PUB-24).
    let edited = before.state != State::Published || before.source_hash != source_hash;
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
        source_hash,
        state: State::Published,
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
    scan: &Scan,
    time: &str,
) -> Result<Unit, String> {
    let texts = texts.get(path).ok_or("the plan has no text for the note")?;
    let entry = entry_of(path, texts, scan.manifest.get(path), time);
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
fn removal_unit(path: &str, scan: &Scan) -> Result<Unit, String> {
    let entry = scan
        .manifest
        .get(path)
        .ok_or("the note has no manifest entry")?;
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

/// The keys of the files of the attachment storage that the published notes
/// of a manifest use. An attachment whose file is under a guard now is used
/// by no note, also when an entry that the plan held still lists it.
fn used_keys(
    manifest: &BTreeMap<String, ManifestEntry>,
    scan: &Scan,
    vault: &Vault,
) -> BTreeSet<String> {
    manifest
        .values()
        .filter(|entry| entry.state == State::Published)
        .flat_map(|entry| &entry.attachments)
        .filter(|attachment| !scan.is_guarded_file(vault, &attachment.path, &attachment.hash))
        .map(|attachment| key_of(&attachment.hash).to_owned())
        .collect()
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
            let bytes = self.vault.read_bytes(&attachment.path)?;
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
    fn take_back(&self, manifest: &BTreeMap<String, ManifestEntry>, scan: &Scan) -> Vec<String> {
        let used = used_keys(manifest, scan, self.vault);
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
) -> Cleanup {
    let used = used_keys(manifest, scan, vault);
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
            return cleanup;
        }
    };
    sort_by_code_point(&mut names);
    let present: BTreeSet<String> = names.iter().cloned().collect();
    for name in names {
        if used.contains(&name) {
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
    repair_storage(storage, manifest, scan, vault, &present, &mut cleanup);
    cleanup
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
fn store_paths_of(plan: &PublicationPlan, scan: &Scan, time: &str) -> Vec<String> {
    let mut paths = BTreeSet::new();
    for path in plan
        .forced_remove()
        .iter()
        .chain(plan.publish())
        .chain(plan.update())
        .chain(plan.remove())
    {
        paths.insert(format!("{NOTES_FOLDER}/{path}"));
        let id = scan
            .manifest
            .get(path)
            .map_or_else(|| note_id(path, time), |entry| entry.id.clone());
        paths.insert(manifest_file(&id));
    }
    // The set gives its texts in the order of the code points.
    paths.into_iter().collect()
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
    scan: &Scan,
) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    for path in plan.forced_remove() {
        let mut remove = || -> Result<(), String> {
            let entry = scan
                .manifest
                .get(path)
                .ok_or("the note has no manifest entry")?;
            for file in [format!("{NOTES_FOLDER}/{path}"), manifest_file(&entry.id)] {
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
                warn(format!(
                    "the note changed during the publication: its {STATE_PROPERTY} property is corrected at the next publication"
                ));
                continue;
            }
            Err(error) => {
                warn(format!(
                    "the {STATE_PROPERTY} property could not be corrected: the note {error}"
                ));
                continue;
            }
        };
        // A new line below a line in the flow form of YAML (`{ }`, `[ ]`) is
        // not valid YAML. The note stays as the author wrote it.
        if has_flow_properties(&text) {
            warn(format!(
                "the properties of the note are in the flow form of YAML ({{ }} or [ ]), and the tool does not write into that form: correct the {STATE_PROPERTY} property by hand"
            ));
            continue;
        }
        let wanted = if is_published {
            set_property(&text, STATE_PROPERTY, "true")
        } else {
            remove_property(&text, STATE_PROPERTY)
        };
        // The write must not change what the guard reads. In an odd form of
        // the properties, a line of the ignore property can belong to the
        // state property, or the new lines can close properties that were
        // open. Such a note is never written.
        if names_in_properties(&wanted, IGNORE_PROPERTY)
            != names_in_properties(&text, IGNORE_PROPERTY)
        {
            warn(format!(
                "the {STATE_PROPERTY} property cannot be corrected with no change to what the ignore property says: correct it by hand"
            ));
            continue;
        }
        match device.vault.write(path, &wanted) {
            Ok(()) if is_published => correction.property_set.push(path.clone()),
            Ok(()) => correction.property_removed.push(path.clone()),
            Err(error) => warn(format!(
                "the {STATE_PROPERTY} property could not be corrected: {error}"
            )),
        }
    }
    correction
}

/// Checks the inputs of a publication: the time, the name of the device, the
/// face and the id of the plan.
fn check_inputs(id: &str, run: &Run) -> Result<(), String> {
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
    if !is_plan_id(id) {
        return Err(format!(
            "\"{id}\" is not the id of a plan: an id is 16 hexadecimal digits"
        ));
    }
    Ok(())
}

/// What the writes of a plan did.
struct Written {
    failed: Vec<Value>,
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

/// Writes the files of a plan into the copy, and commits and pushes them.
/// The forced removals come first: when one fails, the whole publication
/// stops. A note whose uploads or files fail is left out and reported
/// (PUB-26).
fn write_all(
    device: &Device,
    journal: &mut Backup,
    uploads: &mut Uploads,
    computed: &Computed,
    run: &Run,
    commit: &Commit,
) -> Result<Written, String> {
    let Computed {
        plan, scan, texts, ..
    } = computed;
    // The forced removals come first, and they are no unit of one note: a
    // failure stops the whole publication.
    let mut paths = remove_forced(journal, plan, scan)?;
    let mut manifest = scan.manifest.clone();
    for path in plan.forced_remove() {
        manifest.remove(path);
    }
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
            // A failure of one note leaves that note out (PUB-26).
            Err(Failure::Note(reason)) => {
                failed.push(json!({ "path": path, "reason": reason }));
                Ok(false)
            }
            Err(Failure::Stop(reason)) => Err(reason),
        }
    };
    for path in plan.publish() {
        if apply(path, note_unit(path, texts, scan, run.time))? {
            done.published.push(path.clone());
        }
    }
    for path in plan.update() {
        if apply(path, note_unit(path, texts, scan, run.time))? {
            done.updated.push(path.clone());
        }
    }
    for path in plan.remove() {
        if apply(path, removal_unit(path, scan))? {
            done.removed.push(path.clone());
        }
    }
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
        device.store.commit_and_push(
            &format!(
                "Publish: {} new, {} updated, {} removed, {} forced, {} skipped\n\nDevice: {}\nFace: {}\nPlan: {}",
                done.published.len(),
                done.updated.len(),
                done.removed.len(),
                plan.forced_remove().len(),
                skipped.len(),
                run.device,
                run.face,
                commit.plan
            ),
            &paths,
        )?;
    }
    // Sorted by path, like every list of the report. A stable sort.
    failed.sort_by(|one: &Value, two: &Value| one["path"].as_str().cmp(&two["path"].as_str()));
    Ok(Written {
        failed,
        published: done.published,
        updated: done.updated,
        removed: done.removed,
        skipped,
        paths,
        manifest,
    })
}

/// Applies exactly one plan, by its id.
///
/// It takes the lock of the device, and puts back what a publication that
/// stopped halfway left. It computes the record of the plan again: when the
/// new record is not the stored one, the plan is stale and nothing is
/// published. The run journal is written before the first write into the
/// copy. The forced removals come first: when one fails, nothing is
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
) -> Result<(), String> {
    if current.record == record {
        return Ok(());
    }
    let cleanup = clean_storage(
        storage,
        &current.scan.manifest,
        &current.scan,
        &device.vault,
    );
    Err(format!(
        "the plan {id} is stale: a note of the plan, the publication queue, the configuration or the content store changed. Make a new plan{}",
        warning_lines(&cleanup.warnings)
    ))
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
    let current = record_for(device, &selection_of(&record, id)?, Fetch::Must)?;
    refuse_stale(device, storage, &current, &record, id)?;
    // The journal comes before the first write into the copy: a run that
    // stops halfway is put back by the next one.
    let paths = store_paths_of(&current.plan, &current.scan, run.time);
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
        &current,
        run,
        &Commit { plan: id, own_lock },
    ) {
        Ok(written) => written,
        // Another run took the copy: this run touches nothing of it any more,
        // or it would put its files back over the work of the other run.
        Err(error) if error == LOCK_LOST => return Err(error),
        Err(error) => {
            // Files that stay in the copy would be read as published at the
            // next run, and an upload that stays would be public with no
            // entry.
            let stayed = journal.put_all_back();
            let kept = uploads.take_back(&current.scan.manifest, &current.scan);
            // A file that could not be put back, or a commit that git could
            // not take back, stays in the journal, so the next run puts it
            // back.
            if stayed.is_empty() && device.store.head() == head {
                settle(owed)?;
            }
            let files = if stayed.is_empty() {
                "and the files of the copy are as they were before".to_owned()
            } else {
                format!(
                    "and these files of the copy could not be put back: {}. The next plan or publish puts them back",
                    stayed.join(", ")
                )
            };
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
    let cleanup = clean_storage(storage, &written.manifest, &current.scan, &device.vault);
    if correct {
        device.store.remove_journal()?;
    }
    let reserved = reserved_alias_warnings(
        &current.texts,
        written.published.iter().chain(&written.updated),
    );
    report_of(
        &written,
        &current.plan,
        &uploads.uploaded,
        reserved,
        correction,
        cleanup,
    )
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
    uploads: &[String],
    reserved: Vec<Value>,
    correction: Correction,
    cleanup: Cleanup,
) -> Result<Outcome, String> {
    let mut uploaded = uploads.to_vec();
    uploaded.extend(cleanup.uploaded);
    sort_by_code_point(&mut uploaded);
    let mut warnings = reserved;
    warnings.extend(correction.warnings);
    warnings.extend(cleanup.warnings);
    // A stable sort, by the path of each warning.
    warnings.sort_by(|one, two| one["path"].as_str().cmp(&two["path"].as_str()));
    let output = canonical(&json!({
        "attachmentsDeleted": cleanup.deleted,
        "attachmentsUploaded": uploaded,
        "failed": written.failed,
        "forcedRemoved": plan.forced_remove(),
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
        failed: written.failed.len(),
    })
}
