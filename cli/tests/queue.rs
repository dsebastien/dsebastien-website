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
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

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
    /// The file of the answers of the Starter Kit of a scenario, which a
    /// step can change or remove. Without one, no note has a type.
    answers: Option<PathBuf>,
    /// The file of the answers of the main site of a scenario (PUB-100),
    /// which a step can change. Without one, no post is checked.
    main_site: Option<PathBuf>,
}

fn errors_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn json_of(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("the output is JSON")
}

/// The bytes of a file of a scenario: a text, or `{"bytes": ...}` with its
/// bytes in hexadecimal. A `{"sparse": ...}` file is made by `write_files`.
fn bytes_of(content: &Value) -> Vec<u8> {
    if let Some(text) = content.as_str() {
        return text.as_bytes().to_vec();
    }
    let hex = content["bytes"]
        .as_str()
        .expect("a file has a text or its bytes");
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("the bytes are hexadecimal"))
        .collect()
}

/// The path of a file for the file system. On Windows it is the verbatim
/// form (a path that starts with two backslashes, a question mark and a
/// backslash), which Windows does not change: a scenario can then hold a name
/// with a dot or a space at the end, or the name of a device, as a copy from
/// another system can.
fn disk_path(folder: &Path, path: &str) -> PathBuf {
    if cfg!(windows) {
        let full = folder.join(path).to_string_lossy().replace('/', "\\");
        PathBuf::from(format!(r"\\?\{full}"))
    } else {
        folder.join(path)
    }
}

fn write_files(folder: &Path, files: &Value) {
    for (path, content) in files.as_object().expect("the files are an object") {
        let file = disk_path(folder, path);
        fs::create_dir_all(file.parent().expect("a file has a folder"))
            .expect("the folder can be made");
        // A sparse file of zero bytes of that size, made without writing them.
        if let Some(size) = content["sparse"].as_u64() {
            fs::File::create(&file)
                .and_then(|made| made.set_len(size))
                .expect("the sparse file is made");
            continue;
        }
        fs::write(file, bytes_of(content)).expect("the file is written");
    }
}

/// Every file of the attachment storage, by its name, with its bytes.
fn storage_of(folder: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<(String, Vec<u8>)> = fs::read_dir(folder)
        .expect("the storage can be listed")
        .map(|entry| {
            let entry = entry.expect("the entry can be read");
            (
                entry.file_name().to_string_lossy().into_owned(),
                fs::read(entry.path()).expect("the file can be read"),
            )
        })
        .collect();
    files.sort();
    files
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
    push_to_store_with(copy, files, "A change of another device");
}

