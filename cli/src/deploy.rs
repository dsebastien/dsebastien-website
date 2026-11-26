//! The deploy that the tool starts after a push (issue 32, BUILD-02, PUB-42,
//! decision R76): the deploy command of the site runs on this machine, in a
//! clean clone of the site code that is kept for deploys, and gives its
//! result as the last line of its standard output. This module makes the
//! command and reads the result. It starts no process: the device gives the
//! port that does (`device::ChildProcess`), and a test gives a fake. The
//! TypeScript twin is `apps/plugin/src/publishing/deploy.ts`; both read the
//! shared cases of `fixtures/canonical/deploy.json`.
//!
//! The publication is done at the push: a deploy that fails never undoes it,
//! and never turns the publication report into a failure. The deploy report
//! is apart from the publication report, which the parity rule compares.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::canonical::to_canonical_json;

/// The settings of a deploy on this device. `None` or an empty path is a
/// setting that is not set.
#[derive(Debug, Clone, Default)]
pub struct DeploySettings {
    /// The folder of the clean clone of the site code, kept for deploys.
    pub site_code: Option<PathBuf>,
    /// The private target file of the deployment (the names of the host).
    pub target: Option<PathBuf>,
    /// The private env file that holds the token of the deployment.
    pub env_file: Option<PathBuf>,
    /// The bun program. `None` for `bun` of the path of the system.
    pub bun: Option<PathBuf>,
    /// The folder of the copy of the content store.
    pub content_store: Option<PathBuf>,
    /// The folder of the attachment storage.
    pub attachments: Option<PathBuf>,
    /// The time limit of the deploy, in minutes. `None` for 30.
    pub timeout_minutes: Option<u64>,
}

/// The time limit of a deploy when the settings name none, in minutes.
pub const DEFAULT_TIMEOUT_MINUTES: u64 = 30;

/// The most for the time limit of a deploy, in minutes: 24 hours, as in the
/// TypeScript face, whose timer holds it.
pub const MAX_TIMEOUT_MINUTES: u64 = 1440;

/// What the tool runs: a program with a list of arguments, no shell, in a
/// folder, stopped with the programs that it started after its time limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub folder: PathBuf,
    pub timeout_minutes: u64,
}

/// Why the tool stopped a deploy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// Its time limit.
    Time,
    /// The author: the publication center of the plugin; in the command
    /// line program, Ctrl-C in a terminal while it waits for the deploy.
    Author,
}

/// What a run of the deploy gave.
pub struct ChildRun {
    /// The exit code, or `None` when a signal stopped the program.
    pub code: Option<i32>,
    /// The standard output, where the last line is the result.
    pub stdout: String,
    /// The whole output (standard output and errors), for the author only.
    pub output: String,
    /// Why the tool stopped the deploy, or `None` when it ended by itself.
    pub stopped: Option<Stop>,
}

/// A takedown that waits for its deploy: the commit of its push, or, before
/// the push, the commit of the copy before it (`Above`, `None` for a copy
/// with no commit): the commit of the takedown comes after it. `Any` is an
/// entry that cannot be read: any deploy with `--takedown` that succeeds
/// settles it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TakedownEntry {
    Commit(String),
    Above(Option<String>),
    Any,
}

/// The marker of the takedowns of this device, one entry per takedown, in
/// the git folder of the copy (`.git/vault-publish/takedowns/`). An entry is
/// written before the push of a takedown and holds its commit after it; it
/// goes when nothing was pushed. Every deploy runs with `--takedown` while an
/// entry is there, and a deploy with `--takedown` that succeeded removes only
/// the entries that its release holds: its content revision is the commit of
/// the entry or descends from it.
pub trait TakedownMarker {
    /// The entries, with their ids.
    ///
    /// # Errors
    ///
    /// They cannot be read: the marker then counts as set.
    fn entries(&self) -> Result<Vec<(String, TakedownEntry)>, String>;
    /// Adds an entry, and gives its id.
    ///
    /// # Errors
    ///
    /// The marker cannot be written.
    fn add(&self, entry: &TakedownEntry) -> Result<String, String>;
    /// Writes the entry of this id again.
    ///
    /// # Errors
    ///
    /// The marker cannot be written.
    fn replace(&self, id: &str, entry: &TakedownEntry) -> Result<(), String>;
    /// # Errors
    ///
    /// The entry cannot be removed.
    fn remove(&self, id: &str) -> Result<(), String>;
    /// True when `ancestor` is `revision` or one of its ancestors in the copy,
    /// false when it is not, `None` when the copy does not know them.
    fn is_ancestor(&self, ancestor: &str, revision: &str) -> Option<bool>;
}

/// The entry of a takedown as its file holds it, or `Any` for a text that
/// cannot be read.
pub fn takedown_entry_of(text: &str) -> TakedownEntry {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text) else {
        return TakedownEntry::Any;
    };
    if object.len() != 1 {
        return TakedownEntry::Any;
    }
    match (object.get("commit"), object.get("above")) {
        (Some(Value::String(commit)), _) => TakedownEntry::Commit(commit.clone()),
        (_, Some(Value::String(above))) => TakedownEntry::Above(Some(above.clone())),
        (_, Some(Value::Null)) => TakedownEntry::Above(None),
        _ => TakedownEntry::Any,
    }
}

