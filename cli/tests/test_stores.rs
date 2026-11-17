//! A test gets an empty content store and an empty attachment storage of its
//! own, and they are removed after it.

mod support;

use std::fs;
use std::path::Path;
use std::process::Command;

use support::TestStores;

/// Runs git on a repository that is named with `--git-dir` or `-C`, never
/// through the current folder: git can refuse a bare repository that it finds
/// by itself (`safe.bareRepository`).
fn git(args: &[&str]) -> String {
    let output = Command::new("git").args(args).output().expect("git starts");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn text(path: &Path) -> &str {
    path.to_str().expect("the path is valid UTF-8")
}

fn commit_count(content_store: &Path) -> String {
    git(&[
        "--git-dir",
        text(content_store),
        "rev-list",
        "--all",
        "--count",
    ])
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
fn the_content_store_has_the_branch_main() {
    let stores = TestStores::new();

    let head = git(&[
        "--git-dir",
        text(stores.content_store()),
        "symbolic-ref",
        "HEAD",
    ]);

    assert_eq!(head, "refs/heads/main");
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

/// The publishing tool works on a copy of the content store and pushes to it.
/// Git makes its object files read-only, and the removal must still work, on
/// Windows too.
#[test]
fn the_content_store_takes_a_push_and_is_removed_after_it() {
    let stores = TestStores::new();
    let root = stores.root().to_path_buf();
    let copy = root.join("copy");
    git(&[
        "clone",
        "--quiet",
        text(stores.content_store()),
        text(&copy),
    ]);
    fs::write(copy.join("note.md"), "An invented note.\n").expect("the note can be written");
    git(&["-C", text(&copy), "add", "note.md"]);
    git(&[
        "-C",
        text(&copy),
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--message",
        "publish one note",
    ]);
    git(&["-C", text(&copy), "push", "--quiet", "origin", "HEAD:main"]);

    let pushed = git(&[
        "--git-dir",
        text(stores.content_store()),
        "show",
        "main:note.md",
    ]);
    assert_eq!(pushed, "An invented note.");

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
