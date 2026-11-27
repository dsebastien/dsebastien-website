//! The device: the vault and the copy of the content store as folders, with
//! the `git` program of the system (TOOL-12 of the spec). The TypeScript twin
//! is `apps/plugin/src/publishing/node/device.ts`.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::env;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};

use crate::canonical::to_canonical_json;
use crate::deploy::{
    ChildRun, DeployCommand, DeployProcess, DeployRecord, Stop, TakedownEntry, TakedownMarker,
    takedown_entry_of, takedown_entry_text,
};
use crate::names::{is_changed_by_windows, is_refused_by_windows};

/// How a check of the copy reaches the content store: `None` reads no
/// network (`status`), `Try` fetches and uses the last fetch when the content
/// store cannot be reached (`plan`), `Must` fetches and fails when it cannot
/// (`publish`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fetch {
    None,
    Try,
    Must,
}

/// What a check of the copy found.
pub struct Verified {
    /// The number of commits of the branch `main` of the content store, at
    /// the last fetch, that the copy does not have.
    pub behind: u64,
    /// False when the check tried to fetch and the content store could not be
    /// reached.
    pub reached: bool,
}

/// The lock of the device, as `lock` found it.
pub enum Lock {
    /// The run took the lock, with this text.
    Taken(String),
    /// Another run holds the lock, with this text.
    Held(String),
}

/// What the copy did with the files of a publication that stopped halfway.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    /// The commit of the run arrived in the content store.
    Pushed,
    /// The copy is back at the commit before the run.
    Undone,
}

/// Why a fetch failed.
enum FetchFailure {
    /// The content store cannot be reached: no network, or no such
    /// repository.
    Unreachable(String),
    /// The copy cannot be trusted.
    Other(String),
}

/// A test switch: a debug build of the program stops at this point when the
/// environment names it, as after a power cut (issue 36). A release build has
/// no such switch.
pub fn crash_point(point: &str) {
    #[cfg(debug_assertions)]
    if env::var_os("DSEBASTIEN_VAULT_PUBLISH_TEST_CRASH").is_some_and(|value| value == point) {
        eprintln!("test switch: the run stops at \"{point}\"");
        std::process::exit(99);
    }
    #[cfg(not(debug_assertions))]
    let _ = point;
}

/// A switch of the debug build for the tests of the lock (issue 78): at the
/// step `point`, the lock of the copy is given to another run, as when the
/// author ran unlock and another publication took the copy. The release
/// build has no switch.
pub fn steal_point(point: &str, store: &ContentStore) {
    #[cfg(debug_assertions)]
    if env::var_os("DSEBASTIEN_VAULT_PUBLISH_TEST_STEAL_LOCK").is_some_and(|value| value == point) {
        eprintln!("test switch: another run takes the lock at \"{point}\"");
        let _ = fs::write(
            store.local_file("lock"),
            "{\"device\":\"another run\",\"token\":\"another\"}",
        );
    }
    #[cfg(not(debug_assertions))]
    let _ = (point, store);
}

/// What a folder holds at exactly one path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    File,
    Folder,
}

/// The listing of one folder: its files and its folders, by their names. A
/// symbolic link is neither, and a name that is not valid Unicode has no exact
/// name, so it matches no path.
struct Listing {
    /// The files and the folders, with the replacement character in a name in
    /// the place of what cannot be read.
    entries: Vec<(String, Entry)>,
    /// The files and the folders whose names are valid Unicode, by name.
    exact: HashMap<String, Entry>,
}

/// The vault: the only source of content.
///
/// A vault lives for one run of the program: it lists each folder one time and
/// keeps the listing until the end of the run (issue 69). A check of the exact
/// path of a note would else list the folder of each note again.
pub struct Vault {
    folder: PathBuf,
    listings: RefCell<HashMap<String, Rc<Listing>>>,
}

impl Vault {
    pub fn new(folder: &Path) -> Self {
        Self {
            folder: folder.to_path_buf(),
            listings: RefCell::new(HashMap::new()),
        }
    }

    /// The listing of one folder, read one time per run.
    fn listing(&self, folder: &str) -> Result<Rc<Listing>, String> {
        if let Some(listing) = self.listings.borrow().get(folder) {
            return Ok(Rc::clone(listing));
        }
        let failed = |error: std::io::Error| {
            format!("the folder \"{folder}\" of the vault cannot be listed: {error}")
        };
        let mut listing = Listing {
            entries: Vec::new(),
            exact: HashMap::new(),
        };
        for entry in fs::read_dir(self.folder.join(folder)).map_err(failed)? {
            let entry = entry.map_err(failed)?;
            let name = entry.file_name();
            // A name that Windows changes would open another entry, also a
            // folder of the deny list (issue 79): it is no entry.
            if name.to_str().is_some_and(is_changed_by_windows) {
                continue;
            }
            let kind = entry.file_type().map_err(failed)?;
            // A symbolic link is neither a file nor a folder of the vault.
            let kind = if kind.is_file() {
                Entry::File
            } else if kind.is_dir() {
                Entry::Folder
            } else {
                continue;
            };
            if let Some(exact) = name.to_str() {
                listing.exact.insert(exact.to_owned(), kind);
            }
            listing
                .entries
                .push((name.to_string_lossy().into_owned(), kind));
        }
        let listing = Rc::new(listing);
        self.listings
            .borrow_mut()
            .insert(folder.to_owned(), Rc::clone(&listing));
        Ok(listing)
    }

    /// What the vault holds at exactly this path: a file, a folder, or nothing.
    ///
    /// Each part of the path must be a name of the folder listing. A file
    /// system that ignores letter case would else open `90 locked shed/` for
    /// the folder `90 Locked Shed/` of the deny list. A symbolic link is
    /// nothing: it can lead to a file that the guards would refuse, or out of
    /// the vault. The listing is the one of the run, and the kind of each part
    /// is read again now, so a part that became a link since is nothing too.
    fn exact_entry(&self, path: &str) -> Option<Entry> {
        let parts: Vec<&str> = path.split('/').collect();
        let mut folder = String::new();
        let mut kind = None;
        for part in &parts {
            if !self.listing(&folder).ok()?.exact.contains_key(*part) {
                return None;
            }
            if kind == Some(Entry::File) {
                return None;
            }
            if !folder.is_empty() {
                folder.push('/');
            }
            folder.push_str(part);
            let now = fs::symlink_metadata(self.folder.join(&folder)).ok()?;
            kind = if now.file_type().is_file() {
                Some(Entry::File)
            } else if now.file_type().is_dir() {
                Some(Entry::Folder)
            } else {
                return None;
            };
        }
        kind
    }

    /// The files and the folders of one folder of the vault, by their names,
    /// in any order. The root is the empty path. A symbolic link is not a file
    /// and not a folder of the vault, so it is not in the result. A name that
    /// is not valid Unicode comes with the replacement character in the place
    /// of what cannot be read. Each folder is listed one time per run.
    ///
    /// # Errors
    ///
    /// The folder cannot be listed.
    pub fn list(&self, folder: &str) -> Result<Vec<(String, Entry)>, String> {
        Ok(self.listing(folder)?.entries.clone())
    }

    /// The text of the file with exactly this vault path. `Ok(None)` when the
    /// vault has no such file: each part of the path must be a name of the
    /// folder listing, with the same letter case, and a symbolic link is not a
    /// file of the vault. A file that went away during the run is no file.
    ///
    /// # Errors
    ///
    /// The file is not valid UTF-8, or cannot be read.
    pub fn read(&self, path: &str) -> Result<Option<String>, String> {
        let Some(bytes) = self.read_bytes(path)? else {
            return Ok(None);
        };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "is not valid UTF-8".to_owned())
    }

    /// The bytes of the file with exactly this vault path, as they are: the
    /// same rules as `read`, for a file that is not a note.
    ///
    /// # Errors
    ///
    /// The file cannot be read.
    pub fn read_bytes(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        if self.exact_entry(path) != Some(Entry::File) {
            return Ok(None);
        }
        match fs::read(self.folder.join(path)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.kind().to_string()),
        }
    }

    /// The number of bytes of the file with exactly this vault path, from the
    /// file system, without a read of its bytes: the same rules as `read`.
    /// `Ok(None)` when the vault has no such file.
    ///
    /// # Errors
    ///
    /// The size cannot be read.
    pub fn size(&self, path: &str) -> Result<Option<u64>, String> {
        if self.exact_entry(path) != Some(Entry::File) {
            return Ok(None);
        }
        match fs::symlink_metadata(self.folder.join(path)) {
            Ok(metadata) => Ok(Some(metadata.len())),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.kind().to_string()),
        }
    }

    /// True when the vault has a folder with exactly this vault path, which is
    /// not a symbolic link.
    pub fn has_folder(&self, path: &str) -> bool {
        self.exact_entry(path) == Some(Entry::Folder)
    }

    /// Writes the text of a note. A stop of the process during the write
    /// never leaves the note empty or half written: the text goes into a
    /// hidden file of the same folder first, which is then renamed.
    ///
    /// # Errors
    ///
    /// The file is read only, or cannot be written.
    pub fn write(&self, path: &str, text: &str) -> Result<(), String> {
        write_whole(&self.folder.join(path), text)
    }
}

/// The attachment storage: an object storage on the host, a folder on a
/// device and in the tests. Its files are directly in the folder, named by
/// their keys: the 64 hexadecimal digits of the SHA-256 of their bytes.
pub struct AttachmentStorage {
    folder: PathBuf,
}

/// True when the text is a key of the attachment storage.
fn is_attachment_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

impl AttachmentStorage {
    pub fn new(folder: &Path) -> Self {
        Self {
            folder: folder.to_path_buf(),
        }
    }

