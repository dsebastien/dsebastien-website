//! The edits of the guards (issue 42, decisions R69): the commands `guards`,
//! `deny`, `allow`, `ignore` and `unignore`, on a copy of the fixture vault and
//! on a content store made for the test. The rules of each edit are in the
//! shared scenario "the edits of the guards" of
//! `fixtures/canonical/queue.json`; these tests cover what a scenario cannot:
//! the lock, a copy that is behind, no network, a refused push, a run that
//! stops halfway, a log that is not valid and a plan that a new event makes
//! stale.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;

use serde_json::{Value, json};

use support::{TestStores, git, text};

const NOTE: &str = "10 Garden/Frost dates explained.md";
/// A note that is never published in these tests.
const DRAFT: &str = "10 Garden/Compost basics.md";
/// A folder of the fixture vault with no note of the site.
const FOLDER: &str = "10 Garden/Herb bed";
const TIME: &str = "2031-04-01T08:00:00Z";
const LATER: &str = "2031-04-02T08:00:00Z";

/// The vault, the copy, the commit of the copy, the commit of the content
/// store and the changes of the copy that git sees.
type State = (
    Vec<(String, Vec<u8>)>,
    Vec<(String, Vec<u8>)>,
    String,
    String,
    String,
);

struct Setup {
    stores: TestStores,
    vault: PathBuf,
    copy: PathBuf,
}

fn set_up() -> Setup {
    let stores = TestStores::new();
    let vault = stores.copy_fixture_vault();
    let copy = stores.make_content_store_copy();
    Setup {
        stores,
        vault,
        copy,
    }
}

fn errors_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn json_of(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("the output is JSON")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).expect("the file can be read")
}

/// Every file of a folder with its bytes, the git folder left out: a picture
/// to compare before and after. The commits and the index are compared apart.
fn picture(folder: &Path) -> Vec<(String, Vec<u8>)> {
    fn collect(folder: &Path, root: &Path, files: &mut Vec<(String, Vec<u8>)>) {
        for entry in fs::read_dir(folder).expect("the folder can be read") {
            let path = entry.expect("the entry can be read").path();
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name != ".git") {
                    collect(&path, root, files);
                }
            } else {
                let name = path
                    .strip_prefix(root)
                    .expect("the file is in the folder")
                    .to_string_lossy()
                    .replace('\\', "/");
                files.push((name, fs::read(&path).expect("the file can be read")));
            }
        }
    }
    let mut files = Vec::new();
    collect(folder, folder, &mut files);
    files.sort();
    files
}

impl Setup {
    fn run(&self, command: &str, arguments: &[&str]) -> Output {
        self.run_with(command, arguments, None)
    }

    /// Runs a command. With a crash point, the run stops there, as after a
    /// power cut: the switch exists only in a debug build of the program.
    fn run_with(&self, command: &str, arguments: &[&str], crash: Option<&str>) -> Output {
        let mut program = support::program();
        program.arg(command);
        if command != "unlock" {
            program.arg("--vault").arg(&self.vault);
        }
        program.arg("--content-store").arg(&self.copy);
        if command == "publish" || command == "unpublish" {
            program
                .arg("--attachment-storage")
                .arg(self.stores.attachment_storage());
        }
        if let Some(point) = crash {
            program.env("DSEBASTIEN_VAULT_PUBLISH_TEST_CRASH", point);
        }
        program
            .args(arguments)
            .output()
            .expect("the program starts")
    }

    /// An edit of the guards at a time, on the device `garden-shed`.
    fn edit(&self, action: &str, path: &str) -> Output {
        self.edit_with(action, path, None)
    }

    fn edit_with(&self, action: &str, path: &str, crash: Option<&str>) -> Output {
        self.run_with(
            action,
            &[
                &format!("--path={path}"),
                "--time",
                LATER,
                "--device",
                "garden-shed",
            ],
            crash,
        )
    }

    /// Makes a plan and gives its id.
    fn plan_id(&self, include: &[&str]) -> String {
        let arguments: Vec<String> = include
            .iter()
            .map(|path| format!("--include={path}"))
            .collect();
        let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
        let output = self.run("plan", &arguments);
        assert!(output.status.success(), "{}", errors_of(&output));
        json_of(&output)["id"]
            .as_str()
            .expect("the plan has an id")
            .to_owned()
    }

