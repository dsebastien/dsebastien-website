//! The publication queue (issue 33): the four lists, the selection, the plan,
//! the publication of updates and removals, and the correction of the state
//! property.
//!
//! The scenarios are in `fixtures/canonical/queue.json`. The TypeScript tests
//! run the same file (`apps/plugin/src/publishing/queue.spec.ts`), so both
//! implementations must give what each step states. The other tests go through
//! the fixture vault and state the same expected texts as the TypeScript
//! tests. The hashes were computed with `sha256sum`, not with this code.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::{Value, json};

use support::{TestStores, git, text};

const SCENARIOS: &str = include_str!("../../fixtures/canonical/queue.json");

const NOTE: &str = "10 Garden/Frost dates explained.md";
const SECOND: &str = "10 Garden/Compost basics.md";
const WRONG: &str = "10 Garden/Bean trellis.md";
const TIME: &str = "2031-04-01T08:00:00Z";
const LATER: &str = "2031-04-02T09:00:00Z";
const NOTE_ID: &str = "203d446940c02032";
const SECOND_ID: &str = "d0fd5a0726f54141";

/// One more line for a note, and the hash of the first note with that line.
const EDIT: &str = "\nA second paragraph.\n";
/// The hash of the second note, and its identity when it is published later.
const SECOND_HASH: &str = "sha256:bcd6b6e0fe725e19061691651bd572fa6c592774832ed25732644e51e8114c36";
const SECOND_LATER_ID: &str = "4cee3ca800418fa0";
const EDITED_HASH: &str = "sha256:ae719597cce4e0bc1f415607af4723afb0a28eb9fa09c45179bc0aca4a53605c";

/// A vault and the copy of a content store, for one test.
struct Setup {
    stores: TestStores,
    vault: PathBuf,
    copy: PathBuf,
}

fn errors_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn json_of(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("the output is JSON")
}

fn write_files(folder: &Path, files: &Value) {
    for (path, content) in files.as_object().expect("the files are an object") {
        let file = folder.join(path);
        fs::create_dir_all(file.parent().expect("a file has a folder"))
            .expect("the folder can be made");
        fs::write(file, content.as_str().expect("a file has a text")).expect("the file is written");
    }
}

/// Another device: it writes files into the content store and pushes them.
fn push_to_store(copy: &Path, files: &Value) {
    write_files(copy, files);
    let run = |arguments: &[&str]| {
        let mut all = vec!["-C", text(copy)];
        all.extend_from_slice(arguments);
        git(&all)
    };
    let mut add = vec!["add", "--"];
    add.extend(
        files
            .as_object()
            .expect("the files are an object")
            .keys()
            .map(String::as_str),
    );
    run(&add);
    run(&[
        "commit",
        "--quiet",
        "--message",
        "A change of another device",
    ]);
    run(&["push", "--quiet", "origin", "HEAD:main"]);
}

/// The paths of a list of the JSON output.
fn paths(list: &Value) -> Vec<String> {
    list.as_array()
        .expect("the value is a list")
        .iter()
        .map(|item| {
            item.as_str()
                .or_else(|| item["path"].as_str())
                .expect("an item is a path, or has one")
                .to_owned()
        })
        .collect()
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).expect("the file can be read")
}

fn append(path: &Path, more: &str) {
    fs::write(path, read(path) + more).expect("the file can be written");
}

impl Setup {
    /// A copy of the fixture vault, and a content store with its configuration.
    fn fixture() -> Self {
        let stores = TestStores::new();
        let vault = stores.copy_fixture_vault();
        let copy = stores.make_content_store_copy();
        Self {
            stores,
            vault,
            copy,
        }
    }

    /// The vault and the deny list of a scenario.
    fn scenario(scenario: &Value) -> Self {
        let stores = TestStores::new();
        let vault = stores.root().join("vault");
        fs::create_dir(&vault).expect("the vault can be made");
        write_files(&vault, &scenario["vault"]);
        let copy = stores.make_content_store_copy();
        let configuration = json!({ "denyList": scenario["denyList"] }).to_string();
        push_to_store(&copy, &json!({ "configuration.json": configuration }));
        Self {
            stores,
            vault,
            copy,
        }
    }