    /// The path of a file of the storage. A name never leaves the folder.
    fn path_of(&self, name: &str) -> Result<PathBuf, String> {
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
            return Err(format!(
                "\"{name}\" is not the name of a file of the attachment storage"
            ));
        }
        Ok(self.folder.join(name))
    }

    /// The names of the files of the storage, in any order. A folder and a
    /// symbolic link are not files of it.
    ///
    /// # Errors
    ///
    /// The folder cannot be listed.
    pub fn list(&self) -> Result<Vec<String>, String> {
        let failed =
            |error: std::io::Error| format!("the attachment storage cannot be listed: {error}");
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.folder).map_err(failed)? {
            let entry = entry.map_err(failed)?;
            if entry.file_type().map_err(failed)?.is_file() {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        Ok(names)
    }

    /// Stores the bytes under the key. The file is written under another name
    /// first and then renamed, so a key never names a part of a file.
    ///
    /// # Errors
    ///
    /// The key has another form, or the file cannot be written.
    pub fn put(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        if !is_attachment_key(key) {
            return Err(format!("\"{key}\" is not a key of the attachment storage"));
        }
        let part = self.path_of(&format!(".{key}.part"))?;
        let target = self.path_of(key)?;
        fs::write(&part, bytes).map_err(|error| error.to_string())?;
        fs::rename(&part, &target).map_err(|error| {
            let _ = fs::remove_file(&part);
            error.to_string()
        })
    }

    /// Removes the file of this name. `Ok(true)` when the file existed.
    ///
    /// # Errors
    ///
    /// The name has another form, or the file cannot be removed.
    pub fn remove(&self, name: &str) -> Result<bool, String> {
        match fs::remove_file(self.path_of(name)?) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// The copy of the content store on this device: a git clone whose `origin` is
/// the content store.
pub struct ContentStore {
    folder: PathBuf,
}

impl ContentStore {
    pub fn new(folder: &Path) -> Self {
        Self {
            folder: folder.to_path_buf(),
        }
    }

    /// # Errors
    ///
    /// The folder is not the root of its own git repository: git would else
    /// work on the repository that holds the folder. Or the copy has commits
    /// that the content store does not have.
    pub fn verify(&self, fetch: Fetch) -> Result<Verified, String> {
        self.check_root()?;
        // A folder with no origin is no clone of the content store (R67).
        let origin = self
            .git_output(&["remote", "get-url", "origin"])
            .unwrap_or_default();
        if origin.trim().is_empty() {
            return Err(format!(
                "the copy of the content store has no origin: it is not a clone of the content store: {}",
                self.folder.display()
            ));
        }
        let mut reached = true;
        if fetch != Fetch::None {
            match self.fetch_main() {
                Ok(()) => {}
                // Without a network a plan uses the last fetch (PERF-16): its
                // publication fetches again.
                Err(FetchFailure::Unreachable(_)) if fetch == Fetch::Try => reached = false,
                Err(FetchFailure::Unreachable(error) | FetchFailure::Other(error)) => {
                    return Err(error);
                }
            }
        }
        // How far the copy is behind the content store, at the last fetch.
        let exists = |name: &str| {
            self.git_output(&["rev-parse", "--verify", "--quiet", name])
                .is_ok()
        };
        let has_main = exists("refs/remotes/origin/main");
        let has_head = exists("HEAD");
        // A copy with no branch of its own that leads to a commit (a clone of
        // a content store that had no branch yet, or a copy made with git
        // init) has no commit ahead. An orphan branch in a copy with commits
        // is not such a copy.
        let no_commit = !has_head
            && self
                .git_output(&[
                    "for-each-ref",
                    "--count=1",
                    "--format=%(refname)",
                    "refs/heads",
                ])
                .is_ok_and(|refs| refs.trim().is_empty());
        let behind = if has_main {
            let range = if has_head {
                "HEAD..refs/remotes/origin/main"
            } else {
                "refs/remotes/origin/main"
            };
            self.git_output(&["rev-list", "--count", range])?
                .trim()
                .parse::<u64>()
                .map_err(|error| format!("git gave no count of commits: {error}"))?
        } else {
            0
        };
        self.check_history(has_main, no_commit)?;
        if has_head {
            self.check_links()?;
        }
        self.check_files()?;
        Ok(Verified { behind, reached })
    }

    /// `Err` when the last commit holds a link (mode `120000`) at a file or
    /// below a folder of the store that the tool reads or writes. A link is no
    /// file of the store: git writes it as a link where it can, and a removal
    /// or a write through it would leave the copy (issue 79).
    fn check_links(&self) -> Result<(), String> {
        let tree = self.git_output(&[
            "ls-tree",
            "-r",
            "-z",
            "--full-tree",
            "HEAD",
            "--",
            "configuration.json",
            "edits.json",
            "manifest",
            "notes",
            "renames.json",
            "withdrawn.json",
        ])?;
        let linked: Vec<&str> = tree
            .split('\0')
            .filter(|entry| entry.starts_with("120000 "))
            .filter_map(|entry| entry.split_once('\t').map(|(_, path)| path))
            .take(5)
            .collect();
        if linked.is_empty() {
            return Ok(());
        }
        Err(format!(
            "{} of the last commit of the content store is a symbolic link: the tool follows no link in the copy. Nothing can be published until the link is removed from the content store by hand: {}",
            linked.join(", "),
            self.folder.display()
        ))
    }

    /// `Err` when the folder is not the root of its own git repository: git
    /// would else work on the repository that holds it.
    fn check_root(&self) -> Result<(), String> {
        let top = self.git_output(&["rev-parse", "--show-toplevel"]).ok();
        let same = top.is_some_and(|top| {
            match (fs::canonicalize(top.trim()), fs::canonicalize(&self.folder)) {
                (Ok(top), Ok(folder)) => top == folder,
                _ => false,
            }
        });
        if same {
            Ok(())
        } else {
            Err(format!(
                "the copy of the content store is not the root of a git repository: {}",
                self.folder.display()
            ))
        }
    }

    /// The commit of the copy, or `None` when the copy has no commit.
    pub fn head(&self) -> Option<String> {
        self.git_output(&["rev-parse", "--verify", "--quiet", "HEAD"])
            .ok()
            .map(|head| head.trim().to_owned())
    }

    /// Puts back what a publication that stopped halfway left, by the rules
    /// of the run journal (`documentation/Canonical Form.md`, "Failure
    /// cases"): `head` is the commit before the run, `paths` are the files
    /// that the run could write, and `plan` is the id of its plan, which the
    /// message of its commit names.
    ///
    /// # Errors
    ///
    /// The copy is not the root of its own git repository, its history
    /// cannot be put back by the rules, the tool must know whether the push
    /// arrived and the content store cannot be reached, or git fails.
    pub fn recover(
        &self,
        head: Option<&str>,
        paths: &[String],
        plan: &str,
        own_lock: &dyn Fn() -> Result<(), String>,
    ) -> Result<Recovery, String> {
        self.check_root()?;
        steal_point("recover", self);
        let now = self.head();
        if now.as_deref() == head {
            own_lock()?;
            self.put_back(head, paths)?;
            return Ok(Recovery::Undone);
        }
        let by_hand = || {
            format!(
                "a publication stopped halfway, and the history of the copy of the content store cannot be put back by the tool. Correct the copy by hand (git fetch origin, then git reset --hard origin/main when the copy holds no other work), then remove .git/vault-publish/journal.json: {}",
                self.folder.display()
            )
        };
        let Some(now) = now else {
            return Err(by_hand());
        };
        if let Some(head) = head
            && self
                .git_output(&["merge-base", "--is-ancestor", head, &now])
                .is_err()
        {
            return Err(by_hand());
        }
        // The commit of the run: the first commit after head on the line of
        // first parents, when it names the plan and changes only paths of the
        // journal. A commit of another device is never taken for it.
        let range = head.map_or_else(|| now.clone(), |head| format!("{head}..{now}"));
        let line = self.git_output(&["rev-list", "--first-parent", "--reverse", &range])?;
        let first = line.lines().next().map(str::to_owned);
        let of_the_run = match &first {
            Some(first) => {
                let message = self.git_output(&["log", "-1", "--format=%B", first])?;
                let changed = self.git_output(&[
                    "diff-tree",
                    "--no-commit-id",
                    "--name-only",
                    "-r",
                    "-z",
                    "--root",
                    "--no-renames",
                    first,
                ])?;
                let journal: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
                message.lines().any(|line| line == format!("Plan: {plan}"))
                    && changed
                        .split('\0')
                        .filter(|path| !path.is_empty())
                        .all(|path| journal.contains(path))
            }
            None => false,
        };
        let Some(first) = first.filter(|_| of_the_run) else {
            // The run made no commit, and other commits came after head.
            own_lock()?;
            self.put_back(Some(&now), paths)?;
            return Ok(Recovery::Undone);
        };
        // The fetch can be slow: another run can take the copy meanwhile.
        own_lock()?;
        self.fetch_main().map_err(|(FetchFailure::Unreachable(error) | FetchFailure::Other(error))| {
            format!(
                "a publication stopped halfway after its commit, and the tool must reach the content store to know whether its push arrived: {error}"
            )
        })?;
        let pushed = self
            .git_output(&[
                "merge-base",
                "--is-ancestor",
                &first,
                "refs/remotes/origin/main",
            ])
            .is_ok();
        if pushed {
            return Ok(Recovery::Pushed);
        }
        if first != now {
            return Err(by_hand());
        }
        // The tool never pushes an old commit: it can be older than a guard
        // that the author added since.
        own_lock()?;
        match head {
            Some(head) => self.git_output(&["update-ref", "HEAD", head])?,
            None => self.git_output(&["update-ref", "-d", "HEAD"])?,
        };
        self.put_back(head, paths)?;
        Ok(Recovery::Undone)
    }

    /// Puts each path back as this commit has it, in the work tree and in the
    /// index. A path that the commit does not have is removed from both.
    fn put_back(&self, commit: Option<&str>, paths: &[String]) -> Result<(), String> {
        let in_commit: BTreeSet<String> = match commit {
            Some(commit) => self
                .git_output(&["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit])?
                .split('\0')
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
                .collect(),
            None => BTreeSet::new(),
        };
        let (back, gone): (Vec<&str>, Vec<&str>) = paths
            .iter()
            .map(String::as_str)
            .partition(|path| in_commit.contains(*path));
        if let Some(commit) = commit
            && !back.is_empty()
        {
            self.git_on_paths(&["checkout", commit], &back)?;
        }
        for path in &gone {
            self.refuse_links(path)?;
            match fs::remove_file(self.folder.join(path)) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "{path} of the content store cannot be removed: {error}"
                    ));
                }
            }
        }
        if !gone.is_empty() {
            self.git_on_paths(&["rm", "--quiet", "--cached", "--ignore-unmatch"], &gone)?;
        }
        if commit.is_none() && self.git_output(&["ls-files", "-z"])?.is_empty() {
            // A fresh clone of an empty content store has no index. An index
            // with no entry would stop a later pull.
            match fs::remove_file(self.folder.join(".git").join("index")) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(format!("the empty index cannot be removed: {error}")),
            }
        }
        Ok(())
    }

    /// Fetches the branch `main` of the content store into
    /// `refs/remotes/origin/main`. The fetch names the branch: the fetch
    /// setting of the copy could else leave that ref as it was (a setting
    /// removed or changed by hand), and a copy that is behind would look up to
    /// date. A content store with no branch yet has nothing to fetch.
    fn fetch_main(&self) -> Result<(), FetchFailure> {
        let failed = |error: String| {
            FetchFailure::Unreachable(format!(
                "the content store cannot be reached (git fetch origin failed: {}). A publication fetches it first, so that a copy that is behind is never used: {}",
                error.trim(),
                self.folder.display()
            ))
        };
        let remote = self
            .git_output(&["ls-remote", "--quiet", "origin", "refs/heads/main"])
            .map_err(failed)?;
        if !remote.trim().is_empty() {
            self.git_output(&[
                "fetch",
                "--quiet",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
            ])
            .map_err(failed)?;
        } else if self
            .git_output(&[
                "rev-parse",
                "--verify",
                "--quiet",
                "refs/remotes/origin/main",
            ])
            .is_ok()
        {
            return Err(FetchFailure::Other(format!(
                "the content store has no branch main, but the copy knows one (refs/remotes/origin/main). Nothing can be published until the copy is corrected by hand: {}",
                self.folder.display()
            )));
        }
        Ok(())
    }

    /// `Err` when the copy has commits that no branch of the content store
    /// has.
    fn check_history(&self, has_main: bool, no_commit: bool) -> Result<(), String> {
        // A copy with no commit, of a content store with a branch, has no
        // commit ahead: it is behind.
        if no_commit && has_main {
            return Ok(());
        }
        // A commit that a failed publication could not take back would be
        // pushed by the next one, also for a note that came under a guard. A
        // commit that a branch of the content store has is not ahead.
        let ahead = match self.git_output(&[
            "rev-list",
            "--count",
            "HEAD",
            "--not",
            "--remotes=origin",
        ]) {
            Ok(ahead) => ahead.trim().to_owned(),
            // Only a copy of a content store with no branch yet, whose own
            // branch has no commit yet, has no history to compare.
            Err(_)
                if self
                    .git_output(&["symbolic-ref", "--quiet", "HEAD"])
                    .is_ok()
                    && no_commit
                    && self
                        .git_output(&["for-each-ref", "--count=1", "refs/remotes/origin"])
                        .is_ok_and(|refs| refs.trim().is_empty()) =>
            {
                "0".to_owned()
            }
            Err(error) => {
                return Err(format!(
                    "the history of the copy of the content store cannot be read: {error}. Correct the copy by hand, for example with git fetch origin: {}",
                    self.folder.display()
                ));
            }
        };
        if ahead != "0" {
            // A push is safe only for a change of the configuration alone: a
            // commit of a publication that git could not take back would
            // publish an older state, also for a note under a guard.
            let files = self.pushed_changes()?;
            let safe = files.is_empty()
                || (files.len() == 1
                    && files[0].1 == "configuration.json"
                    && (files[0].0 == "M" || files[0].0 == "A"));
            let way = if safe {
                "a push changes configuration.json only, and does not remove it: when that is your change of the deny list, push it (git push origin HEAD:main)".to_owned()
            } else {
                format!(
                    "a push would change other files of the store too, or remove the configuration ({}), so the commits can hold a publication that git could not take back, or take back a publication of another device. Keep a copy of configuration.json when it holds a change of yours, take the commits back (git fetch origin, then git reset --hard origin/main when the copy holds no other work), put your configuration.json back, then commit and push it",
                    files
                        .iter()
                        .take(5)
                        .map(|(_, path)| path.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            return Err(format!(
                "the copy of the content store has {ahead} commit(s) that the content store does not have. Nothing can be published until the copy is corrected: {way}: {}",
                self.folder.display()
            ));
        }
        Ok(())
    }

    /// What a push of the copy would change in the content store: each file
    /// with its code (`A`, `M`, `D`, `T`), sorted by path. The commits alone do
    /// not say it: a commit that removes the configuration names only that
    /// file, and a merge commit names no file.
    fn pushed_changes(&self) -> Result<Vec<(String, String)>, String> {
        let pushed = if self
            .git_output(&[
                "rev-parse",
                "--verify",
                "--quiet",
                "refs/remotes/origin/main",
            ])
            .is_ok()
        {
            self.git_output(&[
                "diff",
                "--no-renames",
                "--name-status",
                "-z",
                "refs/remotes/origin/main",
                "HEAD",
            ])?
        } else {
            // The content store has no branch yet: a push adds every file.
            self.git_output(&["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"])?
                .split('\0')
                .filter(|path| !path.is_empty())
                .flat_map(|path| ["A", path])
                .collect::<Vec<_>>()
                .join("\0")
        };
        let fields: Vec<&str> = pushed
            .split('\0')
            .filter(|field| !field.is_empty())
            .collect();
        let mut files: Vec<(String, String)> = fields
            .chunks(2)
            .filter_map(|pair| match pair {
                [code, path] => Some(((*code).to_owned(), (*path).to_owned())),
                _ => None,
            })
            .collect();
        files.sort_by(|left, right| left.1.cmp(&right.1));
        Ok(files)
    }

    /// `Err` when `configuration.json`, `manifest/`, `renames.json` and
    /// `edits.json` in the copy are not exactly the files of its last commit.
    fn check_files(&self) -> Result<(), String> {
        // The tool reads the state from the files of the copy, so they must be
        // the files of its last commit: a file removed, edited, added or
        // replaced could hide a published note under a guard, or empty the
        // deny list. A file that git skips or assumes unchanged is not
        // compared by git status, so it stops the run too.
        // The line ends are converted as the copy converts them: a file that
        // differs only in its line ends is the same file. The stat data is
        // trusted only in full.
        let changes = self.git_with_options(
            COMPARE_OPTIONS,
            &[
                "status",
                "--no-renames",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--ignored",
                "--",
                "configuration.json",
                "manifest",
                "renames.json",
                "edits.json",
                "withdrawn.json",
            ],
            &[],
        )?;
        // The cleaned notes that the last commit has: one that the copy
        // removed or edited would stay in the content store, because a removal
        // stages only what it removes. A file that the commit does not have is
        // never committed, so it is not compared.
        let notes = self.git_with_options(
            COMPARE_OPTIONS,
            &[
                "status",
                "--no-renames",
                "--porcelain=v1",
                "-z",
                "--untracked-files=no",
                "--",
                "notes",
            ],
            &[],
        )?;
        let flags = self.git_output(&[
            "ls-files",
            "-v",
            "-z",
            "--",
            "configuration.json",
            "manifest",
            "renames.json",
            "edits.json",
            "withdrawn.json",
            "notes",
        ])?;
        let edited = self.edited_files()?;
        let different: Vec<(&str, &str)> = edited
            .iter()
            .map(|path| (" M", path.as_str()))
            .chain(
                changes
                    .split('\0')
                    .chain(notes.split('\0'))
                    .filter(|entry| entry.len() > 3)
                    .map(|entry| (&entry[..2], &entry[3..]))
                    .chain(
                        flags
                            .split('\0')
                            .filter(|entry| !entry.is_empty() && !entry.starts_with("H "))
                            .map(|entry| ("skipped", entry.get(2..).unwrap_or(entry))),
                    ),
            )
            .collect();
        if different.is_empty() {
            return Ok(());
        }
        Err(format!(
            "files of the content store in the copy are not the files of its last commit: {}. Nothing can be published until the copy is corrected. {}: {}",
            {
                let mut named: Vec<&str> = Vec::new();
                for (_, path) in &different {
                    if !named.contains(path) {
                        named.push(path);
                    }
                }
                named.into_iter().take(5).collect::<Vec<_>>().join(", ")
            },
            ways_out(&different, &self.folder),
            self.folder.display()
        ))
    }

    /// The files of `configuration.json`, `manifest/`, `renames.json` and
    /// `edits.json` whose text is not the
    /// text of the last commit. Git status trusts the stat data of a file: an
    /// edit of the same size in the same second can look unchanged. So each
    /// file is compared with the commit by its hash, with the line ends
    /// converted as the copy converts them. A link is compared by git status
    /// alone.
    fn edited_files(&self) -> Result<Vec<String>, String> {
        if self
            .git_output(&["rev-parse", "--verify", "--quiet", "HEAD"])
            .is_err()
        {
            return Ok(Vec::new());
        }
        let tree = self.git_output(&[
            "ls-tree",
            "-r",
            "-z",
            "--full-tree",
            "HEAD",
            "--",
            "configuration.json",
            "manifest",
            "renames.json",
            "edits.json",
            "withdrawn.json",
        ])?;
        let present: Vec<(&str, &str)> = tree
            .split('\0')
            .filter_map(|entry| {
                let (meta, path) = entry.split_once('\t')?;
                let mut fields = meta.split(' ');
                let mode = fields.next()?;
                let hash = fields.nth(1)?;
                (mode != "120000"
                    && fs::symlink_metadata(self.folder.join(path))
                        .is_ok_and(|metadata| metadata.file_type().is_file()))
                .then_some((path, hash))
            })
            .collect();
        if present.is_empty() {
            return Ok(Vec::new());
        }
        let mut input = present
            .iter()
            .map(|(path, _)| *path)
            .collect::<Vec<_>>()
            .join("\n");
        input.push('\n');
        // The bytes that the tool reads, with no filter and no attribute of
        // git: a filter could make other bytes look like the commit.
        let hashes = self.git_with(
            &["hash-object", "--no-filters", "--stdin-paths"],
            input.as_bytes(),
        )?;
        let hashes: Vec<&str> = hashes.lines().collect();
        let mut edited = Vec::new();
        for (index, (path, hash)) in present.iter().enumerate() {
            if hashes.get(index) == Some(hash) || self.same_with_unix_line_ends(path, hash)? {
                continue;
            }
            edited.push((*path).to_owned());
        }
        Ok(edited)
    }

    /// True when the file, with each carriage return and line feed made a
    /// line feed, has this hash. A copy that converts line ends writes the
    /// files of its commit with Windows line ends. In a valid JSON text a line
    /// end is only white space, so both texts say the same.
    fn same_with_unix_line_ends(&self, path: &str, hash: &str) -> Result<bool, String> {
        let bytes = fs::read(self.folder.join(path))
            .map_err(|error| format!("\"{path}\" of the copy cannot be read: {error}"))?;
        if !bytes.windows(2).any(|pair| pair == b"\r\n") {
            return Ok(false);
        }
        let mut unix = Vec::with_capacity(bytes.len());
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                continue;
            }
            unix.push(*byte);
        }
        let converted = self.git_with(&["hash-object", "--no-filters", "--stdin"], &unix)?;
        Ok(converted.trim() == hash)
    }

    /// `Err` when a part of the path in the copy is a symbolic link. A link
    /// is not a file of the store: it could lead out of the copy, or to
    /// nothing, and a configuration that leads nowhere would be read as none.
    fn refuse_links(&self, path: &str) -> Result<(), String> {
        let mut part = String::new();
        for name in path.split('/') {
            if !part.is_empty() {
                part.push('/');
            }
            part.push_str(name);
            match fs::symlink_metadata(self.folder.join(&part)) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(format!(
                        "{part} of the content store is a symbolic link: the tool follows no link in the copy"
                    ));
                }
                Ok(_) => {}
                Err(error)
                    if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
                {
                    return Ok(());
                }
                Err(error) => {
                    return Err(format!(
                        "{part} of the content store cannot be read: {}",
                        error.kind()
                    ));
                }
            }
        }
        Ok(())
    }

    /// The text of a file, by its path in the content store. `Ok(None)` only
    /// when there is no such file.
    ///
    /// # Errors
    ///
    /// The file cannot be read or is not valid UTF-8: a file that cannot be
    /// read is never taken for a missing one. A part of the path is a
    /// symbolic link.
    pub fn read(&self, path: &str) -> Result<Option<String>, String> {
        self.refuse_links(path)?;
        let bytes = match fs::read(self.folder.join(path)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "{path} of the content store cannot be read: {}",
                    error.kind()
                ));
            }
        };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| format!("{path} of the content store is not valid UTF-8"))
    }

    /// The files of a folder, one level, as paths in the content store, in
    /// the order of the code points. A folder below it and a symbolic link
    /// are not in the result.
    ///
    /// # Errors
    ///
    /// A part of the path of the folder is a symbolic link, or the folder
    /// exists and cannot be listed.
    pub fn list(&self, folder: &str) -> Result<Vec<String>, String> {
        self.refuse_links(folder)?;
        // Only a folder that does not exist is empty. A folder that cannot be
        // listed would else hide the published notes.
        let failed = |error: std::io::Error| {
            format!(
                "{folder} of the content store cannot be listed: {}",
                error.kind()
            )
        };
        let entries = match fs::read_dir(self.folder.join(folder)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(failed(error)),
        };
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry.map_err(failed)?;
            // A file whose kind cannot be read is never taken for no file.
            if entry.file_type().map_err(failed)?.is_file() {
                files.push(format!("{folder}/{}", entry.file_name().to_string_lossy()));
            }
        }
        files.sort_unstable();
        Ok(files)
    }

    /// # Errors
    ///
    /// The file cannot be written.
    pub fn write(&self, path: &str, text: &str) -> Result<(), String> {
        // A link in a parent folder would take the write out of the copy.
        self.refuse_links(path)?;
        write_text(&self.folder.join(path), text)
    }

    /// Removes a file. `Ok(true)` when the file existed.
    ///
    /// # Errors
    ///
    /// The file exists and cannot be removed.
    pub fn remove(&self, path: &str) -> Result<bool, String> {
        // A link as the file itself leaves the store, but a link in a parent
        // folder would take the removal out of the copy.
        if let Some((parent, _)) = path.rsplit_once('/') {
            self.refuse_links(parent)?;
        }
        match fs::remove_file(self.folder.join(path)) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "{path} of the content store cannot be removed: {}",
                error.kind()
            )),
        }
    }

    /// Puts exactly these files in one commit and pushes it, without force. A
    /// file that was removed is removed by the commit.
    ///
    /// # Errors
    ///
    /// The commit failed, or the push was refused. Then the commit is taken
    /// back and these paths are unstaged: other staged work of the copy stays
    /// staged. The files of the copy stay as they are: the tool puts them
    /// back.
    pub fn commit_and_push(&self, message: &str, paths: &[String]) -> Result<(), String> {
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        // A copy with no commit has no commit to go back to.
        let before = self
            .git_output(&["rev-parse", "--verify", "--quiet", "HEAD"])
            .ok()
            .map(|head| head.trim().to_owned());
        // Takes the commit back, when there is one, and unstages the paths of
        // the publication. Every step runs, also when one fails. The result
        // is what failed.
        // The branch goes back only when it is still at the commit of this
        // publication: another run can have moved it.
        let undo = |made: Option<&str>| -> Vec<String> {
            let mut failures = Vec::new();
            if let Some(made) = made {
                let moved = match &before {
                    Some(before) => self.git_output(&["update-ref", "HEAD", before, made]),
                    None => self.git_output(&["update-ref", "-d", "HEAD", made]),
                };
                failures.extend(moved.err());
            }
            let unstaged = match &before {
                Some(before) => self.git_on_paths(&["reset", "--quiet", before], &paths),
                None => {
                    self.git_on_paths(&["rm", "--quiet", "--cached", "--ignore-unmatch"], &paths)
                }
            };
            failures.extend(unstaged.err());
            if before.is_none() {
                // A fresh clone of an empty content store has no index. An
                // index with no entry would stop a later pull.
                match self.git_output(&["ls-files", "-z"]) {
                    Ok(listing) if listing.is_empty() => {
                        if let Err(error) = fs::remove_file(self.folder.join(".git").join("index"))
                            && error.kind() != ErrorKind::NotFound
                        {
                            failures.push(format!("the empty index cannot be removed: {error}"));
                        }
                    }
                    Ok(_) => {}
                    Err(error) => failures.push(error),
                }
            }
            failures
        };
        let failed = |what: String, failures: Vec<String>| {
            if failures.is_empty() {
                what
            } else {
                let way_out = before.as_ref().map_or_else(
                    || "git update-ref -d HEAD".to_owned(),
                    |before| format!("git reset --soft {before}"),
                );
                format!(
                    "{what}. Git could not take the publication back, so correct the copy by hand before the next publication ({way_out}): {}",
                    failures.join("; ")
                )
            }
        };
        // With force: a rule of the store that ignores a path must not leave a
        // note out of its own publication. Then only the files of the
        // publication: other changes of the copy stay out.
        let committed = self
            .git_on_paths(&["add", "--force"], &paths)
            .and_then(|()| {
                self.git_on_paths(
                    &["commit", "--quiet", "--message", message, "--only"],
                    &paths,
                )
            });
        if let Err(error) = committed {
            return Err(failed(
                format!("the commit into the copy of the content store failed: {error}"),
                undo(None),
            ));
        }
        crash_point("commit");
        let made = self.head().unwrap_or_default();
        // The commit holds exactly the files that changed, on top of the
        // commit before the run: another run that changed the copy in the
        // middle (after an unlock) can never get a commit through that misses
        // a forced removal.
        if !self.holds_exactly(&made, before.as_deref(), &paths) {
            return Err(failed(
                "the commit of this publication does not hold exactly its files on top of the commit before it: another run changed the copy during the publication. Nothing is pushed".to_owned(),
                undo(Some(&made)),
            ));
        }
        // Never with force: when another device pushed first, git refuses.
        // The commit of this run, by its hash: another run can have moved the
        // branch of the copy.
        if self
            .git_output(&[
                "push",
                "--quiet",
                "origin",
                &format!("{made}:refs/heads/main"),
            ])
            .is_ok()
        {
            return Ok(());
        }
        Err(failed(
            "the push to the content store was refused".to_owned(),
            undo(Some(&made)),
        ))
    }

    /// True when the commit changes exactly these paths, and its only parent
    /// is `before` (or it has no parent, when there was no commit before).
    fn holds_exactly(&self, made: &str, before: Option<&str>, paths: &[&str]) -> bool {
        if made.is_empty() {
            return false;
        }
        let parents: Vec<String> = self
            .git_output(&["rev-list", "--parents", "--max-count=1", made])
            .map_or_else(
                // A commit whose parents cannot be read is never on top.
                |_| vec![String::new()],
                |line| line.split_whitespace().skip(1).map(str::to_owned).collect(),
            );
        let on_top = match before {
            Some(before) => parents.len() == 1 && parents[0] == before,
            None => parents.is_empty(),
        };
        let Ok(changed) = self.git_output(&[
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            "--root",
            "--no-renames",
            made,
        ]) else {
            return false;
        };
        let changed: BTreeSet<&str> = changed
            .split('\0')
            .filter(|path| !path.is_empty())
            .collect();
        let wanted: BTreeSet<&str> = paths.iter().copied().collect();
        on_top && changed == wanted
    }

    /// Runs a git command on a list of paths. The paths go to the standard
    /// input of git, not in the arguments: a publication can hold more paths
    /// than the system takes as arguments of one command. No file holds them,
    /// so a relative folder and two publications on one copy work too.
    fn git_on_paths(&self, arguments: &[&str], paths: &[&str]) -> Result<(), String> {
        let mut all = arguments.to_vec();
        all.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
        self.git_with(&all, paths.join("\0").as_bytes()).map(|_| ())
    }

    /// The plans, the lock and the run journal are in the git folder of the
    /// copy: on the device, never in a commit, never in the vault.
    fn local_file(&self, name: &str) -> PathBuf {
        self.folder.join(".git").join("vault-publish").join(name)
    }

    /// The whole output of the last deploy of this device (issue 32): it can
    /// name the address of a removed note, so it stays on the device, for
    /// the author.
    pub fn deploy_log(&self) -> PathBuf {
        self.local_file("deploy.log")
    }

    /// Keeps the whole output of the last deploy in its file.
    ///
    /// # Errors
    ///
    /// The file cannot be written.
    pub fn save_deploy_log(&self, output: &str) -> Result<(), String> {
        write_whole(&self.deploy_log(), output)
    }

    fn plan_file(&self, id: &str) -> PathBuf {
        self.local_file("plans").join(format!("{id}.json"))
    }

    /// Takes the lock of the device for a run, in one create: the file is
    /// made only when no lock exists, with the holder and the id of the
    /// process. `Ok(None)` when the lock was taken, else the text of the lock
    /// that is there.
    ///
    /// # Errors
    ///
    /// The lock cannot be made or read.
    pub fn lock(&self, holder: &Value) -> Result<Lock, String> {
        // A folder that is not a copy gets no `.git` folder.
        if !fs::symlink_metadata(self.folder.join(".git")).is_ok_and(|metadata| metadata.is_dir()) {
            return Err(format!(
                "the copy of the content store is not the root of a git repository: {}",
                self.folder.display()
            ));
        }
        let path = self.local_file("lock");
        let failed =
            |error: std::io::Error| format!("the lock of the device cannot be made: {error}");
        if let Some(folder) = path.parent() {
            fs::create_dir_all(folder).map_err(failed)?;
        }
        let mut content = holder.clone();
        // The computer and the system of the run: a face removes a stale lock
        // of a check or a pull only on the computer that wrote it (R81).
        content["host"] = json!(crate::host_name());
        content["system"] = json!(std::env::consts::OS);
        content["process"] = json!(std::process::id());
        // A token that no other run has: two runs of one process, in the same
        // second, never hold the same text.
        content["token"] = json!(lock_token());
        let text = to_canonical_json(&content).map_err(|error| error.to_string())?;
        // One create, never a test and then a write: two runs that start at
        // the same moment cannot both take the lock.
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(text.as_bytes()).map_err(failed)?;
                Ok(Lock::Taken(text))
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(Lock::Held(
                self.read_lock()?
                    .unwrap_or_else(|| "a lock that went away".to_owned()),
            )),
            Err(error) => Err(failed(error)),
        }
    }

    /// The text of the lock, or `None` when no lock exists.
    ///
    /// # Errors
    ///
    /// The lock exists and cannot be read.
    pub fn read_lock(&self) -> Result<Option<String>, String> {
        read_if_there(&self.local_file("lock"))
    }

    /// Removes the lock only when it still holds this text: a run never
    /// removes the lock of another run.
    ///
    /// # Errors
    ///
    /// The lock cannot be read or removed.
    pub fn release(&self, text: &str) -> Result<(), String> {
        if self.read_lock()?.as_deref() == Some(text) {
            self.unlock()?;
        }
        Ok(())
    }

    /// Removes the lock. `Ok(true)` when a lock existed.
    ///
    /// # Errors
    ///
    /// The lock exists and cannot be removed.
    pub fn unlock(&self) -> Result<bool, String> {
        match fs::remove_file(self.local_file("lock")) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("the lock of the device cannot be removed: {error}")),
        }
    }

    /// # Errors
    ///
    /// The journal cannot be written.
    pub fn save_journal(&self, text: &str) -> Result<(), String> {
        write_whole(&self.local_file("journal.json"), text)
    }

    /// The text of the run journal, or `None` when there is none.
    ///
    /// # Errors
    ///
    /// The journal exists and cannot be read.
    pub fn load_journal(&self) -> Result<Option<String>, String> {
        read_if_there(&self.local_file("journal.json"))
    }

    /// # Errors
    ///
    /// The journal exists and cannot be removed.
    pub fn remove_journal(&self) -> Result<(), String> {
        match fs::remove_file(self.local_file("journal.json")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("the run journal cannot be removed: {error}")),
        }
    }

    /// # Errors
    ///
    /// The plan cannot be written.
    pub fn save_plan(&self, id: &str, record: &str) -> Result<(), String> {
        write_text(&self.plan_file(id), record)
    }

    pub fn load_plan(&self, id: &str) -> Option<String> {
        fs::read_to_string(self.plan_file(id)).ok()
    }

    fn git_output(&self, args: &[&str]) -> Result<String, String> {
        self.git_with(args, &[])
    }

    /// Runs git in the copy. The input goes to its standard input.
    fn git_with(&self, args: &[&str], input: &[u8]) -> Result<String, String> {
        // Literal paths: a note name with `[`, `*` or `?` must never be read
        // as a pattern that names other files too. No conversion of line
        // ends: a setting of the machine must never change the bytes of a
        // file of the store.
        self.git_with_options(
            &["--literal-pathspecs", "-c", "core.autocrlf=false"],
            args,
            input,
        )
    }

    /// Runs git in the copy with these options before the command.
    fn git_with_options(
        &self,
        options: &[&str],
        args: &[&str],
        input: &[u8],
    ) -> Result<String, String> {
        let mut git = Command::new("git");
        git.args(options)
            .args(args)
            .current_dir(&self.folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Inside a git hook, these variables point git to another repository.
        for (name, _) in env::vars_os() {
            if name.to_string_lossy().starts_with("GIT_") {
                git.env_remove(name);
            }
        }
        let mut child = git
            .spawn()
            .map_err(|error| format!("git could not start: {error}"))?;
        let output = thread::scope(|scope| {
            // The input is written while git runs, so that a full pipe of its
            // output never blocks it. Git can end before it reads everything:
            // the error of the pipe is not the error of the command.
            if let Some(mut stdin) = child.stdin.take() {
                scope.spawn(move || {
                    let _ = stdin.write_all(input);
                });
            }
            child.wait_with_output()
        })
        .map_err(|error| format!("git could not run: {error}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(format!(
                "git {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

/// The options of the comparison of the copy with its last commit: the line
/// ends are converted as the copy converts them, and the stat data is trusted
/// only in full.
const COMPARE_OPTIONS: &[&str] = &[
    "--literal-pathspecs",
    "--no-optional-locks",
    "-c",
    "core.checkStat=default",
    "-c",
    "core.trustctime=true",
    "-c",
    "core.fsmonitor=false",
];

/// How the author gets out, for the files of the copy that are not the files
/// of its last commit, each with its code of `git status` or `skipped`. A
/// change of the deny list is work of the author: it is committed, never
/// thrown away. Only the tool writes the manifest.
/// Why git can fail to write a path of the copy on some system (issue 76),
/// or `None`: a name that Windows refuses, or a path longer than the 260
/// characters that Windows allows when git does not use long paths.
fn unwritable_cause(path: &str, folder: &Path) -> Option<&'static str> {
    // A content store written before decision R82 can hold such a path.
    if is_refused_by_windows(path) {
        return Some("a name that Windows refuses");
    }
    let full = format!("{}/{path}", folder.display());
    if full.encode_utf16().count() >= 260 {
        return Some("a path longer than Windows allows");
    }
    None
}

/// The way out for a file of the content store that only the tool writes
/// (`edits.json`, `withdrawn.json`), when the copy differs from its last
/// commit there.
fn tool_file_way(different: &[(&str, &str)], name: &str, why: &str) -> Option<String> {
    let codes: Vec<&str> = different
        .iter()
        .filter(|(_, path)| *path == name)
        .map(|(code, _)| *code)
        .collect();
    if codes.contains(&"skipped") {
        Some(format!(
            "Let git compare {name} again (git update-index --no-skip-worktree --no-assume-unchanged {name})"
        ))
    } else if codes
        .iter()
        .any(|code| code.starts_with('A') && code.contains('D'))
    {
        Some(format!(
            "Take {name} out of the index (git rm --cached --quiet {name}): the last commit has no such file"
        ))
    } else if codes.iter().any(|code| *code == "??" || *code == "!!") {
        Some(format!("Remove {name}: the last commit has no such file"))
    } else if codes.is_empty() {
        None
    } else {
        Some(format!(
            "Put {name} back with git checkout HEAD -- {name}: {why}"
        ))
    }
}

fn ways_out(different: &[(&str, &str)], folder: &Path) -> String {
    let mut ways = Vec::new();
    // `skipped` first, because no `git add` stages a file that git skips, then
    // the code of git status, then the edit that only the hash shows.
    let codes: Vec<&str> = different
        .iter()
        .filter(|(_, path)| *path == "configuration.json")
        .map(|(code, _)| *code)
        .collect();
    let code = codes
        .iter()
        .find(|code| **code == "skipped")
        .or_else(|| codes.iter().find(|code| **code != " M"))
        .or_else(|| codes.first());
    if let Some(code) = code {
        ways.push(if *code == "skipped" {
            "Let git compare configuration.json again (git update-index --no-skip-worktree --no-assume-unchanged configuration.json)"
        } else if code.starts_with('A') && code.contains('D') {
            "Take configuration.json out of the index (git rm --cached --quiet configuration.json): the last commit has no such file"
        } else if code.contains('D') {
            "Put configuration.json back with git checkout HEAD -- configuration.json: a commit of its removal would empty the deny list"
        } else if code.contains('T') {
            "Put configuration.json back with git checkout HEAD -- configuration.json: a link or a folder is not a file of the store"
        } else if *code == "??" || *code == "!!" {
            "When configuration.json is your deny list, commit it and push it (git add --force configuration.json, git commit, then git push origin HEAD:main). Else remove it"
        } else {
            "When you changed the deny list, commit configuration.json and push it (git add configuration.json, git commit, then git push origin HEAD:main). Else put the file back with git checkout HEAD -- configuration.json"
        });
    }
    // The log of the edits of the guards (R69) and the keys that the guards
    // withdrew (issue 120): only the tool writes them.
    let tool_ways = [
        tool_file_way(
            different,
            "edits.json",
            "only the tool writes the log of the edits of the guards",
        ),
        tool_file_way(
            different,
            "withdrawn.json",
            "only the tool writes the keys that the guards withdrew",
        ),
    ];
    ways.extend(tool_ways.iter().flatten().map(String::as_str));
    let notes: Vec<&str> = different
        .iter()
        .filter(|(_, path)| path.starts_with("notes/"))
        .map(|(code, _)| *code)
        .collect();
    if notes.contains(&"skipped") {
        ways.push("Let git compare the cleaned notes again (git update-index --no-skip-worktree --no-assume-unchanged on the files that it skips)");
    }
    let mut unwritable_way = None;
    if notes.iter().any(|code| *code != "skipped") {
        ways.push("Put the cleaned notes back with git checkout HEAD -- notes: a cleaned note that the copy lost would stay in the content store after its removal");
        let unwritable: Vec<String> = different
            .iter()
            .filter(|(code, path)| path.starts_with("notes/") && code.contains('D'))
            .filter_map(|(_, path)| {
                unwritable_cause(path, folder).map(|cause| format!("{path} ({cause})"))
            })
            .collect();
        let named = if unwritable.is_empty() {
            String::new()
        } else {
            format!(" Such paths here: {}.", unwritable.join(", "))
        };
        unwritable_way = Some(format!(
            "When git checkout fails, git cannot write that path on this system, so the file looks deleted:{named} For a long path on Windows, run git config core.longpaths true in the copy, then git checkout again. For a name that Windows refuses, or two notes whose names differ only in letter case on a system that ignores letter case, rename the note in the vault and publish the rename from a device that can write the path"
        ));
    }
    if let Some(way) = &unwritable_way {
        ways.push(way);
    }
    let manifest: Vec<&str> = different
        .iter()
        .filter(|(_, path)| {
            *path != "configuration.json"
                && *path != "edits.json"
                && *path != "withdrawn.json"
                && !path.starts_with("notes/")
        })
        .map(|(code, _)| *code)
        .collect();
    if manifest.contains(&"skipped") {
        ways.push("Let git compare the files of the manifest again (git update-index --no-skip-worktree --no-assume-unchanged on the files that it skips)");
    }
    if manifest.iter().any(|code| *code == "??" || *code == "!!") {
        ways.push("Remove the files of manifest/ that the last commit does not have");
    }
    if manifest
        .iter()
        .any(|code| !["skipped", "??", "!!"].contains(code))
    {
        ways.push("Put the manifest back with git checkout HEAD -- manifest");
    }
    format!("{}. Only the tool writes the manifest", ways.join(". "))
}

/// The number of writes of this process: each one has a hidden file of its
/// own.
static WRITES: AtomicU64 = AtomicU64::new(0);

/// A token for a lock that no other run has: the time in nanoseconds, the
/// process and a count of this process. The logic reads no clock: this is the
/// device.
fn lock_token() -> String {
    static LOCKS: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_nanos());
    format!(
        "{nanos:x}-{:x}-{:x}",
        std::process::id(),
        LOCKS.fetch_add(1, Ordering::Relaxed)
    )
}

/// The text of a file, or `None` when it does not exist.
fn read_if_there(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{} cannot be read: {error}", path.display())),
    }
}

/// Writes a file in two steps: the text goes into a hidden file of the same
/// folder, which is then renamed to the name of the file. A stop of the
/// process during the write never leaves the file empty or half written. A
/// name that starts with a dot is not part of the vault for the scan and for
/// Obsidian. A rename would replace a file that the author made read only, so
/// such a file is refused.
fn write_whole(path: &Path, text: &str) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("{} cannot be written: {error}", path.display());
    if fs::metadata(path).is_ok_and(|metadata| metadata.permissions().readonly()) {
        return Err(format!(
            "{} cannot be written: it is read only",
            path.display()
        ));
    }
    let folder = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(folder).map_err(failed)?;
    // A hidden file of its own for each write of each process: two runs that
    // write into one folder never share one.
    let write = WRITES.fetch_add(1, Ordering::Relaxed) + 1;
    let temporary = folder.join(format!(".vault-publish-{}-{write}.tmp", std::process::id()));
    fs::write(&temporary, text).map_err(failed)?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        failed(error)
    })
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("{} cannot be written: {error}", path.display());
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder).map_err(failed)?;
    }
    fs::write(path, text).map_err(failed)
}

