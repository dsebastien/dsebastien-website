//! Command line program of the publishing tool of the notes website.
//!
//! It is one of the two implementations of the publishing logic (ADR 0009).
//! The other one is in the Obsidian plugin (`apps/plugin`). For the same
//! input, both write the same bytes in the canonical form
//! (`documentation/Canonical Form.md`).

mod attachments;
mod canonical;
mod clean;
mod configuration;
mod device;
mod edits;
mod frontmatter;
mod guards;
mod hash;
mod images;
mod json;
mod links;
mod manifest;
mod mcp;
mod names;
mod note_types;
mod order;
mod plan;
mod queue;
mod renames;
mod small_letters;
mod tool;

use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Args, Parser, Subcommand};

use device::{AttachmentStorage, ContentStore, Vault};
use plan::Selection;
use queue::Move;
use tool::{Device, Outcome, Run};

#[derive(Parser)]
#[command(version, about, arg_required_else_help = true)]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

/// The two places of a publication on this device.
#[derive(Args)]
struct Places {
    /// The folder of the vault.
    #[arg(long)]
    vault: PathBuf,

    /// The folder of the copy of the content store on this device: a git
    /// clone whose `origin` is the content store.
    #[arg(long)]
    content_store: PathBuf,

    /// The command line program of the Obsidian Starter Kit, which gives the
    /// note type of each note (`osk-cli recognize`). The default is the
    /// program that the plugin installs in the vault:
    /// `.obsidian/plugins/obsidian-starter-kit-plugin/osk-cli`
    /// (`osk-cli-windows-x64.exe` on Windows).
    #[arg(long, value_name = "PROGRAM")]
    osk_cli: Option<PathBuf>,

    /// The folder of the rename journals that the plugin writes in the vault
    /// (one file per device). The default is
    /// `.obsidian/plugins/dsebastien-vault-publish/renames` in the vault.
    #[arg(long, value_name = "FOLDER")]
    renames: Option<PathBuf>,
}

/// The options of an edit of the guards (R69).
#[derive(Args)]
struct EditArguments {
    #[command(flatten)]
    places: Places,

    /// The folder (deny, allow) or the vault path of the note (ignore,
    /// unignore), exactly as the vault names it.
    #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
    path: String,

    /// The time of the run, in UTC and to the second, for example
    /// 2031-04-01T08:00:00Z. The default is the time of the clock.
    #[arg(long)]
    time: Option<String>,

    /// The name of this device, for the log and the message of the commit.
    /// The default is the name of the host.
    #[arg(long, value_name = "NAME")]
    device: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Writes the publication queue: the new, the changed and the unchanged
    /// notes, and the notes to remove, with a count per list; the technical
    /// updates; the notes to remove that are only missing from this vault; and
    /// the unpublished notes that a guard excludes, which the next publication
    /// removes; the moves of the rename journals that the next publication
    /// applies (`renamed`), the moved notes whose text is not the published
    /// text, whose update waits for `--include` (`movedEdited`), and the
    /// pairings to confirm (`pairings`). It changes nothing in the vault and
    /// in the content store.
    Status {
        #[command(flatten)]
        places: Places,
    },

    /// Computes a publication plan, stores it on this device and writes it
    /// with its id. It changes nothing in the vault and in the content store.
    /// Without a path, the plan holds the changed notes only, but not the moved
    /// notes whose text changed: `--include` names them. Every plan holds
    /// the moves of the rename journals, which cannot be held, and the forced
    /// removals: the published and the unpublished notes that a guard
    /// excludes.
    Plan {
        #[command(flatten)]
        places: Places,

        /// The vault path of a note to publish. A note that was never
        /// published enters a plan only in this way. Give the option one time
        /// per note.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        include: Vec<String>,

        /// The vault path of a changed note to leave out: its live version
        /// stays. Give the option one time per note.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        hold: Vec<String>,

        /// The vault path of a published note to unpublish. Give the option
        /// one time per note.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        remove: Vec<String>,

        /// A pairing to confirm: the vault path of a published note that is
        /// missing from this vault, then the path of the candidate that is
        /// that note now (a rename that the plugin did not see). The entry
        /// moves, its old path becomes a former path that redirects, and the
        /// candidate is published as its update unless `--hold` names it.
        /// Give the option one time per pairing.
        #[arg(long, num_args = 2, value_names = ["FROM", "TO"], allow_hyphen_values = true)]
        pair: Vec<String>,

        /// A JSON file with the selection, in the place of the four options
        /// above: an object with the lists `include`, `hold` and `remove` of
        /// paths and `pair` of objects with `from` and `to`, each one
        /// optional. A large publication holds more paths than the system
        /// takes as arguments of one command.
        #[arg(long, value_name = "FILE", conflicts_with_all = ["include", "hold", "remove", "pair"])]
        selection: Option<PathBuf>,
    },