    fn run(&self, command: &str, arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
            .arg(command)
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy)
            .args(arguments)
            .output()
            .expect("the program starts")
    }

    fn status(&self) -> Value {
        let output = self.run("status", &[]);
        assert!(output.status.success(), "{}", errors_of(&output));
        json_of(&output)
    }

    /// Runs the `plan` command for a selection: three lists of paths.
    fn plan(&self, selection: &Value) -> Output {
        let mut arguments = Vec::new();
        for key in ["include", "hold", "remove"] {
            if let Some(list) = selection[key].as_array() {
                for path in list {
                    // With `=`: a path can start with a hyphen.
                    arguments.push(format!(
                        "--{key}={}",
                        path.as_str().expect("a path is a text")
                    ));
                }
            }
        }
        let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
        self.run("plan", &arguments)
    }

    fn plan_id(&self, selection: &Value) -> String {
        let output = self.plan(selection);
        assert!(output.status.success(), "{}", errors_of(&output));
        json_of(&output)["id"]
            .as_str()
            .expect("the plan has an id")
            .to_owned()
    }

    fn publish_plan(&self, id: &str, time: &str) -> Output {
        self.run(
            "publish",
            &["--plan", id, "--time", time, "--device", "garden-shed"],
        )
    }

    /// Makes the plan of a selection and applies it. The result is the report.
    fn publish(&self, selection: &Value, time: &str) -> Value {
        let output = self.publish_plan(&self.plan_id(selection), time);
        assert!(output.status.success(), "{}", errors_of(&output));
        json_of(&output)
    }

    fn git(&self, arguments: &[&str]) -> String {
        let mut all = vec!["-C", text(&self.copy)];
        all.extend_from_slice(arguments);
        git(&all)
    }
}

fn collect(folder: &Path, root: &Path, files: &mut Vec<(String, Vec<u8>)>) {
    for entry in fs::read_dir(folder).expect("the folder can be read") {
        let path = entry.expect("the entry can be read").path();
        if path.is_dir() {
            collect(&path, root, files);
        } else {
            let name = path.strip_prefix(root).expect("the file is in the folder");
            files.push((
                name.to_string_lossy().replace('\\', "/"),
                fs::read(&path).expect("the file can be read"),
            ));
        }
    }
}

/// Every file of a folder with its bytes: a picture to compare before and
/// after.
fn picture(folder: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    collect(folder, folder, &mut files);
    files.sort();
    files
}

/// The text of a file as JSON: a text, or `null` when the file does not exist.
fn text_of(path: &Path) -> Value {
    match fs::read(path) {
        Ok(bytes) => Value::String(String::from_utf8(bytes).expect("the file is UTF-8")),
        Err(_) => Value::Null,
    }
}

/// The lists of paths of a report, in the form of the shared file.
fn report_lists(report: &Value) -> Value {
    let mut lists = report.clone();
    for key in ["failed", "warnings"] {
        lists[key] = json!(paths(&report[key]));
    }
    lists
}

fn run_step(setup: &Setup, step: &Value, label: &str) {
    match step["do"].as_str().expect("a step says what it does") {
        "write" => write_files(&setup.vault, &step["files"]),
        "delete" => {
            for path in paths(&step["paths"]) {
                fs::remove_file(setup.vault.join(path)).expect("the file can be removed");
            }
        }
        "store" => push_to_store(&setup.copy, &step["files"]),
        "status" => assert_eq!(setup.status(), step["queue"], "{label}"),
        "plan" => {
            let output = setup.plan(&step["selection"]);
            if step["refused"] == json!(true) {
                assert_eq!(output.status.code(), Some(1), "{label}");
                assert_eq!(String::from_utf8_lossy(&output.stdout), "", "{label}");
                assert!(errors_of(&output).starts_with("error: "), "{label}");
            } else {
                assert!(output.status.success(), "{label}: {}", errors_of(&output));
                assert_eq!(json_of(&output)["plan"], step["plan"], "{label}");
            }
        }
        "publish" => {
            let time = step["time"].as_str().expect("a publication has a time");
            let report = setup.publish(&step["selection"], time);
            assert_eq!(report_lists(&report), step["report"], "{label}");
        }
        "expect" => {
            for (folder, key) in [(&setup.vault, "vault"), (&setup.copy, "store")] {
                for (path, expected) in step[key].as_object().expect("the files are an object") {
                    assert_eq!(&text_of(&folder.join(path)), expected, "{label}: {path}");
                }
            }
        }
        other => panic!("{label}: the step \"{other}\" is not known"),
    }
}

