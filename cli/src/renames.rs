//! The rename journals and the read marker of the content store (decision
//! R66, issue 37). The rules are in `documentation/Canonical Form.md`,
//! section "The rename journal". The TypeScript twin is
//! `apps/plugin/src/publishing/renames.ts`. Change both in the same commit.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use crate::configuration::is_vault_path;
use crate::hash::{bytes_hash, content_hash};
use crate::json::parse_json;

/// The file of the content store that counts the lines of each journal that
/// the publications read.
pub const RENAMES_FILE: &str = "renames.json";

/// The folder of the journals in the vault, below the configuration folder of
/// Obsidian.
pub const JOURNAL_FOLDER: &str = "plugins/dsebastien-vault-publish/renames";

/// True when the name is the name of a journal: 16 small hexadecimal digits
/// and `.jsonl`.
fn is_journal_name(name: &str) -> bool {
    name.strip_suffix(".jsonl").is_some_and(|digits| {
        digits.len() == 16
            && digits
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// True when the text is a hash in the form of the marker: `sha256:` and 64
/// small hexadecimal digits.
fn is_hash(text: &str) -> bool {
    text.strip_prefix("sha256:").is_some_and(|digits| {
        digits.len() == 64
            && digits
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// One rename that Obsidian reported: a note, or a folder with everything
/// below it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalLine {
    pub from: String,
    pub folder: bool,
    pub time: String,
    pub to: String,
}

/// How many lines of one journal the publications read, and the hash of their
/// bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Marker {
    pub hash: String,
    pub lines: u64,
}

/// A warning of the journals or of the moves, with the name of the journal or
/// the path of the note.
#[derive(Clone, Debug)]
pub struct RenameWarning {
    pub path: String,
    pub message: String,
}

/// What the journals of the vault hold, against the read marker of the content
/// store.
pub struct JournalState {
    /// The new valid lines of every journal, in the order of the moves.
    pub lines: Vec<JournalLine>,
    /// Every valid line of every journal, in the same order: for the folder of
    /// a deny list entry.
    pub all: Vec<JournalLine>,
    /// The read marker after a publication that reads these lines.
    pub markers: BTreeMap<String, Marker>,
    /// True when the publication changes the read marker.
    pub read: bool,
    /// The hash of the journals, for the record of a plan.
    pub hash: String,
    pub warnings: Vec<RenameWarning>,
}

/// The rename journals of a folder: its files, as they are. A folder that does
/// not exist has none. A folder below it and a symbolic link are no journal.
pub struct RenameJournals {
    folder: PathBuf,
}

impl RenameJournals {
    pub fn new(folder: PathBuf) -> Self {
        Self { folder }
    }

    /// The names of the files of the folder, in any order.
    fn list(&self) -> Result<Vec<String>, String> {
        let failed = |error: std::io::Error| {
            format!(
                "the folder of the rename journals \"{}\" cannot be listed: {error}",
                self.folder.display()
            )
        };
        let entries = match fs::read_dir(&self.folder) {
            Ok(entries) => entries,
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                return Ok(Vec::new());
            }
            Err(error) => return Err(failed(error)),
        };
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry.map_err(failed)?;
            if !entry.file_type().map_err(failed)?.is_file() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_owned());
            }
        }
        Ok(names)
    }

    /// The bytes of a file of the folder, as they are. `None` when it does not
    /// exist or is no file.
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let path = self.folder.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Ok(None),
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                return Ok(None);
            }
            Err(error) => {
                return Err(format!(
                    "the rename journal \"{name}\" cannot be read: {error}"
                ));
            }
        }
        fs::read(&path)
            .map(Some)
            .map_err(|error| format!("the rename journal \"{name}\" cannot be read: {error}"))
    }
}