    /// Applies exactly one plan, by its id: the moves of the rename journals
    /// and of the pairings come first (the published version moves as it is,
    /// and `renames.json` counts the lines that were read), then the published
    /// and the unpublished notes that a guard excludes leave the content
    /// store, the cleaned notes and the
    /// manifest go to the content store in one commit after the upload of
    /// their attachments, the commit is pushed, the `public_note` property of
    /// the notes of the vault is corrected, and the files of the attachment
    /// storage that no published note uses are deleted.
    /// It writes the publication report. It ends with an error when a note of
    /// the plan was left out, and it publishes nothing when a forced removal
    /// fails.
    Publish {
        #[command(flatten)]
        places: Places,

        /// The folder of the attachment storage. The publication uploads the
        /// attachments of its notes to it, and deletes every file that no
        /// published note uses.
        #[arg(long, value_name = "FOLDER")]
        attachment_storage: PathBuf,

        /// The id that the `plan` command gave.
        #[arg(long, value_name = "ID")]
        plan: String,

        /// The time of the run, in UTC and to the second, for example
        /// 2031-04-01T08:00:00Z. The default is the time of the clock.
        #[arg(long)]
        time: Option<String>,

        /// The name of this device, for the message of the commit. The
        /// default is the name of the host.
        #[arg(long, value_name = "NAME")]
        device: Option<String>,
    },

    /// Unpublishes the named published notes in one step: it makes the plan
    /// that removes them and holds every other changed note, and applies it
    /// as `publish` does. Only the named notes leave, with the forced
    /// removals that every plan holds. Their addresses then answer 410. It
    /// writes the publication report.
    Unpublish {
        #[command(flatten)]
        places: Places,

        /// The folder of the attachment storage. The publication deletes
        /// every file that no published note uses.
        #[arg(long, value_name = "FOLDER")]
        attachment_storage: PathBuf,

        /// The vault path of a published note to unpublish. Give the option
        /// one time per note.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        path: Vec<String>,

        /// The time of the run, in UTC and to the second, for example
        /// 2031-04-01T08:00:00Z. The default is the time of the clock.
        #[arg(long)]
        time: Option<String>,

        /// The name of this device, for the message of the commit. The
        /// default is the name of the host.
        #[arg(long, value_name = "NAME")]
        device: Option<String>,
    },

    /// Takes the named notes down at once, with no plan: each note leaves the
    /// content store with its manifest entry and its former paths, in one
    /// commit that is pushed, so its addresses answer 404 after the next
    /// build. Then the files of the attachment storage that no published note
    /// uses are deleted, and the `public_note` property leaves the notes. A
    /// published or an unpublished note can be taken down. A stale plan, a
    /// failed publication and a missing Starter Kit do not stop it. Copies in
    /// browser caches and at crawlers cannot be recalled, and the text stays
    /// in the history of the content store. It writes the takedown report,
    /// and ends with an error after it when the attachment storage gave a
    /// warning: a file that stays there can still be public. Each takedown
    /// first deletes the files of the storage that no published note uses.
    Takedown {
        /// The folder of the vault. The takedown reads only the named notes
        /// in it, to remove their `public_note` property: on a device with
        /// no copy of the vault, an empty folder works.
        #[arg(long)]
        vault: PathBuf,

        /// The folder of the copy of the content store on this device: a git
        /// clone whose `origin` is the content store.
        #[arg(long)]
        content_store: PathBuf,

        /// The folder of the attachment storage.
        #[arg(long, value_name = "FOLDER")]
        attachment_storage: PathBuf,

        /// The vault path of a note to take down, exactly as the manifest
        /// names it (letter case, Unicode form, the end `.md`). A path that
        /// the manifest does not name stops the whole takedown, and the
        /// message names the paths of the manifest that it is close to. Give
        /// the option one time per note.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        path: Vec<String>,

        /// The time of the run, in UTC and to the second, for example
        /// 2031-04-01T08:00:00Z. The default is the time of the clock.
        #[arg(long)]
        time: Option<String>,

        /// The name of this device, for the message of the commit. The
        /// default is the name of the host.
        #[arg(long, value_name = "NAME")]
        device: Option<String>,
    },

