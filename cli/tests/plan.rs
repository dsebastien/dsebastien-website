//! The `plan` command writes a publication plan in the canonical form
//! (`documentation/Canonical Form.md`). The skeleton gives an empty plan.

mod support;

use std::process::{Command, Output};

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