    fn publish_plan(&self, id: &str) -> Output {
        self.run(
            "publish",
            &["--plan", id, "--time", TIME, "--device", "garden-shed"],
        )
    }

    fn publish(&self, include: &[&str]) {
        let output = self.publish_plan(&self.plan_id(include));
        assert!(output.status.success(), "{}", errors_of(&output));
    }

    fn git(&self, arguments: &[&str]) -> String {
        let mut all = vec!["-C", text(&self.copy)];
        all.extend_from_slice(arguments);
        git(&all)
    }

    fn remote_head(&self) -> String {
        git(&[
            "--git-dir",
            text(self.stores.content_store()),
            "rev-parse",
            "main",
        ])
    }

    fn local_file(&self, name: &str) -> PathBuf {
        self.copy.join(".git").join("vault-publish").join(name)
    }

    /// Everything that an edit can change: the vault, the copy, its commit
    /// and the content store.
    fn state(&self) -> State {
        (
            picture(&self.vault),
            picture(&self.copy),
            self.git(&["rev-parse", "HEAD"]),
            self.remote_head(),
            self.git(&["status", "--porcelain"]),
        )
    }

    /// Another device pushes a commit to the content store after the last
    /// pull of the copy.
    fn push_from_another_device(&self) {
        let other = self.stores.root().join("other-device");
        let remote = text(self.stores.content_store());
        git(&["clone", "--quiet", remote, text(&other)]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgsign", "false"),
        ] {
            git(&["-C", text(&other), "config", key, value]);
        }
        fs::create_dir_all(other.join("notes")).expect("the folder can be made");
        fs::write(
            other.join("notes").join("Elsewhere.md"),
            "A note of another device\n",
        )
        .expect("the note is written");
        git(&["-C", text(&other), "add", "--", "notes/Elsewhere.md"]);
        git(&[
            "-C",
            text(&other),
            "commit",
            "--quiet",
            "--message",
            "A publication of another device",
        ]);
        git(&["-C", text(&other), "push", "--quiet", "origin", "HEAD:main"]);
    }

    /// Commits a file of the content store and pushes it, as another device
    /// that edited it by hand.
    fn commit_file(&self, path: &str, content: &str) {
        fs::write(self.copy.join(path), content).expect("the file is written");
        self.git(&["add", "--", path]);
        self.git(&["commit", "--quiet", "--message", "A change by hand"]);
        self.git(&["push", "--quiet", "origin", "HEAD:main"]);
    }
}

/// The command stopped with an error, wrote nothing to its output, and its
/// message holds the text.
fn assert_refused(output: &Output, says: &str) {
    assert_eq!(output.status.code(), Some(1), "{}", errors_of(output));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert!(errors_of(output).contains(says), "{}", errors_of(output));
}

#[test]
fn an_applied_deny_writes_the_configuration_and_the_log_in_one_commit_that_is_pushed() {
    let setup = set_up();

    let output = setup.edit("deny", FOLDER);

    assert!(output.status.success(), "{}", errors_of(&output));
    let event = &json_of(&output)["edit"];
    assert_eq!(event["state"], "applied");
    assert_eq!(event["face"], "command-line");
    assert_eq!(event["device"], "garden-shed");
    assert_eq!(event["time"], LATER);
    let id = event["id"].as_str().expect("the event has an id");
    let remote = text(setup.stores.content_store());
    let commit = git(&[
        "--git-dir",
        remote,
        "show",
        "--name-status",
        "--format=%B",
        "--no-renames",
        "main",
    ]);
    assert_eq!(
        commit,
        format!(
            "Edit: deny (applied)\n\nDevice: garden-shed\nFace: command-line\nPlan: {id}\n\n\nM\tconfiguration.json\nA\tedits.json"
        )
    );
    assert_eq!(
        read(&setup.copy.join("configuration.json")),
        format!(
            "{{\n  \"denyList\": [\n    \"80 Templates\",\n    \"90 Locked Shed\",\n    \"{FOLDER}\"\n  ]\n}}\n"
        )
    );
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
    assert!(!setup.local_file("journal.json").exists());
    assert!(!setup.local_file("lock").exists());
    // The guards and the next status read the new deny list.
    let guards = setup.run("guards", &[]);
    assert!(guards.status.success(), "{}", errors_of(&guards));
    assert_eq!(json_of(&guards)["edits"], json!([event]));
    let status = setup.run("status", &[]);
    assert!(status.status.success(), "{}", errors_of(&status));
    assert!(
        !json_of(&status)["new"]
            .as_array()
            .expect("a list")
            .iter()
            .any(|path| path.as_str().is_some_and(|path| path.starts_with(FOLDER)))
    );
}