/// The text of the file of an entry, in the canonical form.
pub fn takedown_entry_text(entry: &TakedownEntry) -> String {
    match entry {
        TakedownEntry::Commit(commit) => to_canonical_json(&json!({ "commit": commit })),
        TakedownEntry::Above(Some(above)) => to_canonical_json(&json!({ "above": above })),
        TakedownEntry::Above(None) => return "{\n  \"above\": null\n}\n".to_owned(),
        TakedownEntry::Any => to_canonical_json(&json!({ "any": true })),
    }
    .unwrap_or_default()
}

/// True when a release of this content revision holds the takedown of the
/// entry. A release built elsewhere (`None`) holds none, and a commit that
/// the copy does not know counts as not held.
pub fn holds_takedown(
    entry: &TakedownEntry,
    revision: Option<&str>,
    is_ancestor: &dyn Fn(&str, &str) -> Option<bool>,
) -> bool {
    match (entry, revision) {
        (TakedownEntry::Any, _) => true,
        (_, None) => false,
        (TakedownEntry::Commit(commit), Some(revision)) => {
            revision == commit || is_ancestor(commit, revision) == Some(true)
        }
        (TakedownEntry::Above(above), Some(revision)) => match above {
            Some(above) if above == revision => false,
            Some(above) => is_ancestor(above, revision) == Some(true),
            None => true,
        },
    }
}

/// True when a takedown waits for its deploy. A marker that cannot be read
/// counts as set.
pub fn takedown_waits(marker: &dyn TakedownMarker) -> bool {
    marker.entries().map_or(true, |entries| !entries.is_empty())
}

/// Removes the entries of the marker that a release of this content
/// revision holds, after a deploy with `--takedown` that succeeded. It gives
/// the warnings: the takedowns that still wait, and an entry that could not
/// be removed.
fn settle_takedowns(marker: &dyn TakedownMarker, revision: Option<&str>) -> Vec<String> {
    let entries = match marker.entries() {
        Ok(entries) => entries,
        Err(error) => {
            return vec![format!(
                "the marker of the takedowns cannot be read, so the next deploy runs with --takedown too: {error}"
            )];
        }
    };
    let mut warnings = Vec::new();
    let mut waiting = 0;
    for (id, entry) in entries {
        if !holds_takedown(&entry, revision, &|one, two| marker.is_ancestor(one, two)) {
            waiting += 1;
            continue;
        }
        if let Err(error) = marker.remove(&id) {
            warnings.push(format!(
                "the marker of a takedown could not be removed, so the next deploy runs with --takedown too: {error}"
            ));
        }
    }
    if waiting > 0 {
        warnings.push(format!(
            "{waiting} takedown(s) came after the content of this release and wait for their deploy: the next deploy runs with --takedown"
        ));
    }
    warnings
}

/// The record of the deploys of this device, in the git folder of the copy:
/// the deploys that run (`.git/vault-publish/deploy-running/`, one file per
/// child process of a deploy, named by its number) and the report of the
/// last one (`deploy-report.json`), so that an agent reads them later and
/// every face of this device sees them. A deploy runs while its child runs,
/// also when the face that started it ended.
pub trait DeployRecord {
    /// The child process of a deploy started.
    ///
    /// # Errors
    ///
    /// The record cannot be written.
    fn started(&self, pid: u32) -> Result<(), String>;
    /// The child process of a deploy ended.
    ///
    /// # Errors
    ///
    /// The record cannot be removed.
    fn ended(&self, pid: u32) -> Result<(), String>;
    /// True while the child process of one of the records runs.
    fn running(&self) -> bool;
    /// Keeps the text of the last deploy report (`deployment_text`).
    ///
    /// # Errors
    ///
    /// The record cannot be written.
    fn save_last(&self, text: &str) -> Result<(), String>;
    /// The text of the last deploy report, or `None` when there is none.
    fn last(&self) -> Option<String>;
}

/// The files of the deploy of a device: the marker of a takedown and the
/// record.
pub trait DeployFiles: TakedownMarker + DeployRecord {}

impl<T: TakedownMarker + DeployRecord> DeployFiles for T {}

/// What a deploy follows: a push (`ok`), or nothing (`skipped`, a deploy
/// again), and whether it runs with `--takedown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeployKind {
    pub push: &'static str,
    pub takedown: bool,
}

/// The port that starts the deploy as a child process.
pub trait DeployProcess {
    /// Runs the command to its end; `on_start` gets the number of the child
    /// process when it started.
    ///
    /// # Errors
    ///
    /// The program cannot start: the message of the system.
    fn run(&self, command: &DeployCommand, on_start: &dyn Fn(u32)) -> Result<ChildRun, String>;
}

/// The deploy report: the push, the build and the deploy apart (PUB-42), and
/// "live" with the URL when the deployment record names the new revision
/// (STORE-08, PUB-43). A field that is not known is `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployReport {
    /// `skipped` for a deploy again, with no publication.
    pub push: &'static str,
    /// True for a deploy with `--takedown`.
    pub takedown: bool,
    pub build: &'static str,
    pub deploy: &'static str,
    pub live: bool,
    pub url: Option<String>,
    pub content_revision: Option<String>,
    pub uploaded: u64,
    pub deleted: u64,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

impl DeployReport {
    /// True when the deploy succeeded: `deploy` is `ok` and no error came. A
    /// deploy with `--takedown` must also be seen live: the pages of the
    /// takedown must be gone.
    pub fn succeeded(&self) -> bool {
        self.deploy == "ok" && self.error.is_none() && (!self.takedown || self.live)
    }
}

/// A deploy report with the whole output of the child, which only the author
/// sees.
pub struct Deployment {
    pub report: DeployReport,
    pub output: String,
}

/// The start of the last line of the standard output of the deploy.
pub const RESULT_PREFIX: &str = "DEPLOY-RESULT ";