#[test]
fn every_step_of_the_shared_scenarios_gives_what_the_file_states() {
    let file: Value = serde_json::from_str(SCENARIOS).expect("the scenarios file is JSON");
    let scenarios = file["scenarios"]
        .as_array()
        .expect("the file has scenarios");
    assert!(scenarios.len() >= 3);
    let mut kinds = Vec::new();

    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("a scenario has a name");
        let setup = Setup::scenario(scenario);
        let steps = scenario["steps"].as_array().expect("a scenario has steps");
        for (index, step) in steps.iter().enumerate() {
            let why = step["why"].as_str().expect("a step says why");
            run_step(&setup, step, &format!("{name}, step {}: {why}", index + 1));
            kinds.push(step["do"].as_str().unwrap_or_default().to_owned());
        }
    }

    kinds.sort();
    kinds.dedup();
    assert_eq!(
        kinds,
        [
            "delete", "expect", "plan", "publish", "status", "store", "write"
        ]
    );
}

#[test]
fn the_status_lists_every_candidate_and_no_note_under_a_guard() {
    let setup = Setup::fixture();

    let queue = setup.status();

    let new = paths(&queue["new"]);
    assert!(new.contains(&NOTE.to_owned()));
    assert!(new.contains(&"Welcome.md".to_owned()));
    assert_eq!(
        queue["counts"],
        json!({ "changed": 0, "new": new.len(), "toRemove": 0, "unchanged": 0 })
    );
    // The guards: two folders of the deny list, and the ignore property.
    assert!(!new.iter().any(|path| path.starts_with("80 Templates/")));
    assert!(!new.iter().any(|path| path.starts_with("90 Locked Shed/")));
    assert!(!new.contains(&"10 Garden/Neighbour dispute.md".to_owned()));
    // Only notes: no attachment, no canvas. Letter case is never ignored.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let only_notes = new.iter().all(|path| path.ends_with(".md"));
    assert!(only_notes);
}

/// The same text as in `parity/publication.spec.ts` and in the canonical form.
#[test]
fn the_status_of_an_empty_vault_is_the_empty_queue() {
    let setup = Setup::scenario(&json!({ "vault": {}, "denyList": [] }));

    let output = setup.run("status", &[]);

    assert_eq!(errors_of(&output), "");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "{\n  \"changed\": [],\n  \"counts\": {\n    \"changed\": 0,\n    \"new\": 0,\n    \"toRemove\": 0,\n    \"unchanged\": 0\n  },\n  \"new\": [],\n  \"technicalUpdates\": [],\n  \"toRemove\": [],\n  \"unchanged\": []\n}\n"
    );
}

#[test]
fn the_status_writes_nothing_into_the_vault_and_into_the_copy() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE] }), TIME);
    let before = (picture(&setup.vault), picture(&setup.copy));

    setup.status();

    assert_eq!(picture(&setup.vault), before.0);
    assert_eq!(picture(&setup.copy), before.1);
}

#[test]
fn the_status_stops_when_a_note_cannot_be_read_and_names_it() {
    let setup = Setup::fixture();
    fs::write(setup.vault.join("10 Garden/Broken.md"), [0xff, 0xfe]).expect("the file is written");

    let output = setup.run("status", &[]);

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert!(errors_of(&output).contains("10 Garden/Broken.md"));
}

