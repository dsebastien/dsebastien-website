//! How the program ends: the exit codes, and what happens when its output
//! cannot be written.

mod support;

use std::process::{Command, Stdio};

use support::TestStores;

fn plan_command(stores: &TestStores) -> Command {
    let mut command = support::program();
    command
        .arg("plan")
        .arg("--vault")
        .arg(stores.copy_fixture_vault())
        .arg("--content-store")
        .arg(stores.make_content_store_copy());
    command
}

/// The same text as in `parity/publication.spec.ts`. The bytes are the same on
/// every system: no Windows line end.
#[test]
fn writes_an_empty_plan_with_its_id_when_no_note_is_included() {
    let stores = TestStores::new();

    let output = plan_command(&stores).output().expect("the program starts");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
    let text = String::from_utf8(output.stdout).expect("the plan is UTF-8");
    let (id, plan) = text
        .strip_prefix("{\n  \"id\": \"")
        .and_then(|rest| rest.split_once("\",\n"))
        .expect("the output starts with the id");
    assert_eq!(id.len(), 16);
    assert_eq!(
        plan,
        "  \"listsNotRefreshed\": [],\n  \"liveQueries\": [],\n  \"offline\": false,\n  \"plan\": {\n    \"edits\": [],\n    \"forcedRemove\": [],\n    \"guardedAttachments\": [],\n    \"move\": [],\n    \"publish\": [],\n    \"remove\": [],\n    \"update\": []\n  }\n}\n"
    );
}

#[test]
fn stops_when_a_place_is_not_a_folder() {
    let stores = TestStores::new();
    let missing = stores.root().join("No such folder");

    let output = support::program()
        .arg("plan")
        .arg("--vault")
        .arg(&missing)
        .arg("--content-store")
        .arg(stores.root())
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert!(String::from_utf8_lossy(&output.stderr).contains("No such folder"));
}

/// `plan | head` closes the pipe before the program writes. That is not an
/// error, and the program must not panic.
#[test]
fn ends_without_an_error_when_the_reader_closed_the_pipe() {
    let stores = TestStores::new();
    let mut child = plan_command(&stores)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the program starts");
    drop(child.stdout.take());

    let output = child.wait_with_output().expect("the program ends");

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
}

/// A write that fails is an error with a message, not a panic. `/dev/full`
/// is a file of Linux that refuses every write.
#[cfg(target_os = "linux")]
#[test]
fn stops_with_an_error_when_the_output_cannot_be_written() {
    let stores = TestStores::new();
    let full = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/full")
        .expect("the full device can be opened");

    let output = plan_command(&stores)
        .stdout(full)
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    let errors = String::from_utf8_lossy(&output.stderr);
    assert!(errors.starts_with("error: "), "{errors}");
    assert!(!errors.contains("panicked"), "{errors}");
}

/// A `plan` command on one vault and one copy, which it makes one time.
fn plan_command_of(stores: &TestStores) -> impl Fn() -> Command {
    let vault = stores.copy_fixture_vault();
    let copy = stores.make_content_store_copy();
    move || {
        let mut command = support::program();
        command
            .arg("plan")
            .arg("--vault")
            .arg(&vault)
            .arg("--content-store")
            .arg(&copy);
        command
    }
}

/// The text of the output of a plan, without its id.
fn plan_of(output: &std::process::Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.split_once("\"plan\"")
        .map(|(_, plan)| plan.to_owned())
        .expect("the output has the plan")
}

/// A first publication can hold more paths than the system takes as
/// arguments of one command, so the selection can come from a file.
#[test]
fn reads_the_selection_from_a_file_as_it_reads_the_options() {
    let stores = TestStores::new();
    let plan_command = plan_command_of(&stores);
    let file = stores.root().join("selection.json");
    std::fs::write(
        &file,
        r#"{"include": ["Welcome.md", "10 Garden/Frost dates explained.md"]}"#,
    )
    .expect("the file is written");

    let from_file = plan_command()
        .arg("--selection")
        .arg(&file)
        .output()
        .expect("the program starts");
    let from_options = plan_command()
        .arg("--include=Welcome.md")
        .arg("--include=10 Garden/Frost dates explained.md")
        .output()
        .expect("the program starts");

    assert_eq!(plan_of(&from_file), plan_of(&from_options));
    assert!(plan_of(&from_file).contains("Welcome.md"));
}

#[test]
fn stops_on_a_selection_file_that_is_not_a_selection() {
    let stores = TestStores::new();
    let plan_command = plan_command_of(&stores);
    let file = stores.root().join("selection.json");
    for text in [
        "not JSON",
        r#"{"include": "Welcome.md"}"#,
        r#"{"include": [1]}"#,
        r#"{"includes": ["Welcome.md"]}"#,
        r#"["Welcome.md"]"#,
    ] {
        std::fs::write(&file, text).expect("the file is written");

        let output = plan_command()
            .arg("--selection")
            .arg(&file)
            .output()
            .expect("the program starts");

        assert_eq!(output.status.code(), Some(1), "{text}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("selection"),
            "{text}"
        );
    }
}

#[test]
fn does_not_take_a_selection_file_and_paths_together() {
    let stores = TestStores::new();
    let file = stores.root().join("selection.json");
    std::fs::write(&file, r#"{"include": []}"#).expect("the file is written");

    let output = plan_command(&stores)
        .arg("--selection")
        .arg(&file)
        .arg("--include=Welcome.md")
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(2));
}
