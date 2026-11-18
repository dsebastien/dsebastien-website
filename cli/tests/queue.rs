//! The publication queue (issues 33 and 34): the four lists, the selection,
//! the plan, the publication of updates, removals and forced removals, the
//! links of a note, and the correction of the state property.
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

/// Commits every change of the copy and pushes it, as another device would.
/// Only the tests of symbolic links use it, and they run on Unix.
#[cfg(unix)]
fn commit_all(copy: &Path) {
    let copy = text(copy);
    git(&["-C", copy, "add", "--all"]);
    git(&[
        "-C",
        copy,
        "commit",
        "--quiet",
        "--message",
        "A change of another device",
    ]);
    git(&["-C", copy, "push", "--quiet", "origin", "HEAD:main"]);
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
        "{\n  \"behind\": 0,\n  \"changed\": [],\n  \"counts\": {\n    \"changed\": 0,\n    \"new\": 0,\n    \"toRemove\": 0,\n    \"unchanged\": 0\n  },\n  \"new\": [],\n  \"technicalUpdates\": [],\n  \"toRemove\": [],\n  \"unchanged\": []\n}\n"
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
            "cleaningVersion": 2,
            "firstPublished": TIME,
            "formerPaths": [],
            "id": "00000000000000aa",
            "lastPublished": TIME,
            "links": [],
            "path": "Welcome.md",
            "sourceHash": "sha256:00",
            "state": "published"
        });
        for (key, value) in changes.as_object().expect("the changes are an object") {
            if value.is_null() {
                // `null` stands for a member that the entry does not have.
                entry
                    .as_object_mut()
                    .expect("the entry is an object")
                    .remove(key);
            } else {
                entry[key] = value.clone();
            }
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
        (
            "an entry without its links",
            json!({ "manifest/00000000000000aa.json": entry(json!({ "links": null })) }),
        ),
        (
            "links that are not a list",
            json!({ "manifest/00000000000000aa.json": entry(json!({ "links": {} })) }),
        ),
        (
            "a link whose target is not the vault path of a note",
            json!({
                "manifest/00000000000000aa.json":
                    entry(json!({ "links": [{ "link": "Up", "path": "../Up.md" }] }))
            }),
        ),
        (
            "a link without its link path",
            json!({
                "manifest/00000000000000aa.json":
                    entry(json!({ "links": [{ "path": "Welcome.md" }] }))
            }),
        ),
        (
            "a link with a member that the tool does not know",
            json!({
                "manifest/00000000000000aa.json": entry(json!({
                    "links": [{ "link": "Welcome", "path": "Welcome.md", "title": "Welcome" }]
                }))
            }),
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

/// The text of a manifest entry with a version and former paths as they are
/// written here: the forms that only one reader of JSON would take.
fn raw_entry(version: &str, former_paths: &str) -> String {
    format!(
        r#"{{"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":{version},"firstPublished":"{TIME}","formerPaths":{former_paths},"id":"00000000000000aa","lastPublished":"{TIME}","links":[],"path":"Welcome.md","sourceHash":"sha256:00","state":"published"}}"#
    )
}

/// A whole number in another form is the same number for both
/// implementations.
#[test]
fn a_version_that_is_written_in_another_form_is_read() {
    for version in ["1.0", "1e0", "-0"] {
        let setup = Setup::fixture();
        push_to_store(
            &setup.copy,
            &json!({ "manifest/00000000000000aa.json": raw_entry(version, "[]") }),
        );

        assert_eq!(
            paths(&setup.status()["changed"]),
            ["Welcome.md"],
            "{version}"
        );
    }
}

#[test]
fn a_manifest_or_a_configuration_that_only_one_reader_would_take_stops_the_status() {
    let cases = [
        (
            "manifest/00000000000000aa.json",
            raw_entry("1.5", "[]"),
            "manifest",
        ),
        (
            "manifest/00000000000000aa.json",
            raw_entry("-1", "[]"),
            "manifest",
        ),
        (
            "manifest/00000000000000aa.json",
            raw_entry("1", r#"["\ud800"]"#),
            "manifest",
        ),
        (
            "configuration.json",
            r#"{"denyList":[],"x":1e999}"#.to_owned(),
            "configuration.json",
        ),
    ];

    for (file, content, named) in cases {
        let setup = Setup::fixture();
        push_to_store(&setup.copy, &json!({ file: content }));

        let output = setup.run("status", &[]);

        assert_eq!(output.status.code(), Some(1), "{content}");
        assert!(errors_of(&output).contains(named), "{content}");
    }
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_in_the_manifest_is_not_a_file_of_the_store() {
    let setup = Setup::fixture();
    fs::create_dir(setup.copy.join("manifest")).expect("the folder can be made");
    std::os::unix::fs::symlink(
        setup.vault.join("Welcome.md"),
        setup.copy.join("manifest").join("link.json"),
    )
    .expect("the link can be made");

    commit_all(&setup.copy);

    assert_eq!(setup.status()["counts"]["unchanged"], 0);
}

/// The manifest has one level: a folder below it is not read.
#[cfg(unix)]
#[test]
fn a_symbolic_link_to_a_folder_in_the_manifest_is_not_read() {
    let setup = Setup::fixture();
    let elsewhere = setup.stores.root().join("elsewhere");
    fs::create_dir(&elsewhere).expect("the folder can be made");
    fs::write(elsewhere.join("x.json"), "{}\n").expect("the file is written");
    fs::create_dir(setup.copy.join("manifest")).expect("the folder can be made");
    std::os::unix::fs::symlink(&elsewhere, setup.copy.join("manifest").join("sub"))
        .expect("the link can be made");

    commit_all(&setup.copy);

    assert_eq!(setup.status()["counts"]["unchanged"], 0);
}

/// A configuration that is a link could lead to nothing, and be read as no
/// configuration: the deny list would be empty.
#[cfg(unix)]
#[test]
fn a_configuration_that_is_a_symbolic_link_stops_the_status_also_when_it_leads_nowhere() {
    let setup = Setup::fixture();
    let file = setup.copy.join("configuration.json");
    let elsewhere = setup.stores.root().join("configuration.json");
    fs::copy(&file, &elsewhere).expect("the file can be copied");
    fs::remove_file(&file).expect("the file can be removed");
    std::os::unix::fs::symlink(&elsewhere, &file).expect("the link can be made");
    commit_all(&setup.copy);

    let output = setup.run("status", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("symbolic link"),
        "{}",
        errors_of(&output)
    );

    fs::remove_file(&elsewhere).expect("the file can be removed");

    let output = setup.run("status", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("symbolic link"),
        "{}",
        errors_of(&output)
    );
}

/// A valid entry of a note that is not published: only a check of the files
/// of the copy refuses it.
fn unpublished_entry(id: &str) -> String {
    format!(
        r#"{{"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":2,"firstPublished":"2031-04-01T08:00:00Z","formerPaths":[],"id":"{id}","lastPublished":"2031-04-01T08:00:00Z","links":[],"path":"Welcome.md","sourceHash":"sha256:00","state":"unpublished"}}
"#
    )
}

/// Git for Windows converts line ends by default (`core.autocrlf`). A file
/// that differs from the commit only in its line ends is the same file.
#[test]
fn a_copy_that_converts_line_ends_is_the_copy_of_its_last_commit() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE] }), TIME);
    setup.git(&["config", "core.autocrlf", "true"]);
    fs::remove_dir_all(setup.copy.join("manifest")).expect("the folder can be removed");
    fs::remove_file(setup.copy.join("configuration.json")).expect("the file can be removed");
    setup.git(&["checkout", "--", "configuration.json", "manifest"]);
    assert!(read(&setup.copy.join("configuration.json")).contains("\r\n"));
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    for file in [
        "configuration.json".to_owned(),
        format!("manifest/{NOTE_ID}.json"),
    ] {
        fs::File::options()
            .write(true)
            .open(setup.copy.join(file))
            .expect("the file opens")
            .set_modified(later)
            .expect("the time is set");
    }

    assert_eq!(paths(&setup.status()["unchanged"]), [NOTE]);
}

