//! The deploy of the site after a push, and the `deploy` command (issue 32,
//! BUILD-02, PUB-42). The deploy of the site is a fake here: a shell script
//! in the place of bun, which keeps its arguments and its folder, and gives a
//! result line. No test starts a real deploy.

#![cfg(unix)]

mod support;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};
use support::{TestStores, text};

const NOTE: &str = "A.md";
const TIME: &str = "2031-07-01T08:00:00Z";

/// The result line of a deploy that went live.
const LIVE: &str = r#"DEPLOY-RESULT {"build":"ok","deploy":"ok","live":true,"url":"https://preview.example.org/","contentRevision":"@HEAD@","uploaded":1,"deleted":0,"warnings":[],"error":null}"#;

/// The result line of a deploy whose build failed.
const BUILD_FAILED: &str = r#"DEPLOY-RESULT {"build":"failed","deploy":"skipped","live":false,"url":"https://preview.example.org/","contentRevision":"@HEAD@","uploaded":0,"deleted":0,"warnings":[],"error":"the build stopped"}"#;

/// A vault with one note, its copy of the content store, a folder of the site
/// code, and a fake bun.
struct Setup {
    stores: TestStores,
    vault: PathBuf,
    copy: PathBuf,
    site_code: PathBuf,
    bun: PathBuf,
}

fn errors_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Every JSON object of the standard output, in order.
fn objects_of(output: &Output) -> Vec<Value> {
    serde_json::Deserializer::from_slice(&output.stdout)
        .into_iter::<Value>()
        .collect::<Result<Vec<Value>, _>>()
        .expect("the output is JSON objects")
}

impl Setup {
    fn new() -> Self {
        let stores = TestStores::new();
        let vault = stores.root().join("vault");
        fs::create_dir(&vault).expect("the vault can be made");
        fs::write(vault.join(NOTE), "Alpha\n").expect("the note can be written");
        // The folders of the deny list of the fixture configuration.
        for folder in ["80 Templates", "90 Locked Shed"] {
            fs::create_dir(vault.join(folder)).expect("the folder can be made");
        }
        let copy = stores.make_content_store_copy();
        let site_code = stores.root().join("site code");
        fs::create_dir(&site_code).expect("the folder of the site code can be made");
        let bun = stores.root().join("fake bun");
        let setup = Self {
            stores,
            vault,
            copy,
            site_code,
            bun,
        };
        setup.answer(LIVE, 0);
        setup
    }

    /// The fake bun: it keeps its folder and its arguments, writes to both
    /// outputs, and ends with the result line and the exit code of the test.
    fn answer(&self, line: &str, status: u8) {
        self.answer_after(line, status, 0);
    }

    /// The fake bun, which takes `seconds` before its answer.
    fn answer_after(&self, line: &str, status: u8, seconds: u8) {
        use std::os::unix::fs::PermissionsExt;

        let kept = self.stores.root().join("kept");
        fs::write(
            &self.bun,
            format!(
                "#!/bin/sh\npwd > '{kept}.folder'\nprintf '%s\\n' \"$PATH\" > '{kept}.path'\nprintf '%s\\n' \"$@\" > '{kept}.arguments'\nsleep {seconds}\necho 'Building the site'\necho 'a warning of the build' >&2\nprintf '%s\\n' '{line}' | sed \"s/@HEAD@/$(git -C '{copy}' rev-parse HEAD)/\"\nexit {status}\n",
                kept = kept.display(),
                copy = self.copy.display()
            ),
        )
        .expect("the script can be written");
        fs::set_permissions(&self.bun, fs::Permissions::from_mode(0o755))
            .expect("the script can be made a program");
    }

    /// The arguments of the last run of the fake bun, or `None` when it never ran.
    fn arguments(&self) -> Option<Vec<String>> {
        fs::read_to_string(self.stores.root().join("kept.arguments"))
            .ok()
            .map(|text| text.lines().map(str::to_owned).collect())
    }

