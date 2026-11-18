//! The device: the vault and the copy of the content store as folders, with
//! the `git` program of the system (TOOL-12 of the spec). The TypeScript twin
//! is `apps/plugin/src/publishing/node/device.ts`.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

/// What a folder holds at exactly one path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    File,
    Folder,
}

/// What the folder holds at exactly this path: a file, a folder, or nothing.
///
/// Each part of the path must be a name of the folder listing. A file system
/// that ignores letter case would else open `90 locked shed/` for the folder
/// `90 Locked Shed/` of the deny list. A symbolic link is nothing: it can lead
/// to a file that the guards would refuse, or out of the vault.
fn exact_entry(root: &Path, path: &str) -> Option<Entry> {
    let parts: Vec<&str> = path.split('/').collect();
    let mut folder = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        let entry = fs::read_dir(&folder)
            .ok()?
            .flatten()
            .find(|entry| entry.file_name().to_str() == Some(*part))?;
        let kind = entry.file_type().ok()?;
        if kind.is_symlink() {
            return None;
        }
        if index == parts.len() - 1 {
            return if kind.is_file() {
                Some(Entry::File)
            } else if kind.is_dir() {
                Some(Entry::Folder)
            } else {
                None
            };
        }
        if !kind.is_dir() {
            return None;
        }
        folder.push(part);
    }
    None
}

/// The vault: the only source of content.
pub struct Vault {
    folder: PathBuf,
}

impl Vault {
    pub fn new(folder: &Path) -> Self {
        Self {
            folder: folder.to_path_buf(),
        }
    }

    /// The files and the folders of one folder of the vault, by their names,
    /// in any order. The root is the empty path. A symbolic link is not a file
    /// and not a folder of the vault, so it is not in the result. A name that
    /// is not valid Unicode comes with the replacement character in the place
    /// of what cannot be read.
    ///
    /// # Errors
    ///
    /// The folder cannot be listed.
    pub fn list(&self, folder: &str) -> Result<Vec<(String, Entry)>, String> {
        let failed = |error: std::io::Error| {
            format!("the folder \"{folder}\" of the vault cannot be listed: {error}")
        };
        let mut listed = Vec::new();
        for entry in fs::read_dir(self.folder.join(folder)).map_err(failed)? {
            let entry = entry.map_err(failed)?;
            let kind = entry.file_type().map_err(failed)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // A symbolic link is neither.
            if kind.is_file() {
                listed.push((name, Entry::File));
            } else if kind.is_dir() {
                listed.push((name, Entry::Folder));
            }
        }
        Ok(listed)
    }

    /// The text of the file with exactly this vault path. `Ok(None)` when the
    /// vault has no such file: each part of the path must be a name of the
    /// folder listing, with the same letter case, and a symbolic link is not a
    /// file of the vault.
    ///
    /// # Errors
    ///
    /// The file is not valid UTF-8, or cannot be read.
    pub fn read(&self, path: &str) -> Result<Option<String>, String> {
        if exact_entry(&self.folder, path) != Some(Entry::File) {
            return Ok(None);
        }
        let bytes = fs::read(self.folder.join(path)).map_err(|error| error.kind().to_string())?;
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "is not valid UTF-8".to_owned())
    }

    /// True when the vault has a folder with exactly this vault path, which is
    /// not a symbolic link.
    pub fn has_folder(&self, path: &str) -> bool {
        exact_entry(&self.folder, path) == Some(Entry::Folder)
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
    /// The folder is not the root of its own git repository. Git would else
    /// work on the repository that holds the folder.
    pub fn verify(&self) -> Result<(), String> {
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

    /// The text of a file, by its path in the content store. `Ok(None)` only
    /// when there is no such file.
    ///
    /// # Errors
    ///
    /// The file cannot be read or is not valid UTF-8: a file that cannot be
    /// read is never taken for a missing one.
    pub fn read(&self, path: &str) -> Result<Option<String>, String> {
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

    /// The files below a folder, as paths in the content store, in the order
    /// of the code points.
    pub fn list(&self, below: &str) -> Vec<String> {
        let mut files = Vec::new();
        collect(&self.folder.join(below), below, &mut files);
        files.sort_unstable();
        files
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

    /// Puts these files back as they are in the last commit of the copy: a
    /// file of the commit gets its text again, and another file is removed.
    ///
    /// # Errors
    ///
    /// Git cannot put a file back.
    pub fn discard(&self, paths: &[String]) -> Result<(), String> {
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        self.discard_paths(&paths)
    }

    fn discard_paths(&self, paths: &[&str]) -> Result<(), String> {
        // A copy with no commit has no file to put back.
        let listing = self
            .git_output(&["ls-tree", "-r", "-z", "--name-only", "HEAD"])
            .unwrap_or_default();
        let committed: HashSet<&str> = listing.split('\0').collect();
        let (to_restore, to_remove): (Vec<&str>, Vec<&str>) =
            paths.iter().partition(|path| committed.contains(**path));
        if !to_restore.is_empty() {
            self.git_on_paths(&["checkout", "--quiet", "HEAD"], &to_restore)?;
        }
        for path in to_remove {
            let _ = fs::remove_file(self.folder.join(path));
        }
        Ok(())
    }

    /// Puts exactly these files in one commit and pushes it, without force. A
    /// file that was removed is removed by the commit.
    ///
    /// # Errors
    ///
    /// The commit failed, or the push was refused. After a refused push the
    /// commit is taken back and the files are discarded: the copy is as it
    /// was before.
    pub fn commit_and_push(&self, message: &str, paths: &[String]) -> Result<(), String> {
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        // A copy with no commit has no commit to go back to.
        let before = self
            .git_output(&["rev-parse", "--verify", "--quiet", "HEAD"])
            .ok();
        // Takes back everything that this publication did to the copy.
        let undo = || -> Result<(), String> {
            if let Some(before) = &before {
                self.git_output(&["reset", "--quiet", before.trim()])?;
            } else {
                let _ = self.git_output(&["update-ref", "-d", "HEAD"]);
                let _ =
                    self.git_on_paths(&["rm", "--quiet", "--cached", "--ignore-unmatch"], &paths);
            }
            self.discard_paths(&paths)
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
            // Files that stay in the copy would be read as published at the
            // next run.
            undo()?;
            return Err(format!(
                "the commit into the copy of the content store failed. Nothing is published, and the copy is as it was before: {error}"
            ));
        }
        // Never with force: when another device pushed first, git refuses.
        if self
            .git_output(&["push", "--quiet", "origin", "HEAD:main"])
            .is_ok()
        {
            return Ok(());
        }
        undo()?;
        Err(
            "the push to the content store was refused. Nothing is published, and the copy is as it was before"
                .to_owned(),
        )
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
        let mut git = Command::new("git");
        // Literal paths: a note name with `[`, `*` or `?` must never be read
        // as a pattern that names other files too. No conversion of line
        // ends: a setting of the machine must never change the bytes of a
        // file of the store.
        git.args(["--literal-pathspecs", "-c", "core.autocrlf=false"])
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

/// Adds the files below a folder to the list, as paths with `/` on every
/// system.
fn collect(folder: &Path, path: &str, files: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let below = format!("{path}/{name}");
        // A symbolic link is not a file of the store, as in the vault.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect(&entry.path(), &below, files);
        } else if kind.is_file() {
            files.push(below);
        }
    }
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("{} cannot be written: {error}", path.display());
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder).map_err(failed)?;
    }
    fs::write(path, text).map_err(failed)
}
