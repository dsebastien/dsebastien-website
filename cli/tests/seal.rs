//! The seal of the content store (decision R104, `documentation/Canonical
//! Form.md`, "The seal of the content store"). The tests go through the
//! commands of the program, on a copy of the fixture vault and on a content
//! store made for the test. A commit by hand stands for the commit of another
//! device: `git` of the support seals it as a tool would, and `git_unsealed`
//! makes the commit that no tool wrote. Every key is built at run time.

mod support;

use std::fs;
use std::path::PathBuf;
use std::process::Output;

use serde_json::Value;

use support::{TestStores, expected_seal, git, git_unsealed, program, text};

const NOTE: &str = "10 Garden/Frost dates explained.md";
const SECOND: &str = "10 Garden/Compost basics.md";
const TIME: &str = "2031-04-01T08:00:00Z";

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

fn json_of(output: &Output) -> Value {
    assert!(output.status.success(), "{}", errors_of(output));
    serde_json::from_slice(&output.stdout).expect("the output is JSON")
}

impl Setup {
    fn command(&self, command: &str) -> std::process::Command {
        let mut program = program();
        program
            .arg(command)
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy);
        if command == "publish" || command == "takedown" {
            program
                .arg("--attachment-storage")
                .arg(self.stores.attachment_storage())
                .arg("--no-deploy");
        }
        program
    }

    fn run(&self, command: &str, arguments: &[&str]) -> Output {
        self.command(command)
            .args(arguments)
            .output()
            .expect("the program starts")
    }

    fn plan_id(&self, note: &str) -> String {
        let plan = json_of(&self.run("plan", &["--include", note]));
        plan["id"].as_str().expect("the plan has an id").to_owned()
    }

    fn publish_plan(&self, id: &str) -> Output {
        self.run(
            "publish",
            &["--plan", id, "--time", TIME, "--device", "garden-shed"],
        )
    }

    fn publish(&self, note: &str) {
        let id = self.plan_id(note);
        let output = self.publish_plan(&id);
        assert!(output.status.success(), "{}", errors_of(&output));
    }

    fn git(&self, arguments: &[&str]) -> String {
        let mut all = vec!["-C", text(&self.copy)];
        all.extend_from_slice(arguments);
        git(&all)
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }

    fn message(&self, revision: &str) -> String {
        self.git(&["log", "--max-count=1", "--format=%B", revision])
    }

    /// A commit that no tool wrote, pushed: another device, or an edit by
    /// hand.
    fn commit_by_hand(&self, files: &[(&str, &str)]) {
        for (path, content) in files {
            let file = self.copy.join(path);
            fs::create_dir_all(file.parent().expect("a folder")).expect("the folder");
            fs::write(file, content).expect("the file is written");
            git_unsealed(&["-C", text(&self.copy), "add", "--force", "--", path]);
        }
        git_unsealed(&[
            "-C",
            text(&self.copy),
            "commit",
            "--quiet",
            "--message",
            "A change by hand",
        ]);
        git_unsealed(&[
            "-C",
            text(&self.copy),
            "push",
            "--quiet",
            "origin",
            "HEAD:main",
        ]);
    }

    /// A manifest entry that says `published`, as no tool wrote it.
    fn commit_published_entry(&self) {
        self.commit_by_hand(&[(
            "manifest/0123456789abcdef.json",
            "{\n  \"path\": \"10 Garden/Compost basics.md\",\n  \"state\": \"published\"\n}\n",
        )]);
    }
}

fn seal_line(message: &str) -> Option<&str> {
    message
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| line.strip_prefix("Seal: "))
}

#[test]
fn a_publication_commit_carries_a_valid_seal_and_nothing_else_changes() {
    let setup = set_up();
    let before = setup.head();

    setup.publish(NOTE);

    let head = setup.head();
    assert_ne!(head, before);
    // The sealed commit sits on top of the commit before it, with the files of
    // a publication only.
    assert_eq!(setup.git(&["rev-parse", "HEAD^"]), before);
    let message = setup.message("HEAD");
    assert!(message.starts_with("Publish: 1 new"), "{message}");
    assert_eq!(
        seal_line(&message),
        Some(expected_seal(text(&setup.copy), "HEAD").as_str())
    );
    let remote = git(&[
        "--git-dir",
        text(setup.stores.content_store()),
        "rev-parse",
        "main",
    ]);
    assert_eq!(remote, head);
    let changed = setup.git(&["show", "--name-only", "--format=", "HEAD"]);
    assert!(changed.lines().all(|path| path.starts_with("manifest/")
        || path.starts_with("notes/")
        || path == "withdrawn.json"));
    // The next plan trusts it.
    setup.plan_id(NOTE);
}