/// The child process of the deploy (issue 32, BUILD-02, R76): the port
/// `DeployProcess` of `deploy.rs` on this device. It runs the program with a
/// list of arguments, with no shell, in the folder of the site code, and keeps
/// the whole output for the author. After the time limit of the command, it
/// stops the program with the programs that it started; with a watch of
/// Ctrl-C, after a Ctrl-C too.
pub struct ChildProcess {
    /// The length of a minute: a test makes it short.
    minute: Duration,
    /// The time between the soft and the hard stop.
    grace: Duration,
    /// The Ctrl-C that stops the deploy, or `None`: the deploys of the MCP
    /// server run in the background, and Ctrl-C stops the server.
    interrupt: Option<Interrupt>,
}

/// The exit code of a program that Ctrl-C stopped on Windows: 128 and the
/// number of SIGINT, as a shell gives it.
#[cfg(windows)]
const CTRL_C_EXIT: i32 = 130;

/// The watch of SIGINT of this process, once a deploy in a terminal set it,
/// or `None` when the system refused the handler.
static TERMINAL: OnceLock<Option<Interrupt>> = OnceLock::new();

/// Ctrl-C in a terminal while the program waits for a deploy (issue 126).
/// The child leads a process group of its own, so the Ctrl-C reaches only
/// the program: the program then stops the deploy with the programs that it
/// started, and its report says that the author stopped it. A second Ctrl-C
/// during the stop kills them at once. Outside a deploy, a Ctrl-C stops the
/// program at once, as with no watch.
#[derive(Clone)]
struct Interrupt {
    /// True after a Ctrl-C that the watch of the deploy did not see yet.
    pressed: Arc<AtomicBool>,
    /// True after a Ctrl-C during the deploy.
    interrupted: Arc<AtomicBool>,
    /// True while no deploy runs: a Ctrl-C then stops the program.
    idle: Arc<AtomicBool>,
}

