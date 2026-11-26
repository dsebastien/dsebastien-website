//! The program of the Obsidian Starter Kit, which gives the note type of each
//! note (decision R61, `documentation/Canonical Form.md`, "The note type of a
//! note"). The other tests answer from a file through the switch of the debug
//! build; these run a program, as a release build does.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use support::TestStores;

/// A vault with one note, published one time with no type, and its copy of
/// the content store.
struct Published {
    stores: TestStores,
    vault: PathBuf,
    copy: PathBuf,
}

fn json_of(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("the output is JSON")
}

fn errors_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

impl Published {
    fn new() -> Self {
        let stores = TestStores::new();
        let vault = stores.root().join("vault");
        fs::create_dir(&vault).expect("the vault can be made");
        fs::write(vault.join("A.md"), "Alpha\n").expect("the note can be written");
        // The folders of the deny list of the fixture configuration.
        for folder in ["80 Templates", "90 Locked Shed"] {
            fs::create_dir(vault.join(folder)).expect("the folder can be made");
        }
        let copy = stores.make_content_store_copy();
        let published = Self {
            stores,
            vault,
            copy,
        };
        let planned = published
            .command("plan")
            .args(["--include", "A.md"])
            .output()
            .expect("the program starts");
        assert!(planned.status.success(), "{}", errors_of(&planned));
        let id = json_of(&planned)["id"]
            .as_str()
            .expect("the plan has an id")
            .to_owned();
        let done = published
            .command("publish")
            .arg("--attachment-storage")
            .arg(published.stores.attachment_storage())
            .arg("--no-deploy")
            .args(["--plan", &id, "--time", "2031-07-01T08:00:00Z"])
            .output()
            .expect("the program starts");
        assert!(done.status.success(), "{}", errors_of(&done));
        published
    }

    /// A command with the Starter Kit of the tests: no note has a type.
    fn command(&self, command: &str) -> Command {
        let mut program = support::program();
        program
            .arg(command)
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy);
        program
    }

    /// `status` with a real program of the Starter Kit: the switch of the
    /// tests is off.
    fn status_with(&self, program: Option<&Path>) -> Output {
        let mut status = self.command("status");
        status.env_remove("DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES");
        if let Some(program) = program {
            status.arg("--osk-cli").arg(program);
        }
        status.output().expect("the program starts")
    }
}

#[test]
fn stops_when_the_program_of_the_starter_kit_is_missing() {
    let published = Published::new();
    let missing = published.stores.root().join("no-osk-cli");

    let output = published.status_with(Some(&missing));

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert!(
        errors_of(&output).contains("the Obsidian Starter Kit cannot give the note types"),
        "{}",
        errors_of(&output)
    );
    assert!(errors_of(&output).contains("no-osk-cli"));
}

#[test]
fn stops_when_the_starter_kit_is_not_in_the_vault() {
    let published = Published::new();

    let output = published.status_with(None);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("obsidian-starter-kit"),
        "{}",
        errors_of(&output)
    );
}

/// A program of the Starter Kit: a shell script that keeps its arguments and
/// its input, and writes the answer (or fails with `status`).
#[cfg(unix)]
fn script(path: &Path, answer: &str, status: u8) {
    use std::os::unix::fs::PermissionsExt;

    let folder = path.parent().expect("the script is in a folder");
    fs::create_dir_all(folder).expect("the folder can be made");
    let kept = folder.join("kept");
    fs::write(
        path,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}.arguments'\ncat > '{}.input'\nprintf '%s' '{answer}'\nprintf 'a failure of the Starter Kit' >&2\nexit {status}\n",
            kept.display(),
            kept.display()
        ),
    )
    .expect("the script can be written");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .expect("the script can be made a program");
}

