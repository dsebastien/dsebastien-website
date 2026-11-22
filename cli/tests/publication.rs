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
use std::process::Output;

use support::{TestStores, git, text};

const NOTE: &str = "10 Garden/Frost dates explained.md";
const SECOND: &str = "10 Garden/Compost basics.md";
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
  "aliases": [],
  "attachments": [],
  "cleanedHash": "sha256:0272965e3663dcff6c10306e1d6f76d41005e50d7cf9fa72db8fad03caa76e1b",
  "cleaningVersion": 5,
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
        "aliases": [],
        "attachments": [],
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

/// Commits every change of the copy and pushes it, as another device would:
/// the tool reads the files of the last commit of the copy.
fn commit_in_copy(copy: &Path, message: &str) {
    let copy = text(copy);
    git(&["-C", copy, "add", "--all"]);
    git(&["-C", copy, "commit", "--quiet", "--message", message]);
    git(&["-C", copy, "push", "--quiet", "origin", "HEAD:main"]);
}

fn errors_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

impl Setup {
    fn run(&self, command: &str, arguments: &[&str]) -> Output {
        let mut program = support::program();
        program
            .arg(command)
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy);
        if command == "publish" || command == "takedown" {
            program
                .arg("--attachment-storage")
                .arg(self.stores.attachment_storage());
        }
        program
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
        commit_in_copy(&setup.copy, "A configuration that cannot be trusted");

        // An open note too: a configuration that cannot be trusted stops everything.
        setup.refuses(NOTE, reason);
        setup.refuses(DENIED, reason);
    }
}

#[test]
fn a_configuration_that_is_a_folder_stops_the_plan() {
    let setup = set_up();
    git(&[
        "-C",
        text(&setup.copy),
        "rm",
        "--quiet",
        "configuration.json",
    ]);
    fs::create_dir(setup.copy.join("configuration.json")).expect("the folder can be made");
    fs::write(
        setup.copy.join("configuration.json").join("inside"),
        "A file in a folder\n",
    )
    .expect("the file is written");
    commit_in_copy(&setup.copy, "A configuration that is a folder");

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

    setup.refuses(DENIED, "last commit");
}

#[test]
fn a_folder_that_is_not_the_root_of_its_own_git_repository_is_not_a_content_store() {
    let setup = set_up();
    let inside = setup.copy.join("inside");
    fs::create_dir(&inside).expect("the folder can be made");

    let output = support::program()
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
    setup.stores.refuse_pushes();
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

/// Another device pushes between the fetch of the publication and its push
/// (issue 36, PUB-94, PUB-97). The author pulls, and the next run publishes on
/// top of the other device, with no forced push.
#[test]
fn a_push_that_another_device_made_first_is_refused_and_after_a_pull_the_next_run_publishes() {
    let setup = set_up();
    let remote = text(setup.stores.content_store());
    let other = setup.stores.root().join("other-device");
    git(&["clone", "--quiet", remote, text(&other)]);
    let in_other = |arguments: &[&str]| {
        let mut all = vec!["-C", text(&other)];
        all.extend_from_slice(arguments);
        git(&all)
    };
    in_other(&["config", "user.name", "Test"]);
    in_other(&["config", "user.email", "test@example.invalid"]);
    in_other(&["config", "commit.gpgsign", "false"]);
    fs::create_dir_all(other.join("notes")).expect("the folder can be made");
    fs::write(
        other.join("notes").join("Elsewhere.md"),
        "A note of another device\n",
    )
    .expect("the file can be written");
    in_other(&["add", "--", "notes/Elsewhere.md"]);
    in_other(&[
        "commit",
        "--quiet",
        "--message",
        "A publication of another device",
    ]);
    let theirs = in_other(&["rev-parse", "HEAD"]);
    // The other device pushes when this one is about to push.
    let hooks = setup.copy.join(".git").join("hooks");
    fs::create_dir_all(&hooks).expect("the folder can be made");
    let hook = hooks.join("pre-push");
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\nenv -i PATH=\"$PATH\" HOME=\"$HOME\" git -C \"{}\" push --quiet origin HEAD:main\n",
            text(&other).replace('\\', "/")
        ),
    )
    .expect("the hook is written");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("the hook can run");
    }
    let id = setup.plan(NOTE);
    let before = (
        picture(&setup.vault),
        git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]),
    );

    let output = setup.run("publish", &["--plan", &id, "--time", TIME]);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("refused"),
        "{}",
        errors_of(&output)
    );
    // Nothing is published and no property is corrected.
    assert_eq!(git(&["--git-dir", remote, "rev-parse", "main"]), theirs);
    assert_eq!(picture(&setup.vault), before.0);
    assert_eq!(
        git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]),
        before.1
    );
    let output = setup.run("plan", &["--include", NOTE]);
    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("git pull --ff-only origin main"));

    fs::remove_file(&hook).expect("the hook can be removed");
    git(&[
        "-C",
        text(&setup.copy),
        "pull",
        "--quiet",
        "--ff-only",
        "origin",
        "main",
    ]);
    setup.publish(NOTE);

    // On top of the commit of the other device: no forced push took it back.
    git(&[
        "--git-dir",
        remote,
        "merge-base",
        "--is-ancestor",
        &theirs,
        "main",
    ]);
    assert_eq!(
        git(&["--git-dir", remote, "show", &format!("main:notes/{NOTE}")]),
        NOTE_TEXT.trim_end()
    );
    assert!(read(&setup.vault.join(NOTE)).contains("public_note: true"));
}

