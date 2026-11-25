//! The MCP server of the publishing tool (issue 41, TOOL-03, TOOL-27): the
//! messages of the protocol and the calls of the tools. The `mcp` command
//! serves it over the standard input and output, one message of JSON per
//! line. The TypeScript twin is `apps/plugin/src/publishing/mcp.ts`, which the
//! plugin serves over HTTP on the computer. Both read the tools from
//! `mcp-tools.json` and pass the shared cases of `fixtures/canonical/mcp.json`.
//! A tool does what the command of the same name does, and gives the same
//! output: no rule of the publishing logic lives here.

use std::io::{self, BufRead, Write};
use std::sync::OnceLock;

use serde_json::{Map, Value, json};

use crate::queue::Move;
use crate::tool::Outcome;

/// What a tool gives: the outcome of its command, and the deploy report of the
/// deploy after its push (issue 32), which never turns the result into a
/// failure.
pub struct ToolOutcome {
    pub outcome: Outcome,
    pub deploy: Option<String>,
}

impl From<Outcome> for ToolOutcome {
    fn from(outcome: Outcome) -> Self {
        Self {
            outcome,
            deploy: None,
        }
    }
}

/// The tools and the instructions, in the file that the TypeScript face reads.
const TOOLS_FILE: &str = include_str!("../../apps/plugin/src/publishing/mcp-tools.json");

/// The versions of the protocol that the server knows, the newest first.
pub const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// The names of the tools: the names of the commands of the program, but
/// `mcp`.
pub const TOOL_NAMES: [&str; 12] = [
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
    "deploy",
];

/// The tools that edit the guards: each takes one path (R69).
const EDIT_TOOLS: [&str; 4] = ["deny", "allow", "ignore", "unignore"];

/// The name of the server in `initialize`.
pub const SERVER_NAME: &str = "dsebastien-vault-publish";

const PARSE_ERROR: i64 = -32_700;
const INVALID_REQUEST: i64 = -32_600;
const METHOD_NOT_FOUND: i64 = -32_601;
const INVALID_PARAMS: i64 = -32_602;

fn definitions() -> &'static Value {
    static DEFINITIONS: OnceLock<Value> = OnceLock::new();
    DEFINITIONS.get_or_init(|| serde_json::from_str(TOOLS_FILE).unwrap_or(Value::Null))
}

/// A call of a tool, with its arguments read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Call {
    Status,
    Plan {
        include: Vec<String>,
        hold: Vec<String>,
        remove: Vec<String>,
        pair: Vec<Move>,
        accept: Vec<String>,
    },
    Publish {
        plan: String,
    },
    Unpublish {
        paths: Vec<String>,
        accept: Vec<String>,
    },
    Takedown {
        paths: Vec<String>,
    },
    Guards,
    /// An edit of the guards: `deny`, `allow`, `ignore` or `unignore`.
    Edit {
        action: &'static str,
        path: String,
    },
    Unlock,
    /// The deploy again, with no publication (issue 32), with `--takedown`
    /// when `takedown` is true; with `last`, the last deploy report, with no
    /// deploy.
    Deploy {
        takedown: bool,
        last: bool,
    },
}

impl Call {
    /// The name of the tool of the call.
    #[cfg(test)]
    fn tool(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Plan { .. } => "plan",
            Self::Publish { .. } => "publish",
            Self::Unpublish { .. } => "unpublish",
            Self::Takedown { .. } => "takedown",
            Self::Guards => "guards",
            Self::Edit { action, .. } => action,
            Self::Unlock => "unlock",
            Self::Deploy { .. } => "deploy",
        }
    }

    /// The call as data, in the form of the shared cases.
    #[cfg(test)]
    fn to_value(&self) -> Value {
        let mut value = match self {
            Self::Status | Self::Guards | Self::Unlock => json!({}),
            // The shared cases name `takedown` and `last` only when true.
            Self::Deploy { takedown, last } => {
                let mut value = json!({});
                if *takedown {
                    value["takedown"] = json!(true);
                }
                if *last {
                    value["last"] = json!(true);
                }
                value
            }
            Self::Edit { path, .. } => json!({ "path": path }),
            Self::Plan {
                include,
                hold,
                remove,
                pair,
                accept,
            } => {
                let mut value = json!({
                    "include": include,
                    "hold": hold,
                    "remove": remove,
                    "pair": pair,
                });
                // The shared cases name `accept` only when a call has it.
                if !accept.is_empty() {
                    value["accept"] = json!(accept);
                }
                value
            }
            Self::Publish { plan } => json!({ "plan": plan }),
            Self::Unpublish { paths, accept } => {
                let mut value = json!({ "paths": paths });
                if !accept.is_empty() {
                    value["accept"] = json!(accept);
                }
                value
            }
            Self::Takedown { paths } => json!({ "paths": paths }),
        };
        value["tool"] = json!(self.tool());
        value
    }
}