/// Another device published first into an empty content store: the
/// publication stops before its push, and the copy must then take the
/// publication of the other device with a plain pull.
#[test]
fn a_first_publication_after_another_device_stops_and_the_copy_can_pull() {
    let setup = copy_with_no_commit();
    let first = setup.stores.root().join("first");
    git(&[
        "clone",
        "--quiet",
        text(setup.stores.content_store()),
        text(&first),
    ]);
    for (key, value) in [
        ("user.name", "Other"),
        ("user.email", "other@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(&["-C", text(&first), "config", key, value]);
    }
    let first_device = Setup {
        stores: TestStores::new(),
        vault: setup.vault.clone(),
        copy: first,
    };
    let id = setup.plan_id(&json!({ "include": ["Welcome.md"] }));
    first_device.publish(&json!({ "include": ["Welcome.md"] }), TIME);

    let output = setup.publish_plan(&id, TIME);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("git pull --ff-only"),
        "{}",
        errors_of(&output)
    );
    setup.git(&["pull", "--quiet", "--ff-only", "origin", "main"]);
    assert_eq!(paths(&setup.status()["unchanged"]), ["Welcome.md"]);
}

/// One way to change the copy of a test.
type Change<'a> = Box<dyn Fn(&Setup) + 'a>;

/// Removes a deny list entry with the same size and the same time, in a copy
/// with weak stat settings.
fn edit_with_weak_stat_settings(setup: &Setup) {
    setup.git(&["config", "core.checkStat", "minimal"]);
    setup.git(&["config", "core.trustctime", "false"]);
    // An old time, and an index written after it: git then trusts
    // the stat data, and does not compare the text again.
    let file = setup.copy.join("configuration.json");
    let old = std::time::UNIX_EPOCH + std::time::Duration::from_hours(438_288);
    let set_old = || {
        fs::File::options()
            .write(true)
            .open(&file)
            .expect("the file opens")
            .set_modified(old)
            .expect("the time is set");
    };
    set_old();
    setup.git(&["update-index", "--refresh"]);
    let text = read(&file);
    let entry = ", \"90 Locked Shed\"";
    assert!(text.contains(entry));
    fs::write(&file, text.replace(entry, &" ".repeat(entry.len()))).expect("the file is written");
    set_old();
}

/// The changes of the copy that make it differ from its last commit.
fn changes_of_the_copy(entry: &str) -> Vec<(&'static str, Change<'_>)> {
    let first: Vec<(&'static str, Change<'_>)> = vec![
        (
            "an entry removed with git",
            Box::new(move |setup: &Setup| {
                setup.git(&["rm", "--quiet", entry]);
            }),
        ),
        (
            "an entry whose text says another state",
            Box::new(move |setup: &Setup| {
                let file = setup.copy.join(entry);
                fs::write(
                    &file,
                    read(&file).replace("\"published\"", "\"unpublished\""),
                )
                .expect("the file is written");
            }),
        ),
        (
            "a folder in the place of an entry",
            Box::new(move |setup: &Setup| {
                fs::remove_file(setup.copy.join(entry)).expect("the file can be removed");
                fs::create_dir(setup.copy.join(entry)).expect("the folder can be made");
            }),
        ),
        (
            "no index, and an entry removed",
            Box::new(move |setup: &Setup| {
                fs::remove_file(setup.copy.join(".git").join("index"))
                    .expect("the index can be removed");
                fs::remove_file(setup.copy.join(entry)).expect("the file can be removed");
            }),
        ),
        (
            "an entry that git assumes unchanged, and that is removed",
            Box::new(move |setup: &Setup| {
                setup.git(&["update-index", "--assume-unchanged", entry]);
                fs::remove_file(setup.copy.join(entry)).expect("the file can be removed");
            }),
        ),
        (
            "an entry that is not in the last commit",
            Box::new(move |setup: &Setup| {
                fs::write(
                    setup.copy.join("manifest").join("00000000000000aa.json"),
                    unpublished_entry("00000000000000aa"),
                )
                .expect("the file is written");
            }),
        ),
        (
            "an entry that git ignores",
            Box::new(move |setup: &Setup| {
                fs::write(
                    setup.copy.join(".git").join("info").join("exclude"),
                    "manifest/00000000000000ab.json\n",
                )
                .expect("the file is written");
                fs::write(
                    setup.copy.join("manifest").join("00000000000000ab.json"),
                    unpublished_entry("00000000000000ab"),
                )
                .expect("the file is written");
            }),
        ),
    ];
    first
        .into_iter()
        .chain(more_changes_of_the_copy())
        .collect()
}

/// The changes of the copy that do not need the path of an entry.
fn more_changes_of_the_copy() -> Vec<(&'static str, Change<'static>)> {
    vec![
        (
            "the configuration removed with git",
            Box::new(move |setup: &Setup| {
                setup.git(&["rm", "--quiet", "configuration.json"]);
            }),
        ),
        (
            "a deny list entry removed with the same size and the same time, in a copy with weak stat settings",
            Box::new(move |setup: &Setup| {
                edit_with_weak_stat_settings(setup);
            }),
        ),
        (
            "a branch that leads to no commit",
            Box::new(move |setup: &Setup| {
                fs::write(
                    setup
                        .copy
                        .join(".git")
                        .join("refs")
                        .join("heads")
                        .join("main"),
                    format!("{}\n", "1".repeat(40)),
                )
                .expect("the reference is written");
            }),
        ),
        (
            "a new branch with no commit and no files",
            Box::new(move |setup: &Setup| {
                setup.git(&["checkout", "--quiet", "--orphan", "fresh"]);
                setup.git(&["rm", "-r", "--quiet", "--cached", "."]);
                fs::remove_dir_all(setup.copy.join("manifest")).expect("the folder can be removed");
                fs::remove_dir_all(setup.copy.join("notes")).expect("the folder can be removed");
                fs::remove_file(setup.copy.join("configuration.json"))
                    .expect("the file can be removed");
            }),
        ),
    ]
}