    fn folder(&self) -> String {
        fs::read_to_string(self.stores.root().join("kept.folder"))
            .expect("the fake bun ran")
            .trim_end()
            .to_owned()
    }

    fn target(&self) -> PathBuf {
        self.stores.root().join("private").join("target.json")
    }

    fn env_file(&self) -> PathBuf {
        self.stores.root().join("private").join("deploy.env")
    }

    /// The options of the deploy, with every setting.
    fn deploy_options(&self, command: &mut Command) {
        command
            .arg("--site-code")
            .arg(&self.site_code)
            .arg("--deploy-target")
            .arg(self.target())
            .arg("--deploy-env-file")
            .arg(self.env_file())
            .arg("--bun")
            .arg(&self.bun);
    }

    fn deploy(&self) -> Output {
        self.deploy_with(&[])
    }

    fn deploy_with(&self, options: &[&str]) -> Output {
        let mut command = support::program();
        command
            .arg("deploy")
            .arg("--content-store")
            .arg(&self.copy)
            .arg("--attachment-storage")
            .arg(self.stores.attachment_storage());
        self.deploy_options(&mut command);
        command.args(options);
        command.output().expect("the program starts")
    }

    /// The entries of the marker of the takedowns of the copy.
    fn takedowns(&self) -> Vec<Value> {
        let folder = self
            .copy
            .join(".git")
            .join("vault-publish")
            .join("takedowns");
        let mut names: Vec<PathBuf> = fs::read_dir(folder).map_or_else(
            |_| Vec::new(),
            |listing| {
                listing
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .collect()
            },
        );
        names.sort();
        names
            .iter()
            .map(|file| {
                serde_json::from_str(&fs::read_to_string(file).expect("an entry")).expect("JSON")
            })
            .collect()
    }

    /// The arguments that the deploy of the site gets.
    fn expected_arguments(&self, takedown: bool) -> Vec<String> {
        let mut expected = vec![
            format!("--env-file={}", self.env_file().display()),
            "run".to_owned(),
            "deploy".to_owned(),
            "--from-main".to_owned(),
            "--target".to_owned(),
            text(&self.target()).to_owned(),
            "--content-store".to_owned(),
            text(&self.copy).to_owned(),
            "--attachments".to_owned(),
            text(self.stores.attachment_storage()).to_owned(),
        ];
        if takedown {
            expected.push("--takedown".to_owned());
        }
        expected
    }

    fn places(&self, command: &str) -> Command {
        let mut program = support::program();
        program
            .arg(command)
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy)
            .arg("--attachment-storage")
            .arg(self.stores.attachment_storage());
        program
    }

    /// Publishes the note. With `deploy`, the options of the deploy.
    fn publish(&self, deploy: bool) -> Output {
        let planned = support::program()
            .arg("plan")
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy)
            .args(["--include", NOTE])
            .output()
            .expect("the program starts");
        assert!(planned.status.success(), "{}", errors_of(&planned));
        let id = objects_of(&planned)[0]["id"]
            .as_str()
            .expect("the plan has an id")
            .to_owned();
        let mut command = self.places("publish");
        command.args(["--plan", &id, "--time", TIME]);
        if deploy {
            self.deploy_options(&mut command);
        } else {
            command.arg("--no-deploy");
        }
        command.output().expect("the program starts")
    }

    fn deploy_log(&self) -> String {
        fs::read_to_string(
            self.copy
                .join(".git")
                .join("vault-publish")
                .join("deploy.log"),
        )
        .expect("the deploy log exists")
    }
}

fn same_folder(one: &str, two: &Path) -> bool {
    fs::canonicalize(one).ok() == fs::canonicalize(two).ok()
}