/// A write of the tool into a note (issue 36): the new text goes into a hidden
/// file of the same folder, which is then renamed. A stop of the process
/// during the write never leaves the note empty or half written.
#[cfg(unix)]
#[test]
fn the_write_of_a_note_replaces_it_in_one_rename_and_leaves_no_other_file() {
    use std::os::unix::fs::MetadataExt;
    let setup = set_up();
    let note = setup.vault.join(NOTE);
    let before = fs::metadata(&note).expect("the note exists").ino();
    let names = |folder: &Path| {
        let mut names: Vec<String> = fs::read_dir(folder)
            .expect("the folder can be listed")
            .map(|entry| {
                entry
                    .expect("the entry can be read")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    };
    let folder = names(&setup.vault.join("10 Garden"));

    setup.publish(NOTE);

    // Another file, renamed over the old one: a write into the same file
    // keeps its number.
    assert_ne!(fs::metadata(&note).expect("the note exists").ino(), before);
    assert!(read(&note).contains("public_note: true"));
    assert_eq!(names(&setup.vault.join("10 Garden")), folder);
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

/// The lock of another run: the author ran unlock while a publication ran.
#[cfg(unix)]
const OTHER_LOCK: &str = "{\n  \"command\": \"plan\",\n  \"process\": 1\n}\n";

/// The corrections after the first review of issue 36: a publication whose
/// lock another run took after its commit corrects no property and keeps that
/// lock.
#[cfg(unix)]
#[test]
fn a_publication_whose_lock_another_run_took_corrects_no_property_and_keeps_that_lock() {
    use std::os::unix::fs::PermissionsExt;
    let setup = set_up();
    let hooks = setup.copy.join(".git").join("hooks");
    fs::create_dir_all(&hooks).expect("the folder can be made");
    let hook = hooks.join("pre-commit");
    fs::write(
        &hook,
        format!("#!/bin/sh\nprintf '%s' '{OTHER_LOCK}' > .git/vault-publish/lock\n"),
    )
    .expect("the hook is written");
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("the hook can run");
    let id = setup.plan(NOTE);
    let vault = picture(&setup.vault);

    let output = setup.run("publish", &["--plan", &id, "--time", TIME]);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("lock"),
        "{}",
        errors_of(&output)
    );
    assert_eq!(picture(&setup.vault), vault);
    assert_eq!(
        read(&setup.copy.join(".git").join("vault-publish").join("lock")),
        OTHER_LOCK
    );
}

/// A cleaned note that the copy lost would stay in the content store after
/// its forced removal: the removal stages only what it removes.
#[test]
fn a_cleaned_note_that_is_missing_from_the_copy_stops_the_run() {
    let setup = set_up();
    setup.publish(NOTE);
    fs::remove_file(setup.copy.join("notes").join(NOTE)).expect("the note can be removed");

    for output in [setup.run("status", &[]), setup.run("plan", &[])] {
        assert_eq!(output.status.code(), Some(1));
        let message = errors_of(&output);
        assert!(message.contains(&format!("notes/{NOTE}")), "{message}");
        assert!(message.contains("git checkout HEAD -- notes"), "{message}");
    }
}

#[test]
fn a_publication_of_a_stale_plan_cleans_the_attachment_storage_before_it_stops() {
    let setup = set_up();
    // An upload of a run that stopped halfway: no published note uses it.
    let left = setup.stores.attachment_storage().join("a".repeat(64));
    fs::write(&left, "An upload of a run that stopped\n").expect("the file can be written");
    let id = setup.plan(NOTE);
    fs::write(
        setup.vault.join(NOTE),
        format!("{NOTE_TEXT}\nAn edit after the plan.\n"),
    )
    .expect("the note can be written");

    let output = setup.run("publish", &["--plan", &id, "--time", TIME]);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("stale"),
        "{}",
        errors_of(&output)
    );
    assert!(!left.exists());
}

/// Issue 77: the warnings of the cleanup of a stale plan are not lost.
#[test]
fn the_refusal_of_a_stale_plan_names_the_warnings_of_the_cleanup_of_the_storage() {
    let setup = set_up();
    fs::write(
        setup.stores.attachment_storage().join("stray.txt"),
        "Not an upload of the tool\n",
    )
    .expect("the file can be written");
    let id = setup.plan(NOTE);
    fs::write(
        setup.vault.join(NOTE),
        format!("{NOTE_TEXT}\nAn edit after the plan.\n"),
    )
    .expect("the note can be written");

    let output = setup.run("publish", &["--plan", &id, "--time", TIME]);

    assert_eq!(output.status.code(), Some(1));
    let errors = errors_of(&output);
    assert!(errors.contains("stale"), "{errors}");
    assert!(
        errors.contains("The cleanup of the attachment storage gave these warnings:\n- stray.txt: the attachment storage holds a file whose name is not a key, and the tool leaves it: is the folder of the storage the right one?"),
        "{errors}"
    );
}

#[test]
fn the_refusal_of_a_stale_plan_whose_cleanup_gave_no_warning_names_none() {
    let setup = set_up();
    let id = setup.plan(NOTE);
    fs::write(
        setup.vault.join(NOTE),
        format!("{NOTE_TEXT}\nAn edit after the plan.\n"),
    )
    .expect("the note can be written");

    let output = setup.run("publish", &["--plan", &id, "--time", TIME]);

    assert_eq!(output.status.code(), Some(1));
    let errors = errors_of(&output);
    assert!(
        errors.contains(&format!("the plan {id} is stale: a note of the plan, the publication queue, the configuration or the content store changed. Make a new plan")),
        "{errors}"
    );
    assert!(!errors.contains("The cleanup"), "{errors}");
    assert!(!errors.contains("\n- "), "{errors}");
}

// Windows refuses a file name with a line break.
#[cfg(not(windows))]
#[test]
fn a_name_of_the_storage_with_a_line_break_gives_one_line_in_the_refusal() {
    let setup = set_up();
    fs::write(
        setup
            .stores
            .attachment_storage()
            .join("x\n- fake: injected"),
        "Odd\n",
    )
    .expect("the file can be written");
    let id = setup.plan(NOTE);
    fs::write(
        setup.vault.join(NOTE),
        format!("{NOTE_TEXT}\nAn edit after the plan.\n"),
    )
    .expect("the note can be written");

    let output = setup.run("publish", &["--plan", &id, "--time", TIME]);

    let errors = errors_of(&output);
    let lines: Vec<&str> = errors
        .lines()
        .filter(|line| line.starts_with("- "))
        .collect();
    assert_eq!(
        lines,
        [
            "- x\\n- fake: injected: the attachment storage holds a file whose name is not a key, and the tool leaves it: is the folder of the storage the right one?"
        ],
        "{errors}"
    );
}

#[test]
fn a_folder_that_is_not_a_copy_of_the_content_store_gets_no_file_of_the_tool() {
    let setup = set_up();
    let id = setup.plan(NOTE);
    let folder = setup.stores.root().join("not-a-copy");
    fs::create_dir(&folder).expect("the folder can be made");
    let run = |arguments: &[&str]| {
        support::program()
            .args(arguments)
            .arg("--vault")
            .arg(&setup.vault)
            .arg("--content-store")
            .arg(&folder)
            .output()
            .expect("the program starts")
    };

    let published = run(&[
        "publish",
        "--attachment-storage",
        text(setup.stores.attachment_storage()),
        "--plan",
        &id,
        "--time",
        TIME,
    ]);
    let planned = run(&["plan", "--include", NOTE]);

    for output in [published, planned] {
        assert_eq!(output.status.code(), Some(1));
        assert!(
            errors_of(&output).contains("not the root"),
            "{}",
            errors_of(&output)
        );
    }
    assert_eq!(
        fs::read_dir(&folder)
            .expect("the folder can be listed")
            .count(),
        0
    );
}

/// The note with the ignore property: a guard now excludes it.
#[cfg(unix)]
const IGNORED_NOTE: &str = "---\npublish_ignore: true\n---\nPrivate now.\n";

/// The corrections after the second review of issue 36: another run puts a
/// file of the run back during the commit. The commit then misses a forced
/// removal, and it must never be pushed.
#[cfg(unix)]
#[test]
fn a_commit_that_does_not_hold_exactly_the_files_of_the_run_is_never_pushed() {
    use std::os::unix::fs::PermissionsExt;
    let setup = set_up();
    setup.publish(NOTE);
    fs::write(setup.vault.join(NOTE), IGNORED_NOTE).expect("the note can be written");
    let output = setup.run("plan", &[]);
    assert!(output.status.success(), "{}", errors_of(&output));
    let plan: serde_json::Value = serde_json::from_slice(&output.stdout).expect("JSON");
    assert_eq!(plan["plan"]["forcedRemove"], serde_json::json!([NOTE]));
    let id = plan["id"].as_str().expect("the plan has an id");
    let remote = text(setup.stores.content_store());
    let before = git(&["--git-dir", remote, "rev-parse", "main"]);
    let hooks = setup.copy.join(".git").join("hooks");
    fs::create_dir_all(&hooks).expect("the folder can be made");
    let hook = hooks.join("pre-commit");
    fs::write(
        &hook,
        format!("#!/bin/sh\ngit checkout HEAD -- \"notes/{NOTE}\"\n"),
    )
    .expect("the hook is written");
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("the hook can run");

    let output = setup.run("publish", &["--plan", id, "--time", TIME]);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("does not hold exactly its files"),
        "{}",
        errors_of(&output)
    );
    assert_eq!(git(&["--git-dir", remote, "rev-parse", "main"]), before);
    assert_eq!(git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]), before);
}

