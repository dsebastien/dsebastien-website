//! The program exists and says which program and which version it is.
//! It does nothing else yet: the publishing logic starts with issue 29.

use std::process::Command;

#[test]
fn prints_its_name_and_version() {
    let output = Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
        .output()
        .expect("the program starts");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim_end(),
        concat!("dsebastien-vault-publish ", env!("CARGO_PKG_VERSION"))
    );
}
