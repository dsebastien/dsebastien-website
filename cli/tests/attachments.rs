//! The attachments of a publication (issue 35): only the files that published
//! notes use go to the attachment storage, by their content hash, never a file
//! of a deny list folder, and a failed run leaves no file there that the
//! manifest does not list. The tests go through the commands of the program,
//! on a copy of the fixture vault and on stores made for the test.
//!
//! The expected values are the ones of
//! `apps/plugin/src/publishing/publication.spec.ts`. The hashes were computed
//! with `sha256sum`, not with this code.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;

use serde_json::{Value, json};

use support::{TestStores, text};

const NOTE: &str = "10 Garden/Frost dates explained.md";
const PLAN: &str = "10 Garden/Garden plan.md";
const TOUR: &str = "10 Garden/Tool shed tour.md";
const IMAGE: &str = "Attachments/garden-plan.png";
const IMAGE_KEY: &str = "a9526809f9da4f3a083bceb07247ac2633b41de1ddf9cad8d37e0a518b550a33";
const DENIED_KEY: &str = "86571f2b883d23bc5c95dc18aa3cef6077451c6f13a52c6f44373b667503c3a1";
const PLAN_ID: &str = "d3bc99e6071c5b92";
const TIME: &str = "2031-04-01T08:00:00Z";

/// A copy of the fixture vault and of the content store, for one test.
struct Setup {
    stores: TestStores,
    vault: PathBuf,
    copy: PathBuf,
}

fn set_up() -> Setup {
    let stores = TestStores::new();
    let vault = stores.copy_fixture_vault();
    let copy = stores.make_content_store_copy();
    Setup {
        stores,
        vault,
        copy,
    }
}

fn errors_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

impl Setup {
    fn run(&self, arguments: &[&str]) -> Output {
        support::program()
            .args(arguments)
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy)
            .output()
            .expect("the program starts")
    }

    /// Plans a selection and gives the id of the plan. The selection accepts
    /// every forced removal and every note of `guardedAttachments` of the
    /// plan, as the author who saw the plan names them (rule 10 of "The edits
    /// of the guards"): the command line program applies it then.
    fn plan(&self, include: &[&str], remove: &[&str]) -> String {
        let mut arguments = vec!["plan".to_owned()];
        arguments.extend(include.iter().map(|path| format!("--include={path}")));
        arguments.extend(remove.iter().map(|path| format!("--remove={path}")));
        let planned = |arguments: &[String]| -> Value {
            let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
            let output = self.run(&arguments);
            assert!(output.status.success(), "{}", errors_of(&output));
            serde_json::from_slice(&output.stdout).expect("the plan is JSON")
        };
        let mut plan = planned(&arguments);
        let named: Vec<String> = paths(&plan["plan"]["forcedRemove"])
            .into_iter()
            .chain(paths(&plan["plan"]["guardedAttachments"]))
            .collect();
        if !named.is_empty() {
            arguments.extend(named.iter().map(|path| format!("--accept={path}")));
            plan = planned(&arguments);
        }
        plan["id"].as_str().expect("the plan has an id").to_owned()
    }

    /// Applies a plan, and gives the output of the program.
    fn apply(&self, id: &str) -> Output {
        self.run(&[
            "publish",
            "--plan",
            id,
            "--time",
            TIME,
            "--attachment-storage",
            text(self.stores.attachment_storage()),
            "--no-deploy",
        ])
    }

    /// Plans a selection and applies it. The result is the report, also
    /// when a note was left out.
    fn publish(&self, include: &[&str], remove: &[&str]) -> Value {
        let output = self.apply(&self.plan(include, remove));
        serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("the report is JSON: {}", errors_of(&output)))
    }

    /// The names of the files of the attachment storage, sorted.
    fn storage(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.stores.attachment_storage())
            .expect("the storage can be listed")
            .map(|entry| entry.expect("the entry can be read"))
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn add_ignore(&self, note: &str) {
        let path = self.vault.join(note);
        let text = fs::read_to_string(&path).expect("the note can be read");
        fs::write(
            &path,
            text.replacen("---\n", "---\npublish_ignore: true\n", 1),
        )
        .expect("the note can be written");
    }
}