/// A cleaned note that git skips is not compared by git status: its removal
/// would stage nothing.
#[test]
fn a_cleaned_note_that_git_skips_stops_the_run() {
    let setup = set_up();
    setup.publish(NOTE);
    git(&[
        "-C",
        text(&setup.copy),
        "update-index",
        "--skip-worktree",
        "--",
        &format!("notes/{NOTE}"),
    ]);
    fs::remove_file(setup.copy.join("notes").join(NOTE)).expect("the note can be removed");

    let output = setup.run("status", &[]);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        errors_of(&output).contains("--no-skip-worktree"),
        "{}",
        errors_of(&output)
    );
}

/// Issue 78: the check of the lock just before the commit. The switch of the
/// debug build gives the lock to another run at that moment, as when the
/// author ran unlock and another publication took the copy.
#[test]
fn a_publication_whose_lock_another_run_took_before_the_commit_makes_no_commit() {
    let setup = set_up();
    let id = setup.plan(NOTE);
    let head = git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]);

    let output = support::program()
        .arg("publish")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&setup.copy)
        .arg("--attachment-storage")
        .arg(setup.stores.attachment_storage())
        .args(["--plan", &id, "--time", TIME])
        .env("DSEBASTIEN_VAULT_PUBLISH_TEST_STEAL_LOCK", "commit")
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    let errors = errors_of(&output);
    assert!(
        errors.contains("the lock of this publication was removed while it ran"),
        "{errors}"
    );
    assert_eq!(git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]), head);
    assert_eq!(
        git(&["-C", text(&setup.copy), "rev-parse", "origin/main"]),
        head
    );
}

