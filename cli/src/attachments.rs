//! The attachments of a note (`documentation/Canonical Form.md`, sections "The
//! attachment storage" and "The attachments of a note"). The TypeScript twin
//! is `apps/plugin/src/publishing/attachments.ts`. Change both in the same
//! commit.

use std::cell::RefCell;
use std::collections::BTreeMap;

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

/// The key of a file in the attachment storage: its hash without `sha256:`.
pub fn key_of(hash: &str) -> &str {
    hash.strip_prefix("sha256:").unwrap_or(hash)
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
/// one time per run: two notes that link to one image read it one time.
#[derive(Default)]
pub struct FileReader {
    facts: RefCell<BTreeMap<String, FileFacts>>,
}

impl FileReader {
    /// The facts of a file of the vault.
    ///
    /// # Errors
    ///
    /// The file cannot be read, or went away during the run.
    pub fn facts(&self, vault: &Vault, path: &str) -> Result<FileFacts, String> {
        if let Some(facts) = self.facts.borrow().get(path) {
            return Ok(facts.clone());
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