#[test]
fn deploy_runs_bun_in_the_folder_of_the_site_code_and_writes_the_deploy_report() {
    let setup = Setup::new();

    let output = setup.deploy();

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(
        objects_of(&output),
        [json!({ "deployment": {
            "build": "ok",
            "contentRevision": support::git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]).trim(),
            "deleted": 0,
            "deploy": "ok",
            "live": true,
            "push": "skipped",
            "state": "done",
            "takedown": false,
            "uploaded": 1,
            "url": "https://preview.example.org/",
            "warnings": [],
        }})]
    );
    assert_eq!(setup.arguments(), Some(setup.expected_arguments(false)));
    assert!(same_folder(&setup.folder(), &setup.site_code));
    // The whole output stays on the device, with the errors of the child.
    let log = setup.deploy_log();
    assert!(log.contains("a warning of the build"), "{log}");
    assert!(log.contains("Building the site"), "{log}");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("a warning of the build"));
    assert!(errors_of(&output).contains("deploy.log"));
}

#[test]
fn a_deploy_that_failed_writes_its_report_and_ends_with_its_error() {
    let setup = Setup::new();
    setup.answer(BUILD_FAILED, 1);

    let output = setup.deploy();

    assert_eq!(output.status.code(), Some(1));
    let report = &objects_of(&output)[0]["deployment"];
    assert_eq!(report["build"], "failed");
    assert_eq!(report["deploy"], "skipped");
    assert_eq!(report["live"], false);
    assert!(errors_of(&output).contains("error: the build stopped"));
}

#[test]
fn a_deploy_without_the_folder_of_the_site_code_runs_nothing_and_names_it() {
    let setup = Setup::new();

    let output = support::program()
        .arg("deploy")
        .arg("--content-store")
        .arg(&setup.copy)
        .arg("--attachment-storage")
        .arg(setup.stores.attachment_storage())
        .arg("--deploy-target")
        .arg(setup.target())
        .output()
        .expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(setup.arguments(), None);
    assert_eq!(
        objects_of(&output)[0]["deployment"]["error"],
        "nothing was deployed: the folder of the site code is not set (in the settings of Vault Publish, or --site-code of the command line program)"
    );
}

#[test]
fn a_publication_deploys_after_its_push_and_writes_the_deploy_report_after_its_report() {
    let setup = Setup::new();

    let output = setup.publish(true);

    assert!(output.status.success(), "{}", errors_of(&output));
    let objects = objects_of(&output);
    assert_eq!(objects.len(), 2);
    assert_eq!(objects[0]["published"], json!([NOTE]));
    assert_eq!(objects[1]["deployment"]["push"], "ok");
    assert_eq!(objects[1]["deployment"]["live"], true);
    assert_eq!(setup.arguments(), Some(setup.expected_arguments(false)));
}

#[test]
fn a_failed_deploy_never_turns_the_publication_into_a_failure() {
    let setup = Setup::new();
    setup.answer(BUILD_FAILED, 1);

    let output = setup.publish(true);

    assert!(output.status.success(), "{}", errors_of(&output));
    let objects = objects_of(&output);
    assert_eq!(objects[0]["published"], json!([NOTE]));
    assert_eq!(objects[1]["deployment"]["build"], "failed");
    assert!(errors_of(&output).contains("the publication is done, but nothing new is live"));
}

#[test]
fn a_publication_without_the_settings_of_the_deploy_still_pushes_and_says_what_is_missing() {
    let setup = Setup::new();

    let output = setup.places("publish").args(["--plan", "x"]).output();
    // An unknown plan stops before any push: no deploy report.
    let output = output.expect("the program starts");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(output.stdout, b"");

    let planned = support::program()
        .arg("plan")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&setup.copy)
        .args(["--include", NOTE])
        .output()
        .expect("the program starts");
    let id = objects_of(&planned)[0]["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let output = setup
        .places("publish")
        .args(["--plan", &id, "--time", TIME])
        .output()
        .expect("the program starts");

    assert!(output.status.success(), "{}", errors_of(&output));
    let objects = objects_of(&output);
    assert_eq!(objects[0]["published"], json!([NOTE]));
    assert_eq!(
        objects[1]["deployment"]["error"],
        "nothing was deployed: the folder of the site code and the target file of the deployment are not set (in the settings of Vault Publish, or --site-code and --deploy-target of the command line program)"
    );
    assert_eq!(setup.arguments(), None);
}