/// The tool reads the state from the files of the copy. Every way that they
/// can differ from the last commit could hide a published note under a guard
/// or empty the deny list, so each one stops the run.
#[test]
fn a_copy_that_differs_from_its_last_commit_stops_the_status() {
    let entry = format!("manifest/{NOTE_ID}.json");
    let changes = changes_of_the_copy(&entry);
    for (name, change) in &changes {
        let setup = Setup::fixture();
        setup.publish(&json!({ "include": [NOTE] }), TIME);
        fs::write(setup.vault.join(NOTE), IGNORED).expect("the note is written");

        change(&setup);

        let output = setup.run("status", &[]);
        assert_eq!(output.status.code(), Some(1), "{name}");
    }
}

/// A change of the deny list is work of the author. The message must not
/// propose a command that throws it away.
#[test]
fn a_deny_list_that_is_changed_and_not_committed_stops_the_status_and_the_message_says_to_commit_it()
 {
    let setup = Setup::fixture();
    fs::write(
        setup.copy.join("configuration.json"),
        "{\"denyList\":[\"80 Templates\"]}\n",
    )
    .expect("the file is written");

    let output = setup.run("status", &[]);

    assert_eq!(output.status.code(), Some(1));
    let message = errors_of(&output);
    assert!(message.contains("commit configuration.json"), "{message}");
    assert!(!message.contains("checkout HEAD -- manifest"), "{message}");
}

/// A push of commits of the copy is safe only for a change of the
/// configuration alone. A commit of a publication that git could not take
/// back would publish an older state.
#[test]
fn the_message_proposes_a_push_only_for_commits_of_the_configuration_alone() {
    let setup = Setup::fixture();
    fs::write(
        setup.copy.join("configuration.json"),
        "{\"denyList\":[\"80 Templates\",\"90 Locked Shed\",\"10 Garden\"]}\n",
    )
    .expect("the file is written");
    setup.git(&[
        "commit",
        "--quiet",
        "--all",
        "--message",
        "A stricter deny list",
    ]);

    let output = setup.run("status", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("git push origin HEAD:main"),
        "{}",
        errors_of(&output)
    );

    fs::create_dir_all(setup.copy.join("notes")).expect("the folder can be made");
    fs::write(
        setup.copy.join("notes").join("Stuck.md"),
        "A publication that stayed\n",
    )
    .expect("the file is written");
    setup.git(&["add", "notes"]);
    setup.git(&[
        "commit",
        "--quiet",
        "--message",
        "A publication that stayed",
    ]);
    let output = setup.run("status", &[]);
    let message = errors_of(&output);

    assert_eq!(output.status.code(), Some(1));
    assert!(!message.contains("push it (git push"), "{message}");
    assert!(
        message.contains("git reset --hard origin/main"),
        "{message}"
    );
    assert!(message.contains("notes/Stuck.md"), "{message}");
}

/// The advice reads what a push would change in the content store, not the
/// names of the files in the commits: a commit that removes the configuration
/// would empty the deny list.
#[test]
fn the_message_never_proposes_to_push_a_commit_that_removes_the_configuration() {
    let setup = Setup::fixture();
    setup.git(&["rm", "--quiet", "configuration.json"]);
    setup.git(&["commit", "--quiet", "--message", "No deny list"]);

    let output = setup.run("status", &[]);
    let message = errors_of(&output);

    assert_eq!(output.status.code(), Some(1));
    assert!(!message.contains("push it (git push"), "{message}");
    assert!(message.contains("configuration.json"), "{message}");
}

/// A merge commit names no file in `git log`. A merge that keeps the files of
/// the copy takes back what another device published, for example the forced
/// removal of a note under a guard.
#[test]
fn the_message_never_proposes_to_push_a_merge_that_takes_back_a_change_of_another_device() {
    let setup = Setup::fixture();
    let other = setup.stores.root().join("other");
    git(&[
        "clone",
        "--quiet",
        text(setup.stores.content_store()),
        text(&other),
    ]);
    git(&["-C", text(&other), "config", "user.name", "Test"]);
    git(&[
        "-C",
        text(&other),
        "config",
        "user.email",
        "test@example.invalid",
    ]);
    git(&["-C", text(&other), "config", "commit.gpgsign", "false"]);
    push_to_store(&other, &json!({ "manifest/a.json": "{}\n" }));
    fs::write(
        setup.copy.join("configuration.json"),
        "{\"denyList\":[\"80 Templates\",\"90 Locked Shed\",\"10 Garden\"]}\n",
    )
    .expect("the file is written");
    setup.git(&[
        "commit",
        "--quiet",
        "--all",
        "--message",
        "A stricter deny list",
    ]);
    setup.git(&["fetch", "--quiet", "origin"]);
    setup.git(&[
        "merge",
        "--quiet",
        "--strategy=ours",
        "--message",
        "Keep the copy",
        "origin/main",
    ]);

    let output = setup.run("status", &[]);
    let message = errors_of(&output);

    assert_eq!(output.status.code(), Some(1));
    assert!(!message.contains("push it (git push"), "{message}");
    assert!(message.contains("manifest/a.json"), "{message}");
}

/// A configuration committed with Windows line ends is the file of its last
/// commit, also in a copy that converts line ends.
#[test]
fn a_configuration_committed_with_windows_line_ends_is_the_file_of_the_commit() {
    let setup = Setup::fixture();
    let file = setup.copy.join("configuration.json");
    // Git for Windows converts line ends by default: the commit must keep them.
    setup.git(&["config", "core.autocrlf", "false"]);
    fs::write(&file, read(&file).replace('\n', "\r\n")).expect("the file is written");
    setup.git(&[
        "commit",
        "--quiet",
        "--all",
        "--message",
        "Windows line ends",
    ]);
    setup.git(&["push", "--quiet", "origin", "HEAD:main"]);
    setup.git(&["config", "core.autocrlf", "true"]);

    let output = setup.run("status", &[]);

    assert!(output.status.success(), "{}", errors_of(&output));
}

