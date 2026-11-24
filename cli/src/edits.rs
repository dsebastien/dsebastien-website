//! The edits of the guards (issue 42, decisions of the author R69): the log
//! `edits.json` of the content store, with the proposals that only the author
//! confirms. The rules are in `documentation/Canonical Form.md`, section "The
//! edits of the guards". The TypeScript twin is
//! `apps/plugin/src/publishing/edits.ts`. Change both in the same commit.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::canonical::to_canonical_json;
use crate::configuration::is_vault_path;
use crate::hash::sha256_hex;
use crate::json::parse_json;
use crate::manifest::whole_number;
use crate::tool::{FACES, is_canonical_time, is_one_line};

/// The path of the log in the content store.
pub const EDITS_FILE: &str = "edits.json";

/// The edits of the guards. `deny` and `ignore` make the tool stricter,
/// `allow` and `unignore` make it looser.
pub const ACTIONS: [&str; 4] = ["deny", "allow", "ignore", "unignore"];

/// The states of an event.
const STATES: [&str; 4] = ["applied", "proposed", "confirmed", "rejected"];

/// The keys that an event can have.
const EVENT_KEYS: [&str; 10] = [
    "action", "affects", "device", "face", "id", "path", "proposal", "removes", "state", "time",
];

/// True when the action makes the guards looser: it is always a proposal
/// (R69, decision 1).
pub fn is_looser(action: &str) -> bool {
    action == "allow" || action == "unignore"
}

/// True when the action names a note, not a folder.
pub fn names_a_note(action: &str) -> bool {
    action == "ignore" || action == "unignore"
}

/// One event of the log. It is never changed and never removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Event {
    pub action: String,
    /// For `proposed` and `confirmed` of `deny`: the vault paths of the
    /// published entries, not in `removes`, that use an attachment that the
    /// edit puts under the guard, sorted by path. No key when it is empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub affects: Vec<String>,
    pub device: String,
    pub face: String,
    pub id: String,
    /// The folder, or the vault path of the note.
    pub path: String,
    /// For `confirmed` and `rejected`: the id of the proposal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal: Option<String>,
    /// For `proposed` and `confirmed`: the vault paths of the manifest entries
    /// that the edit takes away, sorted by path. No key when it is empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub removes: Vec<String>,
    pub state: String,
    pub time: String,
}

/// What an event says, without its id.
pub struct EventFacts<'a> {
    pub action: &'a str,
    pub path: &'a str,
    pub state: &'a str,
    pub removes: Vec<String>,
    pub affects: Vec<String>,
    pub time: &'a str,
    pub device: &'a str,
    pub face: &'a str,
}

impl Event {
    /// A new event, with its id: 16 small hexadecimal digits of the SHA-256 of
    /// the event without `id`, in the canonical form.
    ///
    /// # Errors
    ///
    /// The event has no canonical form.
    pub fn new(facts: EventFacts) -> Result<Self, String> {
        let mut event = Self {
            action: facts.action.to_owned(),
            affects: facts.affects,
            device: facts.device.to_owned(),
            face: facts.face.to_owned(),
            id: String::new(),
            path: facts.path.to_owned(),
            proposal: None,
            removes: facts.removes,
            state: facts.state.to_owned(),
            time: facts.time.to_owned(),
        };
        event.id = event_id(&event)?;
        Ok(event)
    }
}

/// The id of an event: 16 small hexadecimal digits of the SHA-256 of the event
/// without `id`, in the canonical form (with its line end).
fn event_id(event: &Event) -> Result<String, String> {
    let mut value = serde_json::to_value(event).map_err(|error| error.to_string())?;
    if let Some(object) = value.as_object_mut() {
        object.remove("id");
    }
    let text = to_canonical_json(&value).map_err(|error| error.to_string())?;
    Ok(sha256_hex(&text)[..16].to_owned())
}

/// The log of the edits of the guards: `edits.json` of the content store.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct EditLog {
    /// The events, in the order in which they were written.
    pub edits: Vec<Event>,
    /// How many events a publication showed: the plan shows the events after
    /// them.
    pub published: usize,
}

impl EditLog {
    /// The events that no publication showed yet: the plan shows them.
    pub fn since(&self) -> &[Event] {
        &self.edits[self.published.min(self.edits.len())..]
    }