impl Interrupt {
    /// A watch that no signal sets: a test presses it.
    fn new() -> Self {
        Self {
            pressed: Arc::new(AtomicBool::new(false)),
            interrupted: Arc::new(AtomicBool::new(false)),
            idle: Arc::new(AtomicBool::new(true)),
        }
    }

    /// The watch of SIGINT of this process, the same one for each deploy.
    fn of_terminal() -> Option<Self> {
        TERMINAL
            .get_or_init(|| {
                use signal_hook::consts::SIGINT;
                use signal_hook::flag;

                let interrupt = Self::new();
                // In this order: a Ctrl-C outside a deploy stops the program,
                // as it does with no watch; one during a deploy sets the flag.
                #[cfg(unix)]
                let outside =
                    flag::register_conditional_default(SIGINT, Arc::clone(&interrupt.idle));
                #[cfg(windows)]
                let outside = flag::register_conditional_shutdown(
                    SIGINT,
                    CTRL_C_EXIT,
                    Arc::clone(&interrupt.idle),
                );
                outside
                    .and_then(|_| flag::register(SIGINT, Arc::clone(&interrupt.pressed)))
                    .ok()
                    .map(|_| interrupt)
            })
            .clone()
    }

    /// The deploy starts: a Ctrl-C stops it, not the program.
    fn arm(&self) {
        self.pressed.store(false, Ordering::SeqCst);
        self.interrupted.store(false, Ordering::SeqCst);
        self.idle.store(false, Ordering::SeqCst);
    }