/// Reads the read marker from the text of `renames.json`. A content store
/// without the file read no line.
///
/// # Errors
///
/// The text is not a marker: a marker that the tool cannot read could apply
/// old lines again.
pub fn parse_markers(text: Option<&str>) -> Result<BTreeMap<String, Marker>, String> {
    let Some(text) = text else {
        return Ok(BTreeMap::new());
    };
    let value = parse_json(text)
        .map_err(|error| format!("{RENAMES_FILE} of the content store is not JSON: {error}"))?;
    let refuse = |why: String| format!("{RENAMES_FILE} of the content store cannot be read: {why}");
    let Value::Object(object) = value else {
        return Err(refuse("it is not an object".to_owned()));
    };
    let mut markers = BTreeMap::new();
    for (name, marker) in object {
        if !is_journal_name(&name) {
            return Err(refuse(format!("\"{name}\" is not the name of a journal")));
        }
        let read = marker.as_object().and_then(|fields| {
            if fields.len() != 2 {
                return None;
            }
            let hash = fields.get("hash")?.as_str()?;
            // A whole number from 0, as JavaScript reads it: `1.0` is 1.
            let lines = fields.get("lines")?.as_f64()?;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let whole = (lines >= 0.0 && lines.fract() == 0.0 && lines <= 9_007_199_254_740_991.0)
                .then_some(lines as u64)?;
            is_hash(hash).then(|| Marker {
                hash: hash.to_owned(),
                lines: whole,
            })
        });
        let Some(read) = read else {
            return Err(refuse(format!(
                "the marker of \"{name}\" is not a hash and a count of lines"
            )));
        };
        markers.insert(name, read);
    }
    Ok(markers)
}

/// Reads one line of a journal: `None` when it is not a valid line.
fn read_line(bytes: &[u8]) -> Option<JournalLine> {
    let text = std::str::from_utf8(bytes).ok()?;
    let value = parse_json(text).ok()?;
    let object = value.as_object()?;
    if object.len() != 4 {
        return None;
    }
    let text_of = |key: &str| object.get(key)?.as_str().map(str::to_owned);
    let (from, kind, time, to) = (
        text_of("from")?,
        text_of("kind")?,
        text_of("time")?,
        text_of("to")?,
    );
    // Letter case is never ignored in the logic.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let notes = from.ends_with(".md") && to.ends_with(".md");
    let folder = match kind.as_str() {
        "folder" => true,
        "note" if notes => false,
        _ => return None,
    };
    (from != to
        && is_vault_path(&from)
        && is_vault_path(&to)
        && crate::tool::is_canonical_time(&time))
    .then_some(JournalLine {
        from,
        folder,
        time,
        to,
    })
}

/// The complete lines of a journal: the bytes before each line feed. The
/// bytes after the last one are not a line yet.
fn lines_of(bytes: &[u8]) -> Vec<&[u8]> {
    let mut lines: Vec<&[u8]> = bytes.split(|byte| *byte == b'\n').collect();
    // The last part follows the last line feed: it is not a line yet.
    lines.pop();
    lines
}

/// The bytes of the first lines of a journal, with their line feeds.
fn prefix_of<'a>(bytes: &'a [u8], lines: &[&[u8]], count: usize) -> &'a [u8] {
    let end: usize = lines.iter().take(count).map(|line| line.len() + 1).sum();
    &bytes[..end]
}

