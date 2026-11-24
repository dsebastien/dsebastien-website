//! The publication plan as data: the exact list of what one publication will
//! do. The rules are in `documentation/Canonical Form.md`, sections "The
//! selection" and "The publication plan". The TypeScript twin is
//! `apps/plugin/src/publishing/plan.ts`. Change both in the same commit.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::configuration::is_vault_path;
use crate::edits::Event;
use crate::guards::{IGNORE_PROPERTY, in_deny_list};
use crate::manifest::State;
use crate::names::{
    first_part, folded_form, is_changed_by_obsidian, is_reserved_root_name, obsidian_path,
    obsidian_twins,
};
use crate::order::sort_by_code_point;
use crate::queue::{Move, Scan};

/// The notes that one publication publishes, updates and removes, as vault
/// paths. Each list is sorted by path, in the order of the code points.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationPlan {
    /// The forced removals: the notes with a manifest entry that a guard
    /// excludes, also unpublished ones (R64). No
    /// selection changes this list (PUB-21).
    forced_remove: Vec<String>,
    /// The moves: of the new lines of the rename journals, and of the
    /// pairings of the selection (R66). Sorted by `from`.
    #[serde(rename = "move")]
    moves: Vec<Move>,
    publish: Vec<String>,
    update: Vec<String>,
    remove: Vec<String>,
    /// The events of the log of the edits of the guards that no publication
    /// showed yet, in the order of the log (GATE-07, GATE-40, R69). A new
    /// event makes a stored plan stale.
    edits: Vec<Event>,
    /// The published entries after the plan whose attachments list a file
    /// under a guard now (rule 8 of "A publication"): the publication would
    /// delete the file. Sorted by path. Set with the texts of the plan.
    guarded_attachments: Vec<String>,
}

/// Moves sorted by `from`, then by `to`, each one time.
fn sort_moves(moves: &mut Vec<Move>) {
    moves.sort_by(|one, two| one.from.cmp(&two.from).then_with(|| one.to.cmp(&two.to)));
    moves.dedup();
}

impl PublicationPlan {
    /// Makes a plan from its four lists. Each list is put in the order of the
    /// canonical form here, so that no caller can give a plan in another order.
    pub fn new(
        mut forced_remove: Vec<String>,
        mut moves: Vec<Move>,
        mut publish: Vec<String>,
        mut update: Vec<String>,
        mut remove: Vec<String>,
        edits: Vec<Event>,
    ) -> Self {
        sort_moves(&mut moves);
        sort_by_code_point(&mut forced_remove);
        sort_by_code_point(&mut publish);
        sort_by_code_point(&mut update);
        sort_by_code_point(&mut remove);
        Self {
            forced_remove,
            moves,
            publish,
            update,
            remove,
            edits,
            guarded_attachments: Vec::new(),
        }
    }

    /// Sets the published entries after the plan whose attachments list a
    /// file under a guard now, in the order of the canonical form.
    pub fn set_guarded_attachments(&mut self, mut paths: Vec<String>) {
        sort_by_code_point(&mut paths);
        paths.dedup();
        self.guarded_attachments = paths;
    }

    /// The published entries after the plan whose attachments list a file
    /// under a guard now, sorted by path.
    pub fn guarded_attachments(&self) -> &[String] {
        &self.guarded_attachments
    }

    /// The events of the edits of the guards that the plan shows, in the
    /// order of the log.
    pub fn edits(&self) -> &[Event] {
        &self.edits
    }

    /// The moves of the plan, sorted by `from`.
    pub fn moves(&self) -> &[Move] {
        &self.moves
    }

    /// The vault paths of the notes with a manifest entry that a guard
    /// excludes, also unpublished ones (R64).
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
#[derive(Clone, Debug, Serialize)]
pub struct Selection {
    /// The forced removals and the notes of `guardedAttachments` that the
    /// author named: only they let an agent face apply the plan (rule 10 of
    /// "The edits of the guards"). They change nothing in the plan.
    accept: Vec<String>,
    /// The notes to leave out: their live version stays.
    hold: Vec<String>,
    /// The notes to publish. A new candidate enters a plan only through this
    /// list.
    include: Vec<String>,
    /// The pairings that the author confirms: a published note that is
    /// missing, and the candidate that is that note now (PUB-62, PUB-96).
    /// Each one time, sorted by `from`.
    pair: Vec<Move>,
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
    pub fn new(
        include: &[String],
        hold: &[String],
        remove: &[String],
        pair: &[Move],
        accept: &[String],
    ) -> Self {
        let mut pair = pair.to_vec();
        sort_moves(&mut pair);
        Self {
            accept: unique(accept),
            hold: unique(hold),
            include: unique(include),
            pair,
            remove: unique(remove),
        }
    }