    /// The deploy ended: a Ctrl-C stops the program again.
    fn disarm(&self) {
        // A Ctrl-C at the end of the deploy, which the watch did not see,
        // counts too.
        let _ = self.take_press();
        self.idle.store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn press(&self) {
        self.pressed.store(true, Ordering::SeqCst);
    }

    /// True when a Ctrl-C came since the last look; it then counts as an
    /// interruption of the deploy.
    fn take_press(&self) -> bool {
        let pressed = self.pressed.swap(false, Ordering::SeqCst);
        if pressed {
            self.interrupted.store(true, Ordering::SeqCst);
        }
        pressed
    }

    /// True when a Ctrl-C came during the deploy.
    fn interrupted(&self) -> bool {
        self.interrupted.load(Ordering::SeqCst)
    }
}

/// After the report of a deploy that a Ctrl-C reached, the program stops as
/// Ctrl-C stops a program, so that a loop of the shell stops too: on Unix
/// by the default action of SIGINT, on Windows with the exit code 130. It
/// does nothing when no Ctrl-C came.
pub fn stop_after_ctrl_c() {
    if !TERMINAL
        .get()
        .and_then(Option::as_ref)
        .is_some_and(Interrupt::interrupted)
    {
        return;
    }
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    #[cfg(unix)]
    {
        let _ = signal_hook::low_level::emulate_default_handler(signal_hook::consts::SIGINT);
        std::process::exit(130);
    }
    #[cfg(windows)]
    std::process::exit(CTRL_C_EXIT);
}

impl ChildProcess {
    /// The child process of a run of the program.
    ///
    /// A switch of the debug build for the tests of the time limit:
    /// `DSEBASTIEN_VAULT_PUBLISH_TEST_MINUTE_MS` gives the length of a minute
    /// in milliseconds. The release build has no switch.
    pub fn new() -> Self {
        #[cfg(debug_assertions)]
        if let Some(milliseconds) = env::var("DSEBASTIEN_VAULT_PUBLISH_TEST_MINUTE_MS")
            .ok()
            .and_then(|text| text.parse::<u64>().ok())
        {
            return Self {
                minute: Duration::from_millis(milliseconds),
                grace: Duration::from_millis(200),
                interrupt: None,
            };
        }
        Self {
            minute: Duration::from_secs(60),
            grace: Duration::from_secs(5),
            interrupt: None,
        }
    }