/// A commit of another device with its own message, pushed to the content store.
fn push_to_store_with(copy: &Path, files: &Value, message: &str) {
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
    run(&["commit", "--quiet", "--message", message]);
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
            answers: None,
            main_site: None,
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
        let answers = stores.root().join("note-types.json");
        let note_types = match &scenario["noteTypes"] {
            Value::Null => json!({ "noteTypes": [], "notes": {} }),
            note_types => note_types.clone(),
        };
        fs::write(&answers, note_types.to_string()).expect("the answers can be written");
        let main_site = (!scenario["mainSite"].is_null()).then(|| {
            let file = stores.root().join("main-site.json");
            set_main_site(&file, &scenario["mainSite"]);
            file
        });
        Self {
            stores,
            vault,
            copy,
            answers: Some(answers),
            main_site,
        }
    }

    fn run(&self, command: &str, arguments: &[&str]) -> Output {
        self.run_with(command, arguments, None)
    }

    /// Runs a command. With a crash point, the run stops there, as after a
    /// power cut: the switch exists only in a debug build of the program.
    fn run_with(&self, command: &str, arguments: &[&str], crash: Option<&str>) -> Output {
        let mut program = support::program();
        program.arg(command);
        // The lock is a file of the copy: `unlock` needs no vault.
        if command != "unlock" {
            program.arg("--vault").arg(&self.vault);
        }
        program.arg("--content-store").arg(&self.copy);
        if let Some(point) = crash {
            program.env("DSEBASTIEN_VAULT_PUBLISH_TEST_CRASH", point);
        }
        if let Some(file) = &self.main_site {
            program.env("DSEBASTIEN_VAULT_PUBLISH_TEST_MAIN_SITE", file);
        }
        if let Some(answers) = &self.answers {
            program.env("DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES", answers);
            let mut asked = answers.as_os_str().to_owned();
            asked.push(".asked");
            program.env("DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES_ASKED", asked);
        }
        if ["publish", "takedown", "unpublish", "mcp"].contains(&command) {
            program
                .arg("--attachment-storage")
                .arg(self.stores.attachment_storage())
                .arg("--no-deploy");
        }
        program
            .args(arguments)
            .output()
            .expect("the program starts")
    }

    /// The step `mainSite`: the main site of the scenario gives other answers.
    fn set_main_site(&self, answers: &Value) {
        let file = self
            .main_site
            .as_ref()
            .expect("the scenario has a main site");
        set_main_site(file, answers);
    }

    fn status(&self) -> Value {
        let output = self.run("status", &[]);
        assert!(output.status.success(), "{}", errors_of(&output));
        json_of(&output)
    }

    /// Runs the `plan` command for a selection: three lists of paths.
    fn plan(&self, selection: &Value) -> Output {
        let mut arguments = Vec::new();
        for key in ["include", "hold", "remove", "accept"] {
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
        // A pairing: `--pair <from> <to>`. A path can start with a hyphen.
        if let Some(pairs) = selection["pair"].as_array() {
            for pairing in pairs {
                arguments.push("--pair".to_owned());
                for key in ["from", "to"] {
                    arguments.push(
                        pairing[key]
                            .as_str()
                            .expect("a path of a pairing is a text")
                            .to_owned(),
                    );
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

    /// Runs a command on the paths of a step, at the time of the step.
    fn run_on_paths(&self, command: &str, step: &Value, crash: Option<&str>) -> Output {
        let time = step["time"].as_str().expect("a run has a time");
        // The program is the face of the command line: a step names that face or none.
        assert!(
            step["face"].is_null() || step["face"] == "command-line",
            "a step on paths runs from the command line"
        );
        let key = if step["do"] == "crash" {
            "takedown"
        } else {
            "paths"
        };
        let mut arguments = vec![
            "--time".to_owned(),
            time.to_owned(),
            "--device".to_owned(),
            "garden-shed".to_owned(),
        ];
        // With `=`: a path can start with a hyphen.
        arguments.extend(
            paths(&step[key])
                .iter()
                .map(|path| format!("--path={path}")),
        );
        // The forced removals that the author named (rule 10 of "The edits
        // of the guards").
        if step["accept"].is_array() {
            arguments.extend(
                paths(&step["accept"])
                    .iter()
                    .map(|path| format!("--accept={path}")),
            );
        }
        let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
        self.run_with(command, &arguments, crash)
    }

    /// Calls one tool of the MCP server of the program (the face
    /// `mcp-server`), at the time of the step. The result is the result of
    /// the call: its texts and whether it is an error.
    fn call_tool(&self, tool: &str, arguments: &Value, time: &str) -> Value {
        let mut program = support::program();
        program
            .arg("mcp")
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy)
            .arg("--attachment-storage")
            .arg(self.stores.attachment_storage())
            .arg("--no-deploy")
            .arg("--device")
            .arg("garden-shed")
            // The server takes the time of the clock: the switch of the debug
            // build gives it the time of the step.
            .env("DSEBASTIEN_VAULT_PUBLISH_TEST_TIME", time)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(file) = &self.main_site {
            program.env("DSEBASTIEN_VAULT_PUBLISH_TEST_MAIN_SITE", file);
        }
        if let Some(answers) = &self.answers {
            program.env("DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES", answers);
        }
        let mut child = program.spawn().expect("the program starts");
        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments },
        });
        child
            .stdin
            .take()
            .expect("the input is a pipe")
            .write_all(format!("{request}\n").as_bytes())
            .expect("the request is written");
        let output = child.wait_with_output().expect("the program ends");
        assert!(output.status.success(), "{}", errors_of(&output));
        let answer: Value = serde_json::from_slice(&output.stdout).expect("the answer is JSON");
        answer["result"].clone()
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
    // A takedown report has no `failed`, and a publication report no
    // `storageWarnings`.
    for key in [
        "failed",
        "originalsNotVerified",
        "storageWarnings",
        "warnings",
    ] {
        if report.get(key).is_some() {
            lists[key] = json!(paths(&report[key]));
        }
    }
    lists
}

/// The report that a step states. A publication report of a scenario before
/// issue 55 has no list `originalsNotVerified`, and one before issue 135 no
/// list `attachmentsRemoved`: they are empty then.
fn expected_report(report: &Value) -> Value {
    let mut expected = report.clone();
    if report.get("attachmentsUploaded").is_some() {
        for key in ["attachmentsRemoved", "originalsNotVerified"] {
            if report.get(key).is_none() {
                expected[key] = json!([]);
            }
        }
    }
    expected
}

/// The answers of the main site of a scenario, by URL, into its file.
fn set_main_site(file: &Path, answers: &Value) {
    fs::write(file, json!({ "answers": answers }).to_string())
        .expect("the answers of the main site can be written");
}

/// The command stopped with an error and wrote nothing to its output.
fn assert_refused(output: &Output, label: &str) {
    assert_eq!(output.status.code(), Some(1), "{label}");
    assert_eq!(String::from_utf8_lossy(&output.stdout), "", "{label}");
    assert!(errors_of(output).starts_with("error: "), "{label}");
}

/// The command stopped, and its message has what the step says.
fn assert_refused_saying(output: &Output, step: &Value, label: &str) {
    assert_refused(output, label);
    if let Some(says) = step["says"].as_str() {
        assert!(
            errors_of(output).contains(says),
            "{label}: {}",
            errors_of(output)
        );
    }
}

/// The step `asked`: the questions to the Starter Kit since the last such
/// step, in their order, when the step names them.
fn check_questions(setup: &Setup, step: &Value, label: &str) {
    let answers = setup.answers.as_ref().expect("a scenario has answers");
    let mut file = answers.as_os_str().to_owned();
    file.push(".asked");
    let text = fs::read_to_string(&file).unwrap_or_default();
    let _ = fs::remove_file(&file);
    if !step["questions"].is_null() {
        let questions: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).expect("a question is JSON"))
            .collect();
        assert_eq!(Value::from(questions), step["questions"], "{label}");
    }
}

