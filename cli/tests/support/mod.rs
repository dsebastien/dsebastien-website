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
use std::io::ErrorKind;
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
        let root = Self::make_root(&cache);

        let stores = Self {
            content_store: root.join("content-store.git"),
            attachment_storage: root.join("attachment-storage"),
            root,
        };
        stores.make_content_store();
        fs::create_dir(&stores.attachment_storage).expect("the attachment storage can be made");
        stores
    }

    /// Makes a new folder for one test.
    ///
    /// `create_dir` fails when the folder exists, so this value owns a folder
    /// that it made, and `drop` never removes another one. A folder of an
    /// earlier run with the same process id can still be there: the next
    /// number is tried.
    fn make_root(cache: &Path) -> PathBuf {
        loop {
            let name = format!(
                "test-rust-{}-{}",
                process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            let root = cache.join(name);
            match fs::create_dir(&root) {
                Ok(()) => return root,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                Err(error) => panic!("the folder of the test cannot be made: {error}"),
            }
        }
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
        // An empty template: the store gets no sample hook of the machine.
        git.args([
            "init",
            "--quiet",
            "--bare",
            "--initial-branch=main",
            "--template=",
        ])
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

/// Runs git on a repository that is named in the arguments (`--git-dir`,
/// `-C`), with an environment that points to no other repository.
pub fn git(args: &[&str]) -> String {
    let mut git = Command::new("git");
    git.args(args);
    for (name, _) in env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            git.env_remove(name);
        }
    }
    let output = git.output().expect("git starts");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned()
}

pub fn text(path: &Path) -> &str {
    path.to_str().expect("the path is valid UTF-8")
}

fn copy_folder(from: &Path, to: &Path) {
    fs::create_dir(to).expect("the folder of the copy is new");
    for entry in fs::read_dir(from).expect("the folder can be read") {
        let entry = entry.expect("the entry can be read");
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_folder(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("the file can be copied");
        }
    }
}

impl TestStores {
    /// Copies the fixture vault into the folder of the test and returns the
    /// path of the copy. A test never writes into the fixture vault itself.
    pub fn copy_fixture_vault(&self) -> PathBuf {
        let vault = self.root.join("vault");
        copy_folder(&fixture_vault(), &vault);
        vault
    }

    /// Makes the copy of the content store on which the publishing tool works:
    /// a clone of the content store of the test, with an invented author. Its
    /// first commit holds the configuration of the fixture vault and is
    /// pushed, because the configuration of the tool lives in the content
    /// store (GATE-04).
    pub fn make_content_store_copy(&self) -> PathBuf {
        let copy = self.root.join("copy");
        git(&["clone", "--quiet", text(&self.content_store), text(&copy)]);
        let run = |args: &[&str]| {
            let mut all = vec!["-C", text(&copy)];
            all.extend_from_slice(args);
            git(&all)
        };
        run(&["config", "user.name", "Test"]);
        run(&["config", "user.email", "test@example.invalid"]);
        run(&["config", "commit.gpgsign", "false"]);
        run(&["checkout", "--quiet", "-B", "main"]);
        fs::copy(fixture_configuration(), copy.join("configuration.json"))
            .expect("the configuration can be copied");
        run(&["add", "configuration.json"]);
        run(&[
            "commit",
            "--quiet",
            "--message",
            "Add the configuration of the fixture vault",
        ]);
        run(&["push", "--quiet", "origin", "HEAD:main"]);
        copy
    }
}