#[test]
fn a_deny_of_a_folder_with_a_note_of_the_site_is_only_proposed() {
    let setup = set_up();
    setup.publish(&[NOTE]);
    let configuration = read(&setup.copy.join("configuration.json"));

    let output = setup.edit("deny", "10 Garden");

    assert!(output.status.success(), "{}", errors_of(&output));
    let event = &json_of(&output)["edit"];
    assert_eq!(event["state"], "proposed");
    assert_eq!(event["removes"], json!([NOTE]));
    assert_eq!(read(&setup.copy.join("configuration.json")), configuration);
    let status = setup.run("status", &[]);
    assert_eq!(json_of(&status)["proposals"], json!([event]));
}

#[test]
fn a_lock_of_another_run_stops_an_edit_which_changes_nothing() {
    let setup = set_up();
    fs::create_dir_all(setup.local_file("")).expect("the folder can be made");
    fs::write(setup.local_file("lock"), "{\"command\":\"publish\"}\n").expect("the lock is made");
    let before = setup.state();

    let output = setup.edit("deny", FOLDER);

    assert_refused(&output, "unlock");
    assert_eq!(setup.state(), before);
    assert_eq!(
        read(&setup.local_file("lock")),
        "{\"command\":\"publish\"}\n"
    );
}

#[test]
fn an_edit_on_a_copy_that_is_behind_stops_and_says_to_pull() {
    let setup = set_up();
    setup.push_from_another_device();
    let before = setup.state();

    let output = setup.edit("ignore", DRAFT);

    assert_refused(&output, "git pull --ff-only origin main");
    assert_eq!(setup.state(), before);
    assert!(!setup.local_file("lock").exists());
}

#[test]
fn an_edit_without_a_network_stops() {
    let setup = set_up();
    let unreachable = setup.stores.root().join("unreachable");
    setup.git(&["remote", "set-url", "origin", text(&unreachable)]);
    let before = setup.state();

    let output = setup.edit("deny", FOLDER);

    assert_refused(&output, "cannot be reached");
    assert_eq!(setup.state(), before);
}

#[test]
fn a_refused_push_applies_nothing_and_puts_the_files_back() {
    let setup = set_up();
    setup.stores.refuse_pushes();
    let before = setup.state();

    let output = setup.edit("deny", FOLDER);

    assert_refused(&output, "refused");
    assert!(errors_of(&output).contains("Nothing is applied"));
    assert!(!errors_of(&output).contains("publish_ignore"));
    assert_eq!(setup.state(), before);
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
    assert!(!setup.local_file("journal.json").exists());
    assert!(!setup.local_file("lock").exists());
}

#[test]
fn a_refused_push_of_an_ignore_keeps_the_property_in_the_note_and_says_so() {
    let setup = set_up();
    setup.stores.refuse_pushes();
    let note = setup.vault.join(DRAFT);
    let text_before = read(&note);
    let before = setup.state();

    let output = setup.edit("ignore", DRAFT);

    assert_refused(&output, "refused");
    let message = errors_of(&output);
    assert!(
        message.contains(&format!(
            "The publish_ignore property stays in the note \"{DRAFT}\""
        )),
        "{message}"
    );
    assert!(message.contains("the log of the edits has no event for it"));
    // The property is the only change: a stricter guard is safe.
    assert_eq!(
        read(&note),
        text_before.replacen(
            "updated: 2031-03-02T07:45\n---",
            "updated: 2031-03-02T07:45\npublish_ignore: true\n---",
            1
        )
    );
    assert_eq!(setup.state().1, before.1);
    assert_eq!(setup.state().3, before.3);
    assert!(!setup.copy.join("edits.json").exists());
    // The guard excludes the note now.
    let status = setup.run("status", &[]);
    assert!(
        !json_of(&status)["new"]
            .as_array()
            .expect("a list")
            .contains(&json!(DRAFT))
    );
}

#[test]
fn an_ignore_whose_note_cannot_be_written_applies_nothing() {
    let setup = set_up();
    let note = setup.vault.join(DRAFT);
    let mut permissions = fs::metadata(&note).expect("the note exists").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&note, permissions).expect("the note is read only");
    let before = setup.state();

    let output = setup.edit("ignore", DRAFT);

    assert_refused(&output, "read only");
    assert_eq!(setup.state(), before);
    assert!(!setup.local_file("journal.json").exists());
}