fn paths(list: &Value) -> Vec<String> {
    list.as_array()
        .expect("the value is a list")
        .iter()
        .map(|item| {
            item.as_str()
                .or_else(|| item["path"].as_str())
                .expect("an item is a path, or has one")
                .to_owned()
        })
        .collect()
}

#[test]
fn uploads_only_the_files_that_the_published_notes_use_under_the_hash_of_their_bytes() {
    let setup = set_up();

    let report = setup.publish(&[PLAN, TOUR], &[]);

    assert_eq!(paths(&report["published"]), [PLAN, TOUR]);
    assert_eq!(paths(&report["attachmentsUploaded"]), [IMAGE_KEY]);
    assert_eq!(setup.storage(), [IMAGE_KEY]);
    assert_eq!(
        fs::read(setup.stores.attachment_storage().join(IMAGE_KEY)).expect("the file exists"),
        fs::read(setup.vault.join(IMAGE)).expect("the image exists")
    );
}

#[test]
fn lists_the_attachment_in_the_manifest_entry_with_its_hash_its_size_and_the_size_of_the_image() {
    let setup = set_up();

    setup.publish(&[PLAN], &[]);

    let entry: Value = serde_json::from_str(
        &fs::read_to_string(setup.copy.join("manifest").join(format!("{PLAN_ID}.json")))
            .expect("the entry exists"),
    )
    .expect("the entry is JSON");
    assert_eq!(entry["path"], PLAN);
    assert_eq!(
        entry["attachments"],
        json!([{
            "hash": format!("sha256:{IMAGE_KEY}"),
            "height": 12,
            "link": "garden-plan.png",
            "path": IMAGE,
            "size": 78,
            "width": 16
        }])
    );
}

/// GATE-42: the tour embeds the key of the locked shed.
#[test]
fn never_uploads_a_file_of_a_deny_list_folder_and_writes_none_of_its_paths() {
    let setup = set_up();

    setup.publish(&[TOUR], &[]);

    assert_eq!(setup.storage(), [IMAGE_KEY]);
    // The cleaned note keeps the embed as the author wrote it. No entry names
    // the file under the guard.
    let entries: Vec<PathBuf> = fs::read_dir(setup.copy.join("manifest"))
        .expect("the manifest exists")
        .map(|entry| entry.expect("the entry can be read").path())
        .collect();
    assert_eq!(entries.len(), 1);
    for entry in &entries {
        let text = fs::read_to_string(entry).expect("the entry can be read");
        assert!(!text.contains("Locked Shed"), "{}", entry.display());
        assert!(!text.contains(DENIED_KEY), "{}", entry.display());
    }
    assert!(!setup.copy.join("notes").join("90 Locked Shed").exists());
}

#[test]
fn a_forced_removal_takes_out_the_files_that_no_other_published_note_uses() {
    let setup = set_up();
    setup.publish(&[PLAN, TOUR], &[]);

    setup.add_ignore(TOUR);
    let first = setup.publish(&[], &[]);
    assert_eq!(paths(&first["forcedRemoved"]), [TOUR]);
    assert_eq!(paths(&first["attachmentsDeleted"]), Vec::<String>::new());
    assert_eq!(setup.storage(), [IMAGE_KEY]);

    setup.add_ignore(PLAN);
    let second = setup.publish(&[], &[]);
    assert_eq!(paths(&second["forcedRemoved"]), [PLAN]);
    assert_eq!(paths(&second["attachmentsDeleted"]), [IMAGE_KEY]);
    assert_eq!(setup.storage(), Vec::<String>::new());
}

#[test]
fn an_unpublish_takes_out_the_files_of_the_note() {
    let setup = set_up();
    setup.publish(&[PLAN], &[]);

    let report = setup.publish(&[], &[PLAN]);

    assert_eq!(paths(&report["removed"]), [PLAN]);
    assert_eq!(paths(&report["attachmentsDeleted"]), [IMAGE_KEY]);
    assert_eq!(setup.storage(), Vec::<String>::new());
}