#[test]
fn no_deploy_pushes_with_no_deploy_report() {
    let setup = Setup::new();

    let output = setup.publish(false);

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(objects_of(&output).len(), 1);
    assert_eq!(setup.arguments(), None);
}

#[test]
fn a_takedown_deploys_with_takedown() {
    let setup = Setup::new();
    let published = setup.publish(false);
    assert!(published.status.success(), "{}", errors_of(&published));

    let mut command = setup.places("takedown");
    command.args(["--path", NOTE, "--time", TIME]);
    setup.deploy_options(&mut command);
    let output = command.output().expect("the program starts");

    assert!(output.status.success(), "{}", errors_of(&output));
    let objects = objects_of(&output);
    assert_eq!(objects[0]["takenDown"], json!([NOTE]));
    assert_eq!(objects[1]["deployment"]["deploy"], "ok");
    assert_eq!(setup.arguments(), Some(setup.expected_arguments(true)));
}

#[test]
fn the_mcp_server_never_waits_for_a_build_and_reads_the_last_report_later() {
    let setup = Setup::new();
    let published = setup.publish(false);
    assert!(published.status.success(), "{}", errors_of(&published));
    setup.answer_after(LIVE, 0, 1);
    let mut command = setup.places("mcp");
    setup.deploy_options(&mut command);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the program starts");
    let calls = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "takedown", "arguments": { "paths": [NOTE] } } }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "deploy", "arguments": { "last": true } } }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "deploy", "arguments": {} } }),
    ];
    {
        let mut input = child.stdin.take().expect("the input is a pipe");
        for call in &calls {
            writeln!(input, "{call}").expect("the call can be written");
        }
    }

    let output = child.wait_with_output().expect("the program ends");

    assert!(output.status.success(), "{}", errors_of(&output));
    let answers = objects_of(&output);
    let texts = |answer: &Value| -> Vec<Value> {
        answer["result"]["content"]
            .as_array()
            .expect("a result")
            .iter()
            .map(|item| serde_json::from_str(item["text"].as_str().expect("a text")).expect("JSON"))
            .collect()
    };
    let takedown = texts(&answers[0]);
    assert_eq!(answers[0]["result"]["isError"], false);
    assert_eq!(takedown[0]["takenDown"], json!([NOTE]));
    assert_eq!(
        takedown[1],
        json!({ "deployment": { "push": "ok", "state": "started", "takedown": true } })
    );
    // The deploy of the takedown takes a second: it still runs.
    assert_eq!(
        texts(&answers[1]),
        [json!({ "running": true, "takedownWaits": true })]
    );
    assert_eq!(
        texts(&answers[2]),
        [json!({ "deployment": { "push": "skipped", "state": "started", "takedown": false } })]
    );
    // The server waited for its deploys before its end.
    let last = support::program()
        .arg("deploy")
        .arg("--content-store")
        .arg(&setup.copy)
        .arg("--attachment-storage")
        .arg(setup.stores.attachment_storage())
        .arg("--last")
        .output()
        .expect("the program starts");
    let read = &objects_of(&last)[0];
    assert_eq!(read["running"], false);
    assert_eq!(read["deployment"]["state"], "done");
    assert_eq!(read["deployment"]["push"], "skipped");
    // The deploy of the takedown succeeded and removed the marker, so the
    // deploy again ran with no --takedown.
    assert_eq!(setup.arguments(), Some(setup.expected_arguments(false)));
}

