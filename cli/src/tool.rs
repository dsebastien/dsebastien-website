//! The operations of the publishing tool. The commands of the program call
//! these. The TypeScript twin is `apps/plugin/src/publishing/tool.ts`.

use serde_json::{Value, json};

use crate::canonical::to_canonical_json;
use crate::clean::{CLEANING_VERSION, STATE_PROPERTY, clean_note, source_of};
use crate::configuration::{CONFIGURATION_FILE, parse_configuration};
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

/// The record of a plan: the plan and the selection that gave it, in the
/// canonical form.
fn record_of(plan: &PublicationPlan, include: &[String]) -> Result<String, String> {
    canonical(&json!({
        "plan": to_value(plan)?,
        "selection": { "include": unique(include) },
    }))
}

fn plan_for(device: &Device, include: &[String]) -> Result<PublicationPlan, String> {
    let configuration = parse_configuration(device.store.read(CONFIGURATION_FILE).as_deref())?;
    let manifest = read_manifest(&device.store)?;
    compute_plan(&device.vault, &manifest, &configuration, include)
}

/// Computes a publication plan and stores it on the device. It writes nothing
/// into the vault and nothing into the content of the store. The result is the
/// plan with its id, in the canonical form.
///
/// # Errors
///
/// The selection cannot become a plan, or the plan cannot be stored.
pub fn plan(device: &Device, include: &[String]) -> Result<String, String> {
    let computed = plan_for(device, include)?;
    let record = record_of(&computed, include)?;
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

/// True when the text is a time in the canonical form: UTC, to the second.
fn is_canonical_time(time: &str) -> bool {
    let pattern = b"dddd-dd-ddTdd:dd:ddZ";
    time.len() == pattern.len()
        && time
            .bytes()
            .zip(pattern)
            .all(|(byte, expected)| match expected {
                b'd' => byte.is_ascii_digit(),
                other => byte == *other,
            })
}

/// Applies exactly one plan, by its id.
///
/// It computes the plan again: when the vault or the content store changed
/// since the plan, the plan is stale and nothing is published. Then the
/// cleaned notes and their manifest entries go to the content store in one
/// commit, which is pushed. Only after the push, the state property of the
/// published notes is corrected in the vault. The result is the report of the
/// publication, in the canonical form.
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
            "the time of the run must be in UTC, to the second: \"{time}\" is not"
        ));
    }
    let record = device
        .store
        .load_plan(id)
        .ok_or_else(|| format!("there is no plan with the id {id} on this device"))?;
    let include = selection_of(&record, id)?;
    let current = plan_for(device, &include)?;
    if record_of(&current, &include)? != record {
        return Err(format!(
            "the plan {id} is stale: the vault or the content store changed. Make a new plan"
        ));
    }

    for path in current.publish() {
        let text = device
            .vault
            .read(path)
            .ok_or_else(|| format!("\"{path}\" does not exist in the vault"))?;
        let source = source_of(&text);
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
        device
            .store
            .write(&format!("{NOTES_FOLDER}/{path}"), &cleaned)?;
        device.store.write(
            &format!("{MANIFEST_FOLDER}/{}.json", entry.id),
            &canonical(&to_value(&entry)?)?,
        )?;
    }
    if current.publish().is_empty() {
        return canonical(&json!({ "corrected": [], "published": [] }));
    }
    device.store.commit_and_push(&format!(
        "Publish: {} new, 0 updated, 0 removed",
        current.publish().len()
    ))?;

    // The push succeeded: the notes are published. The vault now says so.
    let mut corrected = Vec::new();
    for path in current.publish() {
        if let Some(text) = device.vault.read(path) {
            let wanted = set_property(&text, STATE_PROPERTY, "true");
            if wanted != text {
                device.vault.write(path, &wanted)?;
                corrected.push(path.clone());
            }
        }
    }
    canonical(&json!({ "corrected": corrected, "published": current.publish() }))
}