#[cfg(unix)]
#[test]
fn asks_the_program_with_the_published_notes_on_its_input() {
    let published = Published::new();
    let program = published.stores.root().join("kit").join("osk-cli");
    script(
        &program,
        r#"{"noteTypes":[],"notes":[{"path":"A.md","noteType":null}]}"#,
        0,
    );

    let output = published.status_with(Some(&program));

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(json_of(&output)["unchanged"], serde_json::json!(["A.md"]));
    let folder = program.parent().expect("a folder");
    assert_eq!(
        fs::read_to_string(folder.join("kept.arguments")).expect("the arguments were kept"),
        format!("recognize\n--vault\n{}\n", published.vault.display())
    );
    assert_eq!(
        fs::read_to_string(folder.join("kept.input")).expect("the input was kept"),
        "A.md\n"
    );
}

#[cfg(unix)]
#[test]
fn runs_the_program_that_the_plugin_installs_in_the_vault_by_default() {
    let published = Published::new();
    // A plugin installed by hand, in a folder that is not named by its id,
    // beside another plugin: the manifest says which one is the Starter Kit.
    let plugins = published.vault.join(".obsidian/plugins");
    for (folder, id) in [
        ("another", "another-plugin"),
        ("osk-by-hand", "obsidian-starter-kit"),
    ] {
        fs::create_dir_all(plugins.join(folder)).expect("the folder can be made");
        fs::write(
            plugins.join(folder).join("manifest.json"),
            format!("{{\"id\": \"{id}\"}}"),
        )
        .expect("the manifest can be written");
    }
    let program = plugins.join("osk-by-hand").join("osk-cli");
    script(
        &program,
        r#"{"noteTypes":[{"name":"letters","displayName":"Letters","prefix":"","suffix":""}],"notes":[{"path":"A.md","noteType":"letters"}]}"#,
        0,
    );

    let output = published.status_with(None);

    assert!(output.status.success(), "{}", errors_of(&output));
    // The note got a type: a technical update.
    assert_eq!(
        json_of(&output)["technicalUpdates"],
        serde_json::json!(["A.md"])
    );
}

#[cfg(unix)]
#[test]
fn stops_with_the_message_of_a_program_that_fails() {
    let published = Published::new();
    let program = published.stores.root().join("kit").join("osk-cli");
    script(&program, "", 1);

    let output = published.status_with(Some(&program));

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("ended with an error: a failure of the Starter Kit"),
        "{}",
        errors_of(&output)
    );
}

#[cfg(unix)]
#[test]
fn stops_when_the_program_writes_no_json() {
    let published = Published::new();
    let program = published.stores.root().join("kit").join("osk-cli");
    script(&program, "not JSON", 0);

    let output = published.status_with(Some(&program));

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("wrote no JSON"),
        "{}",
        errors_of(&output)
    );
}

#[cfg(unix)]
#[test]
fn stops_a_program_that_does_not_end_in_time() {
    let published = Published::new();
    let program = published.stores.root().join("kit").join("osk-cli");
    fs::create_dir_all(program.parent().expect("a folder")).expect("the folder can be made");
    fs::write(&program, "#!/bin/sh\nsleep 30\n").expect("the script can be written");
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755))
            .expect("the script can be made a program");
    }

    let mut status = published.command("status");
    status
        .env_remove("DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES")
        .env("DSEBASTIEN_VAULT_PUBLISH_TEST_OSK_CLI_SECONDS", "1")
        .arg("--osk-cli")
        .arg(&program);
    let started = std::time::Instant::now();
    let output = status.output().expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    assert!(started.elapsed().as_secs() < 20);
    assert!(
        errors_of(&output).contains("did not end within 1 seconds"),
        "{}",
        errors_of(&output)
    );
}

