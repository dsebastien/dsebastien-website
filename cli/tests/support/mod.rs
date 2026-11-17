//! Support for the tests of the command line program: the paths of the fixture
//! vault, and stores that exist for one test.
//!
//! It is the Rust twin of `packages/testing`. Each test file is a crate of its
//! own and takes it with `mod support;`.

// A test file uses a part of this module only, and each one compiles its own
// copy. Without this line, every part that one file does not use is a warning,
// and clippy denies warnings.
#![allow(dead_code)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{self, Command};
use std::sync::atomic::{AtomicU32, Ordering};

/// The root of the repository.
fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the program is in a folder of the repository")
        .to_path_buf()
}

/// The fixture vault: invented notes only. A test never writes into it.
pub fn fixture_vault() -> PathBuf {
    repository().join("fixtures").join("vault")
}

/// The invented configuration of the publishing tool for the fixture vault.
pub fn fixture_configuration() -> PathBuf {
    repository().join("fixtures").join("configuration.json")
}

/// An empty content store and an empty attachment storage that exist for one
/// test. The folder of the test is removed when the value is dropped, also
/// when the test fails.
///
/// The folder is in `.cache` of the clone, which git ignores: nothing that a
/// test writes can enter a commit.
pub struct TestStores {
    root: PathBuf,
    content_store: PathBuf,
    attachment_storage: PathBuf,
}

/// Makes each folder name of one test run different.
static NEXT: AtomicU32 = AtomicU32::new(0);

impl TestStores {
    pub fn new() -> Self {
        let cache = repository().join(".cache").join("test-stores");
        fs::create_dir_all(&cache).expect("the cache folder can be made");
        let name = format!(
            "test-rust-{}-{}",
            process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let root = cache.join(name);
        // `create_dir` fails when the folder exists, so this value owns a
        // folder that it made, and `drop` never removes another one.
        fs::create_dir(&root).expect("the folder of the test is new");

        let stores = Self {
            content_store: root.join("content-store.git"),
            attachment_storage: root.join("attachment-storage"),
            root,
        };
        stores.make_content_store();
        fs::create_dir(&stores.attachment_storage).expect("the attachment storage can be made");
        stores
    }

    /// The folder that was made for the test. A test can add its own folders.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A bare git repository with no commit and the branch `main`. It stands
    /// for the remote repository: a test clones it and pushes to it.
    pub fn content_store(&self) -> &Path {
        &self.content_store
    }

    /// An empty folder that stands for the object storage.
    pub fn attachment_storage(&self) -> &Path {
        &self.attachment_storage
    }

    fn make_content_store(&self) {
        let mut git = Command::new("git");
        git.args(["init", "--quiet", "--bare", "--initial-branch=main"])
            .arg(&self.content_store);
        // Inside a git hook, these variables point git to the clone.
        for (name, _) in env::vars_os() {
            if name.to_string_lossy().starts_with("GIT_") {
                git.env_remove(name);
            }
        }
        let status = git.status().expect("git starts");
        assert!(status.success(), "git could not make the content store");
    }
}

impl Drop for TestStores {
    fn drop(&mut self) {
        // A failure here must not hide the result of the test.
        let _ = fs::remove_dir_all(&self.root);
    }
}
