//! The device: the vault and the copy of the content store as folders, with
//! the `git` program of the system (TOOL-12 of the spec). The TypeScript twin
//! is `apps/plugin/src/publishing/node/device.ts`.

use std::env;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;

/// What a folder holds at exactly one path.
#[derive(PartialEq, Eq)]
enum Entry {
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

    /// Puts exactly these files in one commit and pushes it, without force.
    ///
    /// # Errors
    ///
    /// The commit failed, or the push was refused. After a refused push the
    /// commit and the files are taken back: the copy is as it was before.
    pub fn commit_and_push(&self, message: &str, paths: &[String]) -> Result<(), String> {
        let before = self.git_output(&["rev-parse", "HEAD"])?;
        let with_paths = |arguments: &[&str]| {
            let mut all: Vec<&str> = arguments.to_vec();
            all.push("--");
            all.extend(paths.iter().map(String::as_str));
            self.git_output(&all).map(|_| ())
        };
        // With force: a rule of the store that ignores a path must not leave a
        // note out of its own publication.
        with_paths(&["add", "--force"])?;
        // Only the files of the publication. Other changes of the copy stay out.
        with_paths(&["commit", "--quiet", "--message", message, "--only"])?;
        // Never with force: when another device pushed first, git refuses.
        if self
            .git_output(&["push", "--quiet", "origin", "HEAD:main"])
            .is_ok()
        {
            return Ok(());
        }
        self.git_output(&["reset", "--quiet", before.trim()])?;
        for path in paths {
            let _ = fs::remove_file(self.folder.join(path));
        }
        Err(
            "the push to the content store was refused. Nothing is published, and the copy is as it was before"
                .to_owned(),
        )
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
        let mut git = Command::new("git");
        git.args(args).current_dir(&self.folder);
        // Inside a git hook, these variables point git to another repository.
        for (name, _) in env::vars_os() {
            if name.to_string_lossy().starts_with("GIT_") {
                git.env_remove(name);
            }
        }
        let output = git
            .output()
            .map_err(|error| format!("git could not start: {error}"))?;
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
        if entry.path().is_dir() {
            collect(&entry.path(), &below, files);
        } else {
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