const READ_OUTPUT: &str = "read the output of the deploy";

/// True for an absolute path, by one rule in both faces: on Unix a path that
/// starts with `/`; on Windows a drive with its separator (`C:\`, `C:/`) or
/// a network path (`\\server\share`). On Windows, `\foo` and `/foo` are
/// not absolute: they depend on the drive of the moment. A path that is not
/// text is not absolute.
pub fn is_absolute_path(path: &Path, windows: bool) -> bool {
    let Some(path) = path.to_str() else {
        return false;
    };
    if !windows {
        return path.starts_with('/');
    }
    let separator = |byte: u8| byte == b'\\' || byte == b'/';
    match path.as_bytes() {
        [drive, b':', next, ..] => drive.is_ascii_alphabetic() && separator(*next),
        [one, two, three, ..] => separator(*one) && separator(*two) && !separator(*three),
        _ => false,
    }
}

/// "a", "a and b", "a, b and c".
fn listed(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [first @ .., last] => format!("{} and {last}", first.join(", ")),
    }
}

/// A setting that is set: not `None` and not empty.
fn set(path: Option<&PathBuf>) -> Option<&Path> {
    path.map(PathBuf::as_path)
        .filter(|path| !path.as_os_str().is_empty())
}

/// The command of the deploy (the interface of `scripts/deploy.ts`), or the
/// error of a deploy report that deploys nothing: a setting that is not set,
/// or a path that is not absolute (`is_absolute_path`). Every path is
/// absolute, so no argument starts with `-`.
///
/// # Errors
///
/// A setting is not set, or a path is not absolute: the message names it.
pub fn deploy_command(
    settings: &DeploySettings,
    takedown: bool,
    windows: bool,
) -> Result<DeployCommand, String> {
    // The name of each setting in a message, and its option.
    let site_code = ("the folder of the site code", "--site-code");
    let target = ("the target file of the deployment", "--deploy-target");
    let env_file = ("the env file of the deployment", "--deploy-env-file");
    let bun = ("the bun program", "--bun");
    let content_store = ("the copy of the content store", "--content-store");
    let attachments = ("the attachment storage", "--attachment-storage");
    let required = [
        (site_code, set(settings.site_code.as_ref())),
        (target, set(settings.target.as_ref())),
        (content_store, set(settings.content_store.as_ref())),
        (attachments, set(settings.attachments.as_ref())),
    ];
    let missing: Vec<(&str, &str)> = required
        .iter()
        .filter(|(_, path)| path.is_none())
        .map(|(names, _)| *names)
        .collect();
    if !missing.is_empty() {
        let names: Vec<&str> = missing.iter().map(|(name, _)| *name).collect();
        let options: Vec<&str> = missing.iter().map(|(_, option)| *option).collect();
        return Err(format!(
            "nothing was deployed: {} {} not set (in the settings of Vault Publish, or {} of the command line program)",
            listed(&names),
            if missing.len() == 1 { "is" } else { "are" },
            listed(&options)
        ));
    }
    let paths = [
        (site_code, set(settings.site_code.as_ref())),
        (target, set(settings.target.as_ref())),
        (env_file, set(settings.env_file.as_ref())),
        (bun, set(settings.bun.as_ref())),
        (content_store, set(settings.content_store.as_ref())),
        (attachments, set(settings.attachments.as_ref())),
    ];
    if let Some(((name, _), Some(path))) = paths
        .iter()
        .find(|(_, path)| path.is_some_and(|path| !is_absolute_path(path, windows)))
    {
        return Err(format!(
            "nothing was deployed: {name} must be an absolute path: \"{}\"",
            path.display()
        ));
    }
    // Every required setting is set here.
    let path = |path: Option<&PathBuf>| set(path).map_or_else(PathBuf::new, Path::to_path_buf);
    let mut args: Vec<OsString> = Vec::new();
    if let Some(file) = set(settings.env_file.as_ref()) {
        let mut option = OsString::from("--env-file=");
        option.push(file);
        args.push(option);
    }
    for arg in ["run", "deploy", "--from-main", "--target"] {
        args.push(arg.into());
    }
    args.push(path(settings.target.as_ref()).into());
    args.push("--content-store".into());
    args.push(path(settings.content_store.as_ref()).into());
    args.push("--attachments".into());
    args.push(path(settings.attachments.as_ref()).into());
    if takedown {
        args.push("--takedown".into());
    }
    let timeout_minutes = settings.timeout_minutes.unwrap_or(DEFAULT_TIMEOUT_MINUTES);
    if !(1..=MAX_TIMEOUT_MINUTES).contains(&timeout_minutes) {
        return Err(format!(
            "nothing was deployed: the time limit of the deploy must be a whole number of minutes from 1 to {MAX_TIMEOUT_MINUTES}"
        ));
    }
    Ok(DeployCommand {
        timeout_minutes,
        program: set(settings.bun.as_ref()).map_or_else(|| PathBuf::from("bun"), Path::to_path_buf),
        args,
        folder: path(settings.site_code.as_ref()),
    })
}

/// A report with no step done, before the warning of a takedown.
fn bare(error: String, kind: DeployKind) -> DeployReport {
    DeployReport {
        push: kind.push,
        takedown: kind.takedown,
        build: "skipped",
        deploy: "skipped",
        live: false,
        url: None,
        content_revision: None,
        uploaded: 0,
        deleted: 0,
        warnings: Vec::new(),
        error: Some(error),
    }
}