    /// Writes the guards: the deny list (`denyList`), the open proposals that
    /// wait for the author (`proposals`), and the edits of the guards since
    /// the last publication (`edits`). It reads no network, and it also works
    /// when a deny list entry names no folder, which stops every
    /// publication. It changes nothing.
    Guards {
        /// The folder of the vault.
        #[arg(long)]
        vault: PathBuf,

        /// The folder of the copy of the content store on this device.
        #[arg(long)]
        content_store: PathBuf,
    },

    /// Adds a folder to the deny list: no note of the folder can be
    /// published. It applies at once when it takes no manifest entry away, as
    /// the next publication counts it (with the moves of the rename journals
    /// and the names of the notes that are missing from this vault), and puts
    /// no attachment of a published note under the guard. Else it is a
    /// proposal, with the entries that would leave the content store
    /// (`removes`) and the published notes that would lose an attachment
    /// (`affects`), which only the author confirms, in the view of the
    /// plugin. The edit is logged in `edits.json` of the content store, in
    /// one commit that is pushed. It writes the event (`edit`).
    Deny {
        #[command(flatten)]
        edit: EditArguments,
    },

    /// Proposes to remove a folder from the deny list. It never applies at
    /// once: only the author confirms it, in the view of the plugin. The
    /// proposal is logged in `edits.json` of the content store, in one commit
    /// that is pushed. It writes the event (`edit`).
    Allow {
        #[command(flatten)]
        edit: EditArguments,
    },

    /// Sets the `publish_ignore` property of a note: the note can never be
    /// published. It applies at once, with the property written into the
    /// note, when it takes no manifest entry away, as the next publication
    /// counts it (with the moves of the rename journals). Else it is a
    /// proposal, with the entries that would leave the content store
    /// (`removes`), which only the author confirms, in the view of the
    /// plugin. The edit is
    /// logged in `edits.json` of the content store, in one commit that is
    /// pushed. It writes the event (`edit`).
    Ignore {
        #[command(flatten)]
        edit: EditArguments,
    },

    /// Proposes to remove the `publish_ignore` property of a note. It never
    /// applies at once: only the author confirms it, in the view of the
    /// plugin. The proposal is logged in `edits.json` of the content store, in
    /// one commit that is pushed. It writes the event (`edit`).
    Unignore {
        #[command(flatten)]
        edit: EditArguments,
    },

    /// Serves the MCP server of the tool over the standard input and output,
    /// one message of JSON per line, until the input ends (TOOL-03). Its tools
    /// are the commands of this program, with the same output: status, plan,
    /// publish, unpublish, takedown, guards, deny, allow, ignore, unignore
    /// and unlock. The places of this device are
    /// given here, one time. A run takes the time of the clock and the name
    /// of the device, and its face is "mcp-server". Errors of the program go
    /// to the error output.
    Mcp {
        #[command(flatten)]
        places: Places,

        /// The folder of the attachment storage, for the tools publish,
        /// unpublish and takedown.
        #[arg(long, value_name = "FOLDER")]
        attachment_storage: PathBuf,

        /// The name of this device, for the message of the commit. The
        /// default is the name of the host.
        #[arg(long, value_name = "NAME")]
        device: Option<String>,
    },