    /// The pairings of the selection, sorted by `from`.
    pub fn pair(&self) -> &[Move] {
        &self.pair
    }

    /// The vault paths that the selection accepts, sorted.
    pub fn accept(&self) -> &[String] {
        &self.accept
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
/// every forced removal: a note with a manifest entry that a guard excludes,
/// published or unpublished, leaves the content store at the next publication,
/// whatever is selected, and it cannot be held (PUB-21, R64).
///
/// # Errors
///
/// The selection cannot become a plan. The message says which path and why.
pub fn compute_plan(scan: &Scan, selection: &Selection) -> Result<PublicationPlan, String> {
    let queue = &scan.queue;
    let refuse = |path: &str, reason: &str| Err(format!("\"{path}\" {reason}"));
    refuse_paths(selection)?;

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
        if within(&queue.unpublished_under_guard, path) {
            return refuse(
                path,
                "is unpublished and a guard excludes it: its removal cannot be held",
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
    refuse_pairings(scan, selection)?;

    // A guard wins over an unpublish: the note leaves the manifest.
    let remove = selection
        .remove
        .iter()
        .filter(|path| !within(&forced, path))
        .cloned()
        .collect();
    // An unpublished note under a guard leaves the manifest too (decision R64).
    let plan = PublicationPlan::new(
        forced
            .iter()
            .chain(&queue.unpublished_under_guard)
            .cloned()
            .collect(),
        // Every move of the journals, which no selection holds, and the
        // pairings (R66).
        queue
            .renamed
            .iter()
            .chain(&selection.pair)
            .cloned()
            .collect(),
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
            // The update of a moved note whose text changed waits for a tick
            // (R67).
            .filter(|path| !within(&queue.moved_edited, path) || within(&selection.include, path))
            .chain(
                selection
                    .pair
                    .iter()
                    .map(|pairing| &pairing.to)
                    .filter(|path| !within(&selection.hold, path)),
            )
            .cloned()
            .collect(),
        remove,
        scan.edits.since().to_vec(),
    );
    refuse_obsidian_paths(scan, &plan, &selection.pair)?;
    refuse_root_names(scan, &plan, &selection.pair)?;
    Ok(plan)
}

/// The forced removals of the plan of a scan (rule 3 of the plan): the
/// published notes that a guard excludes, and the unpublished ones (R64),
/// sorted by path. No selection changes them.
pub fn forced_removals(scan: &Scan) -> Vec<String> {
    let queue = &scan.queue;
    let mut forced: Vec<String> = queue
        .to_remove
        .iter()
        .filter(|path| queue.missing.binary_search(path).is_err())
        .chain(&queue.unpublished_under_guard)
        .cloned()
        .collect();
    sort_by_code_point(&mut forced);
    forced
}

/// `Err` when a path of the selection is not the vault path of a note, or is
/// in more than one list. The `to` of a pairing can be held.
fn refuse_paths(selection: &Selection) -> Result<(), String> {
    let refuse = |path: &str, reason: &str| Err(format!("\"{path}\" {reason}"));
    // The `to` of a pairing can be held: the move happens, the update waits.
    let held_to = |path: &String| selection.hold.contains(path);
    let mut all: Vec<&String> = selection
        .hold
        .iter()
        .chain(&selection.include)
        .chain(&selection.remove)
        .chain(selection.pair.iter().map(|pairing| &pairing.from))
        .chain(
            selection
                .pair
                .iter()
                .map(|pairing| &pairing.to)
                .filter(|path| !held_to(path)),
        )
        .collect();
    // A path of accept has the form of a note too. It can be in another
    // list: a forced removal can also be named in remove.
    for path in all.iter().copied().chain(&selection.accept) {
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
    Ok(())
}

/// `Err` when a pairing of the selection does not pair a published note that
/// is missing from this vault with a candidate that has no manifest entry.
fn refuse_pairings(scan: &Scan, selection: &Selection) -> Result<(), String> {
    let queue = &scan.queue;
    let within = |list: &[String], path: &String| list.binary_search(path).is_ok();
    let mut paired_to = BTreeSet::new();
    for Move { from, to } in &selection.pair {
        if !paired_to.insert(to) {
            return Err(format!(
                "\"{to}\" is the candidate of more than one pairing"
            ));
        }
        if queue.renamed.iter().any(|one| &one.to == from) {
            return Err(format!(
                "\"{from}\" is the new path of a move of a rename journal in this plan: publish the move first, then confirm the pairing"
            ));
        }
        if !within(&queue.missing, from) {
            return Err(format!(
                "\"{from}\" is not a published note that is missing from this vault: it cannot be paired"
            ));
        }
        if !within(&queue.new, to) || scan.manifest.contains_key(to) {
            return Err(format!(
                "\"{to}\" is not a candidate with no manifest entry: it cannot be paired"
            ));
        }
    }
    Ok(())
}

/// Stops a plan that publishes a note, or pairs a note with a path, that
/// Obsidian reads as another path or as the path of another note of the scan
/// (rule 4 of section "Paths" of the canonical form, decision R72): its
/// links, the Starter Kit and the refresh of its lists would not find it, or
/// would find the other file. The author gives the file another name. A plan
/// without a new note and without a pairing never stops here, so no forced
/// removal waits for this rule.
fn refuse_obsidian_paths(
    scan: &Scan,
    plan: &PublicationPlan,
    pairs: &[Move],
) -> Result<(), String> {
    let paths: Vec<&String> = plan
        .publish
        .iter()
        .chain(pairs.iter().map(|pairing| &pairing.to))
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    let twins = obsidian_twins(scan.notes.keys());
    for path in paths {
        if is_changed_by_obsidian(path) {
            return Err(format!(
                "\"{path}\" cannot be published: Obsidian reads its path as \"{}\" (a no-break space, a backslash, a slash too many or a name that is not in the composed Unicode form), so its links and its note type would not find it. Give the file another name, in Obsidian or outside it",
                obsidian_path(path)
            ));
        }
        if let Some(twin) = twins.get(path) {
            return Err(format!(
                "\"{path}\" cannot be published: the file \"{twin}\" has the same path in Obsidian (\"{}\"), so Obsidian can take one for the other. Give one of the two files another name",
                obsidian_path(path)
            ));
        }
    }
    Ok(())
}

/// The vault path of a note without `.md`: the text of its URL.
fn without_suffix(path: &str) -> &str {
    path.strip_suffix(".md").unwrap_or(path)
}

/// Stops a plan that publishes a note when a note would take a reserved root
/// name of the site, or when two published paths after the plan would be one
/// URL for the resolver (URL-09 of the spec, section "The root names of the
/// site" of the canonical form). A plan without a new note never stops here,
/// so no forced removal waits for these rules.
fn refuse_root_names(scan: &Scan, plan: &PublicationPlan, pairs: &[Move]) -> Result<(), String> {
    if plan.publish.is_empty() && pairs.is_empty() {
        return Ok(());
    }
    for path in plan
        .publish
        .iter()
        .chain(pairs.iter().map(|pairing| &pairing.to))
    {
        let name = without_suffix(path.rsplit('/').next().unwrap_or(path));
        if is_reserved_root_name(name) {
            return Err(format!(
                "\"{path}\" cannot be published: its file name \"{name}\" is a reserved root name of the site"
            ));
        }
        if path.contains('/') && is_reserved_root_name(first_part(path)) {
            return Err(format!(
                "\"{path}\" cannot be published: its first folder \"{}\" is a reserved root name of the site",
                first_part(path)
            ));
        }
    }
    let leaving: BTreeSet<&str> = plan
        .forced_remove
        .iter()
        .chain(&plan.remove)
        .chain(pairs.iter().map(|pairing| &pairing.from))
        .map(String::as_str)
        .collect();
    let notes = scan
        .manifest
        .values()
        .filter(|entry| entry.state == State::Published && !leaving.contains(entry.path.as_str()))
        .map(|entry| entry.path.as_str())
        .chain(plan.publish.iter().map(String::as_str))
        .chain(pairs.iter().map(|pairing| pairing.to.as_str()));
    // Each text of a URL: the path of each note, and each folder of it. A
    // note and a folder with the same text are one text: the note wins. The
    // set of `String` is in the order of the code points.
    let mut texts: BTreeSet<String> = BTreeSet::new();
    for path in notes {
        let text = without_suffix(path);
        texts.insert(text.to_owned());
        for (slash, _) in text.match_indices('/') {
            texts.insert(text[..slash].to_owned());
        }
    }
    let mut by_folded: BTreeMap<String, &str> = BTreeMap::new();
    for text in &texts {
        let folded = folded_form(text);
        if let Some(other) = by_folded.get(&folded) {
            return Err(format!(
                "\"{other}\" and \"{text}\" cannot both be published: they differ only in letter case or in Unicode form, and the site gives them one URL"
            ));
        }
        by_folded.insert(folded, text);
    }
    Ok(())
}