/// What the server says about itself in `initialize`.
pub struct Info<'a> {
    pub name: &'a str,
    pub version: &'a str,
}

/// Why a call cannot be made.
enum Refusal {
    /// A tool that the server does not offer: an error of the protocol.
    UnknownTool(String),
    /// Arguments that do not fit the tool: a tool error for the agent.
    Arguments(String),
}

/// The keys that each tool takes.
fn arguments_of(tool: &str) -> &'static [&'static str] {
    match tool {
        "plan" => &["include", "hold", "remove", "pair", "accept"],
        "publish" => &["plan"],
        "unpublish" => &["paths", "accept"],
        "takedown" => &["paths"],
        "deny" | "allow" | "ignore" | "unignore" => &["path"],
        "deploy" => &["last", "takedown"],
        _ => &[],
    }
}

fn texts(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn list_of(arguments: &Map<String, Value>, key: &str, tool: &str) -> Result<Vec<String>, Refusal> {
    match arguments.get(key) {
        None => Ok(Vec::new()),
        Some(value) => texts(value).ok_or_else(|| {
            Refusal::Arguments(format!(
                "the argument \"{key}\" of {tool} must be a list of vault paths"
            ))
        }),
    }
}

fn pairs_of(arguments: &Map<String, Value>) -> Result<Vec<Move>, Refusal> {
    let wrong = || {
        Refusal::Arguments(
            "the argument \"pair\" of plan must be a list of objects with exactly \"from\" and \"to\", two vault paths"
                .to_owned(),
        )
    };
    match arguments.get("pair") {
        None => Ok(Vec::new()),
        Some(value) => value
            .as_array()
            .ok_or_else(wrong)?
            .iter()
            .map(|item| Move::of(item).ok_or_else(wrong))
            .collect(),
    }
}

fn paths_of(tool: &str, arguments: &Map<String, Value>) -> Result<Vec<String>, Refusal> {
    arguments.get("paths").and_then(texts).ok_or_else(|| {
        Refusal::Arguments(format!(
            "{tool} needs the argument \"paths\": a list of vault paths"
        ))
    })
}

/// The call of a tool with its arguments.
fn call_of(name: &str, arguments: Option<&Value>) -> Result<Call, Refusal> {
    if !TOOL_NAMES.contains(&name) {
        return Err(Refusal::UnknownTool(format!("Unknown tool: {name}")));
    }
    let empty = Map::new();
    let arguments = match arguments {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(Refusal::Arguments(format!(
                "the arguments of {name} must be an object"
            )));
        }
    };
    let known = arguments_of(name);
    // The first key that the tool does not take, in the order of the code
    // points, as the TypeScript face finds it.
    if let Some(other) = arguments.keys().find(|key| !known.contains(&key.as_str())) {
        return Err(Refusal::Arguments(format!(
            "{name} takes no argument \"{other}\""
        )));
    }
    if let Some(action) = EDIT_TOOLS.into_iter().find(|tool| *tool == name) {
        let path = arguments
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                let what = if name == "deny" || name == "allow" {
                    "the vault path of the folder"
                } else {
                    "the vault path of the note"
                };
                Refusal::Arguments(format!("{name} needs the argument \"path\": {what}"))
            })?;
        return Ok(Call::Edit {
            action,
            path: path.to_owned(),
        });
    }
    Ok(match name {
        "status" => Call::Status,
        "guards" => Call::Guards,
        "unlock" => Call::Unlock,
        "deploy" => {
            let flag = |key: &str| match arguments.get(key) {
                None => Ok(false),
                Some(Value::Bool(value)) => Ok(*value),
                Some(_) => Err(Refusal::Arguments(format!(
                    "the argument \"{key}\" of deploy must be true or false"
                ))),
            };
            // The arguments are checked in the order of their names, as the
            // TypeScript face checks them.
            let last = flag("last")?;
            let takedown = flag("takedown")?;
            if takedown && last {
                return Err(Refusal::Arguments(
                    "deploy takes \"last\" to read the last report or \"takedown\" to deploy, not both".to_owned(),
                ));
            }
            Call::Deploy { takedown, last }
        }
        "plan" => Call::Plan {
            include: list_of(arguments, "include", name)?,
            hold: list_of(arguments, "hold", name)?,
            remove: list_of(arguments, "remove", name)?,
            pair: pairs_of(arguments)?,
            accept: list_of(arguments, "accept", name)?,
        },
        "publish" => Call::Publish {
            plan: arguments
                .get("plan")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Refusal::Arguments(
                        "publish needs the argument \"plan\": the id that the plan tool gave"
                            .to_owned(),
                    )
                })?
                .to_owned(),
        },
        "unpublish" => Call::Unpublish {
            paths: paths_of(name, arguments)?,
            accept: list_of(arguments, "accept", name)?,
        },

        _ => Call::Takedown {
            paths: paths_of(name, arguments)?,
        },
    })
}