    /// The child process of a deploy that the program waits for in a
    /// terminal: Ctrl-C stops the deploy too.
    pub fn with_ctrl_c() -> Self {
        Self {
            interrupt: Interrupt::of_terminal(),
            ..Self::new()
        }
    }
}

/// How often the watch of a deploy looks at Ctrl-C.
const WATCH_TICK: Duration = Duration::from_millis(50);

/// Watches the deploy until it ends: stops it after its time limit or at a
/// Ctrl-C, and says why.
fn watch_deploy(
    pid: u32,
    limit: Duration,
    grace: Duration,
    interrupt: Option<&Interrupt>,
    ended: &mpsc::Receiver<()>,
) -> Option<Stop> {
    let deadline = Instant::now().checked_add(limit);
    loop {
        let left = deadline.map_or(Duration::MAX, |at| {
            at.saturating_duration_since(Instant::now())
        });
        let wait = if interrupt.is_some() {
            left.min(WATCH_TICK)
        } else {
            left
        };
        if !matches!(
            ended.recv_timeout(wait),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            return None;
        }
        let stop = if interrupt.is_some_and(Interrupt::take_press) {
            Stop::Author
        } else if deadline.is_some_and(|at| Instant::now() >= at) {
            Stop::Time
        } else {
            continue;
        };
        // A Ctrl-C during the stop kills the deploy at once.
        stop_tree(pid, grace, ended, &|| {
            interrupt.is_some_and(Interrupt::take_press)
        });
        return Some(stop);
    }
}

/// The program and every program that it started, from the table of the
/// processes of the system (`ps`), on Unix.
#[cfg(unix)]
fn tree_of(pid: u32) -> Vec<u32> {
    let table = Command::new("ps")
        .args(["-A", "-o", "pid=", "-o", "ppid="])
        .stderr(Stdio::null())
        .output()
        .map_or_else(
            |_| String::new(),
            |output| String::from_utf8_lossy(&output.stdout).into_owned(),
        );
    let pairs: Vec<(u32, u32)> = table
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace().map(str::parse::<u32>);
            Some((parts.next()?.ok()?, parts.next()?.ok()?))
        })
        .collect();
    let mut tree = vec![pid];
    let mut index = 0;
    while let Some(&parent) = tree.get(index) {
        for (child, _) in pairs.iter().filter(|(_, of)| *of == parent) {
            if !tree.contains(child) {
                tree.push(*child);
            }
        }
        index += 1;
    }
    tree
}