#[test]
fn a_foreign_commit_that_adds_a_published_entry_stops_plan_publish_and_status_with_the_difference()
{
    let setup = set_up();
    setup.publish(NOTE);
    let id = setup.plan_id(SECOND);
    setup.commit_published_entry();
    let head = setup.head();
    let sealed = setup.git(&["rev-parse", "HEAD^"]);

    for output in [
        setup.run("status", &[]),
        setup.run("plan", &["--include", SECOND]),
        setup.publish_plan(&id),
    ] {
        assert!(!output.status.success());
        let error = errors_of(&output);
        assert!(
            error.contains(&format!("at {head} is not the state")),
            "{error}"
        );
        assert!(error.contains(&format!("({sealed})")), "{error}");
        assert!(
            error.contains(
                "manifest entries added (1): \"10 Garden/Compost basics.md\" (none to published)"
            ),
            "{error}"
        );
        assert!(
            error.contains(&format!("confirm-state --head {head}")),
            "{error}"
        );
    }
    // Nothing was published on top of it.
    assert_eq!(setup.head(), head);
}

#[test]
fn a_commit_by_hand_of_the_redirect_list_alone_is_no_difference() {
    let setup = set_up();
    setup.publish(NOTE);
    setup.commit_by_hand(&[("redirects.json", "[]\n")]);

    let plan = setup.run("plan", &["--include", SECOND]);

    assert!(plan.status.success(), "{}", errors_of(&plan));
    assert!(setup.run("status", &[]).status.success());
}

#[test]
fn a_replayed_old_seal_does_not_pass() {
    let setup = set_up();
    setup.publish(NOTE);
    let old = setup.message("HEAD");
    // The state changes by hand (the entry says `unpublished`), under the
    // message of the commit that holds the old seal.
    let manifest = setup
        .git(&["ls-tree", "--name-only", "HEAD", "manifest/"])
        .lines()
        .next()
        .expect("a manifest file")
        .to_owned();
    let entry = fs::read_to_string(setup.copy.join(&manifest)).expect("the entry");
    fs::write(
        setup.copy.join(&manifest),
        entry.replace("\"published\"", "\"unpublished\""),
    )
    .expect("the entry is written");
    git_unsealed(&["-C", text(&setup.copy), "add", "--", &manifest]);
    git_unsealed(&[
        "-C",
        text(&setup.copy),
        "commit",
        "--quiet",
        "--message",
        &old,
    ]);
    git_unsealed(&[
        "-C",
        text(&setup.copy),
        "push",
        "--quiet",
        "origin",
        "HEAD:main",
    ]);
    assert!(seal_line(&setup.message("HEAD")).is_some());

    let plan = setup.run("plan", &["--include", NOTE]);

    assert!(!plan.status.success());
    let error = errors_of(&plan);
    assert!(
        error.contains("manifest entries changed (1)")
            && error.contains("(published to unpublished)"),
        "{error}"
    );
}

#[test]
fn no_key_stops_every_run_with_the_message_that_says_where_to_put_it() {
    let setup = set_up();
    setup.publish(NOTE);
    let id = setup.plan_id(SECOND);

    for output in [
        setup
            .command("status")
            .env_remove("VAULT_PUBLISH_SEAL_KEY")
            .output(),
        setup
            .command("plan")
            .args(["--include", SECOND])
            .env_remove("VAULT_PUBLISH_SEAL_KEY")
            .output(),
        setup
            .command("publish")
            .args(["--plan", &id, "--time", TIME, "--device", "garden-shed"])
            .env_remove("VAULT_PUBLISH_SEAL_KEY")
            .output(),
        setup
            .command("deny")
            .args([
                "--path=10 Garden/Herb bed",
                "--time",
                TIME,
                "--device",
                "garden-shed",
            ])
            .env_remove("VAULT_PUBLISH_SEAL_KEY")
            .output(),
    ] {
        let output = output.expect("the program starts");
        assert!(!output.status.success());
        let error = errors_of(&output);
        assert!(
            error.contains("the seal key of the content store is missing"),
            "{error}"
        );
        assert!(error.contains("openssl rand -hex 32"), "{error}");
        assert!(!error.contains(&support::seal_key()), "{error}");
    }
}