/// The error of a deploy with `--takedown` that was not seen live, as the
/// deploy command writes it.
pub const TAKEDOWN_NOT_LIVE: &str = "the release of the takedown was not seen live, so the takedown waits for a deploy that is seen live";

/// The warning of a takedown whose deploy did not succeed (PUB-42).
pub const TAKEDOWN_WAITS: &str = "the notes of the takedown can still be live until a deploy with --takedown succeeds: the next deploy runs with --takedown";

/// A report of a deploy with `--takedown` that did not succeed warns that
/// the takedown waits.
fn with_takedown(mut report: DeployReport) -> DeployReport {
    if report.takedown && !report.succeeded() {
        report.warnings.push(TAKEDOWN_WAITS.to_owned());
    }
    report
}

/// A deploy report that deploys nothing, with its reason.
pub fn report_of_nothing(error: String, kind: DeployKind) -> DeployReport {
    with_takedown(bare(error, kind))
}

/// The deploy report of a program that could not start.
pub fn report_of_start_error(message: &str, kind: DeployKind) -> DeployReport {
    with_takedown(DeployReport {
        deploy: "failed",
        ..bare(format!("the deploy could not start: {message}"), kind)
    })
}

/// The deploy report of a deploy that the tool stopped: after its time
/// limit, or for the author.
pub fn report_of_stop(stop: Stop, timeout_minutes: u64, kind: DeployKind) -> DeployReport {
    let why = match stop {
        Stop::Time => format!("after its time limit of {timeout_minutes} minutes"),
        Stop::Author => "by the author".to_owned(),
    };
    with_takedown(failed(
        format!("the deploy was stopped {why}, with the programs that it started: {READ_OUTPUT}"),
        kind,
    ))
}

fn failed(error: String, kind: DeployKind) -> DeployReport {
    DeployReport {
        build: "failed",
        deploy: "failed",
        ..bare(error, kind)
    }
}

fn step(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_str) {
        Some("ok") => Some("ok"),
        Some("failed") => Some("failed"),
        Some("skipped") => Some("skipped"),
        _ => None,
    }
}

/// The largest whole number that a double holds exactly.
const LARGEST_COUNT: u64 = 9_007_199_254_740_991;