    /// The open proposals: each `proposed` event that no later event confirms
    /// or rejects, in the order of the log. A decision decides the last open
    /// proposal with its id: an equal proposal can come again after a
    /// decision, with the same id.
    pub fn open_proposals(&self) -> Vec<Event> {
        let mut open: BTreeMap<&str, usize> = BTreeMap::new();
        for (place, event) in self.edits.iter().enumerate() {
            if event.state == "proposed" {
                open.insert(&event.id, place);
            } else if let Some(proposal) = &event.proposal {
                open.remove(proposal.as_str());
            }
        }
        let kept: BTreeSet<usize> = open.into_values().collect();
        self.edits
            .iter()
            .enumerate()
            .filter(|(place, _)| kept.contains(place))
            .map(|(_, event)| event.clone())
            .collect()
    }

    /// The log with one more event.
    pub fn with_event(&self, event: Event) -> Self {
        let mut log = self.clone();
        log.edits.push(event);
        log
    }

    /// The log after a publication that showed these events: `published` is
    /// raised by their number.
    pub fn shown(&self, count: usize) -> Self {
        Self {
            edits: self.edits.clone(),
            published: self.published + count,
        }
    }

    /// The text of the file, in the canonical form.
    ///
    /// # Errors
    ///
    /// The log has no canonical form.
    pub fn text(&self) -> Result<String, String> {
        let value = serde_json::to_value(self).map_err(|error| error.to_string())?;
        to_canonical_json(&value).map_err(|error| error.to_string())
    }
}

/// The message of a log that is not valid: it names the file.
fn not_valid(reason: &str) -> String {
    format!(
        "{EDITS_FILE} of the content store is not valid: {reason}. No run is possible until it is corrected"
    )
}