#[test]
fn the_key_of_the_env_file_of_the_vault_counts_when_the_environment_has_none() {
    let setup = set_up();
    fs::write(
        setup.vault.join(".env"),
        format!(
            "# the key\nexport VAULT_PUBLISH_SEAL_KEY=\"{}\"\n",
            support::seal_key()
        ),
    )
    .expect("the file is written");

    let status = setup
        .command("status")
        .env_remove("VAULT_PUBLISH_SEAL_KEY")
        .output()
        .expect("the program starts");

    assert!(status.status.success(), "{}", errors_of(&status));
}

#[test]
fn a_key_that_is_not_64_hexadecimal_digits_stops_the_run_and_is_never_shown() {
    let setup = set_up();
    let wrong = "q".repeat(64);

    let output = setup
        .command("status")
        .env("VAULT_PUBLISH_SEAL_KEY", &wrong)
        .output()
        .expect("the program starts");

    assert!(!output.status.success());
    let error = errors_of(&output);
    assert!(error.contains("is not 64 hexadecimal digits"), "{error}");
    assert!(error.contains("the environment"), "{error}");
    assert!(!error.contains(&wrong), "{error}");
}

#[test]
fn a_key_other_than_the_one_of_the_commits_reads_as_no_sealed_state() {
    let setup = set_up();
    setup.publish(NOTE);

    let output = setup
        .command("status")
        .env("VAULT_PUBLISH_SEAL_KEY", "a7".repeat(32))
        .output()
        .expect("the program starts");

    assert!(!output.status.success());
    let error = errors_of(&output);
    // The publication left the mark of the copy: the text names it.
    assert!(
        error.contains("has no sealed state that the tool can trust"),
        "{error}"
    );
    assert!(!error.contains(&"a7".repeat(32)), "{error}");
}

#[test]
fn a_store_with_no_seal_stops_and_the_confirmation_names_its_last_commit() {
    let setup = set_up();
    // A store from before R104: its first commit has no seal.
    git_unsealed(&[
        "-C",
        text(&setup.copy),
        "commit",
        "--quiet",
        "--amend",
        "--message",
        "The configuration, with no seal",
    ]);
    git_unsealed(&[
        "-C",
        text(&setup.copy),
        "push",
        "--quiet",
        "--force",
        "origin",
        "HEAD:main",
    ]);
    let head = setup.head();

    let error = errors_of(&setup.run("status", &[]));

    assert!(error.contains("has no sealed state yet"), "{error}");
    assert!(error.contains(&format!("Its state at {head}")), "{error}");
}

#[test]
fn a_confirmation_with_a_wrong_head_stops_and_writes_nothing() {
    let setup = set_up();
    setup.commit_published_entry();
    let head = setup.head();
    let other = "0".repeat(40);

    let confirm = |head: &str| {
        setup.run(
            "confirm-state",
            &["--head", head, "--time", TIME, "--device", "garden-shed"],
        )
    };
    let wrong = confirm(&other);
    let short = confirm("abc");
    let capitals = confirm(&head.to_uppercase());

    for output in [&short, &capitals] {
        assert!(!output.status.success());
        assert!(
            errors_of(output).contains(
                "the commit to confirm must be the 40 or 64 small hexadecimal digits of a commit"
            ),
            "{}",
            errors_of(output)
        );
    }
    assert!(!wrong.status.success());
    assert!(
        errors_of(&wrong).contains(&format!(
            "the content store changed since the difference that you read: its last commit is now {head}, not {other}. Read the difference again (status or plan), then confirm that commit"
        )),
        "{}",
        errors_of(&wrong)
    );
    assert_eq!(setup.head(), head);
    assert!(!setup.run("plan", &["--include", SECOND]).status.success());
}