/// The step `noteTypes`: the Starter Kit of the scenario gives other
/// answers, or is missing (`null`).
fn set_answers(setup: &Setup, note_types: &Value) {
    let answers = setup.answers.as_ref().expect("a scenario has answers");
    if note_types.is_null() {
        fs::remove_file(answers).expect("the answers can be removed");
    } else {
        fs::write(answers, note_types.to_string()).expect("the answers can be written");
    }
}

/// The plans of the steps of one scenario: the last one that stopped, and
/// the last one that a `plan` step stored.
#[derive(Default)]
struct Plans {
    stopped: String,
    stored: String,
}

/// The step `expect`: the texts of files of the vault and of the content
/// store, and the files of the attachment storage when the step names them.
fn check_files(setup: &Setup, step: &Value, label: &str) {
    for (folder, key) in [(&setup.vault, "vault"), (&setup.copy, "store")] {
        for (path, expected) in step[key].as_object().expect("the files are an object") {
            assert_eq!(&text_of(&folder.join(path)), expected, "{label}: {path}");
        }
    }
    if let Some(storage) = step["attachmentStorage"].as_object() {
        let mut expected: Vec<(String, Vec<u8>)> = storage
            .iter()
            .map(|(key, content)| (key.clone(), bytes_of(content)))
            .collect();
        expected.sort();
        assert_eq!(
            storage_of(setup.stores.attachment_storage()),
            expected,
            "{label}"
        );
    }
}

/// The step `edit` (issue 42): an edit of the guards from the face of the
/// step, at its time, on the device `garden-shed`. It gives its event, or is
/// refused with the text of `says`.
fn run_edit_step(setup: &Setup, step: &Value, label: &str) {
    let action = step["action"].as_str().expect("an edit has an action");
    let path = step["path"].as_str().expect("an edit has a path");
    let time = step["time"].as_str().expect("an edit has a time");
    let refused = step["refused"] == json!(true);
    match step["face"].as_str().expect("an edit has a face") {
        "command-line" => {
            let output = setup.run(
                action,
                &[
                    &format!("--path={path}"),
                    "--time",
                    time,
                    "--device",
                    "garden-shed",
                ],
            );
            if refused {
                assert_refused_saying(&output, step, label);
            } else {
                assert!(output.status.success(), "{label}: {}", errors_of(&output));
                assert_eq!(
                    json_of(&output),
                    json!({ "edit": step["event"] }),
                    "{label}"
                );
            }
        }
        "mcp-server" => {
            let result = setup.call_tool(action, &json!({ "path": path }), time);
            let first = result["content"][0]["text"]
                .as_str()
                .expect("the result has a text");
            assert_eq!(result["isError"], json!(refused), "{label}: {first}");
            if refused {
                let says = step["says"].as_str().expect("a refusal says why");
                assert!(first.contains(says), "{label}: {first}");
            } else {
                let output: Value = serde_json::from_str(first).expect("the output is JSON");
                assert_eq!(output, json!({ "edit": step["event"] }), "{label}");
            }
        }
        other => panic!("{label}: the face \"{other}\" is not known"),
    }
}

/// The lists of the output of `plan` beside the plan, empty when a step
/// does not state them.
const PLAN_LISTS: [&str; 4] = [
    "attachmentsRemoved",
    "listsNotRefreshed",
    "liveQueries",
    "tooLarge",
];

/// The step `publish`: the plan of the selection, or the stored one, applied
/// from the face of the step (`command-line` by default, `mcp-server` through
/// the `mcp` command), at its time. It gives its report, or is refused with
/// the text of `says`.
fn run_publish_step(setup: &Setup, step: &Value, label: &str, plans: &Plans) {
    let time = step["time"].as_str().expect("a publication has a time");
    let refused = step["refused"] == json!(true);
    let id = if step["stored"] == json!(true) {
        plans.stored.clone()
    } else {
        setup.plan_id(&step["selection"])
    };
    match step["face"].as_str().unwrap_or("command-line") {
        "command-line" => {
            let output = setup.publish_plan(&id, time);
            if refused {
                assert_refused_saying(&output, step, label);
            } else {
                assert!(output.status.success(), "{label}: {}", errors_of(&output));
                assert_eq!(
                    report_lists(&json_of(&output)),
                    expected_report(&step["report"]),
                    "{label}"
                );
            }
        }
        "mcp-server" => {
            let result = setup.call_tool("publish", &json!({ "plan": id }), time);
            let first = result["content"][0]["text"]
                .as_str()
                .expect("the result has a text");
            assert_eq!(result["isError"], json!(refused), "{label}: {first}");
            if refused {
                let says = step["says"].as_str().expect("a refusal says why");
                assert!(first.contains(says), "{label}: {first}");
            } else {
                let report: Value = serde_json::from_str(first).expect("the report is JSON");
                assert_eq!(
                    report_lists(&report),
                    expected_report(&step["report"]),
                    "{label}"
                );
            }
        }
        other => panic!("{label}: the face \"{other}\" is not known"),
    }
}