/// Issue 75: the recovery of a plan checks its own lock before each write.
#[test]
fn a_plan_whose_lock_another_run_took_during_its_recovery_changes_nothing_more() {
    let setup = set_up();
    let id = setup.plan(NOTE);
    let crashed = support::program()
        .arg("publish")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&setup.copy)
        .arg("--attachment-storage")
        .arg(setup.stores.attachment_storage())
        .args(["--plan", &id, "--time", TIME])
        .env("DSEBASTIEN_VAULT_PUBLISH_TEST_CRASH", "write")
        .output()
        .expect("the program starts");
    assert_eq!(crashed.status.code(), Some(99), "{}", errors_of(&crashed));
    // The lock is a file of the copy: `unlock` takes no vault.
    let unlocked = support::program()
        .arg("unlock")
        .arg("--content-store")
        .arg(&setup.copy)
        .output()
        .expect("the program starts");
    assert!(unlocked.status.success(), "{}", errors_of(&unlocked));
    let local = setup.copy.join(".git").join("vault-publish");
    let journal = fs::read_to_string(local.join("journal.json")).expect("the journal exists");
    let written = setup.copy.join("notes").join(NOTE);
    assert!(written.exists());

    let output = support::program()
        .arg("plan")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&setup.copy)
        .args(["--include", NOTE])
        .env("DSEBASTIEN_VAULT_PUBLISH_TEST_STEAL_LOCK", "recover")
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    let errors = errors_of(&output);
    assert!(
        errors.contains("the lock of this publication was removed while it ran"),
        "{errors}"
    );
    assert!(written.exists());
    assert_eq!(
        fs::read_to_string(local.join("journal.json")).expect("the journal exists"),
        journal
    );
    assert!(
        fs::read_to_string(local.join("lock"))
            .expect("the lock of the other run exists")
            .contains("another run")
    );
}