#[test]
fn a_confirmation_with_the_right_head_writes_one_empty_sealed_commit_and_then_plan_works() {
    let setup = set_up();
    setup.commit_by_hand(&[("notes/Elsewhere.md", "A note of another device\n")]);
    let head = setup.head();
    let sealed = setup.git(&["rev-parse", "HEAD^"]);
    let tree = setup.git(&["rev-parse", "HEAD^{tree}"]);

    let output = setup.run(
        "confirm-state",
        &["--head", &head, "--time", TIME, "--device", "garden-shed"],
    );

    let confirmation = json_of(&output);
    assert_eq!(confirmation["confirmed"], true);
    assert_eq!(confirmation["difference"]["head"], head.as_str());
    assert_eq!(confirmation["difference"]["sealed"], sealed.as_str());
    assert_eq!(
        confirmation["difference"]["files"],
        serde_json::json!([{ "path": "notes/Elsewhere.md", "change": "added" }])
    );
    // One commit on top of the last one, with the same files.
    assert_eq!(
        setup.git(&["rev-list", "--count", &format!("{head}..HEAD")]),
        "1"
    );
    assert_eq!(setup.git(&["rev-parse", "HEAD^"]), head);
    assert_eq!(setup.git(&["rev-parse", "HEAD^{tree}"]), tree);
    let message = setup.message("HEAD");
    let seal = expected_seal(text(&setup.copy), "HEAD");
    assert_eq!(
        message,
        format!(
            "Confirm the state of the content store\n\nConfirmed: {head}\nDevice: garden-shed\nFace: command-line\nSeal: {seal}"
        )
    );
    let remote = git(&[
        "--git-dir",
        text(setup.stores.content_store()),
        "rev-parse",
        "main",
    ]);
    assert_eq!(remote, setup.head());
    // The state is trusted now.
    assert!(setup.run("status", &[]).status.success());
    setup.plan_id(NOTE);
    // A second confirmation has nothing to confirm.
    let again = setup.run(
        "confirm-state",
        &[
            "--head",
            &setup.head(),
            "--time",
            TIME,
            "--device",
            "garden-shed",
        ],
    );
    assert_eq!(json_of(&again), serde_json::json!({ "confirmed": false }));
    assert_eq!(
        setup.git(&["rev-list", "--count", &format!("{head}..HEAD")]),
        "1"
    );
}

#[test]
fn a_confirmation_needs_the_key() {
    let setup = set_up();
    setup.commit_published_entry();

    let output = setup
        .command("confirm-state")
        .args(["--head", &setup.head()])
        .env_remove("VAULT_PUBLISH_SEAL_KEY")
        .output()
        .expect("the program starts");

    assert!(!output.status.success());
    assert!(
        errors_of(&output).contains("the seal key of the content store is missing"),
        "{}",
        errors_of(&output)
    );
}

#[test]
fn an_edit_of_the_guards_seals_its_commit() {
    let setup = set_up();

    let output = setup.run(
        "deny",
        &[
            "--path=10 Garden/Herb bed",
            "--time",
            TIME,
            "--device",
            "garden-shed",
        ],
    );

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(
        seal_line(&setup.message("HEAD")),
        Some(expected_seal(text(&setup.copy), "HEAD").as_str())
    );
    assert!(setup.run("status", &[]).status.success());
}

#[test]
fn a_takedown_on_a_sealed_store_seals_its_commit() {
    let setup = set_up();
    setup.publish(NOTE);

    let output = setup.run(
        "takedown",
        &["--path", NOTE, "--time", TIME, "--device", "garden-shed"],
    );

    assert!(output.status.success(), "{}", errors_of(&output));
    assert!(setup.message("HEAD").starts_with("Takedown: 1 note"));
    assert_eq!(
        seal_line(&setup.message("HEAD")),
        Some(expected_seal(text(&setup.copy), "HEAD").as_str())
    );
    assert!(setup.run("status", &[]).status.success());
}

