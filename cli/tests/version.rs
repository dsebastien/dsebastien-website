//! The program says which program and which version it is, and it does
//! nothing without a command.

use std::process::Command;

fn program() -> Command {
    Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
}

#[test]
fn prints_its_name_and_version() {
    let output = program()
        .arg("--version")
        .output()
        .expect("the program starts");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim_end(),
        concat!("dsebastien-vault-publish ", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn asks_for_a_command_when_it_gets_none() {
    let output = program().output().expect("the program starts");

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
}