/// Reads the journals against the read marker. A journal that was cut or
/// edited applies none of its lines, and its marker becomes all its lines. A
/// line that is not valid is counted, not applied, and gives a warning.
///
/// # Errors
///
/// The folder of the journals or a journal cannot be read.
pub fn read_journals(
    journals: &RenameJournals,
    markers: &BTreeMap<String, Marker>,
) -> Result<JournalState, String> {
    let mut names: Vec<String> = journals
        .list()?
        .into_iter()
        .filter(|name| is_journal_name(name))
        .collect();
    names.sort_unstable();
    let mut warnings = Vec::new();
    let mut next = markers.clone();
    let mut fresh: Vec<Vec<JournalLine>> = Vec::new();
    let mut every: Vec<Vec<JournalLine>> = Vec::new();
    let mut read = false;
    let mut hashes = String::new();
    for name in names {
        let Some(bytes) = journals.read(&name)? else {
            continue;
        };
        let lines = lines_of(&bytes);
        let whole = bytes_hash(prefix_of(&bytes, &lines, lines.len()));
        // Writing to a `String` cannot fail.
        let _ = write!(hashes, "{name}\n{whole}\n");
        let marker = markers.get(&name);
        let mut first = 0;
        // A journal with fewer lines than its count is not counted again: the
        // vault of this device can be behind, and a lower count would apply
        // its later lines a second time.
        let mut keep = false;
        if let Some(marker) = marker {
            let counted = usize::try_from(marker.lines).unwrap_or(usize::MAX);
            if lines.len() < counted {
                warnings.push(RenameWarning {
                    path: name.clone(),
                    message: "the journal has fewer lines than the publications read: the vault of this device may be behind. None of its lines is applied, and its count stays".to_owned(),
                });
                first = lines.len();
                keep = true;
            } else if bytes_hash(prefix_of(&bytes, &lines, counted)) != marker.hash {
                warnings.push(RenameWarning {
                    path: name.clone(),
                    message: "the journal was cut or edited since the last publication: none of its lines is applied, and its notes can show as pairings".to_owned(),
                });
                first = lines.len();
            } else {
                first = counted;
            }
        }
        let mut valid = Vec::new();
        let mut added = Vec::new();
        for (index, bytes_of_line) in lines.iter().enumerate() {
            match read_line(bytes_of_line) {
                Some(line) => {
                    if index >= first {
                        added.push(line.clone());
                    }
                    valid.push(line);
                }
                None if index >= first => warnings.push(RenameWarning {
                    path: name.clone(),
                    message: format!(
                        "line {} of the journal is not a rename, and it is not applied",
                        index + 1
                    ),
                }),
                None => {}
            }
        }
        every.push(valid);
        fresh.push(added);
        let after = Marker {
            hash: whole,
            lines: lines.len() as u64,
        };
        if !keep && marker != Some(&after) && (marker.is_some() || after.lines > 0) {
            next.insert(name, after);
            read = true;
        }
    }
    Ok(JournalState {
        lines: merged(&fresh),
        all: merged(&every),
        markers: next,
        read,
        hash: content_hash(&hashes),
        warnings,
    })
}

/// The lines of the journals in one order: the next line of each journal,
/// then the one with the earliest time; for the same time, the journal whose
/// name comes first. The lines of one journal keep their order.
fn merged(journals: &[Vec<JournalLine>]) -> Vec<JournalLine> {
    let mut at = vec![0; journals.len()];
    let mut result = Vec::new();
    loop {
        let mut best: Option<usize> = None;
        for (index, journal) in journals.iter().enumerate() {
            let Some(line) = journal.get(at[index]) else {
                continue;
            };
            let earlier = best
                .and_then(|best| journals[best].get(at[best]))
                .is_none_or(|current| line.time < current.time);
            if earlier {
                best = Some(index);
            }
        }
        let Some(best) = best else {
            return result;
        };
        result.push(journals[best][at[best]].clone());
        at[best] += 1;
    }
}

/// The fold of the lines of the journals over the paths of the manifest.
pub struct Fold {
    /// The last path of each entry, by its path in the manifest.
    pub positions: BTreeMap<String, String>,
    /// The time of the last line that moved each entry that moved.
    pub times: BTreeMap<String, String>,
    pub warnings: Vec<RenameWarning>,
}