/// Issue 75: the journal is written only while the lock is the own one, also
/// when the recovery of a publication finds that the push of a stopped run
/// arrived.
#[test]
fn a_publication_whose_lock_another_run_took_after_the_recovery_found_the_push_leaves_the_journal()
{
    let setup = set_up();
    let first = setup.plan(NOTE);
    let second = setup.plan(SECOND);
    let crashed = support::program()
        .arg("publish")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&setup.copy)
        .arg("--attachment-storage")
        .arg(setup.stores.attachment_storage())
        .args(["--plan", &second, "--time", TIME])
        .env("DSEBASTIEN_VAULT_PUBLISH_TEST_CRASH", "push")
        .output()
        .expect("the program starts");
    assert_eq!(crashed.status.code(), Some(99), "{}", errors_of(&crashed));
    let unlocked = support::program()
        .arg("unlock")
        .arg("--content-store")
        .arg(&setup.copy)
        .output()
        .expect("the program starts");
    assert!(unlocked.status.success(), "{}", errors_of(&unlocked));
    let local = setup.copy.join(".git").join("vault-publish");
    let journal = fs::read_to_string(local.join("journal.json")).expect("the journal exists");

    let output = support::program()
        .arg("publish")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&setup.copy)
        .arg("--attachment-storage")
        .arg(setup.stores.attachment_storage())
        .args(["--plan", &first, "--time", TIME])
        .env("DSEBASTIEN_VAULT_PUBLISH_TEST_STEAL_LOCK", "journal")
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    let errors = errors_of(&output);
    assert!(
        errors.contains("the lock of this publication was removed while it ran"),
        "{errors}"
    );
    assert_eq!(
        fs::read_to_string(local.join("journal.json")).expect("the journal exists"),
        journal
    );
}