#[test]
fn a_takedown_is_never_lost_its_marker_stays_until_a_deploy_with_takedown_succeeds() {
    let setup = Setup::new();
    let published = setup.publish(false);
    assert!(published.status.success(), "{}", errors_of(&published));

    let taken = setup
        .places("takedown")
        .args(["--path", NOTE, "--time", TIME, "--no-deploy"])
        .output()
        .expect("the program starts");
    assert!(taken.status.success(), "{}", errors_of(&taken));
    let head = support::git(&["-C", text(&setup.copy), "rev-parse", "HEAD"]);
    assert_eq!(setup.takedowns(), [json!({ "commit": head.trim() })]);
    setup.answer(BUILD_FAILED, 1);
    let failed = setup.deploy();
    let failed_report = &objects_of(&failed)[0]["deployment"];
    let after_failure = !setup.takedowns().is_empty();
    setup.answer(LIVE, 0);
    let done = setup.deploy();
    let after_success = !setup.takedowns().is_empty();

    assert_eq!(failed_report["takedown"], true);
    assert!(
        failed_report["warnings"]
            .as_array()
            .expect("the warnings")
            .iter()
            .any(|warning| warning
                .as_str()
                .is_some_and(|text| text.contains("still be live")))
    );
    assert!(after_failure);
    assert!(done.status.success(), "{}", errors_of(&done));
    assert_eq!(objects_of(&done)[0]["deployment"]["takedown"], true);
    assert_eq!(setup.arguments(), Some(setup.expected_arguments(true)));
    assert!(!after_success);
    let again = setup.deploy();
    assert_eq!(objects_of(&again)[0]["deployment"]["takedown"], false);
}

#[test]
fn deploy_takedown_asks_for_takedown() {
    let setup = Setup::new();

    let output = setup.deploy_with(&["--takedown"]);

    assert!(output.status.success(), "{}", errors_of(&output));
    assert_eq!(setup.arguments(), Some(setup.expected_arguments(true)));
    assert_eq!(objects_of(&output)[0]["deployment"]["takedown"], true);
}

#[test]
fn a_deploy_stops_with_the_programs_that_it_started_after_its_time_limit() {
    use std::os::unix::fs::PermissionsExt;

    let setup = Setup::new();
    let pid_file = setup.stores.root().join("grandchild.pid");
    fs::write(
        &setup.bun,
        format!(
            "#!/bin/sh\necho 'Building the site'\nsleep 30 &\necho $! > '{}'\nwait\n",
            pid_file.display()
        ),
    )
    .expect("the script can be written");
    fs::set_permissions(&setup.bun, fs::Permissions::from_mode(0o755))
        .expect("the script can be made a program");

    let mut command = support::program();
    command
        .env("DSEBASTIEN_VAULT_PUBLISH_TEST_MINUTE_MS", "300")
        .arg("deploy")
        .arg("--content-store")
        .arg(&setup.copy)
        .arg("--attachment-storage")
        .arg(setup.stores.attachment_storage())
        .args(["--deploy-timeout", "1"]);
    setup.deploy_options(&mut command);
    let output = command.output().expect("the program starts");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        objects_of(&output)[0]["deployment"]["error"],
        "the deploy was stopped after its time limit of 1 minutes, with the programs that it started: read the output of the deploy"
    );
    let grandchild = fs::read_to_string(&pid_file).expect("the grandchild started");
    std::thread::sleep(std::time::Duration::from_millis(300));
    let alive = Command::new("kill")
        .args(["-0", grandchild.trim()])
        .stderr(Stdio::null())
        .status()
        .expect("kill runs");
    assert!(!alive.success(), "the grandchild still runs");
    assert!(setup.deploy_log().contains("Building the site"));
}

#[test]
fn a_time_limit_of_0_deploys_nothing() {
    let setup = Setup::new();

    let output = setup.deploy_with(&["--deploy-timeout", "0"]);

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(setup.arguments(), None);
}

