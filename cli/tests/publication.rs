//! The first slice (issue 31): one invented note goes through the plan, the
//! guards, the cleaning step and the content store, and its `public_note`
//! property is corrected. The tests go through the two commands of the
//! program, on a copy of the fixture vault and on a content store made for the
//! test.
//!
//! The expected texts are the ones of
//! `apps/plugin/src/publishing/publication.spec.ts`. The hashes were computed
//! with `sha256sum`, not with this code.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use support::{TestStores, git, text};

const NOTE: &str = "10 Garden/Frost dates explained.md";
const TIME: &str = "2031-04-01T08:00:00Z";
const NOTE_ID: &str = "203d446940c02032";

const NOTE_TEXT: &str = "---
tags:
  - type/note
ai_generated: true
created: 2031-03-07T07:00
updated: 2031-03-07T07:02
---

# Frost dates explained

The last frost date is the average day of the last frost in spring. Tender plants go out after it.
";

const MANIFEST_ENTRY: &str = r#"{
  "attachments": [],
  "cleanedHash": "sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b",
  "cleaningVersion": 1,
  "firstPublished": "2031-04-01T08:00:00Z",
  "formerPaths": [],
  "id": "203d446940c02032",
  "lastPublished": "2031-04-01T08:00:00Z",
  "path": "10 Garden/Frost dates explained.md",
  "sourceHash": "sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b",
  "state": "published"
}
"#;

const PLAN_RECORD: &str = r#"{
  "plan": {
    "publish": [
      "10 Garden/Frost dates explained.md"
    ],
    "remove": [],
    "update": []
  },
  "selection": {
    "include": [
      "10 Garden/Frost dates explained.md"
    ]
  }
}
"#;

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
    fn run(&self, command: &str, arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
            .arg(command)
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy)
            .args(arguments)
            .output()
            .expect("the program starts")
    }

    /// Plans the first publication of a note and gives the id of the plan.
    fn plan(&self, note: &str) -> String {
        let output = self.run("plan", &["--include", note]);
        assert!(output.status.success(), "{}", errors_of(&output));
        let plan: serde_json::Value =
            serde_json::from_slice(&output.stdout).expect("the plan is JSON");
        plan["id"].as_str().expect("the plan has an id").to_owned()
    }

    fn publish(&self, note: &str) {
        let id = self.plan(note);
        let output = self.run("publish", &["--plan", &id, "--time", TIME]);
        assert!(output.status.success(), "{}", errors_of(&output));
    }

    fn stored_plan(&self, id: &str) -> PathBuf {
        self.copy
            .join(".git")
            .join("vault-publish")
            .join("plans")
            .join(format!("{id}.json"))
    }
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).expect("the file can be read")
}

fn collect(folder: &Path, root: &Path, files: &mut Vec<(String, Vec<u8>)>) {
    for entry in fs::read_dir(folder).expect("the folder can be read") {
        let path = entry.expect("the entry can be read").path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name != ".git") {
                collect(&path, root, files);
            }
        } else {
            let name = path.strip_prefix(root).expect("the file is in the folder");
            files.push((
                name.to_string_lossy().replace('\\', "/"),
                fs::read(&path).expect("the file can be read"),
            ));
        }
    }
}

/// Every file of a folder with its bytes: a picture to compare before and
/// after. The git folder is left out.
fn picture(folder: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    collect(folder, folder, &mut files);
    files.sort();
    files
}

#[test]
fn the_plan_names_the_included_note_and_has_an_id() {
    let setup = set_up();

    let output = setup.run("plan", &["--include", NOTE]);

    assert!(output.status.success());
    let plan: serde_json::Value = serde_json::from_slice(&output.stdout).expect("the plan is JSON");
    assert_eq!(
        plan["plan"],
        serde_json::json!({ "publish": [NOTE], "remove": [], "update": [] })
    );
    let id = plan["id"].as_str().expect("the plan has an id");
    assert_eq!(id.len(), 16);
    assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

#[test]
fn the_plan_writes_nothing_into_the_vault_and_into_the_content_store() {
    let setup = set_up();
    let before = (picture(&setup.vault), picture(&setup.copy));
    let head = git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]);

    setup.plan(NOTE);

    assert_eq!(picture(&setup.vault), before.0);
    assert_eq!(picture(&setup.copy), before.1);
    assert_eq!(git(&["-C", text(&setup.copy), "status", "--porcelain"]), "");
    assert_eq!(git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]), head);
    let remote = git(&[
        "--git-dir",
        text(setup.stores.content_store()),
        "rev-parse",
        "main",
    ]);
    assert_eq!(remote, head);
}

#[test]
fn the_plan_is_stored_on_the_device_in_the_canonical_form() {
    let setup = set_up();

    let id = setup.plan(NOTE);

    assert_eq!(read(&setup.stored_plan(&id)), PLAN_RECORD);
}

/// The tool never reads the property as an input (PUB-12).
#[test]
fn the_plan_takes_a_note_whose_property_wrongly_says_that_it_is_published() {
    let setup = set_up();

    let output = setup.run("plan", &["--include", "10 Garden/Bean trellis.md"]);

    assert!(output.status.success(), "{}", errors_of(&output));
}

