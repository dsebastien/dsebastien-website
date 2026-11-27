//! The MCP server of the program (issue 41, TOOL-03, TEST-17): the `mcp`
//! command serves the tools over the standard input and output. The tests
//! start it on a copy of the fixture vault and on a content store made for the
//! test, and drive a whole publication through the protocol: the queue, a
//! selection with paths to include, to hold and to remove, a publication, an
//! unpublish, a takedown and an unlock. Each tool gives what its command
//! gives.

mod support;

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};

use serde_json::{Value, json};

use support::{TestStores, git, text};

const NOTE: &str = "10 Garden/Frost dates explained.md";
const SECOND: &str = "10 Garden/Compost basics.md";

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

/// The server, and the next id of a request.
struct Server {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
}

impl Setup {
    fn start(&self) -> Server {
        let mut child = support::program()
            .arg("mcp")
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy)
            .arg("--attachment-storage")
            .arg(self.stores.attachment_storage())
            .arg("--no-deploy")
            .args(["--device", "garden-shed"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the program starts");
        let input = child.stdin.take().expect("the input is piped");
        let output = BufReader::new(child.stdout.take().expect("the output is piped"));
        Server {
            child,
            input,
            output,
            next: 1,
        }
    }

    fn git(&self, arguments: &[&str]) -> String {
        let mut all = vec!["-C", text(&self.copy)];
        all.extend_from_slice(arguments);
        git(&all)
    }

    /// The output of a command of the program.
    fn command(&self, command: &str, arguments: &[&str]) -> String {
        let output = support::program()
            .arg(command)
            .arg("--vault")
            .arg(&self.vault)
            .arg("--content-store")
            .arg(&self.copy)
            .args(arguments)
            .output()
            .expect("the program starts");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("the output is text")
    }
}

impl Server {
    fn send(&mut self, message: &Value) {
        writeln!(self.input, "{message}").expect("the message is sent");
        self.input.flush().expect("the message is sent");
    }

    fn request(&mut self, method: &str, params: &Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let mut line = String::new();
        self.output
            .read_line(&mut line)
            .expect("the answer is read");
        let answer: Value = serde_json::from_str(&line).expect("the answer is JSON");
        assert_eq!(answer["id"], json!(id), "the answer of the request");
        answer
    }

    /// Calls a tool and gives its texts and whether it is an error.
    fn call(&mut self, tool: &str, arguments: &Value) -> (Vec<String>, bool) {
        let answer = self.request(
            "tools/call",
            &json!({ "name": tool, "arguments": arguments }),
        );
        let result = &answer["result"];
        let texts = result["content"]
            .as_array()
            .expect("a tool result has content")
            .iter()
            .map(|item| item["text"].as_str().expect("a text").to_owned())
            .collect();
        (texts, result["isError"].as_bool().expect("isError"))
    }

    /// Calls a tool that must succeed and gives its output as data.
    fn data(&mut self, tool: &str, arguments: &Value) -> Value {
        let (texts, is_error) = self.call(tool, arguments);
        assert!(!is_error, "{tool}: {texts:?}");
        serde_json::from_str(&texts[0]).expect("the output is JSON")
    }

