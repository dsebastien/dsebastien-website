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
        errors_of(&output).contains("obsidian-starter-kit-plugin"),
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
    let program = published
        .vault
        .join(".obsidian/plugins/obsidian-starter-kit-plugin/osk-cli");
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
