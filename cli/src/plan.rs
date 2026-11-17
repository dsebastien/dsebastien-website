//! The publication plan as data: the exact list of what one publication will
//! do. The TypeScript twin is `apps/plugin/src/publishing/plan.ts`.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::configuration::{Configuration, is_vault_path};
use crate::device::Vault;
use crate::guards::{Guard, IGNORE_PROPERTY, guard_of};
use crate::manifest::ManifestEntry;
use crate::order::sort_by_code_point;

/// The notes that one publication publishes, updates and removes, as vault
/// paths. Each list is sorted by path, in the order of the code points.
#[derive(Debug, Serialize)]
pub struct PublicationPlan {
    publish: Vec<String>,
    update: Vec<String>,
    remove: Vec<String>,
}

impl PublicationPlan {
    /// Makes a plan from its three lists. Each list is put in the order of the
    /// canonical form here, so that no caller can give a plan in another order.
    pub fn new(mut publish: Vec<String>, mut update: Vec<String>, mut remove: Vec<String>) -> Self {
        sort_by_code_point(&mut publish);
        sort_by_code_point(&mut update);
        sort_by_code_point(&mut remove);
        Self {
            publish,
            update,
            remove,
        }
    }

    /// The vault paths of the notes to publish.
    pub fn publish(&self) -> &[String] {
        &self.publish
    }
}

/// The paths of a selection, each one time, in the order of the code points.
pub fn unique(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Checks one selected path and says why it cannot be published, or `None`
/// when it can.
fn reason_to_refuse(
    path: &str,
    vault: &Vault,
    manifest: &[ManifestEntry],
    configuration: &Configuration,
) -> Option<String> {
    if !is_vault_path(path) {
        return Some("is not a vault path".to_owned());
    }
    // A note is a file whose path ends in `.md`, in small letters. Letter case
    // is never ignored in the logic (`documentation/Canonical Form.md`), and
    // the TypeScript twin compares in the same way.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let is_note = path.ends_with(".md");
    if !is_note {
        return Some("is not a note".to_owned());
    }
    let text = match vault.read(path) {
        Ok(Some(text)) => text,
        Ok(None) => return Some("does not exist in the vault".to_owned()),
        Err(error) => return Some(format!("cannot be read: it {error}")),
    };
    match guard_of(path, &text, configuration) {
        Some(Guard::DenyList) => return Some("is in a folder of the deny list".to_owned()),
        Some(Guard::IgnoreProperty) => return Some(format!("has the {IGNORE_PROPERTY} property")),
        None => {}
    }
    if manifest.iter().any(|entry| entry.path == path) {
        return Some(
            "is already published. A new version of a published note comes with the publication queue"
                .to_owned(),
        );
    }
    None
}

/// Computes the publication plan.
///
/// The first slice knows one case: the first publication of the notes that the
/// selection includes. The publication queue (changed notes, removals) comes
/// with a later slice.
///
/// # Errors
///
/// A path of the selection cannot be published. The message says which path
/// and why.
pub fn compute_plan(
    vault: &Vault,
    manifest: &[ManifestEntry],
    configuration: &Configuration,
    include: &[String],
) -> Result<PublicationPlan, String> {
    let publish = unique(include);
    for path in &publish {
        if let Some(reason) = reason_to_refuse(path, vault, manifest, configuration) {
            return Err(format!("\"{path}\" {reason}"));
        }
    }
    Ok(PublicationPlan::new(publish, Vec::new(), Vec::new()))
}