/// Stops a deploy with the programs that it started: on Unix its process
/// group (the child leads a group of its own) and every process of its tree
/// (a program can leave the group), first with TERM, then with KILL after the
/// grace, unless it ended, or at once when `hurry` says so; on Windows its
/// tree, with `taskkill`, at once.
fn stop_tree(pid: u32, grace: Duration, ended: &mpsc::Receiver<()>, hurry: &dyn Fn() -> bool) {
    #[cfg(unix)]
    {
        let tree = tree_of(pid);
        let signal = |name: &str, pids: &[u32]| {
            let _ = Command::new("kill")
                .arg(name)
                .arg("--")
                .arg(format!("-{pid}"))
                .args(pids.iter().map(u32::to_string))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        };
        signal("-TERM", &tree);
        let until = Instant::now().checked_add(grace);
        let end = loop {
            let left = until.map_or(Duration::MAX, |at| {
                at.saturating_duration_since(Instant::now())
            });
            match ended.recv_timeout(left.min(WATCH_TICK)) {
                Err(mpsc::RecvTimeoutError::Timeout) if left.is_zero() || hurry() => break false,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                _ => break true,
            }
        };
        if !end {
            // The programs that the tree started meanwhile go too.
            let mut all = tree_of(pid);
            all.extend(tree);
            signal("-KILL", &all);
        }
    }
    #[cfg(windows)]
    {
        let _ = (grace, ended, hurry);
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// How long the readers of the output get after the child ended: a program
/// that the child started can keep a pipe open, and the deploy must not wait
/// for it.
const READ_GRACE: Duration = Duration::from_secs(2);

/// Reads a pipe on a thread of its own into its buffers, and says when it
/// ends. The thread is not joined: an orphan can keep the pipe open.
fn read_pipe(
    mut pipe: impl Read + Send + 'static,
    own: Option<Arc<Mutex<Vec<u8>>>>,
    all: Arc<Mutex<Vec<u8>>>,
) -> mpsc::Receiver<()> {
    let (done, ended) = mpsc::channel();
    thread::spawn(move || {
        let mut chunk = [0_u8; 8_192];
        while let Ok(read @ 1..) = pipe.read(&mut chunk) {
            if let Some(own) = &own
                && let Ok(mut bytes) = own.lock()
            {
                bytes.extend_from_slice(&chunk[..read]);
            }
            if let Ok(mut bytes) = all.lock() {
                bytes.extend_from_slice(&chunk[..read]);
            }
        }
        let _ = done.send(());
    });
    ended
}

/// The command of the child: the program with its arguments, in the folder
/// of the site code, in a process group of its own, with its environment.
fn command_of(command: &DeployCommand) -> Command {
    let mut child = Command::new(&command.program);
    child
        .args(&command.args)
        .current_dir(&command.folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A group of its own, so that a stop reaches every program that the
    // deploy started (on Unix, as in the plugin), and a Ctrl-C in a
    // terminal reaches only the program, which then stops the deploy
    // itself and says so in its report.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        child.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        child.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
    // Inside a git hook, these variables point git to another repository:
    // the deploy runs git in the clone of the site code.
    for (name, _) in env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            child.env_remove(name);
        }
    }
    // The folder of the bun of the settings comes first in the `PATH`.
    if let Some(folder) = command
        .program
        .parent()
        .filter(|_| command.program.is_absolute())
    {
        let rest = env::var_os("PATH").unwrap_or_default();
        if let Ok(path) =
            env::join_paths(std::iter::once(folder.to_path_buf()).chain(env::split_paths(&rest)))
        {
            child.env("PATH", path);
        }
    }
    child
}

impl DeployProcess for ChildProcess {
    fn run(&self, command: &DeployCommand, on_start: &dyn Fn(u32)) -> Result<ChildRun, String> {
        if !command.folder.is_dir() {
            return Err(format!(
                "the folder of the site code is not a folder: {}",
                command.folder.display()
            ));
        }
        let mut child = command_of(command);
        let interrupt = self.interrupt.clone();
        if let Some(interrupt) = &interrupt {
            interrupt.arm();
        }
        let mut child = child.spawn().map_err(|error| {
            if let Some(interrupt) = &interrupt {
                interrupt.disarm();
            }
            format!("{} cannot start: {error}", command.program.display())
        })?;
        let limit = self
            .minute
            .saturating_mul(u32::try_from(command.timeout_minutes).unwrap_or(u32::MAX));
        let pid = child.id();
        on_start(pid);
        let grace = self.grace;
        // The standard output, and both outputs in the order they came.
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::new(Mutex::new(Vec::new()));
        let readers: Vec<mpsc::Receiver<()>> = [
            child
                .stdout
                .take()
                .map(|pipe| read_pipe(pipe, Some(Arc::clone(&stdout)), Arc::clone(&output))),
            child
                .stderr
                .take()
                .map(|pipe| read_pipe(pipe, None, Arc::clone(&output))),
        ]
        .into_iter()
        .flatten()
        .collect();
        let (end, ended) = mpsc::channel::<()>();
        let watch = {
            let interrupt = interrupt.clone();
            thread::spawn(move || watch_deploy(pid, limit, grace, interrupt.as_ref(), &ended))
        };
        let status = child.wait();
        // The watch ends with the child.
        let _ = end.send(());
        let mut stopped = watch.join().ok().flatten();
        if let Some(interrupt) = &interrupt {
            interrupt.disarm();
        }
        // A deploy that ended with 0 before the stop reached it is read by
        // its result.
        if status.as_ref().is_ok_and(ExitStatus::success) {
            stopped = None;
        }
        // The readers end with the pipes; an orphan that keeps one open gets
        // a short grace, then its output is not waited for.
        for reader in &readers {
            let _ = reader.recv_timeout(READ_GRACE);
        }
        let status = status.map_err(|error| format!("the deploy could not run: {error}"))?;
        let text = |buffer: &Arc<Mutex<Vec<u8>>>| {
            buffer.lock().map_or_else(
                |_| String::new(),
                |bytes| String::from_utf8_lossy(&bytes).into_owned(),
            )
        };
        Ok(ChildRun {
            code: status.code(),
            stdout: text(&stdout),
            output: text(&output),
            stopped,
        })
    }
}

/// True when a process runs, by its number.
pub fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // A process of another user runs too: `kill -0` then says that it
        // has no right, and names the process.
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .is_ok_and(|output| {
                output.status.success() || String::from_utf8_lossy(&output.stderr).contains("ermi")
            })
    }
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .stderr(Stdio::null())
            .output()
            .is_ok_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains(&format!(" {pid} "))
            })
    }
}

/// The number of entries of takedowns that this process wrote: each one gets
/// a name of its own.
static ENTRIES: AtomicU64 = AtomicU64::new(0);

/// The marker of the takedowns of this device: `.git/vault-publish/takedowns/`
/// of the copy, one file per takedown, beside the lock and the run journal,
/// so every face of this device sees it.
impl TakedownMarker for ContentStore {
    fn entries(&self) -> Result<Vec<(String, TakedownEntry)>, String> {
        let folder = self.local_file("takedowns");
        let listing = match fs::read_dir(&folder) {
            Ok(listing) => listing,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("{} cannot be read: {error}", folder.display())),
        };
        let mut names: Vec<String> = listing
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| {
                Path::new(name)
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        names.sort();
        let mut found = Vec::new();
        for name in names {
            match fs::read_to_string(folder.join(&name)) {
                Ok(text) => found.push((
                    name.trim_end_matches(".json").to_owned(),
                    takedown_entry_of(&text),
                )),
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(format!("{name} cannot be read: {error}")),
            }
        }
        Ok(found)
    }