#[test]
fn after_a_refused_push_the_storage_holds_no_file_that_the_manifest_does_not_list() {
    let setup = set_up();
    setup.stores.refuse_pushes();
    let id = setup.plan(&[PLAN, TOUR], &[]);

    let output = setup.apply(&id);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("refused"),
        "{}",
        errors_of(&output)
    );
    assert_eq!(setup.storage(), Vec::<String>::new());
}

#[test]
fn a_note_whose_upload_fails_is_left_out_and_the_other_notes_are_published() {
    let setup = set_up();
    // A folder in the place of the file: the upload cannot write it.
    let blocked = setup.stores.attachment_storage().join(IMAGE_KEY);
    fs::create_dir(&blocked).expect("the folder can be made");

    let output = setup.apply(&setup.plan(&[NOTE, PLAN], &[]));

    assert_eq!(output.status.code(), Some(1), "a note was left out");
    let report: Value = serde_json::from_slice(&output.stdout).expect("the report is JSON");
    assert_eq!(paths(&report["published"]), [NOTE]);
    assert_eq!(paths(&report["failed"]), [PLAN]);
    assert_eq!(paths(&report["attachmentsUploaded"]), Vec::<String>::new());
    assert_eq!(setup.storage(), Vec::<String>::new());
    assert!(!setup.copy.join("notes").join(PLAN).exists());

    // The next publication takes the note.
    fs::remove_dir(&blocked).expect("the folder can be removed");
    let next = setup.publish(&[PLAN], &[]);
    assert_eq!(paths(&next["published"]), [PLAN]);
    assert_eq!(setup.storage(), [IMAGE_KEY]);
}

/// A takedown must never wait for the storage (business rules 4 and 16).
#[test]
fn a_forced_removal_with_no_upload_goes_on_when_the_storage_cannot_be_listed() {
    let setup = set_up();
    setup.publish(&[NOTE], &[]);
    setup.add_ignore(NOTE);
    let id = setup.plan(&[], &[]);
    fs::remove_dir_all(setup.stores.attachment_storage()).expect("the storage can be removed");

    let output = setup.apply(&id);

    let report: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("the report is JSON: {}", errors_of(&output)));
    assert_eq!(paths(&report["forcedRemoved"]), [NOTE]);
    assert_eq!(paths(&report["warnings"]), [""]);
    assert!(!setup.copy.join("notes").join(NOTE).exists());
}

#[test]
fn a_folder_of_the_storage_that_holds_other_files_loses_none_of_them() {
    let setup = set_up();
    let storage = setup.stores.attachment_storage();
    let other = format!("{IMAGE_KEY}.png");
    fs::write(storage.join("Inbox.md"), "A note of the author\n").expect("the file is written");
    fs::write(storage.join(&other), "Not a key\n").expect("the file is written");

    let report = setup.publish(&[NOTE], &[]);

    assert_eq!(paths(&report["attachmentsDeleted"]), Vec::<String>::new());
    assert_eq!(paths(&report["warnings"]), ["Inbox.md", other.as_str()]);
    assert_eq!(setup.storage(), ["Inbox.md", other.as_str()]);
}

#[test]
fn a_file_that_no_published_note_uses_leaves_the_storage_at_the_next_publication() {
    let setup = set_up();
    // An upload that an earlier run could not delete.
    fs::write(
        setup.stores.attachment_storage().join(DENIED_KEY),
        "Left by an earlier run\n",
    )
    .expect("the file can be written");

    let report = setup.publish(&[NOTE], &[]);

    assert_eq!(paths(&report["attachmentsDeleted"]), [DENIED_KEY]);
    assert_eq!(setup.storage(), Vec::<String>::new());
}