#[test]
fn an_edit_that_stopped_before_its_commit_is_put_back_by_the_next_run() {
    let setup = set_up();
    let before = setup.state();

    let stopped = setup.edit_with("deny", FOLDER, Some("write"));

    assert_eq!(stopped.status.code(), Some(99));
    assert!(read(&setup.local_file("lock")).contains("\"command\": \"edit\""));
    assert!(read(&setup.local_file("journal.json")).contains("\"configuration.json\""));
    assert_ne!(setup.state().1, before.1);
    // `status` writes nothing, and the lock stops it.
    assert_refused(&setup.run("status", &[]), "unlock");
    let unlocked = setup.run("unlock", &[]);
    assert!(unlocked.status.success(), "{}", errors_of(&unlocked));
    assert_refused(&setup.run("status", &[]), "stopped halfway");
    // The next plan puts the copy back.
    setup.plan_id(&[]);
    assert_eq!(setup.state(), before);
    assert!(!setup.local_file("journal.json").exists());
    // And the same edit applies.
    let output = setup.edit("deny", FOLDER);
    assert!(output.status.success(), "{}", errors_of(&output));
}

#[test]
fn an_edit_that_stopped_after_its_commit_is_taken_back_by_the_next_edit() {
    let setup = set_up();
    let before = setup.state();

    let stopped = setup.edit_with("deny", FOLDER, Some("commit"));

    assert_eq!(stopped.status.code(), Some(99));
    assert_ne!(setup.git(&["rev-parse", "HEAD"]), before.2);
    assert_eq!(setup.remote_head(), before.3);
    let unlocked = setup.run("unlock", &[]);
    assert!(unlocked.status.success(), "{}", errors_of(&unlocked));
    // The next edit takes the commit back, then applies its own edit.
    let output = setup.edit("ignore", DRAFT);
    assert!(output.status.success(), "{}", errors_of(&output));
    let log = setup.git(&["log", "--format=%s", "main"]);
    assert_eq!(
        log.lines().collect::<Vec<_>>(),
        [
            "Edit: ignore (applied)",
            "Add the configuration of the fixture vault"
        ]
    );
    assert!(!read(&setup.copy.join("configuration.json")).contains(FOLDER));
    assert_eq!(setup.git(&["status", "--porcelain"]), "");
}

#[test]
fn an_edit_that_stopped_after_its_push_is_kept_and_not_applied_again() {
    let setup = set_up();

    let stopped = setup.edit_with("deny", FOLDER, Some("push"));

    assert_eq!(stopped.status.code(), Some(99));
    let unlocked = setup.run("unlock", &[]);
    assert!(unlocked.status.success(), "{}", errors_of(&unlocked));
    let output = setup.edit("deny", FOLDER);
    assert_refused(&output, "already in the deny list");
    assert_eq!(
        setup.git(&["log", "-1", "--format=%s", "main"]),
        "Edit: deny (applied)"
    );
    assert!(read(&setup.copy.join("configuration.json")).contains(FOLDER));
}

#[test]
fn a_log_that_is_not_valid_stops_every_run_with_a_message_that_names_it() {
    let setup = set_up();
    // An event whose id is not its hash.
    setup.commit_file(
        "edits.json",
        "{\n  \"edits\": [\n    {\n      \"action\": \"deny\",\n      \"device\": \"garden-shed\",\n      \"face\": \"mcp-server\",\n      \"id\": \"0123456789abcdef\",\n      \"path\": \"Private\",\n      \"state\": \"applied\",\n      \"time\": \"2031-06-01T09:00:00Z\"\n    }\n  ],\n  \"published\": 0\n}\n",
    );

    for output in [
        setup.run("status", &[]),
        setup.run("plan", &[]),
        setup.run("guards", &[]),
        setup.edit("deny", FOLDER),
    ] {
        assert_refused(&output, "edits.json of the content store is not valid");
        assert!(errors_of(&output).contains("not the hash of the event"));
    }
    // The same for `published` above the number of events.
    setup.commit_file("edits.json", "{\"edits\": [], \"published\": 1}\n");
    assert_refused(&setup.run("status", &[]), "above the number of events");
}