/// The largest whole number that both faces read exactly: the TypeScript face
/// reads JSON numbers as doubles.
const LARGEST_ID: i64 = 9_007_199_254_740_991;

/// A number id as a whole number, when both faces read it exactly: a whole
/// number from -(2^53 - 1) to 2^53 - 1, also when it is written `1.0` or
/// `-0`.
fn whole_number(number: &serde_json::Number) -> Option<i64> {
    if let Some(whole) = number.as_i64() {
        return (-LARGEST_ID..=LARGEST_ID).contains(&whole).then_some(whole);
    }
    let value = number.as_f64()?;
    // A number with no fraction (its bits do not change when it is cut), in
    // the range: then the cast is exact.
    #[allow(clippy::cast_precision_loss)]
    let largest = LARGEST_ID as f64;
    if value.trunc().to_bits() != value.to_bits() || value.abs() > largest {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(value as i64)
}

fn error_answer(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn result_answer(id: &Value, result: &Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn tool_result(texts: &[&str], is_error: bool) -> Value {
    json!({
        "content": texts
            .iter()
            .map(|text| json!({ "type": "text", "text": text }))
            .collect::<Vec<Value>>(),
        "isError": is_error,
    })
}

fn initialize_result(params: Option<&Value>, info: &Info) -> Value {
    let asked = params
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str);
    let version = asked
        .filter(|asked| PROTOCOL_VERSIONS.contains(asked))
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": info.name, "version": info.version },
        "instructions": definitions()["instructions"],
    })
}

fn call_result(
    id: &Value,
    params: Option<&Value>,
    operations: &mut dyn FnMut(&Call) -> Result<ToolOutcome, String>,
) -> String {
    let Some(name) = params
        .filter(|params| params.is_object())
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
    else {
        return error_answer(
            id,
            INVALID_PARAMS,
            "Invalid params: tools/call needs the name of a tool",
        );
    };
    let call = match call_of(name, params.and_then(|params| params.get("arguments"))) {
        Ok(call) => call,
        Err(Refusal::UnknownTool(message)) => return error_answer(id, INVALID_PARAMS, &message),
        Err(Refusal::Arguments(message)) => {
            return result_answer(id, &tool_result(&[&message], true));
        }
    };
    let result = match operations(&call) {
        Ok(ToolOutcome { outcome, deploy }) => {
            // The deploy report comes last: a failed deploy is no error of
            // the tool.
            let mut texts = vec![outcome.output.as_str()];
            texts.extend(outcome.failure.as_deref());
            texts.extend(deploy.as_deref());
            tool_result(&texts, outcome.failure.is_some())
        }
        Err(message) => tool_result(&[&message], true),
    };
    result_answer(id, &result)
}

