//! The `plan` command writes a publication plan in the canonical form
//! (`documentation/Canonical Form.md`). The skeleton gives an empty plan.

mod support;

use std::process::{Command, Output, Stdio};

use support::fixture_vault;

fn plan(vault: &std::path::Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
        .arg("plan")
        .arg("--vault")
        .arg(vault)
        .output()
        .expect("the program starts")
}

/// The same text as in `parity/plan.spec.ts`. The bytes are the same on every
/// system: no Windows line end.
#[test]
fn writes_an_empty_plan_in_the_canonical_form() {
    let output = plan(&fixture_vault());

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("the plan is UTF-8"),
        "{\n  \"publish\": [],\n  \"remove\": [],\n  \"update\": []\n}\n"
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
}

#[test]
fn stops_when_the_vault_is_not_a_folder() {
    let missing = fixture_vault().join("No such folder");

    let output = plan(&missing);

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert!(String::from_utf8_lossy(&output.stderr).contains("No such folder"));
}

/// `plan | head` closes the pipe before the program writes. That is not an
/// error, and the program must not panic.
#[test]
fn ends_without_an_error_when_the_reader_closed_the_pipe() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
        .arg("plan")
        .arg("--vault")
        .arg(fixture_vault())
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
    let full = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/full")
        .expect("the full device can be opened");

    let output = Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
        .arg("plan")
        .arg("--vault")
        .arg(fixture_vault())
        .stdout(full)
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    let errors = String::from_utf8_lossy(&output.stderr);
    assert!(errors.starts_with("error: "), "{errors}");
    assert!(!errors.contains("panicked"), "{errors}");
}
