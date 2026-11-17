//! A test gets an empty content store and an empty attachment storage of its
//! own, and they are removed after it.

mod support;

use std::fs;
use std::path::Path;
use std::process::Command;

use support::TestStores;

fn commit_count(repository: &Path) -> String {
    let output = Command::new("git")
        .args(["rev-list", "--all", "--count"])
        .current_dir(repository)
        .output()
        .expect("git starts");
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn entry_count(folder: &Path) -> usize {
    fs::read_dir(folder)
        .expect("the folder can be read")
        .count()
}

#[test]
fn the_content_store_is_a_git_repository_with_no_commit() {
    let stores = TestStores::new();

    assert_eq!(commit_count(stores.content_store()), "0");
}

#[test]
fn the_attachment_storage_is_an_empty_folder() {
    let stores = TestStores::new();

    assert_eq!(entry_count(stores.attachment_storage()), 0);
}

#[test]
fn the_stores_are_removed_after_the_test() {
    let stores = TestStores::new();
    let root = stores.root().to_path_buf();
    assert!(root.is_dir());

    drop(stores);

    assert!(!root.exists());
}

#[test]
fn a_removal_leaves_the_stores_of_another_test() {
    let kept = TestStores::new();
    let removed = TestStores::new();
    assert_ne!(kept.root(), removed.root());

    drop(removed);

    assert_eq!(commit_count(kept.content_store()), "0");
    assert_eq!(entry_count(kept.attachment_storage()), 0);
}
