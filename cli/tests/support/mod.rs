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
use std::fmt::Write as _;
use std::fs;
use std::io::ErrorKind;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use sha2::{Digest, Sha256};

/// The root of the repository.
fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the program is in a folder of the repository")
        .to_path_buf()
}

/// The program of the tool, with the Starter Kit of the tests: no note has a
/// type (the switch `DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES` of the debug
/// build, decision R61). A test that needs types sets the switch to a file
/// of answers. No test reaches the real main site: no post is checked (the
/// switch `DSEBASTIEN_VAULT_PUBLISH_TEST_MAIN_SITE`, PUB-100), unless a test
/// gives a file of answers.
///
/// It sets the seal key of the vault (R104) in the environment, a key built at
/// run time: `seal_key()`, the same as the TypeScript test preload uses, so
/// that parity runs agree.
pub fn program() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"));
    command.env("VAULT_PUBLISH_SEAL_KEY", seal_key());
    command.env("DSEBASTIEN_VAULT_PUBLISH_TEST_NOTE_TYPES", "none");
    command.env("DSEBASTIEN_VAULT_PUBLISH_TEST_MAIN_SITE", "none");
    command
}

/// The fixture file of the answers of the Starter Kit for the fixture vault.
pub fn fixture_note_types() -> PathBuf {
    repository().join("fixtures").join("note-types.json")
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

    /// Makes the content store refuse every push, as when another device
    /// pushes between the fetch of a publication and its push. A test of a
    /// refused push cannot let another device push first: the fetch of the
    /// publication would see it, and stop the run before the push.
    pub fn refuse_pushes(&self) {
        let hooks = self.content_store.join("hooks");
        fs::create_dir_all(&hooks).expect("the folder can be made");
        let hook = hooks.join("pre-receive");
        fs::write(
            &hook,
            "#!/bin/sh\necho \"another device pushed first\" >&2\nexit 1\n",
        )
        .expect("the hook is written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755))
                .expect("the hook can run");
        }
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

/// The seal key of the tests: 32 bytes of `5e`, built at run time. It is never
/// stored as text in a file.
pub fn seal_key() -> String {
    "5e".repeat(32)
}

/// Runs git on a repository that is named in the arguments (`--git-dir`,
/// `-C`), with an environment that points to no other repository.
///
/// A commit that it makes is sealed with the key of the tests (`seal_head`): a
/// commit by hand in a test stands for the commit of a tool, possibly on
/// another device. A test of a commit that no tool wrote uses `git_unsealed`.
pub fn git(args: &[&str]) -> String {
    let output = git_unsealed(args);
    if let Some(copy) = committed_copy(args) {
        seal_head(copy);
    }
    output
}

/// The folder of a `git -C <folder> commit ...` command.
fn committed_copy<'a>(args: &[&'a str]) -> Option<&'a str> {
    let mut folder = None;
    let mut index = 0;
    while index < args.len() {
        match args[index] {
            "-C" => {
                folder = args.get(index + 1).copied();
                index += 2;
            }
            "-c" => index += 2,
            "commit" => return folder,
            _ => return None,
        }
    }
    None
}

/// Runs git as `git` does, and seals nothing.
pub fn git_unsealed(args: &[&str]) -> String {
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

/// The HMAC-SHA256 of RFC 2104, in small hexadecimal digits.
fn hmac(key: &[u8], text: &str) -> String {
    let mut block = [0_u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(text.as_bytes());
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    hex(&outer.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut hex, byte| {
        let _ = write!(hex, "{byte:02x}");
        hex
    })
}

/// The seal of a commit with these parents and its files, as
/// `git ls-tree -r -z --full-tree` lists them: every file but `redirects.json`
/// at the root, one record ended by a NUL each.
fn seal_of(key: &[u8], parents: &[String], listing: &str) -> String {
    let mut lines: Vec<(&str, String)> = Vec::new();
    for entry in listing.split('\0').filter(|entry| !entry.is_empty()) {
        let (facts, path) = entry.split_once('\t').expect("a line of the tree");
        let mut parts = facts.split(' ');
        let (mode, kind, object) = (
            parts.next().expect("a mode"),
            parts.next().expect("a type"),
            parts.next().expect("an object"),
        );
        if (kind == "blob" || kind == "commit") && path != "redirects.json" {
            lines.push((path, format!("{mode} {object} {path}\0")));
        }
    }
    lines.sort();
    let state: String = lines.into_iter().map(|(_, line)| line).collect();
    let mut text = String::from("dsebastien-vault-publish seal 1\n");
    if parents.is_empty() {
        text.push_str("parent none\n");
    }
    for parent in parents {
        let _ = writeln!(text, "parent {parent}");
    }
    let _ = writeln!(text, "state {}", hex(&Sha256::digest(state.as_bytes())));
    hmac(key, &text)
}

/// Every parent of a commit of a repository, in the order of git.
fn parents_of(copy: &str, revision: &str) -> Vec<String> {
    git_unsealed(&[
        "-C",
        copy,
        "rev-list",
        "--parents",
        "--max-count=1",
        revision,
    ])
    .split_whitespace()
    .skip(1)
    .map(str::to_owned)
    .collect()
}

/// The seal that a tool would give a commit of a copy, with the key of the
/// tests: from its parents and its sealed files.
pub fn expected_seal(copy: &str, revision: &str) -> String {
    let parents = parents_of(copy, revision);
    let mut git = Command::new("git");
    git.args(["-C", copy, "ls-tree", "-r", "-z", "--full-tree", revision]);
    for (name, _) in env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            git.env_remove(name);
        }
    }
    let output = git.output().expect("git starts");
    assert!(output.status.success(), "git ls-tree failed");
    seal_of(
        &[0x5e_u8; 32],
        &parents,
        &String::from_utf8_lossy(&output.stdout),
    )
}

/// Makes the last commit of a copy again, with the same tree and parent and
/// a valid seal of the tests as the last line of its message, as a tool does.
/// Call it on a commit that is not pushed yet.
pub fn seal_head(copy: &str) {
    let run = |args: &[&str]| {
        let mut all = vec!["-C", copy];
        all.extend_from_slice(args);
        git_unsealed(&all)
    };
    let head = run(&["rev-parse", "HEAD"]);
    let parents = parents_of(copy, "HEAD");
    let seal = expected_seal(copy, "HEAD");
    let message = format!(
        "{}\n\nSeal: {seal}\n",
        run(&["log", "--max-count=1", "--format=%B", "HEAD"]).trim_end_matches('\n')
    );
    let tree = run(&["rev-parse", "HEAD^{tree}"]);
    let mut commit = Command::new("git");
    commit.args(["-C", copy, "commit-tree", &tree]);
    for parent in &parents {
        commit.args(["-p", parent]);
    }
    for (name, _) in env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            commit.env_remove(name);
        }
    }
    let mut child = commit
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("git starts");
    child
        .stdin
        .take()
        .expect("git has an input")
        .write_all(message.as_bytes())
        .expect("the message is written");
    let output = child.wait_with_output().expect("git ends");
    assert!(
        output.status.success(),
        "git commit-tree failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let sealed = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    run(&["update-ref", "HEAD", &sealed, &head]);
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