#[test]
fn the_status_stops_when_the_deny_list_names_no_folder_of_the_vault() {
    let setup = Setup::fixture();
    fs::remove_dir_all(setup.vault.join("90 Locked Shed")).expect("the folder can be removed");

    let output = setup.run("status", &[]);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("90 Locked Shed"));
}

#[test]
fn a_manifest_that_cannot_be_trusted_stops_the_status_and_the_plan() {
    let entry = |changes: Value| {
        let mut entry = json!({
            "attachments": [],
            "cleanedHash": "sha256:00",
            "cleaningVersion": 1,
            "firstPublished": TIME,
            "formerPaths": [],
            "id": "00000000000000aa",
            "lastPublished": TIME,
            "path": "Welcome.md",
            "sourceHash": "sha256:00",
            "state": "published"
        });
        for (key, value) in changes.as_object().expect("the changes are an object") {
            entry[key] = value.clone();
        }
        entry.to_string()
    };
    let cases = [
        (
            "a path that leaves the notes",
            json!({ "manifest/00000000000000aa.json": entry(json!({ "path": "../Welcome.md" })) }),
        ),
        (
            "a path that is not a note",
            json!({ "manifest/00000000000000aa.json": entry(json!({ "path": "Welcome" })) }),
        ),
        (
            "an id that is not 16 hexadecimal digits",
            json!({ "manifest/x.json": entry(json!({ "id": "../../x" })) }),
        ),
        (
            "a file that does not have the name of its entry",
            json!({ "manifest/00000000000000bb.json": entry(json!({})) }),
        ),
        (
            "two entries with the same path",
            json!({
                "manifest/00000000000000aa.json": entry(json!({})),
                "manifest/00000000000000bb.json": entry(json!({ "id": "00000000000000bb" }))
            }),
        ),
        (
            "a state that the tool does not know",
            json!({ "manifest/00000000000000aa.json": entry(json!({ "state": "live" })) }),
        ),
        (
            "a file that is not JSON",
            json!({ "manifest/00000000000000aa.json": "not JSON" }),
        ),
    ];

    for (name, files) in cases {
        let setup = Setup::fixture();
        push_to_store(&setup.copy, &files);

        for output in [setup.run("status", &[]), setup.plan(&json!({}))] {
            assert_eq!(output.status.code(), Some(1), "{name}");
            assert!(errors_of(&output).contains("manifest"), "{name}");
        }
    }
}

/// TEST-22: the review holds. The record of the plan holds the hash of each
/// cleaned note, and the publication writes exactly that text.
#[test]
fn the_cleaned_notes_after_a_publication_equal_the_text_that_the_plan_showed() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE] }), TIME);
    append(&setup.vault.join(NOTE), EDIT);

    let id = setup.plan_id(&json!({ "include": [SECOND] }));
    let record: Value = serde_json::from_str(&read(
        &setup
            .copy
            .join(".git")
            .join("vault-publish")
            .join("plans")
            .join(format!("{id}.json")),
    ))
    .expect("the record is JSON");
    let output = setup.publish_plan(&id, LATER);
    assert!(output.status.success(), "{}", errors_of(&output));

    let notes = record["state"]["notes"]
        .as_array()
        .expect("the record has notes");
    assert_eq!(paths(&record["state"]["notes"]), [SECOND, NOTE]);
    assert_eq!(notes[1]["cleanedHash"], EDITED_HASH);
    assert_eq!(notes[0]["cleanedHash"], SECOND_HASH);
    let entry: Value = serde_json::from_str(&read(
        &setup
            .copy
            .join("manifest")
            .join(format!("{SECOND_LATER_ID}.json")),
    ))
    .expect("the entry is JSON");
    assert_eq!(entry["cleanedHash"], SECOND_HASH);
    assert_eq!(
        read(&setup.copy.join("notes").join(SECOND)),
        read(&support::fixture_vault().join(SECOND))
    );
    assert_eq!(
        read(&setup.copy.join("notes").join(NOTE)),
        read(&support::fixture_vault().join(NOTE)) + EDIT
    );
    let updated: Value = serde_json::from_str(&read(
        &setup.copy.join("manifest").join(format!("{NOTE_ID}.json")),
    ))
    .expect("the entry is JSON");
    assert_eq!(updated["cleanedHash"], EDITED_HASH);
    assert_eq!(updated["firstPublished"], TIME);
    assert_eq!(updated["lastPublished"], LATER);
}