/// The path of each manifest path after the lines, by the fold of the moves,
/// and the warnings. A note moves when it is at `from`, and a folder moves
/// each path below it. A move to a path that another entry holds does not
/// happen, with a warning.
pub fn fold_moves(paths: impl Iterator<Item = String>, lines: &[JournalLine]) -> Fold {
    // The entry at each current path, and the current path of each entry.
    let mut at: BTreeMap<String, String> = BTreeMap::new();
    let mut positions: BTreeMap<String, String> = BTreeMap::new();
    for path in paths {
        at.insert(path.clone(), path.clone());
        positions.insert(path.clone(), path);
    }
    let mut times: BTreeMap<String, String> = BTreeMap::new();
    let mut warnings = Vec::new();
    let blocked = |entry: &str, from: &str, to: &str| RenameWarning {
        path: entry.to_owned(),
        message: format!(
            "the journal moves the note from \"{from}\" to \"{to}\", where another note of the manifest is: it does not move"
        ),
    };
    for line in lines {
        if !line.folder {
            let Some(entry) = at.get(&line.from).cloned() else {
                continue;
            };
            if at.contains_key(&line.to) {
                warnings.push(blocked(&entry, &line.from, &line.to));
                continue;
            }
            at.remove(&line.from);
            at.insert(line.to.clone(), entry.clone());
            times.insert(entry.clone(), line.time.clone());
            positions.insert(entry, line.to.clone());
            continue;
        }
        let prefix = format!("{}/", line.from);
        let movers: Vec<String> = at
            .keys()
            .filter(|path| path.starts_with(&prefix))
            .cloned()
            .collect();
        let moving: BTreeSet<&String> = movers.iter().collect();
        let mut moved = Vec::new();
        for path in &movers {
            let target = format!("{}/{}", line.to, &path[prefix.len()..]);
            let entry = at.get(path).cloned().unwrap_or_default();
            if at.contains_key(&target) && !moving.contains(&target) {
                warnings.push(blocked(&entry, path, &target));
                continue;
            }
            moved.push((entry, path.clone(), target));
        }
        for (_, path, _) in &moved {
            at.remove(path);
        }
        for (entry, _, target) in moved {
            at.insert(target.clone(), entry.clone());
            times.insert(entry.clone(), line.time.clone());
            positions.insert(entry, target);
        }
    }
    Fold {
        positions,
        times,
        warnings,
    }
}

/// The former paths of an entry that moves from `from` to `to`: without
/// `to`, with `from` at the end.
pub fn former_paths_after(former_paths: &[String], from: &str, to: &str) -> Vec<String> {
    let mut kept: Vec<String> = former_paths
        .iter()
        .filter(|path| *path != to)
        .cloned()
        .collect();
    if !kept.iter().any(|path| path == from) {
        kept.push(from.to_owned());
    }
    kept
}

/// The new path that the journals give to a folder of the deny list that is
/// not in the vault (PUB-91): every valid line, in the order of the moves,
/// moves that folder or a folder above it. `None` when no line moves it.
pub fn moved_folder(folder: &str, lines: &[JournalLine]) -> Option<String> {
    let mut path = folder.to_owned();
    for line in lines.iter().filter(|line| line.folder) {
        if path == line.from {
            path.clone_from(&line.to);
        } else if let Some(rest) = path.strip_prefix(&format!("{}/", line.from)) {
            path = format!("{}/{rest}", line.to);
        }
    }
    (path != folder).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::{lines_of, parse_markers, read_line};
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/renames.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/cases.json");

    fn cases(key: &str) -> Vec<(String, String, bool)> {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        cases[key]
            .as_array()
            .expect("the cases file has the list")
            .iter()
            .map(|case| {
                (
                    case["name"].as_str().expect("a name").to_owned(),
                    case["text"].as_str().expect("a text").to_owned(),
                    case["valid"].as_bool().expect("a verdict"),
                )
            })
            .collect()
    }

    #[test]
    fn reads_a_read_marker_as_the_file_states() {
        let cases = cases("markers");
        assert!(cases.len() > 8);
        for (name, text, valid) in cases {
            let result = parse_markers(Some(&text));
            assert_eq!(result.is_ok(), valid, "{name}");
            if let Err(error) = result {
                assert!(error.contains("renames.json"), "{name}: {error}");
            }
        }
    }

    #[test]
    fn reads_a_line_of_a_journal_as_the_file_states() {
        let cases = cases("journalLines");
        assert!(cases.len() > 15);
        for (name, text, valid) in cases {
            let bytes = format!("{text}\n").into_bytes();
            let lines = lines_of(&bytes);
            assert_eq!(lines.len(), 1, "{name}");
            assert_eq!(read_line(lines[0]).is_some(), valid, "{name}");
        }
    }

    #[test]
    fn the_bytes_after_the_last_line_feed_are_no_line() {
        assert_eq!(lines_of(b"{\"from\":\"A.md\"").len(), 0);
        assert_eq!(lines_of(b"one\ntwo").len(), 1);
    }
}