#[test]
fn a_note_whose_storage_is_missing_is_left_out() {
    let setup = set_up();
    let id = setup.plan(&[NOTE, PLAN], &[]);
    let missing: &Path = &setup.stores.root().join("no-storage");

    let output = setup.run(&[
        "publish",
        "--plan",
        &id,
        "--time",
        TIME,
        "--attachment-storage",
        text(missing),
        "--no-deploy",
    ]);

    assert_eq!(output.status.code(), Some(1), "a note was left out");
    let report: Value = serde_json::from_slice(&output.stdout).expect("the report is JSON");
    assert_eq!(paths(&report["published"]), [NOTE]);
    assert_eq!(paths(&report["failed"]), [PLAN]);
    assert!(!missing.exists());
}

/// Keeps a file of the vault from being read while it lives: on Windows a
/// handle that shares nothing, on Unix no permission. The size of the file
/// stays readable, so a step that reads the file stops, and one that only
/// stats it does not. A test that runs as root on Unix can still read the
/// file: it then checks the results only.
struct NoRead {
    #[cfg(windows)]
    _handle: fs::File,
}

impl NoRead {
    fn on(path: &Path) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let handle = fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(path)
                .expect("the file can be opened");
            Self { _handle: handle }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o000))
                .expect("the permissions can be set");
            Self {}
        }
    }
}

// Issue 72: a file above the size limit of an attachment is never read.
#[test]
fn a_note_that_links_a_file_above_the_size_limit_is_held_and_no_step_reads_the_file() {
    const VIDEO: &str = "Attachments/field-walk.mp4";
    const SIZE: u64 = 101 * 1024 * 1024;
    let setup = set_up();
    // A sparse file: its bytes are not written.
    fs::File::create(setup.vault.join(VIDEO))
        .and_then(|file| file.set_len(SIZE))
        .expect("the sparse file is made");
    assert_eq!(paths(&setup.publish(&[PLAN], &[])["published"]), [PLAN]);
    for note in [PLAN, TOUR] {
        let path = setup.vault.join(note);
        let text = fs::read_to_string(&path).expect("the note can be read");
        fs::write(&path, format!("{text}\n![[field-walk.mp4]]\n")).expect("the note is written");
    }
    let guard = NoRead::on(&setup.vault.join(VIDEO));

    let status = setup.run(&["status"]);
    assert!(status.status.success(), "{}", errors_of(&status));
    let queue: Value = serde_json::from_slice(&status.stdout).expect("the queue is JSON");
    let output = setup.run(&["plan", &format!("--include={TOUR}")]);
    assert!(output.status.success(), "{}", errors_of(&output));
    let planned: Value = serde_json::from_slice(&output.stdout).expect("the plan is JSON");
    let id = planned["id"].as_str().expect("the plan has an id");
    let published = setup.apply(id);
    assert!(published.status.success(), "{}", errors_of(&published));
    let report: Value = serde_json::from_slice(&published.stdout).expect("the report is JSON");
    let down = setup.run(&[
        "takedown",
        &format!("--path={PLAN}"),
        "--time",
        TIME,
        "--attachment-storage",
        text(setup.stores.attachment_storage()),
        "--no-deploy",
    ]);
    assert!(down.status.success(), "{}", errors_of(&down));
    drop(guard);

    assert_eq!(paths(&queue["changed"]), [PLAN]);
    assert_eq!(
        queue["tooLarge"],
        json!([{ "file": VIDEO, "path": PLAN, "size": SIZE }])
    );
    assert_eq!(planned["plan"]["publish"], json!([]));
    assert_eq!(planned["plan"]["update"], json!([]));
    assert_eq!(
        planned["tooLarge"],
        json!([
            { "file": VIDEO, "path": PLAN, "size": SIZE },
            { "file": VIDEO, "path": TOUR, "size": SIZE }
        ])
    );
    assert_eq!(paths(&report["published"]), Vec::<String>::new());
    assert_eq!(paths(&report["updated"]), Vec::<String>::new());
    assert_eq!(paths(&report["skipped"]), [PLAN]);
    let down: Value = serde_json::from_slice(&down.stdout).expect("the report is JSON");
    assert_eq!(paths(&down["takenDown"]), [PLAN]);
}