/// A count: a whole number from 0 that a double holds exactly, in any form
/// of JSON (`1.0`, `1e2`, `-0`), as in the TypeScript face.
fn count(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_number()?;
    if let Some(count) = number.as_u64() {
        return (count <= LARGEST_COUNT).then_some(count);
    }
    let float = number.as_f64()?;
    // The bound is an exact double: the casts below are exact too.
    #[allow(clippy::cast_precision_loss)]
    let largest = LARGEST_COUNT as f64;
    if float.fract() != 0.0 || !(0.0..=largest).contains(&float) {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(float as u64)
}

/// A line of the output with its end and a byte order mark at its start
/// taken away.
fn line_of(line: &str) -> &str {
    let line = line.strip_suffix('\r').unwrap_or(line);
    line.strip_prefix('\u{feff}').unwrap_or(line)
}

/// A line with spaces and tabs only, which the result never is.
fn is_blank(line: &str) -> bool {
    line.bytes().all(|byte| byte == b' ' || byte == b'\t')
}

/// An optional text: absent, `null` or a text. An empty text is a field that
/// the deploy did not know (a target file that cannot be read gives an empty
/// URL). `Err` for any other value.
fn optional_text(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

/// The result line, read strictly, or `None` when its shape is wrong. Unknown
/// fields are ignored.
fn result_of(value: &Value, kind: DeployKind) -> Option<DeployReport> {
    let object = value.as_object()?;
    let warnings = object
        .get("warnings")?
        .as_array()?
        .iter()
        .map(|one| one.as_str().map(str::to_owned))
        .collect::<Option<Vec<String>>>()?;
    Some(DeployReport {
        push: kind.push,
        takedown: kind.takedown,
        build: step(object.get("build"))?,
        deploy: step(object.get("deploy"))?,
        live: object.get("live")?.as_bool()?,
        url: optional_text(object.get("url")).ok()?,
        content_revision: optional_text(object.get("contentRevision")).ok()?,
        uploaded: count(object.get("uploaded"))?,
        deleted: count(object.get("deleted"))?,
        warnings,
        error: optional_text(object.get("error")).ok()?,
    })
}

/// The deploy report of a run of the deploy, from its exit code and its
/// standard output: the last line is the result. A missing or broken result
/// line is a failed deploy. The deploy succeeded only when the exit code is 0
/// and the result says so.
pub fn report_of_run(code: Option<i32>, stdout: &str, kind: DeployKind) -> DeployReport {
    with_takedown(read_run(code, stdout, kind))
}

fn read_run(code: Option<i32>, stdout: &str, kind: DeployKind) -> DeployReport {
    let ended = code.map_or_else(
        || "stopped by a signal".to_owned(),
        |code| format!("exit code {code}"),
    );
    let last = stdout
        .split('\n')
        .map(line_of)
        .rfind(|line| !is_blank(line))
        .unwrap_or("");
    let Some(text) = last.strip_prefix(RESULT_PREFIX) else {
        return failed(
            format!("the deploy gave no result line ({ended}): {READ_OUTPUT}"),
            kind,
        );
    };
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return failed(
            format!("the result line of the deploy is not JSON: {READ_OUTPUT}"),
            kind,
        );
    };
    let Some(result) = result_of(&value, kind) else {
        return failed(
            format!("the result line of the deploy has the wrong shape: {READ_OUTPUT}"),
            kind,
        );
    };
    if result.deploy == "ok" && code == Some(0) && result.error.is_none() {
        if result.takedown && !result.live {
            return DeployReport {
                error: Some(TAKEDOWN_NOT_LIVE.to_owned()),
                ..result
            };
        }
        return result;
    }
    // A step after the switch failed (a cleanup of a takedown): the error of
    // the deploy and "live" stay, and the deploy is no success.
    if result.deploy == "ok" && result.error.is_some() {
        return result;
    }
    if result.deploy == "ok" {
        let how = code.map_or_else(
            || "was stopped by a signal".to_owned(),
            |code| format!("ended with the exit code {code}"),
        );
        return DeployReport {
            deploy: "failed",
            live: false,
            error: Some(format!(
                "the deploy {how}, but its result line says that it succeeded: {READ_OUTPUT}"
            )),
            ..result
        };
    }
    let error = result
        .error
        .clone()
        .unwrap_or_else(|| format!("the deploy did not succeed ({ended}): {READ_OUTPUT}"));
    DeployReport {
        live: false,
        error: Some(error),
        ..result
    }
}

/// Runs the deploy of the settings, or gives the report that names the
/// missing setting. The deploy never fails: its failures are in the report.
/// It runs with `--takedown` when the run asks for it or when the marker of a
/// takedown is set, and removes the marker only when such a deploy
/// succeeded. A marker that cannot be removed is a warning. The record says
/// that it runs, then keeps its report; a record that cannot be written stops
/// nothing.
pub fn run_deploy(
    child: &dyn DeployProcess,
    files: &dyn DeployFiles,
    settings: &DeploySettings,
    asked: DeployKind,
    windows: bool,
) -> Deployment {
    let started = std::cell::Cell::new(None);
    let deployment = deploy_with(child, files, settings, asked, windows, &|pid| {
        started.set(Some(pid));
        let _ = files.started(pid);
    });
    if let Some(pid) = started.get() {
        let _ = files.ended(pid);
    }
    let _ = files.save_last(&deployment_text(&deployment.report));
    deployment
}

fn deploy_with(
    child: &dyn DeployProcess,
    marker: &dyn DeployFiles,
    settings: &DeploySettings,
    asked: DeployKind,
    windows: bool,
    on_start: &dyn Fn(u32),
) -> Deployment {
    let kind = DeployKind {
        push: asked.push,
        takedown: asked.takedown || takedown_waits(marker),
    };
    let command = match deploy_command(settings, kind.takedown, windows) {
        Ok(command) => command,
        Err(error) => {
            return Deployment {
                report: report_of_nothing(error, kind),
                output: String::new(),
            };
        }
    };
    match child.run(&command, on_start) {
        Ok(run) => {
            let mut report = match run.stopped {
                Some(stop) => report_of_stop(stop, command.timeout_minutes, kind),
                None => report_of_run(run.code, &run.stdout, kind),
            };
            if report.takedown && report.succeeded() {
                let warnings = settle_takedowns(marker, report.content_revision.as_deref());
                report.warnings.extend(warnings);
            }
            Deployment {
                report,
                output: run.output,
            }
        }
        Err(message) => Deployment {
            report: report_of_start_error(&message, kind),
            output: String::new(),
        },
    }
}

/// The deploy report as the tool writes it: its own object `deployment`, in
/// the canonical form.
pub fn deployment_text(report: &DeployReport) -> String {
    let mut object = Map::new();
    object.insert("push".into(), json!(report.push));
    object.insert("state".into(), json!("done"));
    object.insert("takedown".into(), json!(report.takedown));
    object.insert("build".into(), json!(report.build));
    object.insert("deploy".into(), json!(report.deploy));
    object.insert("live".into(), json!(report.live));
    if let Some(url) = &report.url {
        object.insert("url".into(), json!(url));
    }
    if let Some(revision) = &report.content_revision {
        object.insert("contentRevision".into(), json!(revision));
    }
    object.insert("uploaded".into(), json!(report.uploaded));
    object.insert("deleted".into(), json!(report.deleted));
    object.insert("warnings".into(), json!(report.warnings));
    if let Some(error) = &report.error {
        object.insert("error".into(), json!(error));
    }
    // Texts, booleans and counts below the limit always have a canonical form.
    to_canonical_json(&json!({ "deployment": Value::Object(object) })).unwrap_or_default()
}

/// The deploy report of a deploy that starts in the background (the MCP
/// server never waits for a build): `state` `started`, with its push and
/// whether it was asked with `--takedown`. The `deploy` tool with `last`
/// reads its result later.
pub fn started_text(kind: DeployKind) -> String {
    to_canonical_json(&json!({ "deployment": {
        "push": kind.push,
        "state": "started",
        "takedown": kind.takedown,
    }}))
    .unwrap_or_default()
}

/// The text that `status` of the MCP server adds after its report when a
/// takedown waits for its deploy, outside the report.
pub fn takedown_waits_text() -> String {
    to_canonical_json(&json!({ "takedownWaits": true })).unwrap_or_default()
}

/// What the `deploy` tool and command give with `last`: the last deploy
/// report of the record (absent when there is none, or when its text is
/// broken), and whether a deploy runs. It starts no deploy.
pub fn last_text(stored: Option<&str>, running: bool, takedown_waits: bool) -> String {
    let mut object = Map::new();
    if let Some(deployment) = stored
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.get("deployment").cloned())
        .filter(|deployment| {
            deployment.is_object()
                && to_canonical_json(&json!({ "deployment": deployment })).is_ok()
        })
    {
        object.insert("deployment".into(), deployment);
    }
    object.insert("running".into(), json!(running));
    object.insert("takedownWaits".into(), json!(takedown_waits));
    to_canonical_json(&Value::Object(object)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/deploy.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/deploy.json");

    fn cases() -> Value {
        serde_json::from_str(CASES).expect("the cases file is JSON")
    }

    #[test]
    fn has_the_one_rule_of_an_absolute_path_of_the_shared_cases() {
        for case in cases()["paths"].as_array().expect("the paths") {
            let path = case["path"].as_str().expect("a path");
            let windows = case["windows"].as_bool().expect("windows");
            assert_eq!(
                is_absolute_path(Path::new(path), windows),
                case["absolute"].as_bool().expect("absolute"),
                "{path} (windows: {windows})"
            );
        }
    }

    fn setting(settings: &Value, key: &str) -> Option<PathBuf> {
        settings[key].as_str().map(PathBuf::from)
    }

    fn settings_of(settings: &Value) -> DeploySettings {
        DeploySettings {
            site_code: setting(settings, "siteCode"),
            target: setting(settings, "target"),
            env_file: setting(settings, "envFile"),
            bun: setting(settings, "bun"),
            content_store: setting(settings, "contentStore"),
            attachments: setting(settings, "attachments"),
            timeout_minutes: settings["timeoutMinutes"].as_u64(),
        }
    }

    fn kind_of(case: &Value) -> DeployKind {
        DeployKind {
            push: if case["push"] == "ok" {
                "ok"
            } else {
                "skipped"
            },
            takedown: case["takedown"].as_bool().unwrap_or(false),
        }
    }

    #[test]
    fn makes_the_command_of_every_shared_case() {
        for case in cases()["commands"].as_array().expect("the commands") {
            let name = case["name"].as_str().expect("a case has a name");
            let made = deploy_command(
                &settings_of(&case["settings"]),
                case["takedown"].as_bool().expect("takedown"),
                case["windows"].as_bool().unwrap_or(false),
            );
            if let Some(error) = case["error"].as_str() {
                assert_eq!(made, Err(error.to_owned()), "{name}");
            } else {
                {
                    let command = &case["command"];
                    let expected = DeployCommand {
                        program: PathBuf::from(command["program"].as_str().expect("program")),
                        args: command["args"]
                            .as_array()
                            .expect("args")
                            .iter()
                            .map(|arg| OsString::from(arg.as_str().expect("an argument")))
                            .collect(),
                        folder: PathBuf::from(command["folder"].as_str().expect("folder")),
                        timeout_minutes: command["timeoutMinutes"].as_u64().expect("a limit"),
                    };
                    assert_eq!(made, Ok(expected), "{name}");
                }
            }
        }
    }

    #[test]
    fn reads_the_result_of_every_shared_case() {
        for case in cases()["results"].as_array().expect("the results") {
            let name = case["name"].as_str().expect("a case has a name");
            let kind = kind_of(case);
            let stop = match case["stopped"].as_str() {
                Some("time") => Some(Stop::Time),
                Some("author") => Some(Stop::Author),
                _ => None,
            };
            let limit = case["timeoutMinutes"].as_u64().unwrap_or(30);
            let report = match (stop, case["startError"].as_str()) {
                (Some(stop), _) => report_of_stop(stop, limit, kind),
                (None, Some(message)) => report_of_start_error(message, kind),
                (None, None) => report_of_run(
                    case["code"]
                        .as_i64()
                        .map(|code| i32::try_from(code).expect("a small code")),
                    case["stdout"].as_str().expect("stdout"),
                    kind,
                ),
            };
            let written: Value =
                serde_json::from_str(&deployment_text(&report)).expect("the report is JSON");
            assert_eq!(written, json!({ "deployment": case["report"] }), "{name}");
        }
    }

    #[test]
    fn writes_the_report_in_the_canonical_form_in_its_own_object() {
        let report = report_of_start_error("no program", PUSHED);

        assert_eq!(
            deployment_text(&report),
            "{\n  \"deployment\": {\n    \"build\": \"skipped\",\n    \"deleted\": 0,\n    \"deploy\": \"failed\",\n    \"error\": \"the deploy could not start: no program\",\n    \"live\": false,\n    \"push\": \"ok\",\n    \"state\": \"done\",\n    \"takedown\": false,\n    \"uploaded\": 0,\n    \"warnings\": []\n  }\n}\n"
        );
    }

    const PUSHED: DeployKind = DeployKind {
        push: "ok",
        takedown: false,
    };

    /// A marker of the takedowns and a record in memory: the entries, the
    /// records of a run, the reports, and the pairs [ancestor, revision] of
    /// the copy.
    struct Marker(
        RefCell<Vec<(String, TakedownEntry)>>,
        RefCell<Vec<bool>>,
        RefCell<Vec<String>>,
        Vec<(String, String)>,
    );

    impl Marker {
        fn pending(&self) -> bool {
            !self.0.borrow().is_empty()
        }
    }

    impl DeployRecord for Marker {
        fn started(&self, _: u32) -> Result<(), String> {
            self.1.borrow_mut().push(true);
            Ok(())
        }
        fn ended(&self, _: u32) -> Result<(), String> {
            self.1.borrow_mut().push(false);
            Ok(())
        }
        fn running(&self) -> bool {
            self.1.borrow().last() == Some(&true)
        }
        fn save_last(&self, text: &str) -> Result<(), String> {
            self.2.borrow_mut().push(text.to_owned());
            Ok(())
        }
        fn last(&self) -> Option<String> {
            self.2.borrow().last().cloned()
        }
    }

    impl TakedownMarker for Marker {
        fn entries(&self) -> Result<Vec<(String, TakedownEntry)>, String> {
            Ok(self.0.borrow().clone())
        }
        fn add(&self, entry: &TakedownEntry) -> Result<String, String> {
            let id = (self.0.borrow().len() + 1).to_string();
            self.0.borrow_mut().push((id.clone(), entry.clone()));
            Ok(id)
        }
        fn replace(&self, id: &str, entry: &TakedownEntry) -> Result<(), String> {
            for one in self.0.borrow_mut().iter_mut() {
                if one.0 == id {
                    one.1 = entry.clone();
                }
            }
            Ok(())
        }
        fn remove(&self, id: &str) -> Result<(), String> {
            self.0.borrow_mut().retain(|one| one.0 != id);
            Ok(())
        }
        fn is_ancestor(&self, ancestor: &str, revision: &str) -> Option<bool> {
            Some(
                ancestor == revision
                    || self
                        .3
                        .iter()
                        .any(|(one, two)| one == ancestor && two == revision),
            )
        }
    }

    fn marker(pending: bool) -> Marker {
        marker_with(pending, Vec::new())
    }

    fn marker_with(pending: bool, ancestors: Vec<(String, String)>) -> Marker {
        let entries = if pending {
            vec![("one".to_owned(), TakedownEntry::Above(None))]
        } else {
            Vec::new()
        };
        Marker(
            RefCell::new(entries),
            RefCell::new(Vec::new()),
            RefCell::new(Vec::new()),
            ancestors,
        )
    }

    fn entry_of_case(value: &Value) -> TakedownEntry {
        match (value.get("commit"), value.get("above"), value.get("any")) {
            (Some(commit), _, _) => {
                TakedownEntry::Commit(commit.as_str().expect("a commit").to_owned())
            }
            (_, Some(above), _) => TakedownEntry::Above(above.as_str().map(str::to_owned)),
            _ => TakedownEntry::Any,
        }
    }

    #[test]
    fn status_adds_the_text_of_the_shared_case() {
        assert_eq!(
            takedown_waits_text(),
            cases()["takedownWaitsText"].as_str().expect("a text")
        );
    }

    #[test]
    fn knows_which_release_holds_a_takedown_in_the_shared_cases() {
        let all = cases();
        let takedowns = &all["takedowns"];
        let pairs: Vec<(String, String)> = takedowns["ancestors"]
            .as_array()
            .expect("the ancestors")
            .iter()
            .map(|pair| {
                (
                    pair[0].as_str().expect("a commit").to_owned(),
                    pair[1].as_str().expect("a commit").to_owned(),
                )
            })
            .collect();
        let unknown: Vec<&str> = takedowns["unknown"]
            .as_array()
            .expect("the unknown")
            .iter()
            .map(|one| one.as_str().expect("a commit"))
            .collect();
        let is_ancestor = |one: &str, two: &str| {
            if unknown.contains(&one) || unknown.contains(&two) {
                return None;
            }
            Some(
                one == two
                    || pairs
                        .iter()
                        .any(|(first, second)| first == one && second == two),
            )
        };
        for case in takedowns["entries"].as_array().expect("the entries") {
            assert_eq!(
                holds_takedown(
                    &entry_of_case(&case["entry"]),
                    case["revision"].as_str(),
                    &is_ancestor
                ),
                case["holds"].as_bool().expect("holds"),
                "{}",
                case["name"]
            );
        }
        for case in takedowns["texts"].as_array().expect("the texts") {
            let text = case["text"].as_str().expect("a text");
            let entry = entry_of_case(&case["entry"]);
            assert_eq!(takedown_entry_of(text), entry, "{}", case["name"]);
            if entry != TakedownEntry::Any {
                assert_eq!(takedown_entry_text(&entry), text, "{}", case["name"]);
            }
        }
    }

    #[test]
    fn keeps_a_takedown_that_was_pushed_while_an_older_deploy_ran_which_succeeds() {
        let c1 = "1".repeat(40);
        let t2 = "3".repeat(40);
        let line: &'static str = Box::leak(
            LINE.replace("0123456789abcdef0123456789abcdef01234567", &c1)
                .into_boxed_str(),
        );
        let child = Fake {
            runs: RefCell::new(Vec::new()),
            answer: Ok((Some(0), line)),
        };
        // T2 came after C1: C1 is an ancestor of T2, not the reverse.
        let files = marker_with(false, vec![(c1.clone(), t2.clone())]);
        files
            .add(&TakedownEntry::Commit(t2.clone()))
            .expect("added");

        let deployment = run_deploy(&child, &files, &settings(), PUSHED, false);

        assert!(deployment.report.takedown);
        assert_eq!(
            deployment.report.content_revision.as_deref(),
            Some(c1.as_str())
        );
        assert_eq!(
            files
                .0
                .borrow()
                .iter()
                .map(|one| one.1.clone())
                .collect::<Vec<_>>(),
            vec![TakedownEntry::Commit(t2)]
        );
        assert!(deployment.report.warnings.contains(
            &"1 takedown(s) came after the content of this release and wait for their deploy: the next deploy runs with --takedown".to_owned()
        ));
    }

    /// A child that records the commands and gives one answer.
    struct Fake {
        runs: RefCell<Vec<DeployCommand>>,
        answer: Result<(Option<i32>, &'static str), &'static str>,
    }

    impl DeployProcess for Fake {
        fn run(&self, command: &DeployCommand, on_start: &dyn Fn(u32)) -> Result<ChildRun, String> {
            if self.answer.is_ok() {
                on_start(4242);
            }
            self.runs.borrow_mut().push(command.clone());
            match self.answer {
                Ok((code, stdout)) => Ok(ChildRun {
                    code,
                    stdout: stdout.to_owned(),
                    output: format!("{stdout}a warning of the build\n"),
                    stopped: None,
                }),
                Err(message) => Err(message.to_owned()),
            }
        }
    }

    const LINE: &str = "DEPLOY-RESULT {\"build\":\"ok\",\"deploy\":\"ok\",\"live\":true,\"url\":\"https://preview.example.org/\",\"contentRevision\":\"0123456789abcdef0123456789abcdef01234567\",\"uploaded\":0,\"deleted\":0,\"warnings\":[],\"error\":null}\n";

    fn settings() -> DeploySettings {
        DeploySettings {
            site_code: Some("/work/site-code".into()),
            target: Some("/private/target.json".into()),
            env_file: None,
            bun: None,
            content_store: Some("/data/copy".into()),
            attachments: Some("/data/files".into()),
            timeout_minutes: None,
        }
    }

    #[test]
    fn a_deploy_runs_the_command_and_keeps_its_whole_output() {
        let child = Fake {
            runs: RefCell::new(Vec::new()),
            answer: Ok((Some(0), LINE)),
        };

        let deployment = run_deploy(
            &child,
            &marker(false),
            &settings(),
            DeployKind {
                push: "ok",
                takedown: true,
            },
            false,
        );

        let runs = child.runs.borrow();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].program, PathBuf::from("bun"));
        assert_eq!(runs[0].folder, PathBuf::from("/work/site-code"));
        assert_eq!(runs[0].args.last(), Some(&OsString::from("--takedown")));
        assert!(deployment.report.live);
        assert_eq!(
            deployment.report.url.as_deref(),
            Some("https://preview.example.org/")
        );
        assert_eq!(deployment.output, format!("{LINE}a warning of the build\n"));
    }

    #[test]
    fn a_deploy_with_a_missing_setting_starts_nothing() {
        let child = Fake {
            runs: RefCell::new(Vec::new()),
            answer: Err("never"),
        };
        let missing = DeploySettings {
            target: None,
            ..settings()
        };

        let pending = marker(true);

        let deployment = run_deploy(&child, &pending, &missing, PUSHED, false);

        assert!(child.runs.borrow().is_empty());
        assert_eq!(
            (deployment.report.build, deployment.report.deploy),
            ("skipped", "skipped")
        );
        assert!(
            deployment
                .report
                .error
                .is_some_and(|error| error.contains("the target file of the deployment is not set"))
        );
        assert!(deployment.report.takedown && pending.pending());
    }

    #[test]
    fn a_program_that_cannot_start_is_a_failed_deploy() {
        let child = Fake {
            runs: RefCell::new(Vec::new()),
            answer: Err("No such file or directory"),
        };

        let deployment = run_deploy(&child, &marker(false), &settings(), PUSHED, false);

        assert_eq!(
            deployment.report.error.as_deref(),
            Some("the deploy could not start: No such file or directory")
        );
        assert_eq!(deployment.report.deploy, "failed");
    }

    #[test]
    fn runs_with_takedown_while_the_marker_is_set_and_removes_it_when_it_succeeded() {
        let failing = Fake {
            runs: RefCell::new(Vec::new()),
            answer: Ok((Some(1), "crash\n")),
        };
        let working = Fake {
            runs: RefCell::new(Vec::new()),
            answer: Ok((Some(0), LINE)),
        };
        let pending = marker(true);
        let again = DeployKind {
            push: "skipped",
            takedown: false,
        };

        let first = run_deploy(&failing, &pending, &settings(), again, false);
        let kept = pending.pending();
        let second = run_deploy(&working, &pending, &settings(), again, false);
        let third = run_deploy(&working, &pending, &settings(), again, false);

        assert_eq!(
            failing.runs.borrow()[0].args.last(),
            Some(&OsString::from("--takedown"))
        );
        let runs = working.runs.borrow();
        assert_eq!(runs[0].args.last(), Some(&OsString::from("--takedown")));
        assert_eq!(runs[1].args.last(), Some(&OsString::from("/data/files")));
        assert!(first.report.takedown && kept);
        assert!(first.report.warnings.contains(&TAKEDOWN_WAITS.to_owned()));
        assert!(second.report.takedown && !pending.pending());
        assert!(!third.report.takedown);
    }

    #[test]
    fn writes_the_report_of_a_start_and_the_last_report_of_the_shared_cases() {
        let all = cases();
        for case in all["started"].as_array().expect("the starts") {
            assert_eq!(
                started_text(kind_of(&case["kind"])),
                case["text"].as_str().expect("a text"),
                "{}",
                case["name"]
            );
        }
        for case in all["last"].as_array().expect("the last reports") {
            assert_eq!(
                last_text(
                    case["stored"].as_str(),
                    case["running"].as_bool().expect("running"),
                    case["takedownWaits"].as_bool().expect("takedownWaits")
                ),
                case["text"].as_str().expect("a text"),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn says_in_the_record_that_it_runs_then_keeps_its_report() {
        let child = Fake {
            runs: RefCell::new(Vec::new()),
            answer: Ok((Some(0), LINE)),
        };
        let files = marker(false);

        let deployment = run_deploy(&child, &files, &settings(), PUSHED, false);

        assert_eq!(*files.1.borrow(), vec![true, false]);
        assert_eq!(*files.2.borrow(), vec![deployment_text(&deployment.report)]);
    }
}