/// Issue 76: git cannot write some paths on some systems, so they look
/// deleted. The message says why and what to do.
// Windows refuses to make the file `CON.md` that the test publishes.
#[cfg(not(windows))]
#[test]
fn a_missing_cleaned_note_whose_path_git_cannot_write_on_some_systems_gets_the_cause() {
    let setup = set_up();
    let reserved = "10 Garden/CON.md";
    let long = format!("{}/{}.md", "L".repeat(150), "x".repeat(150));
    fs::create_dir(setup.vault.join("L".repeat(150))).expect("the folder can be made");
    for path in [reserved, long.as_str()] {
        fs::write(setup.vault.join(path), "# Odd\n\nA note.\n").expect("the note can be written");
    }
    let output = setup.run("plan", &["--include", reserved, "--include", &long]);
    assert!(output.status.success(), "{}", errors_of(&output));
    let plan: serde_json::Value = serde_json::from_slice(&output.stdout).expect("the plan is JSON");
    let id = plan["id"].as_str().expect("the plan has an id").to_owned();
    let published = setup.run("publish", &["--plan", &id, "--time", TIME]);
    assert!(published.status.success(), "{}", errors_of(&published));
    fs::remove_file(setup.copy.join("notes").join(reserved)).expect("the note can be removed");
    fs::remove_file(setup.copy.join("notes").join(&long)).expect("the note can be removed");

    let message = errors_of(&setup.run("status", &[]));

    assert!(
        message.contains(&format!("notes/{reserved} (a name that Windows refuses)")),
        "{message}"
    );
    assert!(
        message.contains(&format!("notes/{long} (a path longer than Windows allows)")),
        "{message}"
    );
    assert!(
        message.contains("git config core.longpaths true"),
        "{message}"
    );
    assert!(
        message.contains("rename the note in the vault"),
        "{message}"
    );
}

/// The takedown (issue 38, PUB-81, PUB-99): one commit with the removals, and
/// nothing taken down when the copy is behind or the push is refused.
fn take_down(setup: &Setup, note: &str) -> Output {
    setup.run(
        "takedown",
        &[
            "--path",
            note,
            "--time",
            "2031-04-02T08:00:00Z",
            "--device",
            "garden-shed",
        ],
    )
}

#[test]
fn a_takedown_removes_the_note_and_its_entry_in_one_commit_which_names_the_takedown() {
    let setup = set_up();
    setup.publish(NOTE);

    let output = take_down(&setup, NOTE);

    assert!(output.status.success(), "{}", errors_of(&output));
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("the report is JSON");
    assert_eq!(report["takenDown"], serde_json::json!([NOTE]));
    let remote = text(setup.stores.content_store());
    let commit = git(&[
        "--git-dir",
        remote,
        "show",
        "--name-status",
        "--format=%B",
        "--no-renames",
        "main",
    ]);
    let (message, files) = commit
        .split_once("\n\n\n")
        .expect("a message and its files");
    let lines: Vec<&str> = message.lines().collect();
    assert_eq!(
        lines[..4],
        [
            "Takedown: 1 note",
            "",
            "Device: garden-shed",
            "Face: command-line"
        ]
    );
    let id = lines[4].strip_prefix("Plan: ").expect("the line Plan:");
    assert!(id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(
        files,
        format!("D\tmanifest/{NOTE_ID}.json\nD\tnotes/{NOTE}")
    );
    assert_eq!(
        git(&["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]),
        "configuration.json"
    );
    let local = setup.copy.join(".git").join("vault-publish");
    assert!(!local.join("journal.json").exists());
    assert!(!local.join("lock").exists());
}

#[test]
fn a_refused_push_takes_nothing_down_and_leaves_everything_as_it_was() {
    let setup = set_up();
    setup.publish(NOTE);
    let remote = text(setup.stores.content_store());
    setup.stores.refuse_pushes();
    let before = (
        picture(&setup.vault),
        picture(&setup.copy),
        picture(setup.stores.attachment_storage()),
        git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]),
        git(&["--git-dir", remote, "rev-parse", "main"]),
    );

    let output = take_down(&setup, NOTE);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("refused"));
    assert!(errors_of(&output).contains("Nothing is taken down"));
    assert_eq!(picture(&setup.vault), before.0);
    assert_eq!(picture(&setup.copy), before.1);
    assert_eq!(picture(setup.stores.attachment_storage()), before.2);
    assert_eq!(
        git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]),
        before.3
    );
    assert_eq!(git(&["-C", text(&setup.copy), "status", "--porcelain"]), "");
    assert_eq!(git(&["--git-dir", remote, "rev-parse", "main"]), before.4);
    assert!(
        !setup
            .copy
            .join(".git")
            .join("vault-publish")
            .join("journal.json")
            .exists()
    );
}