/// The answer to one message of the client, as one line of JSON, or `None`
/// when the message needs none: a notification, or an answer of the client.
/// A notification never calls a tool.
pub fn answer(
    message: &str,
    info: &Info,
    operations: &mut dyn FnMut(&Call) -> Result<ToolOutcome, String>,
) -> Option<String> {
    let Ok(value) = serde_json::from_str::<Value>(message) else {
        return Some(error_answer(
            &Value::Null,
            PARSE_ERROR,
            "Parse error: the message is not JSON",
        ));
    };
    if value.is_array() {
        return Some(error_answer(
            &Value::Null,
            INVALID_REQUEST,
            "Invalid Request: a batch is not supported",
        ));
    }
    let Some(object) = value.as_object() else {
        return Some(error_answer(
            &Value::Null,
            INVALID_REQUEST,
            "Invalid Request: the message must be an object",
        ));
    };
    let id = object.get("id");
    let shown = match id {
        None => Value::Null,
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(Value::Number(number)) if whole_number(number).is_some() => {
            json!(whole_number(number))
        }
        Some(_) => {
            return Some(error_answer(
                &Value::Null,
                INVALID_REQUEST,
                "Invalid Request: the id must be a text or a whole number",
            ));
        }
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(error_answer(
            &shown,
            INVALID_REQUEST,
            "Invalid Request: jsonrpc must be \"2.0\"",
        ));
    }
    let Some(method) = object.get("method") else {
        // An answer of the client: the server asks nothing, so it reads none.
        if object.contains_key("result") || object.contains_key("error") {
            return None;
        }
        return id.map(|_| {
            error_answer(
                &shown,
                INVALID_REQUEST,
                "Invalid Request: the method must be a text",
            )
        });
    };
    let Some(method) = method.as_str() else {
        return id.map(|_| {
            error_answer(
                &shown,
                INVALID_REQUEST,
                "Invalid Request: the method must be a text",
            )
        });
    };
    id?;
    let params = object.get("params");
    Some(match method {
        "initialize" => result_answer(&shown, &initialize_result(params, info)),
        "ping" => result_answer(&shown, &json!({})),
        "tools/list" => result_answer(&shown, &json!({ "tools": definitions()["tools"] })),
        "tools/call" => call_result(&shown, params, operations),
        _ => error_answer(
            &shown,
            METHOD_NOT_FOUND,
            &format!("Method not found: {method}"),
        ),
    })
}