/// True when the text has the form of the id of an event: 16 small
/// hexadecimal digits.
fn is_event_id(text: &str) -> bool {
    text.len() == 16
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// A text of an object, or `None`.
fn text_of<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

/// The list `removes` of an event: vault paths, sorted, each one time, of a
/// proposed or a confirmed edit. No key is an empty list. `Err` with the
/// reason.
fn removes_of(value: Option<&Value>, state: &str) -> Result<Vec<String>, String> {
    let Some(list) = value else {
        return Ok(Vec::new());
    };
    if state != "proposed" && state != "confirmed" {
        return Err(
            "has a list \"removes\", which only a proposal and a confirmation have".to_owned(),
        );
    }
    paths_of(list, "removes")
}

/// The list `affects` of an event: vault paths, sorted, each one time, of a
/// `deny` that is proposed or confirmed. No key is an empty list. `Err` with
/// the reason.
fn affects_of(value: Option<&Value>, action: &str, state: &str) -> Result<Vec<String>, String> {
    let Some(list) = value else {
        return Ok(Vec::new());
    };
    if action != "deny" || (state != "proposed" && state != "confirmed") {
        return Err(
            "has a list \"affects\", which only a deny that is a proposal or a confirmation has"
                .to_owned(),
        );
    }
    paths_of(list, "affects")
}

/// A list of vault paths, sorted, each one time, and not empty.
fn paths_of(list: &Value, key: &str) -> Result<Vec<String>, String> {
    list.as_array()
        .and_then(|items| {
            items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<String>>>()
        })
        .filter(|paths| {
            !paths.is_empty()
                && paths.windows(2).all(|pair| pair[0] < pair[1])
                && paths.iter().all(|path| is_vault_path(path))
        })
        .ok_or_else(|| {
            format!("has a list \"{key}\" that is not vault paths, each one time, sorted")
        })
}

/// Reads one event strictly. `Err` with the reason.
fn read_event(value: &Value, place: usize) -> Result<Event, String> {
    let wrong = |what: &str| format!("the event {} {what}", place + 1);
    let object = value.as_object().ok_or_else(|| wrong("is not an object"))?;
    if let Some(other) = object
        .keys()
        .find(|key| !EVENT_KEYS.contains(&key.as_str()))
    {
        return Err(wrong(&format!(
            "has the key \"{other}\", which no event has"
        )));
    }
    let required =
        |key: &str| text_of(object, key).ok_or_else(|| wrong(&format!("has no text \"{key}\"")));
    let action = required("action")?;
    let state = required("state")?;
    let path = required("path")?;
    let face = required("face")?;
    let device = required("device")?;
    let time = required("time")?;
    let id = required("id")?;
    if !ACTIONS.contains(&action) {
        return Err(wrong(&format!(
            "has the action \"{action}\", which is not deny, allow, ignore or unignore"
        )));
    }
    if !STATES.contains(&state) {
        return Err(wrong(&format!(
            "has the state \"{state}\", which is not applied, proposed, confirmed or rejected"
        )));
    }
    // Letter case is never ignored in the logic.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let is_note = path.ends_with(".md");
    if !is_vault_path(path) || (names_a_note(action) && !is_note) {
        return Err(wrong(
            "has a path that is not the vault path of a folder or of a note",
        ));
    }
    if !FACES.contains(&face) {
        return Err(wrong(&format!(
            "has the face \"{face}\", which is not a face of the tool"
        )));
    }
    if !is_one_line(device) {
        return Err(wrong(
            "has a name of the device that is not one line of text",
        ));
    }
    if !is_canonical_time(time) {
        return Err(wrong(
            "has a time that is not a real date and time in UTC, to the second",
        ));
    }
    if state == "applied" && is_looser(action) {
        return Err(wrong(&format!(
            "is an {action} that applied, but such an edit is always a proposal"
        )));
    }
    let decision = state == "confirmed" || state == "rejected";
    // Only the author decides a proposal, in the view (rule 7).
    if decision && face != "plugin" {
        return Err(wrong(&format!(
            "is a decision of the face \"{face}\": only the author decides a proposal, in the view (the face plugin)"
        )));
    }
    let proposal = match object.get("proposal") {
        None if decision => return Err(wrong("decides no proposal: it has no \"proposal\"")),
        None => None,
        Some(Value::String(proposal)) if decision && is_event_id(proposal) => {
            Some(proposal.clone())
        }
        Some(_) => {
            return Err(wrong(
                "has a \"proposal\" that is not the id of a proposal it decides",
            ));
        }
    };
    let removes = removes_of(object.get("removes"), state).map_err(|why| wrong(&why))?;
    let affects = affects_of(object.get("affects"), action, state).map_err(|why| wrong(&why))?;
    if !is_event_id(id) {
        return Err(wrong("has no id of 16 small hexadecimal digits"));
    }
    let event = Event {
        action: action.to_owned(),
        affects,
        device: device.to_owned(),
        face: face.to_owned(),
        id: id.to_owned(),
        path: path.to_owned(),
        proposal,
        removes,
        state: state.to_owned(),
        time: time.to_owned(),
    };
    if event_id(&event)? != id {
        return Err(wrong(&format!(
            "has the id \"{id}\", which is not the hash of the event"
        )));
    }
    Ok(event)
}

/// Reads the log from the text of its file. A content store without the file
/// has no event, and `published` is 0.
///
/// # Errors
///
/// The file is not a valid log: not JSON, not an object with exactly the list
/// `edits` and the whole number `published`, an event that is not valid or
/// whose id is not its hash, `published` above the number of events, or a
/// decision that does not name an earlier proposal that no other event
/// decided. The message names the file.
pub fn parse_edits(text: Option<&str>) -> Result<EditLog, String> {
    let Some(text) = text else {
        return Ok(EditLog::default());
    };
    let value = parse_json(text).map_err(|_| not_valid("it is not JSON"))?;
    let object = value
        .as_object()
        .filter(|object| object.len() == 2)
        .ok_or_else(|| {
            not_valid("it must be an object with exactly \"edits\" and \"published\"")
        })?;
    let items = object
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| not_valid("\"edits\" must be a list of events"))?;
    let published = object
        .get("published")
        .and_then(whole_number)
        .ok_or_else(|| not_valid("\"published\" must be a whole number from 0"))?;
    let mut edits: Vec<Event> = Vec::new();
    // The proposals that no event decided yet, by their ids.
    let mut open: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (place, item) in items.iter().enumerate() {
        let event = read_event(item, place).map_err(|reason| not_valid(&reason))?;
        if let Some(proposal) = &event.proposal {
            let Some((action, path)) = open.remove(proposal) else {
                return Err(not_valid(&format!(
                    "the event {} decides \"{proposal}\", which is not an earlier proposal that no other event decided",
                    place + 1
                )));
            };
            if action != event.action || path != event.path {
                return Err(not_valid(&format!(
                    "the event {} has another action or path than its proposal",
                    place + 1
                )));
            }
        }
        if event.state == "proposed" {
            open.insert(event.id.clone(), (event.action.clone(), event.path.clone()));
        }
        edits.push(event);
    }
    let published = usize::try_from(published)
        .ok()
        .filter(|published| *published <= edits.len())
        .ok_or_else(|| {
            not_valid(&format!(
                "\"published\" is {published}, above the number of events ({})",
                edits.len()
            ))
        })?;
    Ok(EditLog { edits, published })
}

