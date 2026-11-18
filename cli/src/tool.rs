//! The operations of the publishing tool. The commands of the program call
//! these. The TypeScript twin is `apps/plugin/src/publishing/tool.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

use serde::Serialize;
use serde_json::{Value, json};

use crate::canonical::to_canonical_json;
use crate::clean::{CLEANING_VERSION, STATE_PROPERTY, clean_note, source_of};
use crate::configuration::{CONFIGURATION_FILE, Configuration, parse_configuration};
use crate::device::{ContentStore, Vault};
use crate::frontmatter::{names_in_properties, remove_property, set_property};
use crate::guards::IGNORE_PROPERTY;
use crate::hash::{content_hash, sha256_hex};
use crate::manifest::{
    MANIFEST_FOLDER, ManifestEntry, NOTES_FOLDER, State, manifest_file, note_id, read_manifest,
};
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
    for file in device.store.list(MANIFEST_FOLDER) {
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
}

/// Checks the content store, reads the configuration and the manifest, and
/// scans the vault.
fn read_state(device: &Device) -> Result<DeviceState, String> {
    device.store.verify()?;
    let (configuration, configuration_hash) = read_configuration(device)?;
    let manifest = read_manifest(&device.store)?;
    Ok(DeviceState {
        scan: compute_queue(&device.vault, manifest, configuration)?,
        configuration_hash,
    })
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
    canonical(&to_value(&read_state(device)?.scan.queue)?)
}

/// The source and the cleaned note of one note of a plan.
struct NoteTexts {
    source: String,
    cleaned: String,
}

/// A plan with everything that its publication needs.
struct Computed {
    plan: PublicationPlan,
    /// The record of the plan, in the canonical form.
    record: String,
    scan: Scan,
    /// The texts of the notes to publish and to update, as the record names
    /// them by their hashes.
    texts: BTreeMap<String, NoteTexts>,
}

/// Computes the plan of a selection and its record: the plan, the selection,
/// and the state that the plan was computed from, in the canonical form.
fn record_for(device: &Device, selection: &Selection) -> Result<Computed, String> {
    let DeviceState {
        scan,
        configuration_hash,
    } = read_state(device)?;
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
        texts.insert(path.clone(), NoteTexts { source, cleaned });
    }
    // The map gives the notes in the order of their paths.
    let notes: Vec<Value> = texts
        .iter()
        .map(|(path, texts)| {
            json!({
                "cleanedHash": content_hash(&texts.cleaned),
                "path": path,
                "sourceHash": content_hash(&texts.source),
            })
        })
        .collect();
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
    let computed = record_for(device, selection)?;
    // The id names the record. It is outside the parity rule (TOOL-30).
    let id = sha256_hex(&computed.record)[..16].to_owned();
    device.store.save_plan(&id, &computed.record)?;
    canonical(&json!({ "id": id, "plan": to_value(&computed.plan)? }))
}

/// Reads the selection of a stored record.
fn selection_of(record: &str, id: &str) -> Result<Selection, String> {
    let unreadable = || format!("the stored plan {id} cannot be read");
    let value: Value = serde_json::from_str(record).map_err(|_| unreadable())?;
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

/// Writes the files of one note. They are one unit: when a write fails, the
/// files are put back as they were, and the error goes to the caller. The
/// result is the paths that changed.
fn apply_unit(device: &Device, files: &[StoreFile]) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    let mut write_all = || -> Result<(), String> {
        for file in files {
            match &file.text {
                Some(text) => {
                    device.store.write(&file.path, text)?;
                    changed.push(file.path.clone());
                }
                None => {
                    if device.store.remove(&file.path)? {
                        changed.push(file.path.clone());
                    }
                }
            }
        }
        Ok(())
    };
    if let Err(error) = write_all() {
        let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
        device.store.discard(&paths)?;
        return Err(error);
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
            attachments: Vec::new(),
            cleaned_hash,
            cleaning_version: CLEANING_VERSION,
            first_published: time.to_owned(),
            former_paths: Vec::new(),
            id: note_id(path, time),
            last_published: time.to_owned(),
            path: path.to_owned(),
            source_hash,
            state: State::Published,
        };
    };
    // The identity and the first date stay. A technical update does not move
    // the last date: the author did not edit the note (PUB-24).
    let edited = before.state != State::Published || before.source_hash != source_hash;
    ManifestEntry {
        cleaned_hash,
        cleaning_version: CLEANING_VERSION,
        last_published: if edited {
            time.to_owned()
        } else {
            before.last_published.clone()
        },
        source_hash,
        state: State::Published,
        ..before.clone()
    }
}