#[test]
fn the_plan_refuses_what_cannot_be_published() {
    let cases = [
        ("90 Locked Shed/Shed inventory.md", "deny list"),
        ("10 Garden/Neighbour dispute.md", "publish_ignore"),
        ("10 Garden/No such note.md", "does not exist"),
        ("Attachments/garden-plan.png", "not a note"),
        ("../configuration.json", "vault path"),
    ];
    let setup = set_up();

    for (path, reason) in cases {
        let output = setup.run("plan", &["--include", path]);

        assert_eq!(output.status.code(), Some(1), "{path}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "", "{path}");
        let errors = errors_of(&output);
        assert!(errors.contains(reason), "{path}: {errors}");
    }
    assert!(!setup.copy.join(".git").join("vault-publish").exists());
}

#[test]
fn the_publication_adds_one_commit_with_the_note_and_its_manifest_entry() {
    let setup = set_up();

    setup.publish(NOTE);

    let remote = text(setup.stores.content_store());
    assert_eq!(
        git(&["--git-dir", remote, "rev-list", "--count", "main"]),
        "2"
    );
    let files = git(&[
        "--git-dir",
        remote,
        "diff",
        "--name-only",
        "-z",
        "main~1",
        "main",
    ]);
    let files: Vec<&str> = files.split('\0').filter(|file| !file.is_empty()).collect();
    assert_eq!(
        files,
        [format!("manifest/{NOTE_ID}.json"), format!("notes/{NOTE}")]
    );
    assert_eq!(git(&["-C", text(&setup.copy), "status", "--porcelain"]), "");
    assert_eq!(
        git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]),
        git(&["--git-dir", remote, "rev-parse", "main"])
    );
}

#[test]
fn the_publication_writes_the_cleaned_note_and_the_manifest_entry() {
    let setup = set_up();

    setup.publish(NOTE);

    assert_eq!(read(&setup.copy.join("notes").join(NOTE)), NOTE_TEXT);
    let entry = setup.copy.join("manifest").join(format!("{NOTE_ID}.json"));
    assert_eq!(read(&entry), MANIFEST_ENTRY);
}

#[test]
fn the_publication_sets_the_property_and_changes_no_other_file_of_the_vault() {
    let setup = set_up();
    let before = picture(&setup.vault);

    setup.publish(NOTE);

    assert_eq!(
        read(&setup.vault.join(NOTE)),
        NOTE_TEXT.replace(
            "updated: 2031-03-07T07:02\n",
            "updated: 2031-03-07T07:02\npublic_note: true\n"
        )
    );
    let after = picture(&setup.vault);
    assert_eq!(after.len(), before.len());
    let changed: Vec<&str> = after
        .iter()
        .zip(&before)
        .filter(|(now, then)| now != then)
        .map(|(now, _)| now.0.as_str())
        .collect();
    assert_eq!(changed, [NOTE]);
}

/// The property is the state in the vault, not content: it never reaches the
/// content store (PUB-14).
#[test]
fn the_publication_leaves_the_property_out_of_the_cleaned_note() {
    let setup = set_up();
    let note = "10 Garden/Bean trellis.md";
    let source = read(&setup.vault.join(note));

    setup.publish(note);

    assert_eq!(
        read(&setup.copy.join("notes").join(note)),
        source.replace("public_note: true\n", "")
    );
    assert_eq!(read(&setup.vault.join(note)), source);
}

#[test]
fn the_publication_refuses_an_unknown_plan_a_wrong_time_and_a_second_first_publication() {
    let setup = set_up();

    let unknown = setup.run("publish", &["--plan", "0000000000000000", "--time", TIME]);
    assert_eq!(unknown.status.code(), Some(1));
    assert!(errors_of(&unknown).contains("plan"));

    let id = setup.plan(NOTE);
    let wrong_time = setup.run("publish", &["--plan", &id, "--time", "2031-04-01 08:00"]);
    assert_eq!(wrong_time.status.code(), Some(1));
    assert!(errors_of(&wrong_time).contains("time"));

    setup.publish(NOTE);
    let again = setup.run("plan", &["--include", NOTE]);
    assert_eq!(again.status.code(), Some(1));
    assert!(errors_of(&again).contains("already published"));
}

/// Without `--time`, the program reads the clock one time and gives the
/// canonical form to the logic.
#[test]
fn the_publication_takes_the_time_of_the_clock_by_default() {
    let setup = set_up();
    let id = setup.plan(NOTE);

    let output = setup.run("publish", &["--plan", &id]);

    assert!(output.status.success(), "{}", errors_of(&output));
    let files: Vec<PathBuf> = fs::read_dir(setup.copy.join("manifest"))
        .expect("the manifest exists")
        .map(|entry| entry.expect("the entry can be read").path())
        .collect();
    assert_eq!(files.len(), 1);
    let entry: serde_json::Value =
        serde_json::from_str(&read(&files[0])).expect("the entry is JSON");
    let time = entry["firstPublished"]
        .as_str()
        .expect("the entry has a time");
    assert_eq!(time.len(), TIME.len());
    assert!(time.starts_with("20") && time.ends_with('Z'), "{time}");
}