/// A filter of git attributes makes git compare the copy with what the filter
/// gives, not with the bytes that the tool reads. Here git sees the committed
/// deny list, and the tool would read a deny list with one folder less.
#[cfg(unix)]
#[test]
fn a_configuration_that_a_git_filter_makes_look_committed_stops_the_status() {
    let setup = Setup::fixture();
    let file = setup.copy.join("configuration.json");
    let committed = read(&file);
    let entry = ",\"90 Locked Shed\"";
    let entry = if committed.contains(entry) {
        entry
    } else {
        ", \"90 Locked Shed\""
    };
    assert!(committed.contains(entry), "{committed}");
    setup.git(&[
        "config",
        "filter.back.clean",
        &format!(
            "sed 's/\"80 Templates\"]/\"80 Templates\"{}]/'",
            entry.replace('"', "\\\"")
        ),
    ]);
    fs::write(
        setup.copy.join(".git").join("info").join("attributes"),
        "configuration.json filter=back\n",
    )
    .expect("the attributes are written");
    fs::write(&file, committed.replace(entry, "")).expect("the file is written");
    setup.git(&["add", "configuration.json"]);
    assert_eq!(setup.git(&["status", "--porcelain"]), "");

    let output = setup.run("status", &[]);

    assert_eq!(output.status.code(), Some(1), "{}", errors_of(&output));
    assert!(
        errors_of(&output).contains("configuration.json"),
        "{}",
        errors_of(&output)
    );
}

#[test]
fn the_message_never_proposes_to_commit_the_removal_of_the_configuration() {
    let setup = Setup::fixture();
    fs::remove_file(setup.copy.join("configuration.json")).expect("the file can be removed");

    let output = setup.run("status", &[]);
    let message = errors_of(&output);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        message.contains("git checkout HEAD -- configuration.json"),
        "{message}"
    );
    assert!(!message.contains("commit configuration.json"), "{message}");
}

/// An empty manifest would let a published note under a guard stay live.
#[test]
fn a_manifest_that_cannot_be_listed_stops_the_status() {
    let setup = Setup::fixture();
    fs::write(
        setup.copy.join("manifest"),
        "A file in the place of the folder\n",
    )
    .expect("the file is written");

    let output = setup.run("status", &[]);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("manifest"),
        "{}",
        errors_of(&output)
    );
}

#[cfg(unix)]
#[test]
fn a_manifest_folder_that_is_a_symbolic_link_stops_the_status() {
    let setup = Setup::fixture();
    let elsewhere = setup.stores.root().join("elsewhere");
    fs::create_dir(&elsewhere).expect("the folder can be made");
    fs::write(elsewhere.join("x.json"), "{}\n").expect("the file is written");
    std::os::unix::fs::symlink(&elsewhere, setup.copy.join("manifest"))
        .expect("the link can be made");
    commit_all(&setup.copy);

    let output = setup.run("status", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("symbolic link"),
        "{}",
        errors_of(&output)
    );
}

/// The paths go to git on standard input. A file for them was relative to
/// the folder of the process, but git runs inside the copy.
#[test]
fn a_copy_of_the_content_store_in_a_relative_folder_takes_new_notes_and_updates() {
    let setup = Setup::fixture();
    let root = setup.stores.root();
    let copy = setup
        .copy
        .strip_prefix(root)
        .expect("the copy is in the folder of the test");
    let run = |arguments: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
            .args(arguments)
            .arg("--vault")
            .arg(&setup.vault)
            .arg("--content-store")
            .arg(copy)
            .current_dir(root)
            .output()
            .expect("the program starts")
    };
    let publish = |include: &str, time: &str| {
        let output = run(&["plan", &format!("--include={include}")]);
        assert!(output.status.success(), "{}", errors_of(&output));
        let id = json_of(&output)["id"].as_str().expect("an id").to_owned();
        let output = run(&[
            "publish",
            "--plan",
            &id,
            "--time",
            time,
            "--device",
            "garden-shed",
        ]);
        assert!(output.status.success(), "{}", errors_of(&output));
        json_of(&output)
    };
    publish(NOTE, TIME);
    publish("Welcome.md", TIME);
    append(&setup.vault.join("Welcome.md"), EDIT);

    let report = publish(SECOND, LATER);

    assert_eq!(paths(&report["published"]), [SECOND]);
    assert_eq!(paths(&report["updated"]), ["Welcome.md"]);
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
    assert_eq!(
        paths(&setup.status()["unchanged"]),
        [SECOND, NOTE, "Welcome.md"]
    );
}

/// A publication whose paths are more than the system takes as arguments of
/// one command (about 2 MB on Linux): the paths go to git on standard input,
/// and the selection comes from a file.
#[cfg(unix)]
#[test]
fn a_publication_larger_than_the_limit_of_the_system_for_arguments_is_possible() {
    let setup = Setup::scenario(&json!({ "vault": {}, "denyList": [] }));
    let long = "x".repeat(230);
    // 100 notes per folder: the scan lists the folder of each note it reads.
    let notes: Vec<String> = (0..8_000)
        .map(|index| format!("Big {:02}/{index:04} {long}.md", index / 100))
        .collect();
    for folder in 0..80 {
        fs::create_dir(setup.vault.join(format!("Big {folder:02}")))
            .expect("the folder can be made");
    }
    for note in &notes {
        fs::write(setup.vault.join(note), "Text\n").expect("the note is written");
    }
    let bytes: usize = notes.iter().map(|note| note.len() * 2).sum();
    assert!(bytes > 2 * 1024 * 1024, "{bytes}");
    let file = setup.stores.root().join("selection.json");
    fs::write(&file, json!({ "include": notes }).to_string()).expect("the file is written");
    let output = setup.run("plan", &["--selection", text(&file)]);
    assert!(output.status.success(), "{}", errors_of(&output));
    let id = json_of(&output)["id"].as_str().expect("an id").to_owned();

    let output = setup.publish_plan(&id, TIME);

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(
        json_of(&output)["published"].as_array().map(Vec::len),
        Some(8_000)
    );
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
}

/// The scan lists each folder of the vault one time per run (issue 69). When it
/// listed the folder of each note again, `status` on 6,000 notes in one folder
/// took about 7 s with the debug build. It now takes far less than the budget,
/// which leaves room for a slow runner.
#[test]
fn the_time_of_a_scan_grows_with_the_number_of_notes_in_a_folder_not_with_its_square() {
    let setup = Setup::scenario(&json!({ "vault": {}, "denyList": [] }));
    fs::create_dir(setup.vault.join("Big")).expect("the folder can be made");
    for index in 0..6_000 {
        fs::write(setup.vault.join(format!("Big/{index:04}.md")), "Text\n")
            .expect("the note is written");
    }

    let start = std::time::Instant::now();
    let queue = setup.status();
    let time = start.elapsed();

    assert_eq!(queue["counts"]["new"], 6_000);
    assert!(time.as_secs_f64() < 3.0, "{time:?}");
}

/// Two publications on one copy must not share a file of paths.
#[test]
fn a_publication_needs_no_file_of_paths_in_the_git_folder() {
    let setup = Setup::fixture();
    fs::create_dir_all(setup.copy.join(".git").join("vault-publish").join("paths"))
        .expect("the folder can be made");

    let report = setup.publish(&json!({ "include": [NOTE] }), TIME);

    assert_eq!(paths(&report["published"]), [NOTE]);
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
}