#[cfg(unix)]
#[test]
fn never_asks_the_program_about_a_note_under_a_guard() {
    let published = Published::new();
    // A second published note, which the author then excludes.
    fs::write(published.vault.join("B.md"), "Beta\n").expect("the note can be written");
    let planned = published
        .command("plan")
        .args(["--include", "B.md"])
        .output()
        .expect("the program starts");
    let id = json_of(&planned)["id"].as_str().expect("an id").to_owned();
    let done = published
        .command("publish")
        .arg("--attachment-storage")
        .arg(published.stores.attachment_storage())
        .arg("--no-deploy")
        .args(["--plan", &id, "--time", "2031-07-02T08:00:00Z"])
        .output()
        .expect("the program starts");
    assert!(done.status.success(), "{}", errors_of(&done));
    fs::write(
        published.vault.join("B.md"),
        "---\npublish_ignore: true\n---\nBeta\n",
    )
    .expect("the note can be written");
    let program = published.stores.root().join("kit").join("osk-cli");
    script(
        &program,
        r#"{"noteTypes":[],"notes":[{"path":"A.md","noteType":null}]}"#,
        0,
    );

    let output = published.status_with(Some(&program));

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(json_of(&output)["toRemove"], serde_json::json!(["B.md"]));
    assert_eq!(
        fs::read_to_string(program.parent().expect("a folder").join("kept.input"))
            .expect("the input was kept"),
        "A.md\n"
    );
}

/// Two plugin folders with the id of the Starter Kit: the one that `osk-cli`
/// takes runs, and the other one fails.
#[cfg(unix)]
fn two_plugins(published: &Published, folders: [(&str, bool, bool); 2]) {
    let plugins = published.vault.join(".obsidian/plugins");
    for (folder, configured, chosen) in folders {
        let folder = plugins.join(folder);
        fs::create_dir_all(&folder).expect("the folder can be made");
        fs::write(
            folder.join("manifest.json"),
            r#"{"id": "obsidian-starter-kit"}"#,
        )
        .expect("the manifest can be written");
        if configured {
            fs::write(folder.join("data.json"), "{}").expect("the settings can be written");
        }
        if chosen {
            script(
                &folder.join("osk-cli"),
                r#"{"noteTypes":[],"notes":[{"path":"A.md","noteType":null}]}"#,
                0,
            );
        } else {
            script(&folder.join("osk-cli"), "", 1);
        }
    }
}

#[cfg(unix)]
#[test]
fn takes_the_plugin_folder_named_by_the_id_when_it_has_settings() {
    let published = Published::new();
    two_plugins(
        &published,
        [
            ("a-osk-backup", true, false),
            ("obsidian-starter-kit", true, true),
        ],
    );

    let output = published.status_with(None);

    assert!(output.status.success(), "{}", errors_of(&output));
}

#[cfg(unix)]
#[test]
fn takes_a_plugin_folder_with_settings_over_one_without() {
    let published = Published::new();
    two_plugins(
        &published,
        [("a-old-copy", false, false), ("z-osk", true, true)],
    );

    let output = published.status_with(None);

    assert!(output.status.success(), "{}", errors_of(&output));
}

#[cfg(unix)]
#[test]
fn never_asks_the_program_about_a_note_whose_path_holds_a_line_feed() {
    // Windows cannot hold such a path, so a plan never publishes it (R82): the
    // refusal comes first, and the note stays a candidate that the program of
    // the Starter Kit is never asked about (R61, R72).
    let published = Published::new();
    fs::write(published.vault.join("a\nb.md"), "Odd\n").expect("the note can be written");
    let refused = published
        .command("plan")
        .args(["--include", "a\nb.md"])
        .output()
        .expect("the program starts");
    assert!(!refused.status.success(), "the plan must stop");
    assert!(
        errors_of(&refused).contains("Windows cannot hold its path"),
        "{}",
        errors_of(&refused)
    );
    let program = published.stores.root().join("kit").join("osk-cli");
    script(
        &program,
        r#"{"noteTypes":[],"notes":[{"path":"A.md","noteType":null}]}"#,
        0,
    );

    let output = published.status_with(Some(&program));

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(json_of(&output)["unchanged"], serde_json::json!(["A.md"]));
    assert_eq!(json_of(&output)["new"], serde_json::json!(["a\nb.md"]));
    assert_eq!(
        fs::read_to_string(program.parent().expect("a folder").join("kept.input"))
            .expect("the input was kept"),
        "A.md\n"
    );
}
