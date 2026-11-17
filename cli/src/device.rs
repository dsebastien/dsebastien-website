//! The device: the vault and the copy of the content store as folders, with
//! the `git` program of the system (TOOL-12 of the spec). The TypeScript twin
//! is `apps/plugin/src/publishing/node/device.ts`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

    /// The text of a file, by its vault path. `None` when there is no such
    /// file.
    pub fn read(&self, path: &str) -> Option<String> {
        fs::read_to_string(self.folder.join(path)).ok()
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

    /// The text of a file, by its path in the content store. `None` when there
    /// is no such file.
    pub fn read(&self, path: &str) -> Option<String> {
        fs::read_to_string(self.folder.join(path)).ok()
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

    /// Puts every change in one commit and pushes it, without force: when
    /// another device pushed first, git refuses, and nothing is published.
    ///
    /// # Errors
    ///
    /// The commit or the push failed.
    pub fn commit_and_push(&self, message: &str) -> Result<(), String> {
        self.git(&["add", "--all"])?;
        self.git(&["commit", "--quiet", "--message", message])?;
        self.git(&["push", "--quiet", "origin", "HEAD:main"])
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

    fn git(&self, args: &[&str]) -> Result<(), String> {
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
            Ok(())
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