    /// Removes the lock of this device that a publication left when it
    /// stopped halfway (a crash, a power cut). Run it only when no
    /// publication runs. The next plan, publish or takedown puts the copy of the
    /// content store back. It writes whether a lock was there.
    Unlock {
        /// The folder of the copy of the content store on this device.
        #[arg(long)]
        content_store: PathBuf,
    },
}

fn device(places: &Places) -> Result<Device, String> {
    device_of(
        &places.vault,
        &places.content_store,
        places.osk_cli.as_deref(),
        places.renames.as_deref(),
    )
}

/// The device of a vault and a copy of the content store. A takedown asks no
/// Starter Kit: it gets the default program, which it never runs.
fn device_of(
    vault: &Path,
    content_store: &Path,
    osk_cli: Option<&Path>,
    renames: Option<&Path>,
) -> Result<Device, String> {
    for (name, folder) in [("vault", vault), ("content store", content_store)] {
        if !folder.is_dir() {
            return Err(format!("the {name} is not a folder: {}", folder.display()));
        }
    }
    let program = osk_cli.map_or_else(|| note_types::default_program(vault), Path::to_path_buf);
    let renames = renames.map_or_else(
        || vault.join(".obsidian").join(renames::JOURNAL_FOLDER),
        Path::to_path_buf,
    );
    Ok(Device {
        vault: Vault::new(vault),
        store: ContentStore::new(content_store),
        renames: renames::RenameJournals::new(renames),
        note_types: note_types::StarterKit::new(&program, vault),
    })
}

/// The attachment storage. It is not checked here: a publication with no
/// upload never needs it, and a takedown only deletes from it after its push.
/// A note whose upload fails is left out and reported.
fn storage(folder: &Path) -> AttachmentStorage {
    AttachmentStorage::new(folder)
}