/// The two files of a note to publish or to update.
fn note_files(
    path: &str,
    texts: &BTreeMap<String, NoteTexts>,
    scan: &Scan,
    time: &str,
) -> Result<Vec<StoreFile>, String> {
    let texts = texts.get(path).ok_or("the plan has no text for the note")?;
    let entry = entry_of(path, texts, scan.manifest.get(path), time);
    Ok(vec![
        StoreFile {
            path: format!("{NOTES_FOLDER}/{path}"),
            text: Some(texts.cleaned.clone()),
        },
        StoreFile {
            path: manifest_file(&entry.id),
            text: Some(canonical(&to_value(&entry)?)?),
        },
    ])
}

/// The two files of a note to unpublish: its cleaned note goes, and its entry
/// stays with another state.
fn removal_files(path: &str, scan: &Scan) -> Result<Vec<StoreFile>, String> {
    let entry = scan
        .manifest
        .get(path)
        .ok_or("the note has no manifest entry")?;
    let unpublished = ManifestEntry {
        state: State::Unpublished,
        ..entry.clone()
    };
    Ok(vec![
        StoreFile {
            path: format!("{NOTES_FOLDER}/{path}"),
            text: None,
        },
        StoreFile {
            path: manifest_file(&entry.id),
            text: Some(canonical(&to_value(&unpublished)?)?),
        },
    ])
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

/// Applies exactly one plan, by its id.
///
/// It computes the record of the plan again: when the new record is not the
/// stored one, the plan is stale and nothing is published. Then the cleaned
/// notes and the manifest entries go to the content store in one commit, which
/// is pushed. A note whose files cannot be written is left out and reported.
/// Only after the push, the state property is corrected in the vault. The
/// result is the report of the publication, in the canonical form.
///
/// # Errors
///
/// An input of the run is wrong, the plan is unknown or stale, or the commit
/// or the push failed.
pub fn publish(device: &Device, id: &str, run: &Run) -> Result<Outcome, String> {
    check_inputs(id, run)?;
    let record = device
        .store
        .load_plan(id)
        .ok_or_else(|| format!("there is no plan with the id {id} on this device"))?;
    let current = record_for(device, &selection_of(&record, id)?)?;
    if current.record != record {
        return Err(format!(
            "the plan {id} is stale: a note of the plan, the publication queue, the configuration or the content store changed. Make a new plan"
        ));
    }
    let Computed {
        plan, scan, texts, ..
    } = current;

    let mut written = Vec::new();
    let mut failed = Vec::new();
    // A failure of one note leaves that note out (PUB-26).
    let mut apply = |path: &String, files: Result<Vec<StoreFile>, String>| -> bool {
        match files.and_then(|files| apply_unit(device, &files)) {
            Ok(changed) => {
                written.extend(changed);
                true
            }
            Err(reason) => {
                failed.push(json!({ "path": path, "reason": reason }));
                false
            }
        }
    };
    let mut published = Vec::new();
    let mut updated = Vec::new();
    let mut removed = Vec::new();
    for path in plan.publish() {
        if apply(path, note_files(path, &texts, &scan, run.time)) {
            published.push(path.clone());
        }
    }
    for path in plan.update() {
        if apply(path, note_files(path, &texts, &scan, run.time)) {
            updated.push(path.clone());
        }
    }
    for path in plan.remove() {
        if apply(path, removal_files(path, &scan)) {
            removed.push(path.clone());
        }
    }

    let skipped: Vec<&String> = scan
        .queue
        .changed
        .iter()
        .filter(|path| !plan.update().contains(path) && !plan.remove().contains(path))
        .collect();
    let mut correction = Correction::default();
    // With nothing to commit there is no push, and without a push no property
    // is corrected.
    if !written.is_empty() {
        device.store.commit_and_push(
            &format!(
                "Publish: {} new, {} updated, {} removed, {} skipped\n\nDevice: {}\nFace: {}",
                published.len(),
                updated.len(),
                removed.len(),
                skipped.len(),
                run.device,
                run.face
            ),
            &written,
        )?;
        // The push succeeded: the manifest of the copy is the manifest of the
        // content store. The vault now says the same.
        let mut now_published: BTreeSet<String> = scan
            .manifest
            .keys()
            .filter(|path| scan.is_published(path))
            .cloned()
            .collect();
        now_published.extend(published.iter().cloned());
        for path in &removed {
            now_published.remove(path);
        }
        correction = correct_state(device, &scan, &now_published);
    }
    let output = canonical(&json!({
        "failed": failed,
        "propertyRemoved": correction.property_removed,
        "propertySet": correction.property_set,
        "published": published,
        "removed": removed,
        "skipped": skipped,
        "updated": updated,
        "warnings": correction.warnings,
    }))?;
    Ok(Outcome {
        output,
        failed: failed.len(),
    })
}