/// A hook of the copy that refuses every commit.
fn refuse_commits(copy: &Path) {
    let hooks = copy.join(".git").join("hooks");
    fs::create_dir_all(&hooks).expect("the folder can be made");
    let hook = hooks.join("pre-commit");
    fs::write(&hook, "#!/bin/sh\nexit 1\n").expect("the hook is written");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("the hook can run");
    }
}

/// Files that stay in the copy would be read as published at the next run.
#[test]
fn a_commit_that_fails_leaves_nothing_in_the_copy() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": ["Welcome.md"] }), TIME);
    append(&setup.vault.join("Welcome.md"), EDIT);
    refuse_commits(&setup.copy);
    let before = (picture(&setup.vault), setup.git(&["ls-files", "--stage"]));
    let id = setup.plan_id(&json!({ "include": [NOTE] }));

    let output = setup.publish_plan(&id, LATER);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("commit"));
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
    assert_eq!(setup.git(&["ls-files", "--stage"]), before.1);
    assert!(!setup.copy.join("notes").join(NOTE).exists());
    assert!(!read(&setup.copy.join("notes").join("Welcome.md")).contains("A second paragraph."));
    assert_eq!(picture(&setup.vault), before.0);
    let queue = setup.status();
    assert!(paths(&queue["new"]).contains(&NOTE.to_owned()));
    assert_eq!(paths(&queue["changed"]), ["Welcome.md"]);
    assert_eq!(paths(&queue["unchanged"]), Vec::<String>::new());
}

/// Every file of the copy but its git folder, with its bytes.
fn files_of(copy: &Path) -> Vec<(String, Vec<u8>)> {
    picture(copy)
        .into_iter()
        .filter(|(path, _)| !path.starts_with(".git/"))
        .collect()
}

/// A step of the undo that fails must not stop the later steps. Here git
/// cannot write its index, so neither the commit nor its undo can use it.
#[test]
fn a_commit_that_fails_puts_every_file_back_when_git_cannot_write_its_index() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": ["Welcome.md"] }), TIME);
    append(&setup.vault.join("Welcome.md"), EDIT);
    let id = setup.plan_id(&json!({ "include": [NOTE] }));
    let lock = setup.copy.join(".git").join("index.lock");
    fs::write(&lock, "").expect("the lock is written");
    let before = files_of(&setup.copy);

    let output = setup.publish_plan(&id, LATER);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("commit"),
        "{}",
        errors_of(&output)
    );
    assert_eq!(files_of(&setup.copy), before);
    fs::remove_file(&lock).expect("the lock can be removed");
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
    let queue = setup.status();
    assert!(paths(&queue["new"]).contains(&NOTE.to_owned()));
    assert_eq!(paths(&queue["changed"]), ["Welcome.md"]);
}

/// With no commit, a file of the copy is not new for the publication only
/// because no commit holds it. A copy whose manifest or configuration is in
/// no commit stops before (see `a_copy_that_differs_from_its_last_commit_*`),
/// so here it is a cleaned note that waits in the copy.
#[test]
fn a_commit_that_fails_keeps_the_files_that_a_copy_with_no_commit_held_before() {
    let setup = copy_with_no_commit();
    fs::create_dir(setup.copy.join("notes")).expect("the folder can be made");
    fs::write(
        setup.copy.join("notes").join("Welcome.md"),
        "A text that was here before\n",
    )
    .expect("the file is written");
    refuse_commits(&setup.copy);
    let before = files_of(&setup.copy);
    let id = setup.plan_id(&json!({ "include": ["Welcome.md"] }));

    let output = setup.publish_plan(&id, TIME);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("commit"));
    assert_eq!(files_of(&setup.copy), before);
}

/// The undo takes back the paths of the publication only.
#[test]
fn a_commit_that_fails_keeps_the_other_staged_work_of_the_copy() {
    let setup = Setup::fixture();
    let readme = setup.copy.join("README.md");
    fs::write(&readme, "Staged\n").expect("the file is written");
    setup.git(&["add", "README.md"]);
    fs::write(&readme, "Staged, then edited\n").expect("the file is written");
    refuse_commits(&setup.copy);
    let id = setup.plan_id(&json!({ "include": [NOTE] }));

    let output = setup.publish_plan(&id, TIME);

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(setup.git(&["status", "--porcelain"]), "AM README.md");
    assert_eq!(setup.git(&["show", ":README.md"]), "Staged");
}

#[test]
fn a_refused_push_keeps_the_other_staged_work_of_the_copy() {
    let setup = Setup::fixture();
    let id = setup.plan_id(&json!({ "include": [NOTE] }));
    setup.stores.refuse_pushes();
    fs::write(setup.copy.join("README.md"), "Staged\n").expect("the file is written");
    setup.git(&["add", "README.md"]);
    let head = setup.git(&["rev-parse", "HEAD"]);

    let output = setup.publish_plan(&id, TIME);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("refused"));
    assert_eq!(setup.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(setup.git(&["status", "--porcelain"]), "A  README.md");
    assert!(!setup.copy.join("notes").join(NOTE).exists());
}

/// A push that fails, and an undo whose first step fails: git cannot move
/// the branch back (a hook stands for a lock of the reference). The second
/// step still runs, and the commit that stayed stops the next run: it would
/// else be pushed later, also for a note that came under a guard.
#[cfg(unix)]
#[test]
fn a_commit_that_git_cannot_take_back_stops_the_next_run() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": ["Welcome.md"] }), TIME);
    let before = setup.git(&["rev-parse", "HEAD"]);
    refuse_moves_after_a_commit(&setup.copy);
    let hooks = setup.copy.join(".git").join("hooks");
    let nowhere = setup.stores.root().join("nowhere");
    setup.git(&["remote", "set-url", "--push", "origin", text(&nowhere)]);
    let id = setup.plan_id(&json!({ "include": [NOTE] }));

    let output = setup.publish_plan(&id, LATER);

    assert_eq!(output.status.code(), Some(1));
    let message = errors_of(&output);
    assert!(message.contains("refused"), "{message}");
    assert!(
        message.contains("could not take the publication back"),
        "{message}"
    );
    assert_ne!(setup.git(&["rev-parse", "HEAD"]), before);
    // The second step ran: the index holds the files of before.
    assert_eq!(setup.git(&["diff", "--cached", "--name-only", &before]), "");
    assert!(!setup.copy.join("notes").join(NOTE).exists());
    fs::remove_file(hooks.join("reference-transaction")).expect("the hook can be removed");
    for command in ["status", "plan"] {
        let output = setup.run(command, &[]);
        assert_eq!(output.status.code(), Some(1), "{command}");
        assert!(errors_of(&output).contains("does not have"), "{command}");
    }
}