#[test]
fn a_takedown_on_an_unsealed_store_still_works_and_seals_nothing() {
    let setup = set_up();
    setup.publish(NOTE);
    setup.commit_by_hand(&[("notes/Elsewhere.md", "A note of another device\n")]);
    assert!(!setup.run("status", &[]).status.success());

    let output = setup.run(
        "takedown",
        &["--path", NOTE, "--time", TIME, "--device", "garden-shed"],
    );

    assert!(output.status.success(), "{}", errors_of(&output));
    let report = json_of(&output);
    assert_eq!(report["takenDown"], serde_json::json!([NOTE]));
    assert!(setup.message("HEAD").starts_with("Takedown: 1 note"));
    assert_eq!(seal_line(&setup.message("HEAD")), None);
    // The state stays unconfirmed: the takedown never seals it.
    assert!(!setup.run("status", &[]).status.success());
}

#[test]
fn a_takedown_without_a_key_still_works_and_seals_nothing() {
    let setup = set_up();
    setup.publish(NOTE);

    let output = setup
        .command("takedown")
        .args(["--path", NOTE, "--time", TIME, "--device", "garden-shed"])
        .env_remove("VAULT_PUBLISH_SEAL_KEY")
        .output()
        .expect("the program starts");

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(seal_line(&setup.message("HEAD")), None);
}

impl Setup {
    /// Runs git in the copy, with no seal.
    fn raw(&self, arguments: &[&str]) -> String {
        let mut all = vec!["-C", text(&self.copy)];
        all.extend_from_slice(arguments);
        git_unsealed(&all)
    }

    /// Makes a commit with `git commit-tree`, pushes it as a fast-forward or
    /// with force, and puts the copy at it, as a pull or a reset by hand.
    fn push_commit(&self, tree: &str, parents: &[&str], message: &str, force: bool) -> String {
        let mut arguments = vec!["commit-tree", tree];
        for parent in parents {
            arguments.extend(["-p", parent]);
        }
        arguments.extend(["-m", message]);
        let commit = self.raw(&arguments);
        self.push_and_reset(&commit, force);
        commit
    }

    fn push_and_reset(&self, commit: &str, force: bool) {
        let target = format!("{commit}:refs/heads/main");
        if force {
            self.raw(&["push", "--quiet", "--force", "origin", &target]);
        } else {
            self.raw(&["push", "--quiet", "origin", &target]);
        }
        self.raw(&["fetch", "--quiet", "origin"]);
        self.raw(&["reset", "--quiet", "--hard", "origin/main"]);
    }

    /// The mark of the copy, without its line end.
    fn mark(&self) -> String {
        fs::read_to_string(self.copy.join(".git").join("vault-publish").join("sealed"))
            .expect("the copy has a mark")
            .trim_end()
            .to_owned()
    }
}

/// The start of the text when no trusted sealed commit is found after the
/// mark of the copy.
const MARK_TEXT: &str = "the content store has no sealed state that the tool can trust";

#[test]
fn a_file_of_any_name_and_letter_case_is_sealed_but_the_redirect_list() {
    for (path, named) in [
        (
            "Manifest/0123456789abcdef.json",
            "manifest entries added (1): \"10 Garden/Compost basics.md\" (none to published)",
        ),
        (
            ".gitattributes",
            "files of the store: .gitattributes (added)",
        ),
    ] {
        let setup = set_up();
        // The file goes into the commit by its exact name, as git of another
        // system would write it.
        let file = setup.copy.join(".git").join("entry.json");
        fs::write(
            &file,
            "{\n  \"path\": \"10 Garden/Compost basics.md\",\n  \"state\": \"published\"\n}\n",
        )
        .expect("the entry is written");
        let blob = setup.raw(&["hash-object", "-w", text(&file)]);
        setup.raw(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("100644,{blob},{path}"),
        ]);
        setup.raw(&["commit", "--quiet", "--message", "A file by hand"]);
        setup.raw(&["push", "--quiet", "origin", "HEAD:main"]);
        setup.raw(&["reset", "--quiet", "--hard"]);

        let status = setup.run("status", &[]);

        assert!(!status.status.success(), "{path}");
        let error = errors_of(&status);
        assert!(error.contains(named), "{path}: {error}");
        assert!(
            error.contains("is not the state that a commit"),
            "{path}: {error}"
        );
    }
    let setup = set_up();
    setup.commit_by_hand(&[("redirects.json", "[]\n")]);
    assert!(setup.run("status", &[]).status.success());
}