    fn add(&self, entry: &TakedownEntry) -> Result<String, String> {
        let since = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_millis());
        let id = format!(
            "{since}-{}-{}",
            std::process::id(),
            ENTRIES.fetch_add(1, Ordering::Relaxed) + 1
        );
        self.replace(&id, entry)?;
        Ok(id)
    }

    fn replace(&self, id: &str, entry: &TakedownEntry) -> Result<(), String> {
        write_whole(
            &self.local_file("takedowns").join(format!("{id}.json")),
            &takedown_entry_text(entry),
        )
    }

    fn remove(&self, id: &str) -> Result<(), String> {
        let file = self.local_file("takedowns").join(format!("{id}.json"));
        match fs::remove_file(&file) {
            Err(error) if error.kind() != ErrorKind::NotFound => {
                Err(format!("{} cannot be removed: {error}", file.display()))
            }
            _ => Ok(()),
        }
    }

    fn is_ancestor(&self, ancestor: &str, revision: &str) -> Option<bool> {
        let status = Command::new("git")
            .args(["merge-base", "--is-ancestor", ancestor, revision])
            .current_dir(&self.folder)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        // 1: not an ancestor; another code: a commit that the copy does not know.
        match status.code() {
            Some(0) => Some(true),
            Some(1) => Some(false),
            _ => None,
        }
    }
}

/// The record of the deploys of this device: `.git/vault-publish/deploy-running/`
/// holds one file per child process of a deploy that runs, named by its
/// number, and `deploy-report.json` the last deploy report. `running` is
/// true while one of those processes runs.
impl DeployRecord for ContentStore {
    fn started(&self, pid: u32) -> Result<(), String> {
        write_whole(
            &self.local_file("deploy-running").join(pid.to_string()),
            "A deploy of the command line program runs.\n",
        )
    }

    fn ended(&self, pid: u32) -> Result<(), String> {
        let file = self.local_file("deploy-running").join(pid.to_string());
        match fs::remove_file(&file) {
            Err(error) if error.kind() != ErrorKind::NotFound => {
                Err(format!("{} cannot be removed: {error}", file.display()))
            }
            _ => Ok(()),
        }
    }

    fn running(&self) -> bool {
        fs::read_dir(self.local_file("deploy-running")).is_ok_and(|listing| {
            listing
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter_map(|name| name.parse::<u32>().ok())
                .any(process_is_alive)
        })
    }

    fn save_last(&self, text: &str) -> Result<(), String> {
        write_whole(&self.local_file("deploy-report.json"), text)
    }

    fn last(&self) -> Option<String> {
        fs::read_to_string(self.local_file("deploy-report.json")).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    /// A program that runs for 30 seconds, with a program that it started.
    fn long_command() -> DeployCommand {
        #[cfg(unix)]
        let (program, args) = ("sh", vec!["-c", "sleep 30 & wait"]);
        #[cfg(windows)]
        let (program, args) = ("cmd", vec!["/c", "ping -n 30 127.0.0.1 > nul"]);
        DeployCommand {
            program: PathBuf::from(program),
            args: args.into_iter().map(OsString::from).collect(),
            folder: env::temp_dir(),
            timeout_minutes: 30,
        }
    }

    #[test]
    fn a_ctrl_c_stops_the_deploy_for_the_author() {
        let interrupt = Interrupt::new();
        let child = ChildProcess {
            minute: Duration::from_secs(60),
            grace: Duration::from_millis(200),
            interrupt: Some(interrupt.clone()),
        };
        let started = Instant::now();

        let run = child
            .run(&long_command(), &|_| {
                interrupt.press();
            })
            .expect("the program runs");

        assert_eq!(run.stopped, Some(Stop::Author));
        assert!(started.elapsed() < Duration::from_secs(15));
    }

    #[test]
    fn a_deploy_with_no_ctrl_c_ends_by_itself() {
        let interrupt = Interrupt::new();
        let child = ChildProcess {
            minute: Duration::from_secs(60),
            grace: Duration::from_millis(200),
            interrupt: Some(interrupt),
        };
        let mut command = long_command();
        #[cfg(unix)]
        {
            command.args = vec!["-c".into(), "exit 3".into()];
        }
        #[cfg(windows)]
        {
            command.args = vec!["/c".into(), "exit 3".into()];
        }

        let run = child.run(&command, &|_| {}).expect("the program runs");

        assert_eq!(run.stopped, None);
        assert_eq!(run.code, Some(3));
    }

    /// A program that ignores TERM, with a program that it started: only
    /// KILL stops them.
    #[cfg(unix)]
    fn stubborn_command() -> DeployCommand {
        DeployCommand {
            args: vec!["-c".into(), "trap '' TERM; sleep 30 & wait".into()],
            ..long_command()
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_second_ctrl_c_during_the_stop_kills_the_deploy_at_once() {
        let interrupt = Interrupt::new();
        let child = ChildProcess {
            minute: Duration::from_secs(60),
            grace: Duration::from_secs(20),
            interrupt: Some(interrupt.clone()),
        };
        let started = Instant::now();

        let run = child
            .run(&stubborn_command(), &|_| {
                interrupt.press();
                let again = interrupt.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(500));
                    again.press();
                });
            })
            .expect("the program runs");

        assert_eq!(run.stopped, Some(Stop::Author));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(interrupt.interrupted());
    }

    #[test]
    #[cfg(unix)]
    fn a_deploy_that_ends_with_0_at_the_stop_counts_no_stop() {
        let interrupt = Interrupt::new();
        let child = ChildProcess {
            minute: Duration::from_secs(60),
            grace: Duration::from_secs(5),
            interrupt: Some(interrupt.clone()),
        };
        let command = DeployCommand {
            args: vec!["-c".into(), "trap 'exit 0' TERM; sleep 30 & wait".into()],
            ..long_command()
        };

        let run = child
            .run(&command, &|_| {
                // The shell sets its trap first.
                thread::sleep(Duration::from_millis(300));
                interrupt.press();
            })
            .expect("the program runs");

        assert_eq!(run.code, Some(0));
        assert_eq!(run.stopped, None);
    }

    #[test]
    fn a_deploy_with_no_ctrl_c_leaves_the_program_running() {
        let interrupt = Interrupt::new();
        let child = ChildProcess {
            minute: Duration::from_secs(60),
            grace: Duration::from_millis(200),
            interrupt: Some(interrupt.clone()),
        };
        let mut command = long_command();
        command.args = if cfg!(windows) {
            vec!["/c".into(), "exit 0".into()]
        } else {
            vec!["-c".into(), "exit 0".into()]
        };

        child.run(&command, &|_| {}).expect("the program runs");

        assert!(!interrupt.interrupted());
    }

    /// A new empty folder for one test, removed by the test.
    fn test_folder(name: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let folder = env::temp_dir().join(format!(
            "vault-publish-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).expect("the folder can be made");
        folder
    }

    /// Makes `link` lead to the folder `target`: a junction on Windows, which
    /// needs no rights, and a symbolic link elsewhere.
    fn link_folder(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let made = Command::new("cmd")
                .arg("/c")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .stdout(Stdio::null())
                .status()
                .expect("cmd runs");
            assert!(made.success(), "the junction can be made");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("the link can be made");
    }

    /// A copy whose `notes/Linked` leads to a folder outside the copy.
    fn linked_copy() -> (PathBuf, PathBuf, PathBuf) {
        let root = test_folder("links");
        let copy = root.join("copy");
        let outside = root.join("outside");
        fs::create_dir_all(copy.join("notes")).expect("the folder can be made");
        fs::create_dir_all(&outside).expect("the folder can be made");
        fs::write(outside.join("Kept.md"), "Kept\n").expect("the file is written");
        link_folder(&outside, &copy.join("notes").join("Linked"));
        (root, copy, outside)
    }

    #[test]
    fn a_removal_through_a_link_in_a_parent_folder_stops_and_the_file_outside_stays() {
        let (root, copy, outside) = linked_copy();

        let removed = ContentStore::new(&copy).remove("notes/Linked/Kept.md");

        let kept = fs::read_to_string(outside.join("Kept.md"));
        let _ = fs::remove_dir_all(&root);
        assert!(
            removed
                .expect_err("the removal stops")
                .contains("notes/Linked of the content store is a symbolic link")
        );
        assert_eq!(kept.expect("the file stays"), "Kept\n");
    }

    #[test]
    fn a_write_through_a_link_in_a_parent_folder_stops_and_writes_nothing_outside() {
        let (root, copy, outside) = linked_copy();

        let written = ContentStore::new(&copy).write("notes/Linked/New.md", "New\n");

        let made = outside.join("New.md").exists();
        let _ = fs::remove_dir_all(&root);
        assert!(
            written
                .expect_err("the write stops")
                .contains("notes/Linked of the content store is a symbolic link")
        );
        assert!(!made);
    }

    /// Makes a folder or a file with exactly this name, also one that Windows
    /// would change: on Windows, through the verbatim form of the path.
    fn make_exactly(folder: &Path, path: &str, text: Option<&str>) {
        #[cfg(windows)]
        let file = PathBuf::from(format!(
            r"\\?\{}",
            folder.join(path).to_string_lossy().replace('/', "\\")
        ));
        #[cfg(not(windows))]
        let file = folder.join(path);
        match text {
            Some(text) => fs::write(file, text).expect("the file is written"),
            None => fs::create_dir(file).expect("the folder can be made"),
        }
    }

    #[test]
    fn a_name_that_windows_changes_is_no_entry_of_the_vault() {
        let root = test_folder("names");
        make_exactly(&root, "Private", None);
        make_exactly(&root, "Private/Diary.md", Some("Diary\n"));
        make_exactly(&root, "Private.", None);
        make_exactly(&root, "Private ", None);
        make_exactly(&root, "CON", None);
        make_exactly(&root, "nul.md", Some("Nul\n"));
        let vault = Vault::new(&root);

        let mut names: Vec<String> = vault
            .list("")
            .expect("the vault can be listed")
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        names.sort();
        let through_dot = vault.read("Private./Diary.md");
        let through_space = vault.read("Private /Diary.md");

        let _ = fs::remove_dir_all(&root);
        assert_eq!(names, vec!["Private".to_owned()]);
        assert_eq!(through_dot, Ok(None));
        assert_eq!(through_space, Ok(None));
    }
}