/// The steps of issue 42: `edit`, and `guards`, which states the output of
/// the command. False for every other step.
fn run_guards_step(setup: &Setup, step: &Value, label: &str) -> bool {
    match step["do"].as_str() {
        Some("edit") => run_edit_step(setup, step, label),
        Some("guards") => {
            let output = setup.run("guards", &[]);
            assert!(output.status.success(), "{label}: {}", errors_of(&output));
            assert_eq!(json_of(&output), step["guards"], "{label}");
        }
        _ => return false,
    }
    true
}

/// The steps of issue 38 on the paths of a step: `takedown`, `unpublish`,
/// and a `crash` of a takedown. False for every other step.
fn run_removal_step(setup: &Setup, step: &Value, label: &str) -> bool {
    let kind = step["do"].as_str().unwrap_or_default();
    if kind == "crash" && !step["takedown"].is_null() {
        let point = step["at"].as_str().expect("a crash has a point");
        let output = setup.run_on_paths("takedown", step, Some(point));
        assert!(!output.status.success(), "{label}: the run did not stop");
    } else if kind == "takedown" || kind == "unpublish" {
        let output = setup.run_on_paths(kind, step, None);
        if step["refused"] == json!(true) {
            assert_refused_saying(&output, step, label);
        } else {
            assert!(output.status.success(), "{label}: {}", errors_of(&output));
            assert_eq!(
                report_lists(&json_of(&output)),
                expected_report(&step["report"]),
                "{label}"
            );
        }
    } else {
        return false;
    }
    true
}