/// The hooks that make git refuse to move a branch after the first commit:
/// they stand for a lock of the reference.
#[cfg(unix)]
fn refuse_moves_after_a_commit(copy: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let hooks = copy.join(".git").join("hooks");
    fs::create_dir_all(&hooks).expect("the folder can be made");
    for (name, script) in [
        ("post-commit", "#!/bin/sh\ntouch .git/committed\n"),
        (
            "reference-transaction",
            "#!/bin/sh\nif [ \"$1\" = prepared ] && [ -f .git/committed ]; then exit 1; fi\nexit 0\n",
        ),
    ] {
        fs::write(hooks.join(name), script).expect("the hook is written");
        fs::set_permissions(hooks.join(name), fs::Permissions::from_mode(0o755))
            .expect("the hook can run");
    }
}

/// The same on a first publication: git cannot remove the branch that the
/// failed publication made, and the content store has no branch yet.
#[cfg(unix)]
#[test]
fn a_first_commit_that_git_cannot_take_back_stops_the_next_run() {
    let setup = copy_with_no_commit();
    refuse_moves_after_a_commit(&setup.copy);
    let nowhere = setup.stores.root().join("nowhere");
    setup.git(&["remote", "set-url", "--push", "origin", text(&nowhere)]);
    let id = setup.plan_id(&json!({ "include": ["Welcome.md"] }));

    let output = setup.publish_plan(&id, TIME);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("refused"),
        "{}",
        errors_of(&output)
    );
    fs::remove_file(
        setup
            .copy
            .join(".git")
            .join("hooks")
            .join("reference-transaction"),
    )
    .expect("the hook can be removed");
    let output = setup.run("status", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("does not have"),
        "{}",
        errors_of(&output)
    );
}

/// A commit of the copy that the content store has on another branch is not
/// ahead of the content store.
#[test]
fn a_copy_whose_commits_the_content_store_has_on_another_branch_can_publish() {
    let setup = Setup::fixture();
    push_to_store(
        &setup.copy,
        &json!({ "README.md": "A file of another branch\n" }),
    );
    fs::write(setup.copy.join("README.md"), "A newer text\n").expect("the file is written");
    setup.git(&[
        "commit",
        "--quiet",
        "--all",
        "--message",
        "On another branch",
    ]);
    setup.git(&["push", "--quiet", "origin", "HEAD:other"]);

    assert!(paths(&setup.status()["new"]).contains(&NOTE.to_owned()));
}

/// A manifest that is missing from the copy would let a published note under
/// a guard stay live: also a file that git skips, which git status does not
/// show, and a configuration that is missing.
#[test]
fn a_file_of_the_manifest_or_the_configuration_that_is_missing_from_the_copy_stops_the_status() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE] }), TIME);
    let entry = format!("manifest/{NOTE_ID}.json");
    setup.git(&["update-index", "--skip-worktree", &entry]);
    fs::remove_dir_all(setup.copy.join("manifest")).expect("the folder can be removed");
    assert_eq!(setup.git(&["status", "--porcelain"]), "");

    let output = setup.run("status", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("last commit"),
        "{}",
        errors_of(&output)
    );

    setup.git(&["update-index", "--no-skip-worktree", &entry]);
    setup.git(&["checkout", "--", "manifest"]);
    fs::remove_file(setup.copy.join("configuration.json")).expect("the file can be removed");

    let output = setup.run("status", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("last commit"),
        "{}",
        errors_of(&output)
    );
}

/// A clone of a content store that has no commit and no configuration.
fn copy_with_no_commit() -> Setup {
    let stores = TestStores::new();
    let vault = stores.copy_fixture_vault();
    let copy = stores.root().join("copy");
    git(&[
        "clone",
        "--quiet",
        text(stores.content_store()),
        text(&copy),
    ]);
    for (key, value) in [
        ("user.name", "Test"),
        ("user.email", "test@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(&["-C", text(&copy), "config", key, value]);
    }
    Setup {
        stores,
        vault,
        copy,
    }
}

#[test]
fn a_commit_that_fails_leaves_nothing_in_a_copy_that_has_no_commit() {
    let setup = copy_with_no_commit();
    refuse_commits(&setup.copy);
    let id = setup.plan_id(&json!({ "include": ["Welcome.md"] }));

    let output = setup.publish_plan(&id, TIME);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("commit"));
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
    assert_eq!(paths(&setup.status()["unchanged"]), Vec::<String>::new());
}

#[test]
fn a_copy_that_has_no_commit_takes_its_first_publication() {
    let setup = copy_with_no_commit();

    let report = setup.publish(&json!({ "include": ["Welcome.md"] }), TIME);

    assert_eq!(paths(&report["published"]), ["Welcome.md"]);
    assert_eq!(
        git(&[
            "--git-dir",
            text(setup.stores.content_store()),
            "rev-list",
            "--count",
            "main"
        ]),
        "1"
    );
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
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
        "Publish: 1 new, 1 updated, 1 removed, 0 forced, 1 skipped\n\nDevice: garden-shed\nFace: command-line"
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

/// One line with something to read: the old rules of the two implementations
/// differed on these names, and both take them now.
#[test]
fn a_device_name_of_one_character_that_is_not_a_space_is_taken() {
    for name in ["\u{feff}", "\u{a0}"] {
        let setup = Setup::fixture();
        let id = setup.plan_id(&json!({ "include": [NOTE] }));

        let output = setup.run(
            "publish",
            &["--plan", &id, "--time", TIME, "--device", name],
        );

        assert!(output.status.success(), "{name:?}: {}", errors_of(&output));
        assert!(
            setup
                .git(&["log", "-1", "--format=%B"])
                .contains(&format!("\nDevice: {name}\n")),
            "{name:?}"
        );
    }
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
    // Another device pushes between the fetch and the push of this one.
    setup.stores.refuse_pushes();
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

/// The names of the files of the manifest of the copy, sorted.
fn manifest_files(copy: &Path) -> Vec<String> {
    let mut files: Vec<String> = fs::read_dir(copy.join("manifest"))
        .expect("the manifest can be read")
        .map(|entry| {
            entry
                .expect("the entry can be read")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    files.sort();
    files
}

/// The manifest entry of a note in the copy of the content store, as data.
fn entry_of(copy: &Path, path: &str) -> Value {
    for file in manifest_files(copy) {
        let entry: Value = serde_json::from_str(&read(&copy.join("manifest").join(file)))
            .expect("the entry is JSON");
        if entry["path"] == path {
            return entry;
        }
    }
    panic!("the manifest has no entry for \"{path}\"");
}

/// The files of the last commit of the copy that hold a text, below the given
/// paths of the store. The empty text when no file holds it.
fn committed_files_with(setup: &Setup, needle: &str, below: &[&str]) -> String {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&setup.copy)
        .args(["grep", "-l", needle, "HEAD"])
        .args(below);
    // Inside a git hook, these variables point git to another repository.
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            command.env_remove(name);
        }
    }
    let output = command.output().expect("git starts");
    // Git ends with 1 when no file holds the text. Every other end is an error.
    assert!(
        matches!(output.status.code(), Some(0 | 1)),
        "git grep failed: {}",
        errors_of(&output)
    );
    String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned()
}

const DRIP: &str = "10 Garden/Drip irrigation.md";
const BARREL: &str = "10 Garden/Rain barrel.md";

/// TEST-18, on the side of the tool: a wikilink, a link with a link text, a
/// link to a heading, an embed, a link with the full path, a Markdown link and
/// a link in a property lead to the same note. A name that no note has gives
/// no item.
#[test]
fn a_note_with_a_link_of_each_form_names_the_target_of_each_link_path() {
    let setup = Setup::fixture();

    setup.publish(&json!({ "include": [DRIP] }), TIME);

    assert_eq!(
        entry_of(&setup.copy, DRIP)["links"],
        json!([
            { "link": "10 Garden/Rain barrel", "path": BARREL },
            { "link": "Rain barrel", "path": BARREL },
            { "link": "Rain barrel.md", "path": BARREL }
        ])
    );
    // The text is published as the author wrote it.
    let cleaned = read(&setup.copy.join("notes").join(DRIP));
    assert!(cleaned.contains("[[Rain barrel|the barrel]] or the [[Water butt]]"));
    assert!(cleaned.contains("[the barrel](Rain%20barrel.md)"));
    assert!(cleaned.contains("source: \"[[Rain barrel]]\""));
}

#[test]
fn a_link_to_a_note_in_a_folder_of_the_deny_list_gives_no_item() {
    let setup = Setup::fixture();
    let note = "10 Garden/Watering schedule.md";

    setup.publish(&json!({ "include": [note] }), TIME);

    assert_eq!(entry_of(&setup.copy, note)["links"], json!([]));
    assert_eq!(
        committed_files_with(&setup, "90 Locked Shed", &["--", "manifest"]),
        ""
    );
}

#[test]
fn a_name_that_two_notes_have_leads_to_the_note_below_the_folder_of_the_link() {
    let setup = Setup::fixture();
    let note = "10 Garden/Herb bed/Thyme.md";

    setup.publish(&json!({ "include": [note] }), TIME);

    assert_eq!(
        entry_of(&setup.copy, note)["links"],
        json!([
            {
                "link": "20 Library/20.02 Recipes/Mint",
                "path": "20 Library/20.02 Recipes/Mint.md"
            },
            { "link": "Mint", "path": "10 Garden/Herb bed/Mint.md" }
        ])
    );
}

/// BUILD-05: the entry of the note that links does not depend on the state of
/// the target.
#[test]
fn the_publication_of_a_target_changes_nothing_in_the_note_that_links_to_it() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [DRIP] }), TIME);
    let before = entry_of(&setup.copy, DRIP);

    setup.publish(&json!({ "include": [BARREL] }), LATER);

    assert_eq!(entry_of(&setup.copy, DRIP), before);
    assert_eq!(paths(&setup.status()["unchanged"]), [DRIP, BARREL]);
}

