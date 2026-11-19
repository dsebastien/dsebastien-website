//! The publication plan as data: the exact list of what one publication will
//! do. The rules are in `documentation/Canonical Form.md`, sections "The
//! selection" and "The publication plan". The TypeScript twin is
//! `apps/plugin/src/publishing/plan.ts`. Change both in the same commit.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::configuration::is_vault_path;
use crate::guards::{IGNORE_PROPERTY, in_deny_list};
use crate::order::sort_by_code_point;
use crate::queue::Scan;

/// The notes that one publication publishes, updates and removes, as vault
/// paths. Each list is sorted by path, in the order of the code points.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationPlan {
    /// The forced removals: the published notes that a guard excludes. No
    /// selection changes this list (PUB-21).
    forced_remove: Vec<String>,
    publish: Vec<String>,
    update: Vec<String>,
    remove: Vec<String>,
}

impl PublicationPlan {
    /// Makes a plan from its four lists. Each list is put in the order of the
    /// canonical form here, so that no caller can give a plan in another order.
    pub fn new(
        mut forced_remove: Vec<String>,
        mut publish: Vec<String>,
        mut update: Vec<String>,
        mut remove: Vec<String>,
    ) -> Self {
        sort_by_code_point(&mut forced_remove);
        sort_by_code_point(&mut publish);
        sort_by_code_point(&mut update);
        sort_by_code_point(&mut remove);
        Self {
            forced_remove,
            publish,
            update,
            remove,
        }
    }

    /// The vault paths of the published notes that a guard excludes.
    pub fn forced_remove(&self) -> &[String] {
        &self.forced_remove
    }

    /// The vault paths of the notes to publish.
    pub fn publish(&self) -> &[String] {
        &self.publish
    }

    /// The vault paths of the published notes to update.
    pub fn update(&self) -> &[String] {
        &self.update
    }

    /// The vault paths of the published notes to unpublish.
    pub fn remove(&self) -> &[String] {
        &self.remove
    }
}

/// What the author, or an agent that he started, selected for one plan: three
/// lists of vault paths, each path one time, sorted. It is a part of the
/// record of a plan.
#[derive(Debug, Serialize)]
pub struct Selection {
    /// The notes to leave out: their live version stays.
    hold: Vec<String>,
    /// The notes to publish. A new candidate enters a plan only through this
    /// list.
    include: Vec<String>,
    /// The published notes to unpublish.
    remove: Vec<String>,
}

/// The paths, each one time, in the order of the code points.
fn unique(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

impl Selection {
    pub fn new(include: &[String], hold: &[String], remove: &[String]) -> Self {
        Self {
            hold: unique(hold),
            include: unique(include),
            remove: unique(remove),
        }
    }
}

/// Why a path that is in no list of the queue cannot be published.
fn reason_out_of_queue(path: &str, scan: &Scan) -> String {
    if in_deny_list(path, &scan.configuration) {
        return "is in a folder of the deny list".to_owned();
    }
    if scan.ignored.contains(path) {
        return format!("has the {IGNORE_PROPERTY} property");
    }
    "does not exist in the vault as a note. A symbolic link and a name that starts with a dot are not part of the vault"
        .to_owned()
}

/// Computes the publication plan of a selection from the queue.
///
/// A plan without paths holds the changed notes only. A new candidate enters a
/// plan only when its path is included (PUB-19, PUB-54). Every plan holds
/// every forced removal: a published note that a guard excludes is removed by
/// the next publication, whatever is selected, and it cannot be held (PUB-21).
///
/// # Errors
///
/// The selection cannot become a plan. The message says which path and why.
pub fn compute_plan(scan: &Scan, selection: &Selection) -> Result<PublicationPlan, String> {
    let queue = &scan.queue;
    let refuse = |path: &str, reason: &str| Err(format!("\"{path}\" {reason}"));
    let mut all: Vec<&String> = selection
        .hold
        .iter()
        .chain(&selection.include)
        .chain(&selection.remove)
        .collect();
    for path in &all {
        if !is_vault_path(path) {
            return refuse(path, "is not a vault path");
        }
        // Letter case is never ignored in the logic.
        #[allow(clippy::case_sensitive_file_extension_comparisons)]
        let is_note = path.ends_with(".md");
        if !is_note {
            return refuse(path, "is not a note: its name does not end in .md");
        }
    }
    all.sort_unstable();
    if let Some(pair) = all.windows(2).find(|pair| pair[0] == pair[1]) {
        return refuse(pair[0], "is in more than one list of the selection");
    }

    // Each list of the queue is sorted, so a binary search finds a path.
    let within = |list: &[String], path: &String| list.binary_search(path).is_ok();
    // A published note is a forced removal when a guard excludes it. A note
    // whose file is only missing from this vault is not one (PUB-95). The list
    // is sorted, as the lists of the queue are.
    let forced: Vec<String> = queue
        .to_remove
        .iter()
        .filter(|path| !within(&queue.missing, path))
        .cloned()
        .collect();
    for path in &selection.include {
        if within(&queue.to_remove, path) {
            return refuse(
                path,
                "is published and waits for its removal: it cannot be published again",
            );
        }
        if !within(&queue.new, path)
            && !within(&queue.changed, path)
            && !within(&queue.unchanged, path)
        {
            return refuse(path, &reason_out_of_queue(path, scan));
        }
    }
    for path in &selection.hold {
        if within(&forced, path) {
            return refuse(
                path,
                "is published and a guard excludes it: its removal cannot be held",
            );
        }
        if !within(&queue.new, path)
            && !within(&queue.changed, path)
            && !within(&queue.to_remove, path)
            && !within(&queue.unchanged, path)
        {
            return refuse(
                path,
                "is not a note of the publication queue: there is nothing to hold",
            );
        }
    }
    for path in &selection.remove {
        if !scan.is_published(path) {
            return refuse(path, "is not published: there is nothing to remove");
        }
    }

    // A guard wins over an unpublish: the note leaves the manifest.
    let remove = selection
        .remove
        .iter()
        .filter(|path| !within(&forced, path))
        .cloned()
        .collect();
    Ok(PublicationPlan::new(
        forced,
        selection
            .include
            .iter()
            .filter(|path| within(&queue.new, path))
            .cloned()
            .collect(),
        queue
            .changed
            .iter()
            .filter(|path| !within(&selection.hold, path) && !within(&selection.remove, path))
            .cloned()
            .collect(),
        remove,
    ))
}
