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
  "cleaningVersion": 2,
  "firstPublished": "2031-04-01T08:00:00Z",
  "formerPaths": [],
  "id": "203d446940c02032",
  "lastPublished": "2031-04-01T08:00:00Z",
  "links": [],
  "path": "10 Garden/Frost dates explained.md",
  "sourceHash": "sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b",
  "state": "published"
}
"#;

const PLAN_RECORD: &str = r#"{
  "plan": {
    "forcedRemove": [],
    "publish": [
      "10 Garden/Frost dates explained.md"
    ],
    "remove": [],
    "update": []
  },
  "selection": {
    "hold": [],
    "include": [
      "10 Garden/Frost dates explained.md"
    ],
    "remove": []
  },
  "state": {
    "configuration": "sha256:e06bbfc5161c72405ce2776eab77bc0001e63cdfc935e664fe5e8be0d98b9a12",
    "manifest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "notes": [
      {
        "cleanedHash": "sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b",
        "links": [],
        "path": "10 Garden/Frost dates explained.md",
        "sourceHash": "sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b"
      }
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
        let output = self.run(
            "publish",
            &["--plan", &id, "--time", TIME, "--device", "garden-shed"],
        );
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
        serde_json::json!({ "forcedRemove": [], "publish": [NOTE], "remove": [], "update": [] })
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

/// The fixture vault has three notes that carry the property by mistake: one
/// candidate, and two notes in folders of the deny list, which are never
/// written (PUB-13).
#[test]
fn the_publication_sets_the_property_and_removes_it_from_the_note_that_is_not_published() {
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
    assert_eq!(changed, ["10 Garden/Bean trellis.md", NOTE]);
    assert!(!read(&setup.vault.join("10 Garden/Bean trellis.md")).contains("public_note"));
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
fn the_publication_refuses_an_unknown_plan_and_a_wrong_time() {
    let setup = set_up();

    let unknown = setup.run("publish", &["--plan", "0000000000000000", "--time", TIME]);
    assert_eq!(unknown.status.code(), Some(1));
    assert!(errors_of(&unknown).contains("plan"));

    let id = setup.plan(NOTE);
    let wrong_time = setup.run("publish", &["--plan", &id, "--time", "2031-04-01 08:00"]);
    assert_eq!(wrong_time.status.code(), Some(1));
    assert!(errors_of(&wrong_time).contains("time"));
}

#[test]
fn a_published_note_that_did_not_change_adds_nothing_to_a_later_plan() {
    let setup = set_up();
    setup.publish(NOTE);

    let again = setup.run("plan", &["--include", NOTE]);

    assert!(again.status.success(), "{}", errors_of(&again));
    let plan: serde_json::Value = serde_json::from_slice(&again.stdout).expect("the plan is JSON");
    assert_eq!(
        plan["plan"],
        serde_json::json!({ "forcedRemove": [], "publish": [], "remove": [], "update": [] })
    );
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

// The guards never open by accident (business rules 2 to 4). Each case here
// was a way around a guard before it was closed.

const DENIED: &str = "90 Locked Shed/Shed inventory.md";

impl Setup {
    /// Asks for a plan that must be refused, and checks the reason.
    fn refuses(&self, path: &str, reason: &str) {
        let output = self.run("plan", &["--include", path]);

        assert_eq!(output.status.code(), Some(1), "{path}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "", "{path}");
        let errors = errors_of(&output);
        assert!(errors.contains(reason), "{path}: {errors}");
        assert!(!self.copy.join(".git").join("vault-publish").exists());
    }
}

/// On a file system that ignores letter case (Windows, macOS), the folder
/// `90 Locked Shed` opens under this name too. The path must be refused on
/// every system: on Linux because there is no such folder, and on Windows
/// because the name is not the name of the folder listing.
#[test]
fn a_deny_list_folder_in_another_letter_case_is_not_a_folder_of_the_vault() {
    let setup = set_up();

    setup.refuses("90 locked shed/Shed inventory.md", "does not exist");
    setup.refuses("90 LOCKED SHED/Shed inventory.md", "does not exist");
    setup.refuses("10 garden/Frost dates explained.md", "does not exist");
    setup.refuses("10 Garden/FROST dates explained.md", "does not exist");
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_is_not_a_note_and_not_a_folder_of_the_vault() {
    use std::os::unix::fs::symlink;
    let setup = set_up();
    let outside = setup.stores.root().join("outside.md");
    fs::write(&outside, "Not a note of the vault.\n").expect("the file can be written");
    symlink(
        setup.vault.join(DENIED),
        setup.vault.join("10 Garden/Linked.md"),
    )
    .expect("the link can be made");
    symlink(
        setup.vault.join("90 Locked Shed"),
        setup.vault.join("Open shed"),
    )
    .expect("the link can be made");
    symlink(&outside, setup.vault.join("Outside.md")).expect("the link can be made");

    setup.refuses("10 Garden/Linked.md", "does not exist");
    setup.refuses("Open shed/Shed inventory.md", "does not exist");
    setup.refuses("Outside.md", "does not exist");
    assert_eq!(read(&outside), "Not a note of the vault.\n");
}

#[test]
fn a_note_that_is_not_valid_utf_8_is_refused() {
    let setup = set_up();
    fs::write(setup.vault.join("Latin.md"), [0x63, 0x61, 0x66, 0xe9, 0x0a])
        .expect("the file can be written");

    setup.refuses("Latin.md", "UTF-8");
}

/// The reading of the ignore property fails closed. The shared cases of
/// `cli/src/frontmatter.rs` hold every form.
#[test]
fn a_form_of_the_ignore_property_that_is_not_the_plain_one_still_excludes_the_note() {
    let setup = set_up();
    fs::write(
        setup.vault.join("Quoted.md"),
        "---\n\"publish_ignore\": yes # never\n---\nText\n",
    )
    .expect("the file can be written");

    setup.refuses("Quoted.md", "publish_ignore");
}

#[test]
fn a_configuration_that_cannot_be_trusted_stops_the_plan() {
    let cases: [(&[u8], &str); 9] = [
        (&[0x7b, 0xe9, 0x7d], "UTF-8"),
        (b"{ \"denyList\": [", "JSON"),
        (b"[[]]", "deny list"),
        (b"{}", "deny list"),
        (b"{ \"denyList\": [\"90 Locked Shed/\"] }", "vault path"),
        (b"{ \"denyList\": [\"/90 Locked Shed\"] }", "vault path"),
        (b"{ \"denyList\": [\"90 locked shed\"] }", "not a folder"),
        (b"{ \"denyList\": [\"90 Locked Shed \"] }", "not a folder"),
        (b"{ \"denyList\": [\"Welcome.md\"] }", "not a folder"),
    ];
    let setup = set_up();

    for (configuration, reason) in cases {
        fs::write(setup.copy.join("configuration.json"), configuration)
            .expect("the configuration can be written");

        // An open note too: a configuration that cannot be trusted stops everything.
        setup.refuses(NOTE, reason);
        setup.refuses(DENIED, reason);
    }
}

#[test]
fn a_configuration_that_is_a_folder_stops_the_plan() {
    let setup = set_up();
    fs::remove_file(setup.copy.join("configuration.json")).expect("the file can be removed");
    fs::create_dir(setup.copy.join("configuration.json")).expect("the folder can be made");

    setup.refuses(DENIED, "cannot be read");
}

#[test]
fn only_a_content_store_without_a_configuration_has_an_empty_deny_list() {
    let setup = set_up();
    // Removed from the content store too: a file that git has and the copy
    // does not stops the tool.
    let copy = text(&setup.copy);
    git(&["-C", copy, "rm", "--quiet", "configuration.json"]);
    git(&[
        "-C",
        copy,
        "commit",
        "--quiet",
        "--message",
        "No configuration",
    ]);
    git(&["-C", copy, "push", "--quiet", "origin", "HEAD:main"]);

    let output = setup.run("plan", &["--include", DENIED]);

    assert!(output.status.success(), "{}", errors_of(&output));
}

#[test]
fn a_configuration_that_is_missing_from_the_copy_stops_the_plan() {
    let setup = set_up();
    fs::remove_file(setup.copy.join("configuration.json")).expect("the file can be removed");

    setup.refuses(DENIED, "missing");
}

#[test]
fn a_folder_that_is_not_the_root_of_its_own_git_repository_is_not_a_content_store() {
    let setup = set_up();
    let inside = setup.copy.join("inside");
    fs::create_dir(&inside).expect("the folder can be made");

    let output = Command::new(env!("CARGO_BIN_EXE_dsebastien-vault-publish"))
        .arg("plan")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&inside)
        .args(["--include", NOTE])
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("git repository"));
}

#[test]
fn a_change_after_the_plan_makes_the_plan_stale() {
    let setup = set_up();
    let remote = text(setup.stores.content_store());

    // A note that was edited after the plan.
    let id = setup.plan(NOTE);
    fs::write(
        setup.vault.join(NOTE),
        format!("{NOTE_TEXT}\nA line that the author did not review.\n"),
    )
    .expect("the note can be written");
    let edited = setup.run("publish", &["--plan", &id, "--time", TIME]);
    assert_eq!(edited.status.code(), Some(1));
    assert!(errors_of(&edited).contains("stale"));
    assert_eq!(
        git(&["--git-dir", remote, "rev-list", "--count", "main"]),
        "1"
    );

    // Another publication after the plan.
    let first = setup.plan("10 Garden/Plot map.md");
    setup.publish("Welcome.md");
    let late = setup.run("publish", &["--plan", &first, "--time", TIME]);
    assert_eq!(late.status.code(), Some(1));
    assert!(errors_of(&late).contains("stale"));

    // The same plan a second time.
    let id = setup.plan("10 Garden/Plot map.md");
    let once = setup.run("publish", &["--plan", &id, "--time", TIME]);
    assert!(once.status.success(), "{}", errors_of(&once));
    let twice = setup.run("publish", &["--plan", &id, "--time", TIME]);
    assert_eq!(twice.status.code(), Some(1));
    assert_eq!(
        git(&["--git-dir", remote, "rev-list", "--count", "main"]),
        "3"
    );
}

#[test]
fn an_id_that_is_not_16_hexadecimal_digits_and_a_time_that_is_not_real_are_refused() {
    let setup = set_up();
    let id = setup.plan(NOTE);

    for wrong in [
        "../../other/.git/vault-publish/plans/0000000000000000",
        "ABCDEF0123456789",
        "abc",
    ] {
        let output = setup.run("publish", &["--plan", wrong, "--time", TIME]);
        assert_eq!(output.status.code(), Some(1), "{wrong}");
        assert!(
            errors_of(&output).contains("16 hexadecimal digits"),
            "{wrong}"
        );
    }
    for wrong in [
        "2031-13-45T99:99:99Z",
        "2031-02-30T08:00:00Z",
        "2031-04-01T24:00:00Z",
    ] {
        let output = setup.run("publish", &["--plan", &id, "--time", wrong]);
        assert_eq!(output.status.code(), Some(1), "{wrong}");
        assert!(errors_of(&output).contains("time"), "{wrong}");
    }
    // A leap day is a real date.
    let leap = setup.run(
        "publish",
        &["--plan", &id, "--time", "2032-02-29T23:59:59Z"],
    );
    assert!(leap.status.success(), "{}", errors_of(&leap));
}

#[test]
fn the_commit_holds_only_the_files_of_the_publication_also_when_a_rule_ignores_them() {
    let setup = set_up();
    fs::write(
        setup.copy.join("scratch.txt"),
        "not for the content store\n",
    )
    .expect("the file can be written");
    fs::create_dir_all(setup.copy.join("notes")).expect("the folder can be made");
    fs::write(
        setup.copy.join("notes").join("left-over.md"),
        "A file that no publication wrote.\n",
    )
    .expect("the file can be written");
    fs::create_dir_all(setup.copy.join(".git").join("info")).expect("the folder can be made");
    fs::write(
        setup.copy.join(".git").join("info").join("exclude"),
        "notes/10 Garden/\n",
    )
    .expect("the file can be written");

    setup.publish(NOTE);

    let files = git(&[
        "--git-dir",
        text(setup.stores.content_store()),
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "main",
    ]);
    let mut files: Vec<&str> = files.split('\0').filter(|file| !file.is_empty()).collect();
    files.sort_unstable();
    assert_eq!(
        files,
        [
            "configuration.json".to_owned(),
            format!("manifest/{NOTE_ID}.json"),
            format!("notes/{NOTE}")
        ]
    );
    assert_eq!(
        read(&setup.copy.join("scratch.txt")),
        "not for the content store\n"
    );
}

/// Another device pushed first. Nothing is published, and nothing is left
/// behind.
#[test]
fn a_refused_push_leaves_the_vault_the_copy_and_the_content_store_as_they_were() {
    let setup = set_up();
    let id = setup.plan(NOTE);
    let remote = text(setup.stores.content_store());
    let other = setup.stores.root().join("other-device");
    git(&["clone", "--quiet", remote, text(&other)]);
    fs::write(other.join("other.txt"), "pushed first\n").expect("the file can be written");
    git(&["-C", text(&other), "add", "other.txt"]);
    git(&[
        "-C",
        text(&other),
        "-c",
        "user.name=Other",
        "-c",
        "user.email=other@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--message",
        "Another device publishes",
    ]);
    git(&["-C", text(&other), "push", "--quiet", "origin", "HEAD:main"]);
    let before = (
        picture(&setup.vault),
        picture(&setup.copy),
        git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]),
        git(&["--git-dir", remote, "rev-parse", "main"]),
    );

    let output = setup.run("publish", &["--plan", &id, "--time", TIME]);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("refused"));
    assert_eq!(picture(&setup.vault), before.0);
    assert_eq!(picture(&setup.copy), before.1);
    assert_eq!(
        git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]),
        before.2
    );
    assert_eq!(git(&["-C", text(&setup.copy), "status", "--porcelain"]), "");
    assert_eq!(git(&["--git-dir", remote, "rev-parse", "main"]), before.3);
}

#[test]
fn a_note_with_windows_line_ends_keeps_them_in_the_vault_and_loses_them_in_the_store() {
    let setup = set_up();
    let windows = NOTE_TEXT.replace('\n', "\r\n");
    fs::write(setup.vault.join(NOTE), &windows).expect("the note can be written");

    setup.publish(NOTE);

    assert_eq!(read(&setup.copy.join("notes").join(NOTE)), NOTE_TEXT);
    assert_eq!(
        read(&setup.vault.join(NOTE)),
        windows.replace(
            "updated: 2031-03-07T07:02\r\n",
            "updated: 2031-03-07T07:02\r\npublic_note: true\r\n"
        )
    );
}

/// A name that starts with a hyphen is a note like another one.
#[test]
fn a_note_whose_name_starts_with_a_hyphen_can_be_included() {
    let setup = set_up();
    fs::write(setup.vault.join("-draft.md"), "A note.\n").expect("the note can be written");

    let output = setup.run("plan", &["--include", "-draft.md"]);

    assert!(output.status.success(), "{}", errors_of(&output));
}