#[test]
fn a_published_note_that_comes_under_a_guard_after_the_plan_makes_the_plan_stale() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE, SECOND] }), TIME);
    let id = setup.plan_id(&json!({ "include": ["Welcome.md"] }));
    fs::write(
        setup.vault.join(SECOND),
        "---\npublish_ignore: true\n---\nText\n",
    )
    .expect("the file is written");

    let output = setup.publish_plan(&id, TIME);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("stale"));
    assert!(!setup.copy.join("notes").join("Welcome.md").exists());
}

#[test]
fn a_link_of_a_note_of_the_plan_that_leads_to_another_note_makes_the_plan_stale() {
    let setup = Setup::fixture();
    // The note links to "Water butt", which no note has.
    let id = setup.plan_id(&json!({ "include": [DRIP] }));
    fs::write(
        setup.vault.join("10 Garden/Water butt.md"),
        "Another name\n",
    )
    .expect("the file is written");

    let output = setup.publish_plan(&id, TIME);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("stale"));
}

/// A note with the ignore property: a guard excludes it.
const IGNORED: &str = "---\npublish_ignore: true\n---\nA text that must never go out\n";

/// TEST-13, PUB-29: a forced removal goes with a publication, whatever is
/// selected, and the commit says it.
#[test]
fn a_forced_removal_goes_with_a_publication_of_another_note_and_the_commit_counts_it() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE, SECOND] }), TIME);
    fs::write(setup.vault.join(SECOND), IGNORED).expect("the file is written");

    let report = setup.publish(&json!({ "include": ["Welcome.md"] }), LATER);

    assert_eq!(paths(&report["forcedRemoved"]), [SECOND]);
    assert_eq!(paths(&report["removed"]), Vec::<String>::new());
    assert_eq!(paths(&report["published"]), ["Welcome.md"]);
    assert_eq!(
        setup.git(&["log", "-1", "--format=%s"]),
        "Publish: 1 new, 0 updated, 0 removed, 1 forced, 0 skipped"
    );
    assert!(!setup.copy.join("notes").join(SECOND).exists());
    assert!(
        !setup
            .copy
            .join("manifest")
            .join(format!("{SECOND_ID}.json"))
            .exists()
    );
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
    // The text under the guard is nowhere in the last commit.
    assert_eq!(committed_files_with(&setup, "must never go out", &[]), "");
    // The write into the note under the guard changed nothing: it had no
    // state property.
    assert_eq!(read(&setup.vault.join(SECOND)), IGNORED);
}

/// Story 80: a move into a private folder is enough. The tool does not scan a
/// folder of the deny list, so it knows the move by the name of the note.
#[test]
fn a_forced_removal_takes_a_published_note_that_was_moved_into_a_folder_of_the_deny_list() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE, SECOND] }), TIME);
    let locked = setup.vault.join("90 Locked Shed");
    let moved = locked.join("Attachments").join("Compost basics.md");
    fs::rename(setup.vault.join(SECOND), &moved).expect("the note can be moved");
    // A file that cannot be read as text: the tool lists the folder and reads
    // no file of it.
    fs::write(locked.join("Not a text.md"), [0xff, 0xfe, 0xfd]).expect("the file is written");
    let before = picture(&locked);

    let planned = setup.plan(&json!({ "include": [] }));
    assert!(planned.status.success(), "{}", errors_of(&planned));
    let planned = json_of(&planned);
    let report = setup.publish(&json!({ "include": [] }), LATER);

    assert_eq!(
        planned["plan"],
        json!({ "forcedRemove": [SECOND], "publish": [], "remove": [], "update": [] })
    );
    assert_eq!(paths(&report["forcedRemoved"]), [SECOND]);
    assert!(!setup.copy.join("notes").join(SECOND).exists());
    assert_eq!(manifest_files(&setup.copy), [format!("{NOTE_ID}.json")]);
    // No file of the folder of the deny list is written: the note keeps its
    // state property there.
    assert_eq!(picture(&locked), before);
    assert!(read(&moved).contains("public_note: true"));
}