#[test]
fn the_folders_of_the_deploy_are_absolute_and_bun_comes_first_in_the_path() {
    let setup = Setup::new();
    let root = setup.stores.root();
    let copy = setup
        .copy
        .strip_prefix(root)
        .expect("the copy is in the folder of the test");
    let storage = setup
        .stores
        .attachment_storage()
        .strip_prefix(root)
        .expect("the storage is in the folder of the test");

    let mut command = support::program();
    command
        .current_dir(root)
        .arg("deploy")
        .arg("--content-store")
        .arg(copy)
        .arg("--attachment-storage")
        .arg(storage);
    setup.deploy_options(&mut command);
    let output = command.output().expect("the program starts");

    assert!(output.status.success(), "{}", errors_of(&output));
    let arguments = setup.arguments().expect("the fake bun ran");
    let given = |option: &str| {
        let at = arguments
            .iter()
            .position(|one| one == option)
            .expect("the option");
        PathBuf::from(&arguments[at + 1])
    };
    assert!(given("--content-store").is_absolute());
    assert!(given("--attachments").is_absolute());
    assert!(same_folder(text(&given("--content-store")), &setup.copy));
    let path = fs::read_to_string(root.join("kept.path")).expect("the fake bun kept its PATH");
    let first = path
        .trim_end()
        .split(':')
        .next()
        .unwrap_or_default()
        .to_owned();
    assert!(same_folder(&first, root), "{path}");
}

#[test]
fn a_takedown_that_pushed_nothing_leaves_no_entry_and_status_says_when_one_waits() {
    let setup = Setup::new();

    let refused = setup
        .places("takedown")
        .args(["--path", "No such note.md", "--time", TIME, "--no-deploy"])
        .output()
        .expect("the program starts");
    let quiet = support::program()
        .arg("status")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&setup.copy)
        .output()
        .expect("the program starts");
    let published = setup.publish(false);
    assert!(published.status.success(), "{}", errors_of(&published));
    let taken = setup
        .places("takedown")
        .args(["--path", NOTE, "--time", TIME, "--no-deploy"])
        .output()
        .expect("the program starts");
    assert!(taken.status.success(), "{}", errors_of(&taken));
    let waiting = support::program()
        .arg("status")
        .arg("--vault")
        .arg(&setup.vault)
        .arg("--content-store")
        .arg(&setup.copy)
        .output()
        .expect("the program starts");

    assert_eq!(refused.status.code(), Some(1));
    assert!(!errors_of(&quiet).contains("a takedown waits"));
    assert!(errors_of(&waiting).contains("a takedown waits for a deploy that succeeds"));
    assert_eq!(setup.takedowns().len(), 1);
    let last = setup.deploy_with(&["--last"]);
    assert_eq!(objects_of(&last)[0]["takedownWaits"], true);
}

#[test]
fn an_orphan_that_keeps_the_output_open_does_not_hold_a_deploy_that_succeeded() {
    use std::os::unix::fs::PermissionsExt;

    let setup = Setup::new();
    // The child ends at once with a result that says success; a program
    // that it started keeps its standard output open for 30 seconds.
    fs::write(
        &setup.bun,
        format!(
            "#!/bin/sh\nsleep 30 &\nprintf '%s\\n' '{LIVE}' | sed \"s/@HEAD@/$(git -C '{}' rev-parse HEAD)/\"\nexit 0\n",
            setup.copy.display()
        ),
    )
    .expect("the script can be written");
    fs::set_permissions(&setup.bun, fs::Permissions::from_mode(0o755))
        .expect("the script can be made a program");
    let started = std::time::Instant::now();

    let output = setup.deploy();

    assert!(output.status.success(), "{}", errors_of(&output));
    assert!(started.elapsed() < std::time::Duration::from_secs(15));
    assert_eq!(objects_of(&output)[0]["deployment"]["deploy"], "ok");
}
