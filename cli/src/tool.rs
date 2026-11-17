//! The operations of the publishing tool. The commands of the program call
//! these. The TypeScript twin is `apps/plugin/src/publishing/tool.ts`.

use std::fmt::Write;

use serde_json::{Value, json};

use crate::canonical::to_canonical_json;
use crate::clean::{CLEANING_VERSION, STATE_PROPERTY, clean_note, source_of};
use crate::configuration::{CONFIGURATION_FILE, Configuration, parse_configuration};
use crate::device::{ContentStore, Vault};
use crate::frontmatter::set_property;
use crate::hash::{content_hash, sha256_hex};
use crate::manifest::{
    MANIFEST_FOLDER, ManifestEntry, NOTES_FOLDER, State, note_id, read_manifest,
};
use crate::plan::{PublicationPlan, compute_plan, unique};

/// Everything that a publication needs on one device.
pub struct Device {
    pub vault: Vault,
    pub store: ContentStore,
}

fn canonical(value: &Value) -> Result<String, String> {
    to_canonical_json(value).map_err(|error| error.to_string())
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

/// The source of a note of the plan.
fn source_of_note(device: &Device, path: &str) -> Result<String, String> {
    let text = device
        .vault
        .read(path)
        .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?
        .ok_or_else(|| format!("\"{path}\" does not exist in the vault"))?;
    Ok(source_of(&text))
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

/// Computes the plan of a selection and its record: the plan, the selection,
/// and the state that the plan was computed from, in the canonical form.
fn record_for(device: &Device, include: &[String]) -> Result<(PublicationPlan, String), String> {
    device.store.verify()?;
    let (configuration, configuration_hash) = read_configuration(device)?;
    let manifest = read_manifest(&device.store)?;
    let plan = compute_plan(&device.vault, &manifest, &configuration, include)?;
    let mut notes = Vec::new();
    for path in plan.publish() {
        notes.push(json!({
            "path": path,
            "sourceHash": content_hash(&source_of_note(device, path)?),
        }));
    }
    let record = canonical(&json!({
        "plan": to_value(&plan)?,
        "selection": { "include": unique(include) },
        "state": {
            "configuration": configuration_hash,
            "manifest": manifest_hash(device)?,
            "notes": notes,
        },
    }))?;
    Ok((plan, record))
}

/// Computes a publication plan and stores it on the device. It writes nothing
/// into the vault and nothing into the content of the store. The result is the
/// plan with its id, in the canonical form.
///
/// # Errors
///
/// The selection cannot become a plan, or the plan cannot be stored.
pub fn plan(device: &Device, include: &[String]) -> Result<String, String> {
    let (computed, record) = record_for(device, include)?;
    // The id names the record. It is outside the parity rule (TOOL-30).
    let id = sha256_hex(&record)[..16].to_owned();
    device.store.save_plan(&id, &record)?;
    canonical(&json!({ "id": id, "plan": to_value(&computed)? }))
}

/// Reads the selection of a stored record.
fn selection_of(record: &str, id: &str) -> Result<Vec<String>, String> {
    let unreadable = || format!("the stored plan {id} cannot be read");
    let value: Value = serde_json::from_str(record).map_err(|_| unreadable())?;
    value["selection"]["include"]
        .as_array()
        .ok_or_else(unreadable)?
        .iter()
        .map(|path| path.as_str().map(str::to_owned).ok_or_else(unreadable))
        .collect()
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

/// Applies exactly one plan, by its id.
///
/// It computes the record of the plan again: when a note of the plan, the
/// configuration or the manifest changed since the plan, the plan is stale and
/// nothing is published. Then the cleaned notes and their manifest entries go
/// to the content store in one commit, which is pushed. Only after the push,
/// the state property of the published notes is corrected in the vault. The
/// result is the report of the publication, in the canonical form.
///
/// `time` is the time of the run, in the canonical form. It is an input: the
/// logic reads no clock.
///
/// # Errors
///
/// The time is not canonical, the plan is unknown or stale, or a write, the
/// commit or the push failed.
pub fn publish(device: &Device, id: &str, time: &str) -> Result<String, String> {
    if !is_canonical_time(time) {
        return Err(format!(
            "the time of the run must be a real date and time in UTC, to the second: \"{time}\" is not"
        ));
    }
    if !is_plan_id(id) {
        return Err(format!(
            "\"{id}\" is not the id of a plan: an id is 16 hexadecimal digits"
        ));
    }
    let record = device
        .store
        .load_plan(id)
        .ok_or_else(|| format!("there is no plan with the id {id} on this device"))?;
    let include = selection_of(&record, id)?;
    let (current, current_record) = record_for(device, &include)?;
    if current_record != record {
        return Err(format!(
            "the plan {id} is stale: a note of the plan, the configuration or the content store changed. Make a new plan"
        ));
    }

    let mut written = Vec::new();
    for path in current.publish() {
        let source = source_of_note(device, path)?;
        let cleaned = clean_note(&source);
        let entry = ManifestEntry {
            attachments: Vec::new(),
            cleaned_hash: content_hash(&cleaned),
            cleaning_version: CLEANING_VERSION,
            first_published: time.to_owned(),
            former_paths: Vec::new(),
            id: note_id(path, time),
            last_published: time.to_owned(),
            path: path.clone(),
            source_hash: content_hash(&source),
            state: State::Published,
        };
        let note = format!("{NOTES_FOLDER}/{path}");
        let manifest = format!("{MANIFEST_FOLDER}/{}.json", entry.id);
        device.store.write(&note, &cleaned)?;
        device
            .store
            .write(&manifest, &canonical(&to_value(&entry)?)?)?;
        written.push(note);
        written.push(manifest);
    }
    if written.is_empty() {
        return canonical(&json!({ "corrected": [], "published": [] }));
    }
    device.store.commit_and_push(
        &format!(
            "Publish: {} new, 0 updated, 0 removed",
            current.publish().len()
        ),
        &written,
    )?;

    // The push succeeded: the notes are published. The vault now says so.
    let mut corrected = Vec::new();
    for path in current.publish() {
        if let Ok(Some(text)) = device.vault.read(path) {
            let wanted = set_property(&text, STATE_PROPERTY, "true");
            if wanted != text {
                device.vault.write(path, &wanted)?;
                corrected.push(path.clone());
            }
        }
    }
    canonical(&json!({ "corrected": corrected, "published": current.publish() }))
}