#[test]
fn a_published_note_that_is_edited_after_a_plan_without_paths_makes_the_plan_stale() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE, SECOND] }), TIME);
    append(&setup.vault.join(NOTE), EDIT);
    let id = setup.plan_id(&json!({}));
    // The plan did not show this change, so it cannot publish it (PUB-53).
    append(&setup.vault.join(SECOND), EDIT);

    let output = setup.publish_plan(&id, LATER);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("stale"));
    assert!(!read(&setup.copy.join("notes").join(NOTE)).contains("A second paragraph."));
}

#[test]
fn a_new_candidate_after_the_plan_does_not_make_the_plan_stale() {
    let setup = Setup::fixture();
    let id = setup.plan_id(&json!({ "include": [NOTE] }));
    fs::write(setup.vault.join("10 Garden/A new idea.md"), "An idea\n")
        .expect("the file is written");

    let output = setup.publish_plan(&id, TIME);

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(paths(&json_of(&output)["published"]), [NOTE]);
}

/// PUB-29: the counts, the device, the face and the number of skipped entries.
#[test]
fn the_commit_has_a_message_with_the_counts_the_device_and_the_face() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE, SECOND, "Welcome.md"] }), TIME);
    append(&setup.vault.join(NOTE), EDIT);
    append(&setup.vault.join(SECOND), EDIT);

    setup.publish(
        &json!({ "include": [WRONG], "hold": [SECOND], "remove": ["Welcome.md"] }),
        LATER,
    );

    assert_eq!(
        setup.git(&["log", "-1", "--format=%B"]),
        "Publish: 1 new, 1 updated, 1 removed, 1 skipped\n\nDevice: garden-shed\nFace: command-line"
    );
    // One commit, and the content store has it.
    assert_eq!(setup.git(&["rev-list", "--count", "HEAD"]), "3");
    assert_eq!(
        git(&[
            "--git-dir",
            text(setup.stores.content_store()),
            "rev-parse",
            "main"
        ]),
        setup.git(&["rev-parse", "HEAD"])
    );
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
}

#[test]
fn a_device_name_that_is_not_one_line_is_refused() {
    let setup = Setup::fixture();
    let id = setup.plan_id(&json!({ "include": [NOTE] }));

    for name in ["shed\nFace: plugin", " "] {
        let output = setup.run(
            "publish",
            &["--plan", &id, "--time", TIME, "--device", name],
        );

        assert_eq!(output.status.code(), Some(1), "{name:?}");
        assert!(errors_of(&output).contains("device"), "{name:?}");
    }
    assert_eq!(setup.git(&["rev-list", "--count", "HEAD"]), "1");
}

/// Without `--device`, the program reads the name of the host one time.
#[test]
fn the_commit_names_the_host_when_no_device_is_given() {
    let setup = Setup::fixture();
    let id = setup.plan_id(&json!({ "include": [NOTE] }));

    let output = setup.run("publish", &["--plan", &id, "--time", TIME]);

    assert!(output.status.success(), "{}", errors_of(&output));
    let message = setup.git(&["log", "-1", "--format=%B"]);
    let device = message
        .lines()
        .find_map(|line| line.strip_prefix("Device: "))
        .expect("the message names the device");
    assert_ne!(device.trim(), "");
    assert!(message.ends_with("\nFace: command-line"));
}

