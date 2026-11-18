//! The device: the vault and the copy of the content store as folders, with
//! the `git` program of the system (TOOL-12 of the spec). The TypeScript twin
//! is `apps/plugin/src/publishing/node/device.ts`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::thread;

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
            let kind = entry.file_type().map_err(failed)?;
            // A symbolic link is neither a file nor a folder of the vault.
            let kind = if kind.is_file() {
                Entry::File
            } else if kind.is_dir() {
                Entry::Folder
            } else {
                continue;
            };
            let name = entry.file_name();
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
        if self.exact_entry(path) != Some(Entry::File) {
            return Ok(None);
        }
        let bytes = match fs::read(self.folder.join(path)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.kind().to_string()),
        };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "is not valid UTF-8".to_owned())
    }

    /// True when the vault has a folder with exactly this vault path, which is
    /// not a symbolic link.
    pub fn has_folder(&self, path: &str) -> bool {
        self.exact_entry(path) == Some(Entry::Folder)
    }

    /// # Errors
    ///
    /// The file cannot be written.
    pub fn write(&self, path: &str, text: &str) -> Result<(), String> {
        write_text(&self.folder.join(path), text)
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
    pub fn verify(&self, fetch: bool) -> Result<u64, String> {
        let top = self.git_output(&["rev-parse", "--show-toplevel"]).ok();
        let same = top.is_some_and(|top| {
            match (fs::canonicalize(top.trim()), fs::canonicalize(&self.folder)) {
                (Ok(top), Ok(folder)) => top == folder,
                _ => false,
            }
        });
        if !same {
            return Err(format!(
                "the copy of the content store is not the root of a git repository: {}",
                self.folder.display()
            ));
        }
        if fetch {
            self.git_output(&["fetch", "--quiet", "origin"]).map_err(|error| {
                format!(
                    "the content store cannot be reached (git fetch origin failed: {}). A plan and a publication fetch it first, so that a copy that is behind is never used: {}",
                    error.trim(),
                    self.folder.display()
                )
            })?;
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
        self.check_files()?;
        Ok(behind)
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

    /// `Err` when `configuration.json` and `manifest/` in the copy are not
    /// exactly the files of its last commit.
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
        ])?;
        let edited = self.edited_files()?;
        let different: Vec<(&str, &str)> = edited
            .iter()
            .map(|path| (" M", path.as_str()))
            .chain(
                changes
                    .split('\0')
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
            different
                .iter()
                .take(5)
                .map(|(_, path)| *path)
                .collect::<Vec<_>>()
                .join(", "),
            ways_out(&different),
            self.folder.display()
        ))
    }

    /// The files of `configuration.json` and `manifest/` whose text is not the
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
        write_text(&self.folder.join(path), text)
    }

    /// Removes a file. `Ok(true)` when the file existed.
    ///
    /// # Errors
    ///
    /// The file exists and cannot be removed.
    pub fn remove(&self, path: &str) -> Result<bool, String> {
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
        let undo = |committed: bool| -> Vec<String> {
            let mut failures = Vec::new();
            if committed {
                let moved = match &before {
                    Some(before) => self.git_output(&["update-ref", "HEAD", before]),
                    None => self.git_output(&["update-ref", "-d", "HEAD"]),
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
                undo(false),
            ));
        }
        // Never with force: when another device pushed first, git refuses.
        if self
            .git_output(&["push", "--quiet", "origin", "HEAD:main"])
            .is_ok()
        {
            return Ok(());
        }
        Err(failed(
            "the push to the content store was refused".to_owned(),
            undo(true),
        ))
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

    /// The plans are in the git folder of the copy: on the device, never in a
    /// commit, never in the vault.
    fn plan_file(&self, id: &str) -> PathBuf {
        self.folder
            .join(".git")
            .join("vault-publish")
            .join("plans")
            .join(format!("{id}.json"))
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
fn ways_out(different: &[(&str, &str)]) -> String {
    let mut ways = Vec::new();
    if let Some((code, _)) = different
        .iter()
        .find(|(_, path)| *path == "configuration.json")
    {
        ways.push(if code.contains('D') {
            "Put configuration.json back with git checkout HEAD -- configuration.json: a commit of its removal would empty the deny list"
        } else if *code == "??" || *code == "!!" {
            "When configuration.json is your deny list, commit it and push it (git add --force configuration.json, git commit, then git push origin HEAD:main). Else remove it"
        } else if *code == "skipped" {
            "Let git compare configuration.json again (git update-index --no-skip-worktree --no-assume-unchanged configuration.json)"
        } else {
            "When you changed the deny list, commit configuration.json and push it (git add configuration.json, git commit, then git push origin HEAD:main). Else put the file back with git checkout HEAD -- configuration.json"
        });
    }
    let manifest: Vec<&str> = different
        .iter()
        .filter(|(_, path)| *path != "configuration.json")
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

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("{} cannot be written: {error}", path.display());
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder).map_err(failed)?;
    }
    fs::write(path, text).map_err(failed)
}