    /// Ends the input and waits for the end of the server.
    fn stop(mut self) -> std::process::ExitStatus {
        drop(self.input);
        let status = self.child.wait().expect("the server ends");
        let mut rest = String::new();
        self.output
            .read_line(&mut rest)
            .expect("the output is read");
        assert_eq!(rest, "", "nothing after the last answer");
        status
    }
}

#[test]
fn initializes_and_lists_the_tools_of_the_commands() {
    let setup = set_up();
    let mut server = setup.start();

    let answer = server.request(
        "initialize",
        &json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }),
    );
    server.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    let tools = server.request("tools/list", &json!({}));

    assert_eq!(answer["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(
        answer["result"]["serverInfo"],
        json!({ "name": "dsebastien-vault-publish", "version": env!("CARGO_PKG_VERSION") })
    );
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("a list of tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("a name"))
        .collect();
    assert_eq!(
        names,
        [
            "status",
            "plan",
            "publish",
            "unpublish",
            "takedown",
            "guards",
            "deny",
            "allow",
            "ignore",
            "unignore",
            "unlock",
            "confirm_store_state",
            "deploy"
        ]
    );
    assert!(server.stop().success());
}

#[test]
fn status_gives_the_output_of_the_status_command() {
    let setup = set_up();
    let expected = setup.command("status", &[]);
    let mut server = setup.start();

    let (texts, is_error) = server.call("status", &json!({}));

    assert!(!is_error, "{texts:?}");
    assert_eq!(texts, [expected]);
    assert!(server.stop().success());
}

#[test]
fn each_call_reads_the_vault_again() {
    let setup = set_up();
    let mut server = setup.start();
    let first = server.data("status", &json!({}));
    let note = "10 Garden/Written during the session.md";
    fs::write(
        setup.vault.join(note),
        "---\ntags:\n  - type/note\n---\n\n# Written during the session\n",
    )
    .expect("the note is written");

    let second = server.data("status", &json!({}));

    assert!(
        !first["new"]
            .as_array()
            .expect("a list")
            .contains(&json!(note))
    );
    assert!(
        second["new"]
            .as_array()
            .expect("a list")
            .contains(&json!(note))
    );
    assert_eq!(
        serde_json::to_string(&second).expect("JSON"),
        serde_json::to_string(
            &serde_json::from_str::<Value>(&setup.command("status", &[])).expect("JSON")
        )
        .expect("JSON")
    );
    assert!(server.stop().success());
}

#[test]
fn drives_a_whole_publication_through_the_tools() {
    let setup = set_up();
    let mut server = setup.start();

    // A selection with a path to include.
    let planned = server.data("plan", &json!({ "include": [NOTE, SECOND] }));
    assert_eq!(planned["plan"]["publish"], json!([SECOND, NOTE]));
    // The two lists of the frozen lists come with the plan (R71).
    assert_eq!(planned["listsNotRefreshed"], json!([]));
    assert_eq!(planned["liveQueries"], json!([]));
    let report = server.data("publish", &json!({ "plan": planned["id"] }));
    assert_eq!(report["published"], json!([SECOND, NOTE]));
    let message = git(&["-C", text(&setup.copy), "log", "-1", "--format=%B"]);
    assert!(
        message.contains("Device: garden-shed\nFace: mcp-server\n"),
        "{message}"
    );

    // A selection with a path to hold and a path to remove.
    let source = setup.vault.join(NOTE);
    let edited = fs::read_to_string(&source).expect("the note is read") + "\nOne more line.\n";
    fs::write(&source, edited).expect("the note is written");
    let queue = server.data("status", &json!({}));
    assert_eq!(queue["changed"], json!([NOTE]));
    let held = server.data("plan", &json!({ "hold": [NOTE], "remove": [SECOND] }));
    assert_eq!(held["plan"]["update"], json!([]));
    assert_eq!(held["plan"]["remove"], json!([SECOND]));
    let report = server.data("publish", &json!({ "plan": held["id"] }));
    assert_eq!(report["removed"], json!([SECOND]));
    assert_eq!(report["skipped"], json!([NOTE]));

    // A plan that is stale publishes nothing.
    let stale = server.data("plan", &json!({}));
    fs::write(
        &source,
        "---\ntags:\n  - type/note\n---\n\n# Changed again\n",
    )
    .expect("the note is written");
    let (texts, is_error) = server.call("publish", &json!({ "plan": stale["id"] }));
    assert!(is_error);
    assert!(texts[0].contains("stale"), "{texts:?}");

    let report = server.data("unpublish", &json!({ "paths": [NOTE] }));
    assert_eq!(report["removed"], json!([NOTE]));
    let report = server.data("takedown", &json!({ "paths": [NOTE] }));
    assert_eq!(report["takenDown"], json!([NOTE]));
    let unlocked = server.data("unlock", &json!({}));
    assert_eq!(unlocked, json!({ "removed": false }));
    assert!(server.stop().success());
}

/// The edits of the guards (issue 42): `guards` gives what its command
/// gives, and an edit through the server has the face `mcp-server`.
#[test]
fn reads_and_edits_the_guards_as_the_commands_do() {
    let setup = set_up();
    let expected = setup.command("guards", &[]);
    let mut server = setup.start();

    let (texts, is_error) = server.call("guards", &json!({}));
    let edit = server.data("deny", &json!({ "path": "10 Garden/Herb bed" }));
    let after = server.data("guards", &json!({}));
    let (missing, missing_is_error) = server.call("ignore", &json!({}));

    assert!(!is_error, "{texts:?}");
    assert_eq!(texts, [expected]);
    assert_eq!(edit["edit"]["action"], "deny");
    assert_eq!(edit["edit"]["state"], "applied");
    assert_eq!(edit["edit"]["face"], "mcp-server");
    assert_eq!(edit["edit"]["device"], "garden-shed");
    assert_eq!(after["edits"], json!([edit["edit"]]));
    assert_eq!(
        after["denyList"],
        json!(["80 Templates", "90 Locked Shed", "10 Garden/Herb bed"])
    );
    let message = git(&["-C", text(&setup.copy), "log", "-1", "--format=%B"]);
    assert!(
        message.starts_with("Edit: deny (applied)\n\nDevice: garden-shed\nFace: mcp-server\n"),
        "{message}"
    );
    assert!(missing_is_error);
    assert!(missing[0].contains("\"path\""), "{missing:?}");
    assert!(server.stop().success());
}

#[test]
fn confirm_store_state_confirms_the_difference_that_the_agent_read() {
    let setup = set_up();
    // A commit that no tool wrote: the tools stop with the difference.
    fs::create_dir_all(setup.copy.join("notes")).expect("the folder can be made");
    fs::write(setup.copy.join("notes").join("Elsewhere.md"), "A note\n")
        .expect("the note is written");
    support::git_unsealed(&["-C", text(&setup.copy), "add", "--", "notes/Elsewhere.md"]);
    support::git_unsealed(&[
        "-C",
        text(&setup.copy),
        "commit",
        "--quiet",
        "--message",
        "A change by hand",
    ]);
    support::git_unsealed(&[
        "-C",
        text(&setup.copy),
        "push",
        "--quiet",
        "origin",
        "HEAD:main",
    ]);
    let head = setup.git(&["rev-parse", "HEAD"]);
    let mut server = setup.start();

    let (stopped, is_error) = server.call("status", &json!({}));
    assert!(is_error);
    assert!(stopped[0].contains("confirm_store_state"), "{stopped:?}");
    let (wrong, is_error) = server.call("confirm_store_state", &json!({ "head": "0".repeat(40) }));
    assert!(is_error);
    assert!(
        wrong[0].contains("the content store changed since the difference"),
        "{wrong:?}"
    );
    let (missing, is_error) = server.call("confirm_store_state", &json!({}));
    assert!(is_error);
    assert!(missing[0].contains("needs the argument"), "{missing:?}");
    let confirmed = server.data("confirm_store_state", &json!({ "head": head }));

    assert_eq!(confirmed["confirmed"], true);
    assert_eq!(confirmed["difference"]["head"], head.as_str());
    assert!(
        setup
            .git(&["log", "--max-count=1", "--format=%B"])
            .contains("Face: mcp-server")
    );
    server.data("status", &json!({}));
    assert_eq!(
        server.data(
            "confirm_store_state",
            &json!({ "head": setup.git(&["rev-parse", "HEAD"]) })
        ),
        json!({ "confirmed": false })
    );
    assert!(server.stop().success());
}

#[test]
fn a_tool_error_names_the_cause_and_the_server_goes_on() {
    let setup = set_up();
    let mut server = setup.start();

    let (texts, is_error) = server.call("plan", &json!({ "include": ["90 Locked Shed/none.md"] }));
    let (refused, refused_is_error) = server.call("publish", &json!({ "plan": "not an id" }));
    let queue = server.data("status", &json!({}));

    assert!(is_error);
    assert!(texts[0].contains("90 Locked Shed/none.md"), "{texts:?}");
    assert!(refused_is_error);
    assert!(refused[0].contains("not an id"), "{refused:?}");
    assert!(queue["new"].as_array().is_some_and(|new| !new.is_empty()));
    assert!(server.stop().success());
}

#[test]
fn stops_at_the_start_when_a_place_is_not_a_folder() {
    let setup = set_up();
    let output = support::program()
        .arg("mcp")
        .arg("--vault")
        .arg(setup.stores.root().join("nowhere"))
        .arg("--content-store")
        .arg(&setup.copy)
        .arg("--attachment-storage")
        .arg(setup.stores.attachment_storage())
        .arg("--no-deploy")
        .stdin(Stdio::null())
        .output()
        .expect("the program starts");

    assert!(!output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert!(String::from_utf8_lossy(&output.stderr).contains("the vault is not a folder"));
}