#[test]
fn a_new_event_makes_a_stored_plan_stale() {
    let setup = set_up();
    let id = setup.plan_id(&[NOTE]);
    let output = setup.edit("deny", FOLDER);
    assert!(output.status.success(), "{}", errors_of(&output));

    let refused = setup.publish_plan(&id);

    assert_refused(&refused, "stale");
    assert!(!setup.copy.join("notes").join(NOTE).exists());
    // The new plan shows the event, and its publication marks it as shown.
    let planned = setup.run("plan", &[&format!("--include={NOTE}")]);
    assert_eq!(
        json_of(&planned)["plan"]["edits"],
        json!([json_of(&output)["edit"]])
    );
    setup.publish(&[NOTE]);
    assert!(read(&setup.copy.join("edits.json")).ends_with("  \"published\": 1\n}\n"));
    let planned = setup.run("plan", &[]);
    assert_eq!(json_of(&planned)["plan"]["edits"], json!([]));
}

#[test]
fn guards_and_an_edit_work_when_a_deny_list_entry_names_no_folder() {
    let setup = set_up();
    fs::rename(
        setup.vault.join("90 Locked Shed"),
        setup.vault.join("90 Locked Barn"),
    )
    .expect("the folder can be renamed");
    assert_refused(&setup.run("status", &[]), "not a folder of the vault");

    let guards = setup.run("guards", &[]);
    let allow = setup.edit("allow", "90 Locked Shed");
    let deny = setup.edit("deny", "90 Locked Barn");

    assert!(guards.status.success(), "{}", errors_of(&guards));
    assert_eq!(
        json_of(&guards),
        json!({ "denyList": ["80 Templates", "90 Locked Shed"], "edits": [], "proposals": [] })
    );
    assert!(allow.status.success(), "{}", errors_of(&allow));
    assert_eq!(json_of(&allow)["edit"]["state"], "proposed");
    assert!(deny.status.success(), "{}", errors_of(&deny));
    assert_eq!(json_of(&deny)["edit"]["state"], "applied");
}

#[test]
fn guards_read_no_network_and_write_nothing() {
    let setup = set_up();
    let unreachable = setup.stores.root().join("unreachable");
    setup.git(&["remote", "set-url", "origin", text(&unreachable)]);
    let before = setup.state();

    let output = setup.run("guards", &[]);

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "{\n  \"denyList\": [\n    \"80 Templates\",\n    \"90 Locked Shed\"\n  ],\n  \"edits\": [],\n  \"proposals\": []\n}\n"
    );
    assert_eq!(setup.state(), before);
    assert!(!setup.local_file("lock").exists());
}

#[test]
fn an_edit_with_a_path_in_another_form_stops_and_changes_nothing() {
    let setup = set_up();
    let before = setup.state();

    for (action, path, says) in [
        ("deny", "../Outside", "is not a vault path"),
        ("allow", "/90 Locked Shed", "is not a vault path"),
        (
            "ignore",
            "10 Garden/Compost basics.MD",
            "does not end in .md",
        ),
        ("unignore", "10 Garden", "does not end in .md"),
    ] {
        assert_refused(&setup.edit(action, path), says);
    }
    assert_eq!(setup.state(), before);
    assert!(!setup.local_file("lock").exists());
}

/// What an edit takes away does not depend on the note types: an edit never
/// asks the Starter Kit, so a missing one does not stop it.
#[test]
fn an_edit_never_asks_the_starter_kit() {
    let setup = set_up();
    setup.publish(&[NOTE]);
    let missing = setup.stores.root().join("no-answers.json");
    let run = |command: &str, path: Option<&str>| {
        let mut program = support::program();
        program
            .arg(command)
            .arg("--vault")
            .arg(&setup.vault)
            .arg("--content-store")
            .arg(&setup.copy)
            .env("DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES", &missing);
        if let Some(path) = path {
            program.args([&format!("--path={path}"), "--time", LATER]);
        }
        program.output().expect("the program starts")
    };

    let status = run("status", None);
    let deny = run("deny", Some("10 Garden"));
    let ignore = run("ignore", Some(DRAFT));

    assert_refused(&status, "Starter Kit");
    assert!(deny.status.success(), "{}", errors_of(&deny));
    assert_eq!(json_of(&deny)["edit"]["removes"], json!([NOTE]));
    assert!(ignore.status.success(), "{}", errors_of(&ignore));
    assert_eq!(json_of(&ignore)["edit"]["state"], "applied");
}