/// The event as data, as the file holds it.
///
/// # Errors
///
/// The event has no canonical form.
pub fn event_value(event: &Event) -> Result<Value, String> {
    serde_json::to_value(event).map_err(|error| error.to_string())
}

/// The output of an edit command: its event, in the canonical form.
///
/// # Errors
///
/// The event has no canonical form.
pub fn edit_output(event: &Event) -> Result<String, String> {
    to_canonical_json(&json!({ "edit": event_value(event)? })).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(action: &'a str, path: &'a str, state: &'a str, time: &'a str) -> EventFacts<'a> {
        EventFacts {
            action,
            path,
            state,
            removes: Vec::new(),
            affects: Vec::new(),
            time,
            device: "garden-shed",
            face: "mcp-server",
        }
    }

    /// The first event of the shared scenario "the edits of the guards". The
    /// id was computed with `sha256sum`, not with this code.
    fn deny_private() -> Event {
        Event::new(facts("deny", "Private", "applied", "2031-06-01T09:00:00Z"))
            .expect("the event has an id")
    }

    fn proposal() -> Event {
        Event::new(EventFacts {
            removes: vec!["Mixed/Shown.md".to_owned()],
            ..facts("deny", "Mixed", "proposed", "2031-06-01T10:00:00Z")
        })
        .expect("the event has an id")
    }

    /// A decision of the author in the view, as the plugin writes it.
    fn decision(of: &Event, state: &str, time: &str) -> Event {
        let mut event = Event {
            action: of.action.clone(),
            affects: if state == "confirmed" {
                of.affects.clone()
            } else {
                Vec::new()
            },
            device: "garden-shed".to_owned(),
            face: "plugin".to_owned(),
            id: String::new(),
            path: of.path.clone(),
            proposal: Some(of.id.clone()),
            removes: if state == "confirmed" {
                of.removes.clone()
            } else {
                Vec::new()
            },
            state: state.to_owned(),
            time: time.to_owned(),
        };
        event.id = event_id(&event).expect("the event has an id");
        event
    }

    fn log_of(edits: Vec<Event>, published: usize) -> EditLog {
        EditLog { edits, published }
    }

    #[test]
    fn the_id_of_an_event_is_the_hash_of_the_event_without_its_id() {
        assert_eq!(deny_private().id, "34f508006aa66095");
        assert_eq!(proposal().id, "f2acc19e4bd54a30");
        let confirmed = decision(&proposal(), "confirmed", "2031-06-01T15:00:00Z");
        assert_eq!(confirmed.id, "2c98e8dcc4c24a0d");
    }

    #[test]
    fn a_store_without_the_file_has_no_event() {
        assert_eq!(parse_edits(None), Ok(EditLog::default()));
        assert_eq!(
            EditLog::default().text(),
            Ok("{\n  \"edits\": [],\n  \"published\": 0\n}\n".to_owned())
        );
    }

    /// The event of the shared scenario of an image under the new guard. The
    /// id was computed with `sha256sum`, not with this code.
    #[test]
    fn a_deny_that_puts_an_attachment_under_the_guard_names_the_notes_that_use_it() {
        let event = Event::new(EventFacts {
            affects: vec!["Notes/Plan.md".to_owned()],
            ..facts("deny", "Images", "proposed", "2031-08-01T09:00:00Z")
        })
        .expect("the event has an id");
        assert_eq!(event.id, "c74c3c5596b3d560");
        let log = log_of(vec![event.clone()], 0);
        let text = log.text().expect("the log has a canonical form");
        assert!(text.contains("\"affects\": [\n        \"Notes/Plan.md\"\n      ]"));
        assert_eq!(parse_edits(Some(&text)), Ok(log));
        // Only a deny that is a proposal or a confirmation has the list, and
        // the list is sorted, each path one time.
        let with = |action: &str, affects: Vec<&str>| {
            let mut changed = event.clone();
            action.clone_into(&mut changed.action);
            if action == "ignore" {
                "Notes/Plan.md".clone_into(&mut changed.path);
            }
            changed.affects = affects.into_iter().map(str::to_owned).collect();
            changed.id = event_id(&changed).expect("the event has an id");
            text_with(&[event_value(&changed).expect("data")], 0)
        };
        assert!(refusal(&with("ignore", vec!["Notes/Plan.md"])).contains("only a deny"));
        assert!(refusal(&with("deny", vec!["b.md", "a.md"])).contains("\"affects\" that is not"));
        assert!(refusal(&with("deny", vec!["a.md", "a.md"])).contains("\"affects\" that is not"));
    }

    #[test]
    fn the_written_log_is_read_again_as_it_was() {
        let first = proposal();
        let log = log_of(
            vec![
                deny_private(),
                first.clone(),
                decision(&first, "confirmed", "2031-06-01T15:00:00Z"),
            ],
            1,
        );
        let text = log.text().expect("the log has a canonical form");
        assert!(text.contains("\"removes\": [\n        \"Mixed/Shown.md\"\n      ]"));
        assert!(!text.contains("\"proposal\": \"34f"));
        assert_eq!(parse_edits(Some(&text)), Ok(log));
    }

    #[test]
    fn the_open_proposals_are_the_proposals_that_no_event_decided_in_the_order_of_the_log() {
        let first = proposal();
        let second = Event::new(facts("allow", "Locked", "proposed", "2031-06-01T11:00:00Z"))
            .expect("the event has an id");
        let third = Event::new(facts(
            "unignore",
            "Notes/Kept.md",
            "proposed",
            "2031-06-01T14:00:00Z",
        ))
        .expect("the event has an id");
        let log = log_of(
            vec![
                deny_private(),
                first.clone(),
                second.clone(),
                third.clone(),
                decision(&second, "rejected", "2031-06-01T16:00:00Z"),
            ],
            0,
        );
        assert_eq!(log.open_proposals(), [first, third]);
    }

    #[test]
    fn the_plan_shows_the_events_after_the_first_published_ones() {
        let log = log_of(vec![deny_private(), proposal()], 1);
        assert_eq!(log.since(), [proposal()]);
        assert_eq!(log.shown(1).since(), []);
        assert_eq!(log.shown(1).published, 2);
        assert_eq!(log.with_event(deny_private()).since().len(), 2);
    }

    /// The text of a log with these events, in the canonical form.
    fn text_with(edits: &[Value], published: i64) -> String {
        to_canonical_json(&json!({ "edits": edits, "published": published }))
            .expect("the log has a canonical form")
    }

    fn refusal(text: &str) -> String {
        let error = parse_edits(Some(text)).expect_err("the log is refused");
        assert!(
            error.starts_with("edits.json of the content store is not valid"),
            "{error}"
        );
        error
    }

    #[test]
    fn an_id_that_is_not_the_hash_of_its_event_stops_every_run() {
        let mut event = event_value(&deny_private()).expect("data");
        event["id"] = json!("0123456789abcdef");
        assert!(refusal(&text_with(&[event.clone()], 0)).contains("not the hash"));
        // An edit of the event after it was written.
        let mut edited = event_value(&deny_private()).expect("data");
        edited["path"] = json!("Elsewhere");
        assert!(refusal(&text_with(&[edited], 0)).contains("not the hash"));
    }

    #[test]
    fn published_above_the_number_of_events_stops_every_run() {
        let event = event_value(&deny_private()).expect("data");
        assert!(
            refusal(&text_with(std::slice::from_ref(&event), 2))
                .contains("above the number of events")
        );
        assert!(refusal(&text_with(&[], 1)).contains("above the number of events"));
        assert!(refusal(&text_with(&[event], -1)).contains("whole number"));
        assert_eq!(
            parse_edits(Some("{\"edits\": [], \"published\": 0.0}")),
            Ok(EditLog::default())
        );
    }

    #[test]
    fn a_decision_of_an_unknown_or_already_decided_proposal_stops_every_run() {
        let first = proposal();
        let confirmed = decision(&first, "confirmed", "2031-06-01T15:00:00Z");
        let rejected = decision(&first, "rejected", "2031-06-01T16:00:00Z");
        let value = |event: &Event| event_value(event).expect("data");
        // Unknown: the proposal is not in the log.
        assert!(refusal(&text_with(&[value(&confirmed)], 0)).contains("not an earlier proposal"));
        // Not earlier: the decision comes first.
        assert!(
            refusal(&text_with(&[value(&confirmed), value(&first)], 0))
                .contains("not an earlier proposal")
        );
        // Already decided.
        assert!(
            refusal(&text_with(
                &[value(&first), value(&confirmed), value(&rejected)],
                0
            ))
            .contains("not an earlier proposal")
        );
        // An event that is not a proposal cannot be decided.
        let applied = deny_private();
        let wrong = decision(&applied, "rejected", "2031-06-01T16:00:00Z");
        assert!(
            refusal(&text_with(&[value(&applied), value(&wrong)], 0))
                .contains("not an earlier proposal")
        );
        // A decision of another edit than its proposal.
        let mut other = decision(&first, "rejected", "2031-06-01T16:00:00Z");
        other.path = "Elsewhere".to_owned();
        other.id = event_id(&other).expect("the event has an id");
        assert!(
            refusal(&text_with(&[value(&first), value(&other)], 0))
                .contains("another action or path")
        );
        // A decision of another face than the view.
        for face in ["command-line", "mcp-server"] {
            let mut agent = decision(&first, "confirmed", "2031-06-01T15:00:00Z");
            agent.face = face.to_owned();
            agent.id = event_id(&agent).expect("the event has an id");
            assert!(
                refusal(&text_with(&[value(&first), value(&agent)], 0))
                    .contains("only the author decides")
            );
        }
        // A proposal that comes again after its rejection, with the same id,
        // is open again, and can be decided again.
        let log = log_of(vec![first.clone(), rejected.clone(), first.clone()], 0);
        let text = log.text().expect("the log has a canonical form");
        assert_eq!(parse_edits(Some(&text)), Ok(log.clone()));
        assert_eq!(log.open_proposals(), std::slice::from_ref(&first));
        let again = text_with(
            &[
                value(&first),
                value(&rejected),
                value(&first),
                value(&rejected),
            ],
            0,
        );
        assert_eq!(
            parse_edits(Some(&again)).map(|log| log.open_proposals()),
            Ok(Vec::new())
        );
        // One decision is right.
        let text = text_with(&[value(&first), value(&confirmed)], 2);
        assert_eq!(
            parse_edits(Some(&text)).map(|log| log.open_proposals()),
            Ok(Vec::new())
        );
    }

    #[test]
    fn a_file_in_another_form_stops_every_run() {
        let event = event_value(&deny_private()).expect("data");
        // The event with one key changed, and the id of the changed event:
        // only the change can stop the read.
        let with = |key: &str, item: Value| {
            let mut changed = event.clone();
            changed[key] = item;
            let mut without = changed.clone();
            without.as_object_mut().expect("an object").remove("id");
            let canonical = to_canonical_json(&without).expect("data");
            changed["id"] = json!(sha256_hex(&canonical)[..16]);
            text_with(&[changed], 0)
        };
        for text in [
            "not JSON".to_owned(),
            "[]".to_owned(),
            "{\"edits\": []}".to_owned(),
            "{\"edits\": [], \"published\": 0, \"more\": 1}".to_owned(),
            "{\"edits\": {}, \"published\": 0}".to_owned(),
            text_with(&[json!("deny")], 0),
            with("action", json!("open")),
            with("state", json!("done")),
            with("face", json!("agent")),
            with("device", json!("two\nlines")),
            with("time", json!("2031-06-31T09:00:00Z")),
            with("path", json!("../Private")),
            with("more", json!(true)),
            with("proposal", json!("34f508006aa66095")),
            with("removes", json!([])),
            with("removes", json!(["b.md", "a.md"])),
            with("affects", json!(["Notes/Plan.md"])),
            with("action", json!("allow")),
            with("action", json!("ignore")),
        ] {
            refusal(&text);
        }
    }
}