/// PUB-95: a file that is missing on this device is never removed without a
/// selection.
#[test]
fn a_forced_removal_does_not_take_a_published_note_whose_file_is_only_missing() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE, SECOND] }), TIME);
    fs::remove_file(setup.vault.join(SECOND)).expect("the note can be removed");

    let planned = setup.plan(&json!({ "include": [] }));
    assert!(planned.status.success(), "{}", errors_of(&planned));
    let held = setup.plan(&json!({ "include": [], "hold": [SECOND] }));
    assert!(held.status.success(), "{}", errors_of(&held));

    assert_eq!(
        json_of(&planned)["plan"],
        json!({ "forcedRemove": [], "publish": [], "remove": [], "update": [] })
    );
    assert_eq!(
        paths(&json_of(&held)["plan"]["forcedRemove"]),
        Vec::<String>::new()
    );
}

/// PUB-21: if a forced removal fails, the whole publication stops. Here a
/// folder is in the place of the cleaned note of the second removal: that
/// fails on every system, with no change of a permission.
#[test]
fn a_forced_removal_that_fails_stops_the_whole_publication_and_every_file_is_put_back() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE, SECOND] }), TIME);
    fs::write(setup.vault.join(NOTE), IGNORED).expect("the file is written");
    fs::write(setup.vault.join(SECOND), IGNORED).expect("the file is written");
    let blocked = setup.copy.join("notes").join(NOTE);
    fs::remove_file(&blocked).expect("the cleaned note can be removed");
    fs::create_dir(&blocked).expect("the folder can be made");
    fs::write(
        blocked.join("in the way"),
        "A file in a folder that stands for the note\n",
    )
    .expect("the file is written");
    let planned = setup.plan(&json!({ "include": ["Welcome.md"] }));
    assert!(planned.status.success(), "{}", errors_of(&planned));
    let planned = json_of(&planned);
    assert_eq!(paths(&planned["plan"]["forcedRemove"]), [SECOND, NOTE]);
    let id = planned["id"].as_str().expect("the plan has an id");
    let before = (
        picture(&setup.vault),
        setup.git(&["rev-parse", "HEAD"]),
        manifest_files(&setup.copy),
    );

    let output = setup.publish_plan(id, LATER);

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    let message = errors_of(&output);
    assert!(message.contains(NOTE), "{message}");
    assert!(message.contains("guard"), "{message}");
    assert!(message.contains("Nothing is published"), "{message}");
    assert_eq!(setup.git(&["rev-parse", "HEAD"]), before.1);
    assert_eq!(
        git(&[
            "--git-dir",
            text(setup.stores.content_store()),
            "rev-parse",
            "main"
        ]),
        before.1
    );
    // The first removal was put back, and no other note was published.
    assert!(setup.copy.join("notes").join(SECOND).exists());
    assert_eq!(manifest_files(&setup.copy), before.2);
    assert_eq!(setup.git(&["status", "--porcelain", "--", "manifest"]), "");
    assert!(!setup.copy.join("notes").join("Welcome.md").exists());
    // Without a push, no property is corrected.
    assert_eq!(picture(&setup.vault), before.0);
    // Both notes still wait for their removal.
    assert_eq!(paths(&setup.status()["toRemove"]), [SECOND, NOTE]);
}

/// Another device of the same author: a clone of the content store of the
/// setup, with the same vault.
fn other_device(setup: &Setup, name: &str) -> Setup {
    let copy = setup.stores.root().join(name);
    git(&[
        "clone",
        "--quiet",
        text(setup.stores.content_store()),
        text(&copy),
    ]);
    for (key, value) in [
        ("user.name", "Other"),
        ("user.email", "other@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(&["-C", text(&copy), "config", key, value]);
    }
    Setup {
        stores: TestStores::new(),
        vault: setup.vault.clone(),
        copy,
    }
}

/// Each device has its own copy of the content store (issue 70). A copy that
/// did not pull reads an older manifest: a note that came under a guard since
/// would stay live. So `plan` and `publish` fetch first and stop when the copy
/// is behind, and `status` stays offline and says how far behind the last
/// fetch is.
#[test]
fn a_copy_that_is_behind_stops_plan_and_publish_until_the_pull() {
    let second = copy_with_no_commit();
    let first = other_device(&second, "first");
    let waiting = second.plan_id(&json!({ "include": ["Welcome.md"] }));
    first.publish(&json!({ "include": [NOTE] }), TIME);
    fs::write(
        second.vault.join(NOTE),
        "---\npublish_ignore: true\n---\nA text that must never go out\n",
    )
    .expect("the note is written");

    // Offline: the second copy knows nothing of the publication yet.
    assert_eq!(second.status()["behind"], 0);
    let output = second.plan(&json!({ "include": ["Welcome.md"] }));
    assert_eq!(output.status.code(), Some(1));
    let message = errors_of(&output);
    assert!(message.contains("behind"), "{message}");
    assert!(message.contains("git pull --ff-only"), "{message}");
    let output = second.publish_plan(&waiting, TIME);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("git pull --ff-only"),
        "{}",
        errors_of(&output)
    );
    // The fetch of the plan is the last fetch now.
    assert_eq!(second.status()["behind"], 1);

    second.git(&["pull", "--quiet", "--ff-only", "origin", "main"]);

    assert_eq!(second.status()["behind"], 0);
    let output = second.plan(&json!({}));
    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(paths(&json_of(&output)["plan"]["forcedRemove"]), [NOTE]);
}

#[test]
fn a_copy_that_never_fetched_stops_plan_until_the_pull() {
    let setup = copy_with_no_commit();
    setup.publish(&json!({ "include": [NOTE] }), TIME);
    let fresh = setup.stores.root().join("fresh");
    fs::create_dir(&fresh).expect("the folder can be made");
    git(&[
        "-C",
        text(&fresh),
        "init",
        "--quiet",
        "--initial-branch=main",
    ]);
    git(&[
        "-C",
        text(&fresh),
        "remote",
        "add",
        "origin",
        text(setup.stores.content_store()),
    ]);
    let device = Setup {
        stores: TestStores::new(),
        vault: setup.vault.clone(),
        copy: fresh,
    };

    let output = device.plan(&json!({ "include": ["Welcome.md"] }));

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("git pull --ff-only origin main"),
        "{}",
        errors_of(&output)
    );
    device.git(&["pull", "--quiet", "--ff-only", "origin", "main"]);
    assert_eq!(paths(&device.status()["unchanged"]), [NOTE]);
}

#[test]
fn status_needs_no_network_and_plan_stops_when_the_content_store_cannot_be_reached() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE] }), TIME);
    let store = setup.stores.content_store().to_path_buf();
    let away = store.with_extension("away");
    fs::rename(&store, &away).expect("the store can be moved");

    let queue = setup.status();
    let output = setup.plan(&json!({ "include": [SECOND] }));
    fs::rename(&away, &store).expect("the store can be moved back");

    assert_eq!(paths(&queue["unchanged"]), [NOTE]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("cannot be reached"),
        "{}",
        errors_of(&output)
    );
}