/// `edits.json` in the copy must be the file of its last commit, as the
/// configuration and the manifest: a log that differs would be committed by
/// the next publication or edit as a log that no run wrote.
#[test]
fn a_log_in_the_copy_that_is_not_the_file_of_its_last_commit_stops_every_run() {
    let different = "not the files of its last commit";
    // Every command that checks the copy, with a plan stored before.
    let refuses_all = |setup: &Setup, id: &str, label: &str| {
        for output in [
            setup.run("status", &[]),
            setup.run("plan", &[]),
            setup.publish_plan(id),
            setup.edit("deny", "20 Library"),
        ] {
            assert_eq!(output.status.code(), Some(1), "{label}");
            let message = errors_of(&output);
            assert!(message.contains(different), "{label}: {message}");
            assert!(message.contains("edits.json"), "{label}: {message}");
        }
    };

    // A store with no log in its commit and none in the copy is fine.
    let setup = set_up();
    let status = setup.run("status", &[]);
    assert!(status.status.success(), "{}", errors_of(&status));
    let id = setup.plan_id(&[]);
    // Added and not committed, then added to the index only.
    fs::write(
        setup.copy.join("edits.json"),
        "{\"edits\": [], \"published\": 0}\n",
    )
    .expect("the log is written");
    refuses_all(&setup, &id, "a log that no commit has");
    setup.git(&["add", "--", "edits.json"]);
    refuses_all(&setup, &id, "a log in the index only");

    // A log of the last commit, edited and then removed in the copy.
    let setup = set_up();
    let output = setup.edit("deny", FOLDER);
    assert!(output.status.success(), "{}", errors_of(&output));
    let id = setup.plan_id(&[]);
    let log = setup.copy.join("edits.json");
    let committed = read(&log);
    // An edit of the same size: only the hash shows it.
    fs::write(&log, committed.replace("garden-shed", "garden-shad")).expect("the log is edited");
    refuses_all(&setup, &id, "an edited log");
    fs::remove_file(&log).expect("the log is removed");
    refuses_all(&setup, &id, "a removed log");

    // The log that a copy that converts line ends writes, with Windows line
    // ends, is the file of the commit.
    setup.git(&["config", "core.autocrlf", "true"]);
    setup.git(&["checkout", "--", "edits.json"]);
    assert_eq!(read(&log), committed.replace('\n', "\r\n"));
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    fs::File::options()
        .write(true)
        .open(&log)
        .expect("the log opens")
        .set_modified(later)
        .expect("the time is set");
    let status = setup.run("status", &[]);
    assert!(status.status.success(), "{}", errors_of(&status));
}

/// The removes of a proposed edit, or a failure with the message.
fn removes(output: &Output) -> Value {
    assert!(output.status.success(), "{}", errors_of(output));
    let event = &json_of(output)["edit"];
    assert_eq!(event["state"], "proposed", "{event}");
    event["removes"].clone()
}

/// `removes` is never guessed (review round 1): the forced removals of a
/// scan with the edit applied that are not forced removals now.
#[test]
fn a_published_note_that_a_journal_moves_into_the_folder_is_taken_away() {
    let setup = set_up();
    setup.publish(&[NOTE]);
    // The journal of another device moves the note into the folder; this
    // device still has its old file.
    let moved = setup.vault.join(FOLDER).join("Frost dates explained.md");
    fs::copy(setup.vault.join(NOTE), &moved).expect("the note is copied");
    let journals = setup
        .vault
        .join(".obsidian/plugins/dsebastien-vault-publish/renames");
    fs::create_dir_all(&journals).expect("the folder can be made");
    fs::write(
        journals.join("00000000000000aa.jsonl"),
        format!(
            "{{\"from\":\"{NOTE}\",\"kind\":\"note\",\"time\":\"2031-04-01T09:00:00Z\",\"to\":\"{FOLDER}/Frost dates explained.md\"}}\n"
        ),
    )
    .expect("the journal is written");

    assert_eq!(removes(&setup.edit("deny", FOLDER)), json!([NOTE]));
}