/// A note name can hold the characters of a git pattern.
#[test]
fn the_commit_holds_only_the_files_of_the_publication_when_a_name_is_a_pattern_for_git() {
    let setup = Setup::fixture();
    let pattern = "10 Garden/Beds [ab].md";
    fs::write(setup.vault.join(pattern), "Beds\n").expect("the file is written");
    // A file of the copy that the pattern would name, and that no publication
    // wrote.
    let folder = setup.copy.join("notes").join("10 Garden");
    fs::create_dir_all(&folder).expect("the folder can be made");
    fs::write(folder.join("Beds a.md"), "Not of this publication\n").expect("the file is written");

    setup.publish(&json!({ "include": [pattern] }), TIME);

    let files = setup.git(&[
        "-c",
        "core.quotePath=false",
        "show",
        "--name-only",
        "--format=",
        "HEAD",
    ]);
    let notes: Vec<&str> = files
        .lines()
        .filter(|file| file.starts_with("notes/"))
        .collect();
    assert_eq!(notes, ["notes/10 Garden/Beds [ab].md"]);
}

/// PUB-26: a failure of one note before the commit leaves that note out and
/// reports it. Here a file of the copy is in the place of the folder of the
/// note, so the cleaned note cannot be written.
#[test]
fn a_note_that_fails_is_left_out_and_reported_and_the_other_notes_are_published() {
    let setup = Setup::fixture();
    let blocked = "30 People/Ada Quillfeather.md";
    fs::create_dir_all(setup.copy.join("notes")).expect("the folder can be made");
    fs::write(
        setup.copy.join("notes").join("30 People"),
        "A file in the place of a folder\n",
    )
    .expect("the file is written");

    let output = setup.publish_plan(&setup.plan_id(&json!({ "include": [NOTE, blocked] })), TIME);

    // The report is written, and the exit code says that it names a failure.
    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("1 note of the plan was left out"));
    let report = json_of(&output);
    assert_eq!(paths(&report["published"]), [NOTE]);
    assert_eq!(paths(&report["failed"]), [blocked]);
    assert_ne!(report["failed"][0]["reason"], "");
    // The note that failed is not published: no entry, no property.
    let entries: Vec<String> = fs::read_dir(setup.copy.join("manifest"))
        .expect("the manifest can be read")
        .map(|entry| {
            entry
                .expect("the entry can be read")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(entries, [format!("{NOTE_ID}.json")]);
    assert!(!read(&setup.vault.join(blocked)).contains("public_note"));
    assert_eq!(paths(&report["propertySet"]), [NOTE]);
    assert!(paths(&setup.status()["new"]).contains(&blocked.to_owned()));
}

/// The two files of a note are one unit: the cleaned note is not left behind
/// when its manifest entry cannot be written.
#[test]
fn the_cleaned_note_is_put_back_when_the_manifest_entry_cannot_be_written() {
    let setup = Setup::fixture();
    // A folder in the place of the manifest entry of the note.
    fs::create_dir_all(
        setup
            .copy
            .join("manifest")
            .join(format!("{SECOND_ID}.json")),
    )
    .expect("the folder can be made");

    let output = setup.publish_plan(&setup.plan_id(&json!({ "include": [NOTE, SECOND] })), TIME);

    assert_eq!(output.status.code(), Some(1));
    let report = json_of(&output);
    assert_eq!(paths(&report["published"]), [NOTE]);
    assert_eq!(paths(&report["failed"]), [SECOND]);
    assert!(!setup.copy.join("notes").join(SECOND).exists());
    assert!(setup.copy.join("notes").join(NOTE).exists());
}

#[test]
fn nothing_is_published_and_nothing_is_corrected_when_every_note_fails() {
    let setup = Setup::fixture();
    let blocked = "30 People/Ada Quillfeather.md";
    fs::create_dir_all(setup.copy.join("notes")).expect("the folder can be made");
    fs::write(
        setup.copy.join("notes").join("30 People"),
        "A file in the place of a folder\n",
    )
    .expect("the file is written");
    let before = picture(&setup.vault);

    let output = setup.publish_plan(&setup.plan_id(&json!({ "include": [blocked] })), TIME);

    assert_eq!(output.status.code(), Some(1));
    let report = json_of(&output);
    assert_eq!(paths(&report["published"]), Vec::<String>::new());
    assert_eq!(paths(&report["failed"]), [blocked]);
    assert_eq!(setup.git(&["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(picture(&setup.vault), before);
}

/// PUB-13: a file that changed during the run is skipped and reported. A hook
/// of the copy edits a note at the moment of the commit, after the scan.
#[cfg(unix)]
#[test]
fn a_note_that_changed_during_the_publication_is_skipped_and_reported() {
    use std::os::unix::fs::PermissionsExt;

    let setup = Setup::fixture();
    let hooks = setup.copy.join(".git").join("hooks");
    fs::create_dir_all(&hooks).expect("the folder can be made");
    let hook = hooks.join("post-commit");
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\nprintf 'A line that the author adds now.\\n' >> '{}'\n",
            setup.vault.join(WRONG).display()
        ),
    )
    .expect("the hook is written");
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("the hook can run");

    let report = setup.publish(&json!({ "include": [NOTE] }), TIME);

    assert_eq!(paths(&report["propertySet"]), [NOTE]);
    assert_eq!(paths(&report["propertyRemoved"]), Vec::<String>::new());
    assert_eq!(paths(&report["warnings"]), [WRONG]);
    let text = read(&setup.vault.join(WRONG));
    assert!(text.contains("public_note: true"));
    assert!(text.contains("A line that the author adds now."));

    // The next publication corrects it.
    fs::remove_file(&hook).expect("the hook can be removed");
    let next = setup.publish(&json!({ "include": [SECOND] }), LATER);
    assert_eq!(paths(&next["propertyRemoved"]), [WRONG]);
    assert_eq!(paths(&next["warnings"]), Vec::<String>::new());
}

#[cfg(unix)]
#[test]
fn a_note_that_cannot_be_written_is_reported_and_the_publication_stays_done() {
    use std::os::unix::fs::PermissionsExt;

    let setup = Setup::fixture();
    fs::set_permissions(setup.vault.join(WRONG), fs::Permissions::from_mode(0o444))
        .expect("the permissions can be set");

    let report = setup.publish(&json!({ "include": [NOTE] }), TIME);

    assert_eq!(paths(&report["published"]), [NOTE]);
    assert_eq!(paths(&report["warnings"]), [WRONG]);
    assert_eq!(
        git(&[
            "--git-dir",
            text(setup.stores.content_store()),
            "rev-list",
            "--count",
            "main"
        ]),
        "2"
    );
}

/// TEST-20: no correction when the push fails.
#[test]
fn a_refused_push_of_an_update_puts_the_copy_back_and_corrects_nothing() {
    let setup = Setup::fixture();
    // A setting of the machine that converts line ends must not change a file
    // that is put back.
    setup.git(&["config", "core.autocrlf", "true"]);
    setup.publish(&json!({ "include": [NOTE, "Welcome.md"] }), TIME);
    let published = read(&setup.copy.join("notes").join(NOTE));
    append(&setup.vault.join(NOTE), EDIT);
    let id = setup.plan_id(&json!({ "include": [SECOND], "remove": ["Welcome.md"] }));
    // Another device pushes first. The copy of this device does not know it.
    let other = setup.stores.root().join("other");
    git(&[
        "clone",
        "--quiet",
        text(setup.stores.content_store()),
        text(&other),
    ]);
    for (key, value) in [
        ("user.name", "Other"),
        ("user.email", "other@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(&["-C", text(&other), "config", key, value]);
    }
    push_to_store(
        &other,
        &json!({ "elsewhere.txt": "A change of another device\n" }),
    );
    let before = (picture(&setup.vault), setup.git(&["rev-parse", "HEAD"]));

    let output = setup.publish_plan(&id, LATER);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("refused"));
    assert_eq!(setup.git(&["rev-parse", "HEAD"]), before.1);
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
    // The file of the update has its committed text again, and the file of the
    // removal is back.
    assert_eq!(read(&setup.copy.join("notes").join(NOTE)), published);
    assert!(setup.copy.join("notes").join("Welcome.md").exists());
    assert!(!setup.copy.join("notes").join(SECOND).exists());
    assert_eq!(picture(&setup.vault), before.0);
}
