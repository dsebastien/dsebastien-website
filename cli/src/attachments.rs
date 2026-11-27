//! The attachments of a note (`documentation/Canonical Form.md`, sections "The
//! attachment storage" and "The attachments of a note"). The TypeScript twin
//! is `apps/plugin/src/publishing/attachments.ts`. Change both in the same
//! commit.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::device::Vault;
use crate::hash::bytes_hash;
use crate::images::image_size;
use crate::links::NoteLink;

/// One item of the list `attachments` of a manifest entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Attachment {
    /// `sha256:` and the SHA-256 of the bytes of the file.
    pub hash: String,
    /// The height of an image, when its bytes say it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    /// The link path, as the note writes it.
    pub link: String,
    /// The vault path of the file.
    pub path: String,
    /// The number of bytes of the file.
    pub size: u64,
    /// The width of an image, when its bytes say it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
}

/// What the tool knows of one file of the vault: what an attachment item
/// holds, but its link.
#[derive(Clone, Debug)]
pub struct FileFacts {
    pub hash: String,
    pub height: Option<u64>,
    pub size: u64,
    pub width: Option<u64>,
}

/// The size limit of an attachment, in bytes: 100 MiB (decision of the
/// author of 2026-11-26, issue 72). A note that links a larger file is held,
/// and the tool reads no byte of that file: it only asks its size. The
/// TypeScript twin is `MAX_ATTACHMENT_SIZE` of `attachments.ts`.
pub const MAX_ATTACHMENT_SIZE: u64 = 100 * 1024 * 1024;

/// A file above the size limit that a note links to: the note is held
/// (issue 72).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TooLarge {
    /// The vault path of the file.
    pub file: String,
    /// The vault path of the note.
    pub path: String,
    /// The number of bytes of the file.
    pub size: u64,
}

/// The items of `tooLarge`, each one time, sorted by path, then by file.
pub fn sort_too_large(items: &mut Vec<TooLarge>) {
    items.sort_by(|one, two| {
        one.path
            .cmp(&two.path)
            .then_with(|| one.file.cmp(&two.file))
    });
    items.dedup_by(|one, two| one.path == two.path && one.file == two.file);
}

/// The key of a file in the attachment storage: its hash without `sha256:`.
pub fn key_of(hash: &str) -> &str {
    hash.strip_prefix("sha256:").unwrap_or(hash)
}

/// An attachment that a publication takes off the site (issue 135): its last
/// vault path, and the key of its file in the attachment storage.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct RemovedAttachment {
    // The order of the fields is the order of the list: by path, then by key.
    pub path: String,
    pub key: String,
}

/// The attachments of `before` that leave the site (rule 2 of
/// `attachmentsRemoved` of "The publication plan"): no attachment of `after`
/// has their key, and none has their path. A file whose path stays with new
/// bytes is an update, not a removal. Each pair one time, sorted by path,
/// then by key.
pub fn removed_attachments<'a>(
    before: impl Iterator<Item = &'a [Attachment]>,
    after: impl Iterator<Item = &'a [Attachment]>,
) -> Vec<RemovedAttachment> {
    let mut keys = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for attachment in after.flatten() {
        keys.insert(key_of(&attachment.hash));
        paths.insert(attachment.path.as_str());
    }
    let removed: BTreeSet<RemovedAttachment> = before
        .flatten()
        .filter(|attachment| {
            !keys.contains(key_of(&attachment.hash)) && !paths.contains(attachment.path.as_str())
        })
        .map(|attachment| RemovedAttachment {
            path: attachment.path.clone(),
            key: key_of(&attachment.hash).to_owned(),
        })
        .collect();
    removed.into_iter().collect()
}

/// True when the text is a hash of an attachment: `sha256:` and 64 small
/// hexadecimal digits.
pub fn is_attachment_hash(hash: &str) -> bool {
    hash.strip_prefix("sha256:").is_some_and(|digits| {
        digits.len() == 64
            && digits
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// The facts of the bytes of a file: its hash, its size and the size of an
/// image.
pub fn facts_of(bytes: &[u8]) -> FileFacts {
    let size = image_size(bytes);
    FileFacts {
        hash: bytes_hash(bytes),
        height: size.map(|size| size.height),
        // A file of the vault has fewer bytes than a `u64` holds.
        size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        width: size.map(|size| size.width),
    }
}

/// The files of the vault that the notes of one run link to. Each file is read
/// one time per run: two notes that link to one image read it one time. Its
/// size is asked first, and a file above the size limit is never read.
#[derive(Clone, Default)]
pub struct FileReader {
    facts: RefCell<BTreeMap<String, FileFacts>>,
    sizes: RefCell<BTreeMap<String, u64>>,
}

impl FileReader {
    /// The number of bytes of a file of the vault, from the file system: no
    /// byte is read.
    ///
    /// # Errors
    ///
    /// The size cannot be read, or the file went away during the run.
    pub fn size(&self, vault: &Vault, path: &str) -> Result<u64, String> {
        if let Some(size) = self.sizes.borrow().get(path) {
            return Ok(*size);
        }
        let size = vault
            .size(path)
            .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?
            .ok_or_else(|| format!("\"{path}\" cannot be read: it went away during the run"))?;
        self.sizes.borrow_mut().insert(path.to_owned(), size);
        Ok(size)
    }

    /// The facts of a file of the vault.
    ///
    /// # Errors
    ///
    /// The file cannot be read, or went away during the run.
    pub fn facts(&self, vault: &Vault, path: &str) -> Result<FileFacts, String> {
        if let Some(facts) = self.facts.borrow().get(path) {
            return Ok(facts.clone());
        }
        let size = self.size(vault, path)?;
        if size > MAX_ATTACHMENT_SIZE {
            return Err(format!(
                "\"{path}\" is not read: its {size} bytes are above the size limit"
            ));
        }
        let bytes = vault
            .read_bytes(path)
            .map_err(|error| format!("\"{path}\" cannot be read: it {error}"))?
            .ok_or_else(|| format!("\"{path}\" cannot be read: it went away during the run"))?;
        let facts = facts_of(&bytes);
        self.facts
            .borrow_mut()
            .insert(path.to_owned(), facts.clone());
        Ok(facts)
    }
}

/// The files above the size limit that these links of the note at `path`
/// lead to, each one time, sorted by the vault path of the file. Only their
/// sizes are read.
///
/// # Errors
///
/// The size of a file cannot be read.
pub fn too_large_of(
    path: &str,
    files: &[NoteLink],
    vault: &Vault,
    reader: &FileReader,
) -> Result<Vec<TooLarge>, String> {
    let mut found = Vec::new();
    for file in files {
        let size = reader.size(vault, &file.path)?;
        if size > MAX_ATTACHMENT_SIZE {
            found.push(TooLarge {
                file: file.path.clone(),
                path: path.to_owned(),
                size,
            });
        }
    }
    sort_too_large(&mut found);
    Ok(found)
}

/// The list `attachments` of a note, from the links that lead to a file that
/// is not a note. The links are sorted by their link paths, so the list is
/// too.
///
/// # Errors
///
/// A file cannot be read.
pub fn attachments_of(
    files: &[NoteLink],
    vault: &Vault,
    reader: &FileReader,
) -> Result<Vec<Attachment>, String> {
    files
        .iter()
        .map(|file| {
            let facts = reader.facts(vault, &file.path)?;
            Ok(Attachment {
                hash: facts.hash,
                height: facts.height,
                link: file.link.clone(),
                path: file.path.clone(),
                size: facts.size,
                width: facts.width,
            })
        })
        .collect()
}