#[test]
fn a_missing_note_with_its_name_in_the_folder_in_another_case_or_form_is_taken_away() {
    let setup = set_up();
    let cafe = "10 Garden/Café.md";
    fs::write(setup.vault.join(cafe), "Coffee grounds\n").expect("the note is written");
    setup.publish(&[NOTE, cafe]);
    // Moved with no journal, in other letters and in the decomposed form.
    fs::rename(
        setup.vault.join(NOTE),
        setup.vault.join(FOLDER).join("FROST DATES explained.md"),
    )
    .expect("the note is moved");
    fs::rename(
        setup.vault.join(cafe),
        setup.vault.join(FOLDER).join("CAFE\u{301}.md"),
    )
    .expect("the note is moved");
    let status = setup.run("status", &[]);
    assert_eq!(json_of(&status)["missing"], json!([cafe, NOTE]));

    assert_eq!(removes(&setup.edit("deny", FOLDER)), json!([cafe, NOTE]));
}

#[test]
fn an_unpublished_entry_in_the_folder_is_taken_away() {
    let setup = set_up();
    setup.publish(&[NOTE]);
    let output = setup.run(
        "unpublish",
        &[
            &format!("--path={NOTE}"),
            "--time",
            LATER,
            "--device",
            "garden-shed",
        ],
    );
    assert!(output.status.success(), "{}", errors_of(&output));

    assert_eq!(removes(&setup.edit("deny", "10 Garden")), json!([NOTE]));
    assert_eq!(removes(&setup.edit("ignore", NOTE)), json!([NOTE]));
}

#[test]
fn an_entry_that_a_guard_takes_away_already_is_not_in_removes() {
    let setup = set_up();
    let mint = "10 Garden/Herb bed/Mint.md";
    setup.publish(&[NOTE, mint]);
    setup.commit_file(
        "configuration.json",
        &format!("{{\"denyList\": [\"80 Templates\", \"90 Locked Shed\", \"{FOLDER}\"]}}\n"),
    );

    // The folder above a folder of the deny list: only the note that the
    // new entry takes away.
    assert_eq!(removes(&setup.edit("deny", "10 Garden")), json!([NOTE]));
    // A folder below a folder of the deny list takes nothing more away.
    let inner = setup.edit("deny", "90 Locked Shed/Attachments");
    assert!(inner.status.success(), "{}", errors_of(&inner));
    assert_eq!(json_of(&inner)["edit"]["state"], "applied");
}

#[test]
fn guards_stop_while_the_lock_of_the_device_is_taken() {
    let setup = set_up();
    fs::create_dir_all(setup.local_file("")).expect("the folder can be made");
    fs::write(setup.local_file("lock"), "{\"command\":\"publish\"}\n").expect("the lock is made");

    assert_refused(&setup.run("guards", &[]), "unlock");
}

/// Rule 8: TypeScript cannot tell `1.0` from `1`, so a number with a fraction
/// or an exponent in the configuration stops a deny before any write.
#[test]
fn a_number_with_a_fraction_or_an_exponent_in_the_configuration_stops_a_deny() {
    let setup = set_up();
    for number in [
        "1e2",
        "1.0",
        "-2.5E-3",
        "-0",
        "-0.0",
        "9007199254740992",
        "-9007199254740992",
    ] {
        setup.commit_file(
            "configuration.json",
            &format!(
                "{{\"denyList\": [\"80 Templates\", \"90 Locked Shed\"], \"version\": {number}}}\n"
            ),
        );
        let before = setup.state();

        let output = setup.edit("deny", FOLDER);

        assert_refused(&output, "is not a whole number");
        assert!(
            errors_of(&output).contains(number),
            "{}",
            errors_of(&output)
        );
        assert_eq!(setup.state(), before);
    }
    // A text that looks like such a number, and a whole number, are kept.
    setup.commit_file(
        "configuration.json",
        "{\"denyList\": [\"80 Templates\", \"90 Locked Shed\"], \"most\": -9007199254740991, \"note\": \"1.5e3\", \"version\": -3, \"zero\": 0}\n",
    );
    let output = setup.edit("deny", FOLDER);
    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(
        read(&setup.copy.join("configuration.json")),
        format!(
            "{{\n  \"denyList\": [\n    \"80 Templates\",\n    \"90 Locked Shed\",\n    \"{FOLDER}\"\n  ],\n  \"most\": -9007199254740991,\n  \"note\": \"1.5e3\",\n  \"version\": -3,\n  \"zero\": 0\n}}\n"
        )
    );
}