/// The time of the clock in the canonical form: UTC, cut to the second. The
/// program reads the clock here, one time. The logic never does.
///
/// A switch of the debug build for the tests of the MCP server, which takes
/// no time of its own: `DSEBASTIEN_VAULT_PUBLISH_TEST_TIME` gives the time of
/// every run. The release build has no switch.
fn now() -> String {
    #[cfg(debug_assertions)]
    if let Ok(time) = std::env::var("DSEBASTIEN_VAULT_PUBLISH_TEST_TIME") {
        return time;
    }
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    // The date of a number of days after 1970-01-01 (the algorithm of Howard
    // Hinnant for the civil calendar).
    let shifted = days + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// The name of the host: the default name of the device. The program reads it
/// here. The logic never does.
fn host_name() -> String {
    let from_file = || {
        std::fs::read_to_string("/etc/hostname")
            .ok()
            .map(|name| name.trim().to_owned())
    };
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .or_else(from_file)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown device".to_owned())
}

/// Reads a selection from a JSON file: an object with the lists `include`,
/// `hold` and `remove` of vault paths, each one optional.
fn selection_from_file(file: &Path) -> Result<Selection, String> {
    let wrong = || {
        format!(
            "the selection file {} must be an object with the lists \"include\", \"hold\" and \"remove\" of vault paths, and \"pair\" of objects with \"from\" and \"to\"",
            file.display()
        )
    };
    let text = std::fs::read_to_string(file).map_err(|error| {
        format!(
            "the selection file {} cannot be read: {error}",
            file.display()
        )
    })?;
    let value = json::parse_json(&text).map_err(|_| wrong())?;
    let object = value.as_object().ok_or_else(wrong)?;
    if object
        .keys()
        .any(|key| !["include", "hold", "pair", "remove"].contains(&key.as_str()))
    {
        return Err(wrong());
    }
    let list = |key: &str| -> Result<Vec<String>, String> {
        match object.get(key) {
            None => Ok(Vec::new()),
            Some(list) => list
                .as_array()
                .ok_or_else(wrong)?
                .iter()
                .map(|path| path.as_str().map(str::to_owned).ok_or_else(wrong))
                .collect(),
        }
    };
    let pair = match object.get("pair") {
        None => Vec::new(),
        Some(list) => list
            .as_array()
            .ok_or_else(wrong)?
            .iter()
            .map(|item| Move::of(item).ok_or_else(wrong))
            .collect::<Result<Vec<Move>, String>>()?,
    };
    Ok(Selection::new(
        &list("include")?,
        &list("hold")?,
        &list("remove")?,
        &pair,
    ))
}

/// The pairings of the option `--pair`: its values two by two.
fn pairings_of(values: &[String]) -> Vec<Move> {
    values
        .as_chunks::<2>()
        .0
        .iter()
        .map(|[from, to]| Move {
            from: from.clone(),
            to: to.clone(),
        })
        .collect()
}

/// `status` reads no network: it warns on the error output when the copy is
/// behind the content store at the last fetch (issue 70).
fn warn_when_behind(queue: &str) {
    let behind = json::parse_json(queue)
        .ok()
        .and_then(|queue| queue.get("behind").and_then(serde_json::Value::as_u64))
        .unwrap_or(0);
    if behind > 0 {
        eprintln!(
            "warning: the copy of the content store is {behind} commit(s) behind the content store at the last fetch. Pull before a publication (git pull --ff-only origin main)"
        );
    }
}

/// A plan without a network uses the last fetch (PERF-16): it says so on the
/// error output too.
fn warn_when_offline(plan: &str) {
    let offline = json::parse_json(plan)
        .ok()
        .and_then(|plan| plan.get("offline").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);
    if offline {
        eprintln!(
            "warning: the content store cannot be reached, so the plan uses the last fetch: the copy may be behind. The publication fetches first"
        );
    }
}

/// Runs the call of a tool of the MCP server, as the command of the same name
/// does.
fn operate(
    device: &Device,
    attachment_storage: &AttachmentStorage,
    name: &str,
    call: &mcp::Call,
) -> Result<Outcome, String> {
    let done = |output: String| Outcome {
        output,
        failure: None,
    };
    let time = now();
    let run = Run {
        time: &time,
        device: name,
        face: "mcp-server",
    };
    match call {
        mcp::Call::Status => tool::status(device).map(done),
        mcp::Call::Plan {
            include,
            hold,
            remove,
            pair,
        } => tool::plan(device, &Selection::new(include, hold, remove, pair)).map(done),
        mcp::Call::Publish { plan } => tool::publish(device, attachment_storage, plan, &run),
        mcp::Call::Unpublish { paths } => tool::unpublish(device, attachment_storage, paths, &run),
        mcp::Call::Takedown { paths } => tool::takedown(device, attachment_storage, paths, &run),
        mcp::Call::Guards => tool::guards(device).map(done),
        mcp::Call::Edit { action, path } => tool::edit(device, action, path, &run).map(done),
        mcp::Call::Unlock => tool::unlock(&device.store).map(done),
    }
}

/// Serves the MCP server over the standard input and output (`mcp`).
fn serve(places: &Places, attachment_storage: &Path, name: Option<String>) -> Result<(), String> {
    // The places are checked at the start, so a wrong folder stops the
    // program before the first message.
    device(places)?;
    let storage = storage(attachment_storage);
    let name = name.unwrap_or_else(host_name);
    let info = mcp::Info {
        name: mcp::SERVER_NAME,
        version: env!("CARGO_PKG_VERSION"),
    };
    // A new device for each call: a device keeps the listing of each folder
    // of the vault for one run, and one call is one run, as one command is.
    let mut operations = |call: &mcp::Call| operate(&device(places)?, &storage, &name, call);
    mcp::serve(
        io::stdin().lock(),
        io::stdout().lock(),
        &info,
        &mut operations,
    )
    .map_err(|error| error.to_string())
}

/// Runs an edit of the guards from the command line.
fn run_edit(action: &str, edit: EditArguments) -> Result<Outcome, String> {
    let output = tool::edit(
        &device(&edit.places)?,
        action,
        &edit.path,
        &Run {
            time: &edit.time.unwrap_or_else(now),
            device: &edit.device.unwrap_or_else(host_name),
            face: "command-line",
        },
    )?;
    Ok(Outcome {
        output,
        failure: None,
    })
}

fn run(command: Command) -> Result<Outcome, String> {
    let done = |output: String| Outcome {
        output,
        failure: None,
    };
    match command {
        Command::Status { places } => {
            let output = tool::status(&device(&places)?)?;
            warn_when_behind(&output);
            Ok(done(output))
        }
        Command::Plan {
            places,
            include,
            hold,
            remove,
            pair,
            selection,
        } => {
            let selection = match selection {
                Some(file) => selection_from_file(&file)?,
                None => Selection::new(&include, &hold, &remove, &pairings_of(&pair)),
            };
            let output = tool::plan(&device(&places)?, &selection)?;
            warn_when_offline(&output);
            Ok(done(output))
        }
        Command::Unpublish {
            places,
            attachment_storage,
            path,
            time,
            device: name,
        } => tool::unpublish(
            &device(&places)?,
            &storage(&attachment_storage),
            &path,
            &Run {
                time: &time.unwrap_or_else(now),
                device: &name.unwrap_or_else(host_name),
                face: "command-line",
            },
        ),
        Command::Takedown {
            vault,
            content_store,
            attachment_storage,
            path,
            time,
            device: name,
        } => tool::takedown(
            &device_of(&vault, &content_store, None, None)?,
            &storage(&attachment_storage),
            &path,
            &Run {
                time: &time.unwrap_or_else(now),
                device: &name.unwrap_or_else(host_name),
                face: "command-line",
            },
        ),
        Command::Guards {
            vault,
            content_store,
        } => tool::guards(&device_of(&vault, &content_store, None, None)?).map(done),
        Command::Deny { edit } => run_edit("deny", edit),
        Command::Allow { edit } => run_edit("allow", edit),
        Command::Ignore { edit } => run_edit("ignore", edit),
        Command::Unignore { edit } => run_edit("unignore", edit),
        Command::Mcp {
            places,
            attachment_storage,
            device: name,
        } => serve(&places, &attachment_storage, name).map(|()| done(String::new())),
        Command::Unlock { content_store } => {
            if !content_store.is_dir() {
                return Err(format!(
                    "the content store is not a folder: {}",
                    content_store.display()
                ));
            }
            tool::unlock(&ContentStore::new(&content_store)).map(done)
        }
        Command::Publish {
            places,
            attachment_storage,
            plan,
            time,
            device: name,
        } => tool::publish(
            &device(&places)?,
            &storage(&attachment_storage),
            &plan,
            &Run {
                time: &time.unwrap_or_else(now),
                device: &name.unwrap_or_else(host_name),
                face: "command-line",
            },
        ),
    }
}

/// Writes the output of a command to the standard output.
///
/// A reader that closed the pipe has what it wanted (`plan | head`): that is
/// not an error. Every other failure of the write is one, for example a full
/// disk behind a redirection.
fn write_output(output: &str) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    match stdout
        .write_all(output.as_bytes())
        .and_then(|()| stdout.flush())
    {
        Err(error) if error.kind() == ErrorKind::BrokenPipe => Ok(()),
        result => result,
    }
}

fn main() -> ExitCode {
    let written = run(Arguments::parse().command).and_then(|outcome| {
        write_output(&outcome.output).map_err(|error| error.to_string())?;
        // The report is written. The exit code says that it names a failure.
        outcome.failure.map_or(Ok(()), Err)
    });
    match written {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_tools_of_the_mcp_server_are_the_other_commands() {
        // TEST-17: what the MCP server can do, the program can do, and the
        // reverse. The TypeScript face checks its tools against the same file.
        let mut commands: Vec<String> = Arguments::command()
            .get_subcommands()
            .map(|command| command.get_name().to_owned())
            .filter(|name| name != "mcp")
            .collect();
        commands.sort_unstable();
        let mut tools = mcp::TOOL_NAMES.to_vec();
        tools.sort_unstable();
        assert_eq!(commands, tools);
    }
}