fn run_step(setup: &Setup, step: &Value, label: &str, plans: &mut Plans) {
    if run_removal_step(setup, step, label) || run_guards_step(setup, step, label) {
        return;
    }
    match step["do"].as_str().expect("a step says what it does") {
        "write" => write_files(&setup.vault, &step["files"]),
        "delete" => {
            // A path is a file, or a folder with everything in it.
            for path in paths(&step["paths"]) {
                let path = setup.vault.join(path);
                if path.is_dir() {
                    fs::remove_dir_all(path).expect("the folder can be removed");
                } else {
                    fs::remove_file(path).expect("the file can be removed");
                }
            }
        }
        // `{plan}` in the message is the plan of the last run that stopped.
        "store" => match step["message"].as_str() {
            Some(message) => push_to_store_with(
                &setup.copy,
                &step["files"],
                &message.replace("{plan}", &plans.stopped),
            ),
            None => push_to_store(&setup.copy, &step["files"]),
        },
        "status" if step["refused"] == json!(true) => {
            assert_refused_saying(&setup.run("status", &[]), step, label);
        }
        "status" => {
            // A scenario before issue 72 states no list `tooLarge`, and a queue
            // with no list `unpublished` states an empty one.
            let mut expected = step["queue"].clone();
            for list in ["tooLarge", "unpublished"] {
                if expected.get(list).is_none() {
                    expected[list] = json!([]);
                }
            }
            assert_eq!(setup.status(), expected, "{label}");
        }
        "plan" => {
            let output = setup.plan(&step["selection"]);
            if step["refused"] == json!(true) {
                assert_refused_saying(&output, step, label);
            } else {
                assert!(output.status.success(), "{label}: {}", errors_of(&output));
                json_of(&output)["id"]
                    .as_str()
                    .expect("the plan has an id")
                    .clone_into(&mut plans.stored);
                assert_eq!(json_of(&output)["plan"], step["plan"], "{label}");
                let offline = step.get("offline").cloned().unwrap_or(json!(false));
                assert_eq!(json_of(&output)["offline"], offline, "{label}");
                for key in PLAN_LISTS {
                    let expected = step.get(key).cloned().unwrap_or(json!([]));
                    assert_eq!(json_of(&output)[key], expected, "{label}: {key}");
                }
            }
        }
        "crash" => {
            let time = step["time"].as_str().expect("a publication has a time");
            let point = step["at"].as_str().expect("a crash has a point");
            let id = setup.plan_id(&step["selection"]);
            plans.stopped.clone_from(&id);
            let output = setup.run_with(
                "publish",
                &["--plan", &id, "--time", time, "--device", "garden-shed"],
                Some(point),
            );
            assert!(!output.status.success(), "{label}: the run did not stop");
        }
        "unlock" => {
            let output = setup.run("unlock", &[]);
            assert!(output.status.success(), "{label}: {}", errors_of(&output));
            assert_eq!(json_of(&output), json!({ "removed": true }), "{label}");
        }
        "offline" => {
            let unreachable = setup.stores.root().join("unreachable");
            setup.git(&["remote", "set-url", "origin", text(&unreachable)]);
        }
        "online" => {
            setup.git(&[
                "remote",
                "set-url",
                "origin",
                text(setup.stores.content_store()),
            ]);
        }
        "storage" => write_files(setup.stores.attachment_storage(), &step["files"]),
        "lose" => {
            for key in paths(&step["keys"]) {
                fs::remove_file(setup.stores.attachment_storage().join(key))
                    .expect("the file of the storage can be removed");
            }
        }
        "noteTypes" => set_answers(setup, &step["noteTypes"]),
        "mainSite" => setup.set_main_site(&step["answers"]),
        "asked" => check_questions(setup, step, label),
        "publish" => run_publish_step(setup, step, label, plans),
        "expect" => check_files(setup, step, label),
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
        let mut plans = Plans::default();
        for (index, step) in steps.iter().enumerate() {
            let why = step["why"].as_str().expect("a step says why");
            run_step(
                &setup,
                step,
                &format!("{name}, step {}: {why}", index + 1),
                &mut plans,
            );
            kinds.push(step["do"].as_str().unwrap_or_default().to_owned());
        }
    }

    kinds.sort();
    kinds.dedup();
    assert_eq!(
        kinds,
        [
            "asked",
            "crash",
            "delete",
            "edit",
            "expect",
            "guards",
            "lose",
            "mainSite",
            "noteTypes",
            "offline",
            "online",
            "plan",
            "publish",
            "status",
            "storage",
            "store",
            "takedown",
            "unlock",
            "unpublish",
            "write"
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
        "{\n  \"behind\": 0,\n  \"changed\": [],\n  \"counts\": {\n    \"changed\": 0,\n    \"new\": 0,\n    \"toRemove\": 0,\n    \"unchanged\": 0\n  },\n  \"missing\": [],\n  \"movedEdited\": [],\n  \"new\": [],\n  \"pairings\": [],\n  \"proposals\": [],\n  \"renamed\": [],\n  \"technicalUpdates\": [],\n  \"toRemove\": [],\n  \"tooLarge\": [],\n  \"unchanged\": [],\n  \"unpublished\": [],\n  \"unpublishedUnderGuard\": []\n}\n"
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
            "aliases": [],
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
        r#"{{"aliases":[],"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":{version},"firstPublished":"{TIME}","formerPaths":{former_paths},"id":"00000000000000aa","lastPublished":"{TIME}","links":[],"path":"Welcome.md","sourceHash":"sha256:00","state":"published"}}"#
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

/// On Linux a file `n.md\` is not a note, but Obsidian lists it as `n.md`:
/// the twins are computed over the other files too (issue 115). Windows
/// refuses such a name.
#[cfg(unix)]
#[test]
fn a_note_whose_twin_is_a_file_that_is_not_a_note_is_never_published() {
    let setup = Setup::scenario(&json!({
        "denyList": [],
        "vault": { "n.md": "N\n", "n.md\\": "Other\n" }
    }));

    let status = json_of(&setup.run("status", &[]));
    assert_eq!(status["new"], json!(["n.md"]));
    let output = setup.plan(&json!({ "include": ["n.md"] }));
    assert_refused_saying(
        &output,
        &json!({ "says": "the file \"n.md\\\" has the same path in Obsidian" }),
        "a twin among the other files",
    );
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_in_the_manifest_stops_the_status() {
    let setup = Setup::fixture();
    fs::create_dir(setup.copy.join("manifest")).expect("the folder can be made");
    std::os::unix::fs::symlink(
        setup.vault.join("Welcome.md"),
        setup.copy.join("manifest").join("link.json"),
    )
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

/// A link in the last commit stops the check of the copy (issue 79), also a
/// link to a folder.
#[cfg(unix)]
#[test]
fn a_symbolic_link_to_a_folder_in_the_manifest_stops_the_status() {
    let setup = Setup::fixture();
    let elsewhere = setup.stores.root().join("elsewhere");
    fs::create_dir(&elsewhere).expect("the folder can be made");
    fs::write(elsewhere.join("x.json"), "{}\n").expect("the file is written");
    fs::create_dir(setup.copy.join("manifest")).expect("the folder can be made");
    std::os::unix::fs::symlink(&elsewhere, setup.copy.join("manifest").join("sub"))
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

/// Git writes a link of a commit as a link on macOS and Linux, and as a small
/// text file where it cannot make links: the check refuses both (issue 79).
#[test]
fn a_link_that_the_last_commit_holds_stops_the_status() {
    for path in ["notes/Linked", "manifest/linked.json"] {
        let setup = Setup::fixture();
        let target = setup.stores.root().join("target.txt");
        fs::write(&target, "../elsewhere").expect("the file is written");
        let copy = text(&setup.copy);
        let blob = git(&["-C", copy, "hash-object", "-w", text(&target)]);
        let entry = format!("120000,{},{path}", blob.trim());
        git(&["-C", copy, "update-index", "--add", "--cacheinfo", &entry]);
        git(&[
            "-C",
            copy,
            "commit",
            "--quiet",
            "--message",
            "A change of another device",
        ]);
        git(&["-C", copy, "checkout", "HEAD", "--", path]);
        git(&["-C", copy, "push", "--quiet", "origin", "HEAD:main"]);

        let output = setup.run("status", &[]);
        assert_eq!(output.status.code(), Some(1), "{path}");
        assert!(
            errors_of(&output).contains(&format!(
                "{path} of the last commit of the content store is a symbolic link"
            )),
            "{}",
            errors_of(&output)
        );
    }
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
        r#"{{"aliases":[],"attachments":[],"cleanedHash":"sha256:00","cleaningVersion":2,"firstPublished":"2031-04-01T08:00:00Z","formerPaths":[],"id":"{id}","lastPublished":"2031-04-01T08:00:00Z","links":[],"path":"Welcome.md","sourceHash":"sha256:00","state":"unpublished"}}
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
    let setup = copy_of_a_new_content_store();
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
        answers: None,
        main_site: None,
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

/// Issue 71: each way out that the message proposes gets the tool to run
/// again, or to the next way out. A file that git assumes unchanged is staged
/// by no `git add`, so that advice comes first.
#[test]
fn the_advice_for_an_edited_configuration_that_git_assumes_unchanged_does_not_loop() {
    let setup = Setup::fixture();
    setup.git(&["update-index", "--assume-unchanged", "configuration.json"]);
    fs::write(
        setup.copy.join("configuration.json"),
        "{\"denyList\":[\"80 Templates\",\"90 Locked Shed\",\"10 Garden\"]}\n",
    )
    .expect("the file is written");

    let message = errors_of(&setup.run("status", &[]));
    assert!(
        message.contains("git update-index --no-skip-worktree --no-assume-unchanged"),
        "{message}"
    );
    assert!(!message.contains("configuration.json,"), "{message}");
    setup.git(&[
        "update-index",
        "--no-skip-worktree",
        "--no-assume-unchanged",
        "configuration.json",
    ]);

    let message = errors_of(&setup.run("status", &[]));
    assert!(message.contains("git add configuration.json"), "{message}");
}

#[cfg(unix)]
#[test]
fn the_advice_for_a_configuration_replaced_by_a_link_puts_the_file_back() {
    let setup = Setup::fixture();
    let file = setup.copy.join("configuration.json");
    fs::remove_file(&file).expect("the file can be removed");
    std::os::unix::fs::symlink("elsewhere.json", &file).expect("the link is made");

    let message = errors_of(&setup.run("status", &[]));
    assert!(
        message.contains("git checkout HEAD -- configuration.json"),
        "{message}"
    );
    assert!(!message.contains("commit configuration.json"), "{message}");
    setup.git(&["checkout", "HEAD", "--", "configuration.json"]);

    assert!(setup.status()["new"].as_array().is_some());
}

#[test]
fn the_advice_for_a_configuration_added_and_then_removed_from_the_disk_takes_it_out_of_the_index() {
    let setup = Setup::fixture();
    setup.git(&["rm", "--quiet", "configuration.json"]);
    setup.git(&["commit", "--quiet", "--message", "No deny list"]);
    setup.git(&["push", "--quiet", "origin", "HEAD:main"]);
    let file = setup.copy.join("configuration.json");
    fs::write(
        &file,
        "{\"denyList\":[\"80 Templates\",\"90 Locked Shed\"]}\n",
    )
    .expect("the file is written");
    setup.git(&["add", "configuration.json"]);
    fs::remove_file(&file).expect("the file can be removed");

    let message = errors_of(&setup.run("status", &[]));
    assert!(
        message.contains("git rm --cached --quiet configuration.json"),
        "{message}"
    );
    assert!(
        !message.contains("git checkout HEAD -- configuration.json"),
        "{message}"
    );
    setup.git(&["rm", "--cached", "--quiet", "configuration.json"]);

    // The index follows the last commit again: the run now stops because the
    // content store has no configuration (R67).
    let output = setup.run("status", &[]);
    assert!(
        errors_of(&output).contains("has no configuration.json"),
        "{}",
        errors_of(&output)
    );
}

/// A first publication into a content store with no commit cannot happen:
/// the content store needs its configuration first (R67).
#[test]
fn a_copy_of_a_content_store_with_no_commit_stops_it_has_no_configuration() {
    let stores = TestStores::new();
    let vault = stores.copy_fixture_vault();
    let copy = stores.root().join("copy");
    git(&[
        "clone",
        "--quiet",
        text(stores.content_store()),
        text(&copy),
    ]);
    let setup = Setup {
        stores,
        vault,
        copy,
        answers: None,
        main_site: None,
    };

    let output = setup.plan(&json!({ "include": ["Welcome.md"] }));

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("has no configuration.json"),
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
        support::program()
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
            "--attachment-storage",
            text(setup.stores.attachment_storage()),
            "--no-deploy",
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
    // The journal of the run is still there: status writes nothing, and the
    // next plan takes the commit back, which the content store never got
    // (R46).
    let output = setup.run("status", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("stopped halfway"),
        "{}",
        errors_of(&output)
    );
    let output = setup.plan(&json!({ "include": [NOTE] }));
    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(json_of(&output)["plan"]["publish"], json!([NOTE]));
    assert_eq!(setup.git(&["rev-parse", "HEAD"]), before);
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
/// A copy of a content store whose only commit is an empty deny list: the
/// content store needs its configuration (R67).
fn copy_of_a_new_content_store() -> Setup {
    let stores = TestStores::new();
    let vault = stores.copy_fixture_vault();
    let seed = stores.root().join("seed");
    git(&[
        "clone",
        "--quiet",
        text(stores.content_store()),
        text(&seed),
    ]);
    for (key, value) in [
        ("user.name", "Other"),
        ("user.email", "other@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(&["-C", text(&seed), "config", key, value]);
    }
    git(&["-C", text(&seed), "checkout", "--quiet", "-B", "main"]);
    fs::write(seed.join("configuration.json"), "{\"denyList\": []}\n")
        .expect("the configuration is written");
    git(&["-C", text(&seed), "add", "configuration.json"]);
    git(&[
        "-C",
        text(&seed),
        "commit",
        "--quiet",
        "--message",
        "An empty deny list",
    ]);
    git(&["-C", text(&seed), "push", "--quiet", "origin", "HEAD:main"]);
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
        answers: None,
        main_site: None,
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

    let message = setup.git(&["log", "-1", "--format=%B"]);
    let (counts, plan) = message
        .split_once("\nPlan: ")
        .expect("the message names the plan");
    // The last line is the seal of the commit (R104).
    let (plan, seal) = plan
        .split_once("\nSeal: ")
        .expect("the message ends with its seal");
    assert_eq!(seal.trim_end().len(), 64);
    assert_eq!(
        counts,
        "Publish: 1 new, 1 updated, 1 removed, 0 forced, 1 skipped, 0 moved\n\nDevice: garden-shed\nFace: command-line"
    );
    assert!(
        plan.len() == 16
            && plan
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')),
        "{plan}"
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
    assert!(
        message.contains("\nFace: command-line\nPlan: "),
        "{message}"
    );
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
    assert!(
        errors_of(&output).contains(&format!("1 note of the plan was left out: \"{blocked}\": ")),
        "{}",
        errors_of(&output)
    );
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

    let report = setup.publish(
        &json!({ "include": ["Welcome.md"], "accept": [SECOND] }),
        LATER,
    );

    assert_eq!(paths(&report["forcedRemoved"]), [SECOND]);
    assert_eq!(paths(&report["removed"]), Vec::<String>::new());
    assert_eq!(paths(&report["published"]), ["Welcome.md"]);
    assert_eq!(
        setup.git(&["log", "-1", "--format=%s"]),
        "Publish: 1 new, 0 updated, 0 removed, 1 forced, 0 skipped, 0 moved"
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
    let report = setup.publish(&json!({ "include": [], "accept": [SECOND] }), LATER);

    assert_eq!(
        planned["plan"],
        json!({ "edits": [], "forcedRemove": [SECOND], "guardedAttachments": [], "move": [], "publish": [], "remove": [], "update": [] })
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
        json!({ "edits": [], "forcedRemove": [], "guardedAttachments": [], "move": [], "publish": [], "remove": [], "update": [] })
    );
    assert_eq!(
        paths(&json_of(&held)["plan"]["forcedRemove"]),
        Vec::<String>::new()
    );
}

/// A removal needs no text (issue 36): a cleaned note under a guard that is
/// not valid UTF-8 in the content store (another device pushed it) still
/// leaves the store.
#[test]
fn a_forced_removal_removes_a_cleaned_note_that_is_not_valid_utf_8() {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE] }), TIME);
    fs::write(setup.vault.join(NOTE), IGNORED).expect("the file is written");
    fs::write(setup.copy.join("notes").join(NOTE), [0xff, 0xfe, 0x0a])
        .expect("the file is written");
    setup.git(&["commit", "--quiet", "--all", "--message", "Another device"]);
    setup.git(&["push", "--quiet", "origin", "HEAD:main"]);

    let report = setup.publish(&json!({ "include": [], "accept": [NOTE] }), LATER);

    assert_eq!(paths(&report["forcedRemoved"]), [NOTE]);
    let files = git(&[
        "--git-dir",
        text(setup.stores.content_store()),
        "ls-tree",
        "-r",
        "--name-only",
        "main",
    ]);
    assert!(!files.contains(&format!("notes/{NOTE}")), "{files}");
}

/// PUB-21: if a forced removal fails, the whole publication stops. Here the
/// folder of the cleaned note of the second removal cannot be written, so its
/// removal fails, and the first removal is put back.
#[cfg(unix)]
#[test]
fn a_forced_removal_that_fails_stops_the_whole_publication_and_every_file_is_put_back() {
    use std::os::unix::fs::PermissionsExt;
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [SECOND, "Welcome.md"] }), TIME);
    fs::write(setup.vault.join(SECOND), IGNORED).expect("the file is written");
    fs::write(setup.vault.join("Welcome.md"), IGNORED).expect("the file is written");
    let planned = setup.plan(&json!({ "include": [NOTE], "accept": [SECOND, "Welcome.md"] }));
    assert!(planned.status.success(), "{}", errors_of(&planned));
    let planned = json_of(&planned);
    assert_eq!(
        paths(&planned["plan"]["forcedRemove"]),
        [SECOND, "Welcome.md"]
    );
    let id = planned["id"].as_str().expect("the plan has an id");
    let before = (
        picture(&setup.vault),
        setup.git(&["rev-parse", "HEAD"]),
        manifest_files(&setup.copy),
    );
    let notes = setup.copy.join("notes");
    fs::set_permissions(&notes, fs::Permissions::from_mode(0o555)).expect("the mode is set");

    let output = setup.publish_plan(id, LATER);
    fs::set_permissions(&notes, fs::Permissions::from_mode(0o755)).expect("the mode is set");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    let message = errors_of(&output);
    assert!(message.contains("Welcome.md"), "{message}");
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
    assert_eq!(
        setup.git(&["status", "--porcelain", "--", "manifest", "notes"]),
        ""
    );
    assert!(!setup.copy.join("notes").join(NOTE).exists());
    // Without a push, no property is corrected.
    assert_eq!(picture(&setup.vault), before.0);
    // Both notes still wait for their removal.
    assert_eq!(paths(&setup.status()["toRemove"]), [SECOND, "Welcome.md"]);
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
        answers: None,
        main_site: None,
    }
}

/// Each device has its own copy of the content store (issue 70). A copy that
/// did not pull reads an older manifest: a note that came under a guard since
/// would stay live. So `plan` and `publish` fetch first and stop when the copy
/// is behind, and `status` stays offline and says how far behind the last
/// fetch is.
#[test]
fn a_copy_that_is_behind_stops_plan_and_publish_until_the_pull() {
    let second = copy_of_a_new_content_store();
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
    let output = second.run("status", &[]);
    assert!(output.status.success());
    assert!(
        errors_of(&output).contains("1 commit(s) behind"),
        "{}",
        errors_of(&output)
    );

    second.git(&["pull", "--quiet", "--ff-only", "origin", "main"]);

    assert_eq!(second.status()["behind"], 0);
    let output = second.plan(&json!({}));
    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(paths(&json_of(&output)["plan"]["forcedRemove"]), [NOTE]);
}

/// The fetch names the branch: with the fetch setting of the copy removed or
/// changed by hand, a plain fetch would leave origin/main as it was.
#[test]
fn a_copy_whose_fetch_setting_was_changed_still_stops_plan_and_publish() {
    for setting in [
        vec!["config", "--unset", "remote.origin.fetch"],
        vec![
            "config",
            "remote.origin.fetch",
            "+refs/heads/main:refs/remotes/upstream/main",
        ],
    ] {
        let second = copy_of_a_new_content_store();
        let first = other_device(&second, "first");
        first.publish(&json!({ "include": [NOTE] }), TIME);
        second.git(&["pull", "--quiet", "--ff-only", "origin", "main"]);
        second.git(&setting);
        first.publish(&json!({ "include": ["Welcome.md"] }), LATER);

        let output = second.plan(&json!({}));

        assert_eq!(output.status.code(), Some(1), "{setting:?}");
        assert!(
            errors_of(&output).contains("git pull --ff-only"),
            "{setting:?}: {}",
            errors_of(&output)
        );
    }
}

#[test]
fn a_copy_that_never_fetched_stops_plan_until_the_pull() {
    let setup = copy_of_a_new_content_store();
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
        answers: None,
        main_site: None,
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
fn status_needs_no_network_a_plan_uses_the_last_fetch_and_publish_stops_when_the_content_store_cannot_be_reached()
 {
    let setup = Setup::fixture();
    setup.publish(&json!({ "include": [NOTE] }), TIME);
    let store = setup.stores.content_store().to_path_buf();
    let away = store.with_extension("away");
    fs::rename(&store, &away).expect("the store can be moved");

    let queue = setup.status();
    let planned = setup.plan(&json!({ "include": [SECOND] }));
    let id = json_of(&planned)["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let published = setup.publish_plan(&id, LATER);
    fs::rename(&away, &store).expect("the store can be moved back");

    assert_eq!(paths(&queue["unchanged"]), [NOTE]);
    assert!(planned.status.success(), "{}", errors_of(&planned));
    assert_eq!(json_of(&planned)["offline"], json!(true));
    assert_eq!(json_of(&planned)["plan"]["publish"], json!([SECOND]));
    assert!(errors_of(&planned).contains("cannot be reached"));
    assert_eq!(published.status.code(), Some(1));
    assert!(
        errors_of(&published).contains("cannot be reached"),
        "{}",
        errors_of(&published)
    );
    assert_eq!(
        paths(&setup.publish(&json!({ "include": [SECOND] }), LATER)["published"]),
        [SECOND]
    );
}

/// The lock of the device (issue 36, TOOL-09): one publication at a time on a
/// device, for every face. A lock with no journal is a publication that runs
/// and has not written yet: status, plan and publish all wait.
#[test]
fn a_lock_stops_status_plan_and_publish_and_unlock_removes_it() {
    let setup = Setup::fixture();
    let id = setup.plan_id(&json!({ "include": [NOTE] }));
    let lock = setup.copy.join(".git").join("vault-publish").join("lock");
    fs::write(
        &lock,
        "{\n  \"command\": \"publish\",\n  \"process\": 1\n}\n",
    )
    .expect("the lock can be written");

    for output in [
        setup.run("status", &[]),
        setup.plan(&json!({ "include": [NOTE] })),
        setup.publish_plan(&id, TIME),
    ] {
        assert_refused(&output, "a lock");
        assert!(
            errors_of(&output).contains("unlock"),
            "{}",
            errors_of(&output)
        );
    }
    // A refused run leaves the lock of the other run.
    assert!(lock.exists());

    assert_eq!(
        json_of(&setup.run("unlock", &[])),
        json!({ "removed": true })
    );
    assert_eq!(
        json_of(&setup.run("unlock", &[])),
        json!({ "removed": false })
    );
    let output = setup.publish_plan(&id, TIME);
    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(paths(&json_of(&output)["published"]), [NOTE]);
    // A publication removes its own lock at its end.
    assert!(!lock.exists());
}