/// Writes a line of the rename journal of another device into the vault.
fn write_journal(setup: &Setup, from: &str, to: &str) {
    let journals = setup
        .vault
        .join(".obsidian/plugins/dsebastien-vault-publish/renames");
    fs::create_dir_all(&journals).expect("the folder can be made");
    fs::write(
        journals.join("00000000000000bb.jsonl"),
        format!(
            "{{\"from\":\"{from}\",\"kind\":\"note\",\"time\":\"2031-04-01T09:00:00Z\",\"to\":\"{to}\"}}\n"
        ),
    )
    .expect("the journal is written");
}

/// `affects` names only the published entries that are a forced removal in
/// neither scan (review round 3): a note that the ignore property already
/// takes away loses nothing more.
#[test]
fn a_deny_of_the_image_of_a_note_that_a_guard_takes_away_already_applies() {
    let setup = set_up();
    fs::create_dir_all(setup.vault.join("Pub")).expect("the folder can be made");
    fs::create_dir_all(setup.vault.join("img")).expect("the folder can be made");
    let note = setup.vault.join("Pub/p.md");
    fs::write(&note, "# P\n\n![[pic.png]]\n").expect("the note is written");
    fs::copy(
        setup.vault.join("Attachments/garden-plan.png"),
        setup.vault.join("img/pic.png"),
    )
    .expect("the image is copied");
    setup.publish(&["Pub/p.md"]);
    // The author adds the ignore property by hand.
    fs::write(
        &note,
        "---\npublish_ignore: true\n---\n# P\n\n![[pic.png]]\n",
    )
    .expect("the note is written");

    let output = setup.edit("deny", "img");

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(json_of(&output)["edit"]["state"], "applied");
}

/// Rule 10: a publication from the command line program or the MCP server
/// stops when an edit that applied alone takes an entry away now.
fn assert_publication_stops(setup: &Setup, says: &str) {
    let before = setup.state();
    let id = setup.plan_id(&[]);
    let output = setup.publish_plan(&id);
    assert_refused(&output, "publication center");
    assert!(errors_of(&output).contains(says), "{}", errors_of(&output));
    assert_eq!(setup.state(), before);
}

#[test]
fn a_publication_stops_when_a_journal_line_of_another_device_moves_a_note_under_an_applied_deny() {
    let setup = set_up();
    setup.publish(&[NOTE]);
    let output = setup.edit("deny", FOLDER);
    assert_eq!(json_of(&output)["edit"]["state"], "applied");
    let id = json_of(&output)["edit"]["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    // The vault of another device arrives: its journal moved the note into
    // the folder.
    fs::rename(
        setup.vault.join(NOTE),
        setup.vault.join(FOLDER).join("Frost dates explained.md"),
    )
    .expect("the note is moved");
    write_journal(&setup, NOTE, &format!("{FOLDER}/Frost dates explained.md"));

    assert_publication_stops(&setup, &format!("deny of \"{FOLDER}\" ({id})"));
    assert_publication_stops(&setup, NOTE);
    // An unpublish is a publication: it stops too.
    let output = setup.run(
        "unpublish",
        &[
            &format!("--path={NOTE}"),
            "--time",
            LATER,
            "--device",
            "garden-shed",
        ],
    );
    assert_refused(&output, "publication center");
    assert!(setup.copy.join("notes").join(NOTE).exists());
}

#[test]
fn a_publication_stops_when_a_journal_line_moves_a_note_onto_a_note_of_an_applied_ignore() {
    let setup = set_up();
    setup.publish(&[NOTE]);
    let output = setup.edit("ignore", DRAFT);
    assert_eq!(json_of(&output)["edit"]["state"], "applied");
    // A journal line moves the published note onto the ignored note.
    fs::remove_file(setup.vault.join(NOTE)).expect("the note is removed");
    write_journal(&setup, NOTE, DRAFT);

    assert_publication_stops(&setup, &format!("ignore of \"{DRAFT}\""));
}

#[test]
fn a_publication_stops_when_the_image_of_a_published_note_moves_under_an_applied_deny() {
    let setup = set_up();
    let plan = "10 Garden/Garden plan.md";
    setup.publish(&[plan]);
    let output = setup.edit("deny", FOLDER);
    assert_eq!(json_of(&output)["edit"]["state"], "applied");
    // Later, the image moves into the folder.
    fs::rename(
        setup.vault.join("Attachments/garden-plan.png"),
        setup.vault.join(FOLDER).join("garden-plan.png"),
    )
    .expect("the image is moved");

    assert_publication_stops(&setup, "would lose an attachment");
    assert_publication_stops(&setup, plan);
}