/// Serves the MCP server over a stream: one message of JSON per line in, one
/// answer per line out. An empty line is skipped. It ends at the end of the
/// input.
///
/// # Errors
///
/// The input cannot be read, or the output cannot be written.
pub fn serve(
    input: impl BufRead,
    mut output: impl Write,
    info: &Info,
    operations: &mut dyn FnMut(&Call) -> Result<ToolOutcome, String>,
) -> io::Result<()> {
    let mut input = input;
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        if input.read_until(b'\n', &mut bytes)? == 0 {
            return Ok(());
        }
        // A line that is not UTF-8 is one message that is not JSON: the
        // server answers it and goes on.
        let line = String::from_utf8_lossy(&bytes);
        let line = line.trim_end_matches(['\n', '\r']);
        if line.trim().is_empty() {
            continue;
        }
        let answer = if std::str::from_utf8(&bytes).is_ok() {
            answer(line, info, operations)
        } else {
            Some(error_answer(
                &Value::Null,
                PARSE_ERROR,
                "Parse error: the message is not JSON",
            ))
        };
        if let Some(answer) = answer {
            output.write_all(answer.as_bytes())?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/mcp.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/mcp.json");

    const INFO: Info = Info {
        name: "dsebastien-vault-publish",
        version: "test",
    };

    /// The expected answer, with the instructions and the tools of
    /// `mcp-tools.json`.
    fn expected(value: &Value) -> Value {
        match value {
            Value::String(text) if text == "<instructions>" => {
                definitions()["instructions"].clone()
            }
            Value::String(text) if text == "<tools>" => definitions()["tools"].clone(),
            Value::Array(items) => Value::Array(items.iter().map(expected).collect()),
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, item)| (key.clone(), expected(item)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    fn cases() -> Vec<Value> {
        let all: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        all["cases"]
            .as_array()
            .expect("the cases file has the list")
            .clone()
    }

    #[test]
    fn answers_every_shared_case_as_the_file_states() {
        for case in cases() {
            let name = case["name"].as_str().expect("a case has a name");
            let request = match &case["request"] {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            let outcome = &case["operation"];
            let mut calls = Vec::new();
            let mut operations = |call: &Call| {
                calls.push(call.to_value());
                if let Some(error) = outcome["error"].as_str() {
                    return Err(error.to_owned());
                }
                Ok(ToolOutcome {
                    outcome: Outcome {
                        output: outcome["output"].as_str().unwrap_or("").to_owned(),
                        failure: outcome["failure"].as_str().map(str::to_owned),
                    },
                    deploy: outcome["deploy"].as_str().map(str::to_owned),
                })
            };

            let response = answer(&request, &INFO, &mut operations);

            let expected_calls: Vec<Value> = match &case["call"] {
                Value::Null => Vec::new(),
                call => vec![call.clone()],
            };
            assert_eq!(calls, expected_calls, "the call of the case {name}");
            let response = response.map_or(Value::Null, |text| {
                serde_json::from_str(&text).expect("the answer is JSON")
            });
            assert_eq!(
                response,
                expected(&case["response"]),
                "the answer of the case {name}"
            );
        }
    }

    #[test]
    fn the_shared_file_calls_every_tool() {
        let cases = cases();
        assert!(cases.len() > 30);
        let mut called: Vec<&str> = cases
            .iter()
            .filter_map(|case| case["call"]["tool"].as_str())
            .collect();
        called.sort_unstable();
        called.dedup();
        let mut names = TOOL_NAMES.to_vec();
        names.sort_unstable();
        assert_eq!(called, names);
    }

    #[test]
    fn the_tools_are_the_tools_of_the_shared_file_in_its_order() {
        let names: Vec<&str> = definitions()["tools"]
            .as_array()
            .expect("the file has the tools")
            .iter()
            .map(|tool| tool["name"].as_str().expect("a tool has a name"))
            .collect();
        assert_eq!(names, TOOL_NAMES);
    }

    #[test]
    fn plan_and_unpublish_take_the_paths_that_the_author_accepts() {
        let plan = call_of("plan", Some(&json!({ "accept": ["b.md", "a.md"] })));
        let unpublish = call_of(
            "unpublish",
            Some(&json!({ "paths": ["a.md"], "accept": ["b.md"] })),
        );
        let wrong = call_of(
            "unpublish",
            Some(&json!({ "paths": ["a.md"], "accept": "b.md" })),
        );
        let takedown = call_of(
            "takedown",
            Some(&json!({ "paths": ["a.md"], "accept": [] })),
        );

        assert!(matches!(&plan, Ok(call) if call.to_value()["accept"] == json!(["b.md", "a.md"])));
        assert!(matches!(&unpublish, Ok(call) if call.to_value()["accept"] == json!(["b.md"])));
        assert!(matches!(
            &wrong,
            Err(Refusal::Arguments(message)) if message == "the argument \"accept\" of unpublish must be a list of vault paths"
        ));
        assert!(matches!(
            &takedown,
            Err(Refusal::Arguments(message)) if message == "takedown takes no argument \"accept\""
        ));
    }

    #[test]
    fn every_tool_has_a_call() {
        for name in TOOL_NAMES {
            let arguments = match name {
                "publish" => json!({ "plan": "0123456789abcdef" }),
                "unpublish" | "takedown" => json!({ "paths": ["a.md"] }),
                "deny" | "allow" | "ignore" | "unignore" => json!({ "path": "a.md" }),
                _ => json!({}),
            };
            let call = call_of(name, Some(&arguments));
            assert!(
                matches!(&call, Ok(call) if call.tool() == name),
                "the tool {name}"
            );
        }
    }

    #[test]
    fn answers_a_line_that_is_not_utf_8_and_goes_on() {
        let mut input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"\xff\"}\n".to_vec();
        input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\r\n");
        let mut output = Vec::new();
        let mut operations = |_: &Call| Err("no call".to_owned());

        serve(input.as_slice(), &mut output, &INFO, &mut operations).expect("it serves");

        assert_eq!(
            String::from_utf8(output).expect("the output is text"),
            "{\"error\":{\"code\":-32700,\"message\":\"Parse error: the message is not JSON\"},\"id\":null,\"jsonrpc\":\"2.0\"}\n{\"id\":2,\"jsonrpc\":\"2.0\",\"result\":{}}\n"
        );
    }

    #[test]
    fn serves_one_answer_per_line_and_skips_empty_lines() {
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n";
        let mut output = Vec::new();
        let mut operations = |_: &Call| Err("no call".to_owned());

        serve(input.as_bytes(), &mut output, &INFO, &mut operations).expect("it serves");

        assert_eq!(
            String::from_utf8(output).expect("the output is text"),
            "{\"id\":1,\"jsonrpc\":\"2.0\",\"result\":{}}\n{\"id\":2,\"jsonrpc\":\"2.0\",\"result\":{}}\n"
        );
    }
}