#[test]
fn a_merge_commit_is_refused_also_with_an_old_seal_message() {
    let setup = set_up();
    let first = setup.head();
    setup.publish(NOTE);
    let current = setup.head();
    // The old state, as a merge of the old sealed commit and the current one:
    // a fast-forward of the content store.
    let old_tree = setup.git(&["rev-parse", &format!("{first}^{{tree}}")]);
    setup.push_commit(&old_tree, &[&first, &current], "A merge", false);

    let error = errors_of(&setup.run("plan", &["--include", NOTE]));

    assert!(error.contains(MARK_TEXT), "{error}");
    assert!(error.contains(&current), "{error}");

    // The message of an older sealed commit on a merge of its parent and the
    // current commit: its seal binds the parents.
    let setup = set_up();
    let first = setup.head();
    setup.publish(NOTE);
    let older = setup.head();
    setup.publish(SECOND);
    let current = setup.head();
    let tree = setup.git(&["rev-parse", &format!("{older}^{{tree}}")]);
    let message = setup.message(&older);
    assert!(seal_line(&message).is_some());
    setup.push_commit(&tree, &[&first, &current], &message, false);

    let error = errors_of(&setup.run("plan", &["--include", NOTE]));

    assert!(error.contains(MARK_TEXT), "{error}");
}

#[test]
fn a_forced_push_of_an_older_sealed_history_and_a_reset_by_hand_are_refused_until_confirmed() {
    let setup = set_up();
    setup.publish(NOTE);
    let older = setup.head();
    setup.publish(SECOND);
    let newer = setup.head();
    assert_eq!(setup.mark(), newer);
    // The content store goes back to the older sealed commit, and the author
    // resets the copy by hand.
    setup.push_and_reset(&older, true);
    assert_eq!(setup.head(), older);

    let error = errors_of(&setup.run("plan", &["--include", NOTE]));

    assert!(error.contains(MARK_TEXT), "{error}");
    assert!(error.contains(&newer), "{error}");
    let confirm = setup.run(
        "confirm-state",
        &["--head", &older, "--time", TIME, "--device", "garden-shed"],
    );
    let confirmation = json_of(&confirm);
    assert_eq!(confirmation["confirmed"], true);
    assert_eq!(confirmation["difference"]["base"], "mark");
    assert_eq!(setup.mark(), setup.head());
    setup.plan_id(SECOND);
}

#[test]
fn the_mark_names_the_last_sealed_commit_after_a_publication_and_a_confirmation() {
    let setup = set_up();
    setup.publish(NOTE);
    assert_eq!(setup.mark(), setup.head());
    setup.commit_published_entry();
    let head = setup.head();

    let confirm = setup.run(
        "confirm-state",
        &["--head", &head, "--time", TIME, "--device", "garden-shed"],
    );

    assert_eq!(json_of(&confirm)["confirmed"], true);
    assert_ne!(setup.head(), head);
    assert_eq!(setup.mark(), setup.head());
}

#[test]
fn more_commits_by_hand_than_the_history_that_the_check_reads_name_the_mark() {
    let setup = set_up();
    setup.publish(NOTE);
    let sealed = setup.mark();
    for index in 0..101 {
        let name = format!("notes/By hand {index:03}.md");
        fs::create_dir_all(setup.copy.join("notes")).expect("the folder");
        fs::write(setup.copy.join(&name), "A note by hand\n").expect("the file");
        setup.raw(&["add", "--", &name]);
        setup.raw(&["commit", "--quiet", "--message", "A change by hand"]);
    }
    setup.raw(&["push", "--quiet", "origin", "HEAD:main"]);

    let error = errors_of(&setup.run("status", &[]));

    assert!(error.contains(MARK_TEXT), "{error}");
    assert!(error.contains(&sealed), "{error}");
    assert!(!error.contains("no sealed state yet"), "{error}");
}