#[test]
fn a_copy_that_is_behind_the_content_store_stops_the_takedown_which_says_to_pull() {
    let setup = set_up();
    setup.publish(NOTE);
    // Another device publishes after the last pull of this copy.
    let other = setup.stores.root().join("other-device");
    let remote = text(setup.stores.content_store());
    git(&["clone", "--quiet", remote, text(&other)]);
    // A clone has no identity of its own: a machine with no global one cannot
    // commit.
    for (key, value) in [
        ("user.name", "Test"),
        ("user.email", "test@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(&["-C", text(&other), "config", key, value]);
    }
    fs::write(
        other.join("notes").join("Elsewhere.md"),
        "A note of another device\n",
    )
    .expect("the note is written");
    git(&["-C", text(&other), "add", "--", "notes/Elsewhere.md"]);
    git(&[
        "-C",
        text(&other),
        "commit",
        "--quiet",
        "--message",
        "A publication of another device",
    ]);
    git(&["-C", text(&other), "push", "--quiet", "origin", "HEAD:main"]);
    let after_other = git(&["--git-dir", remote, "rev-parse", "main"]);
    let vault = picture(&setup.vault);

    let output = take_down(&setup, NOTE);

    assert_eq!(output.status.code(), Some(1));
    assert!(errors_of(&output).contains("git pull --ff-only origin main"));
    assert_eq!(
        git(&["--git-dir", remote, "rev-parse", "main"]),
        after_other
    );
    assert!(setup.copy.join("notes").join(NOTE).exists());
    assert_eq!(picture(&setup.vault), vault);
}

/// A file of the attachment storage that the takedown cannot delete can stay
/// public: the program writes the report, then ends with an error.
#[test]
fn a_takedown_whose_storage_gives_a_warning_writes_its_report_and_ends_with_an_error() {
    let setup = set_up();
    setup.publish(NOTE);
    // A file whose name is not a key: the storage may be the wrong folder.
    fs::write(
        setup.stores.attachment_storage().join("notes.txt"),
        "Not a file of the storage\n",
    )
    .expect("the file is written");

    let output = take_down(&setup, NOTE);

    assert_eq!(output.status.code(), Some(1));
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("the report is written");
    assert_eq!(report["takenDown"], serde_json::json!([NOTE]));
    assert_eq!(report["warnings"], serde_json::json!([]));
    let warnings: Vec<&str> = report["storageWarnings"]
        .as_array()
        .expect("a list")
        .iter()
        .filter_map(|warning| warning["path"].as_str())
        .collect();
    assert_eq!(warnings, ["notes.txt"]);
    assert!(
        errors_of(&output).contains("the attachment storage gave 1 warning(s)"),
        "{}",
        errors_of(&output)
    );
}

/// A takedown of a path with no entry stops, and its message says what its
/// first cleanup of the storage deleted: a takedown that stopped after its
/// push is finished in this way.
#[test]
fn a_takedown_of_a_path_with_no_entry_says_what_its_cleanup_of_the_storage_deleted() {
    let setup = set_up();
    setup.publish(NOTE);
    // A file that no published note uses, as a stopped takedown leaves it.
    let key = "0".repeat(64);
    fs::write(
        setup.stores.attachment_storage().join(&key),
        "A left file\n",
    )
    .expect("the file is written");

    let output = take_down(&setup, SECOND);

    assert_eq!(output.status.code(), Some(1));
    let errors = errors_of(&output);
    assert!(
        errors.contains("is the path of no manifest entry"),
        "{errors}"
    );
    assert!(
        errors.contains(&format!(
            "The takedown deleted 1 file(s) of the attachment storage that no published note uses: {key}"
        )),
        "{errors}"
    );
    assert!(!setup.stores.attachment_storage().join(&key).exists());
    assert!(setup.copy.join("notes").join(NOTE).exists());
}
