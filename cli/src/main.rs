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
mod frontmatter;
mod guards;
mod hash;
mod images;
mod json;
mod links;
mod manifest;
mod order;
mod plan;
mod queue;
mod tool;

use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Args, Parser, Subcommand};

use device::{AttachmentStorage, ContentStore, Vault};
use plan::Selection;
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
}

#[derive(Subcommand)]
enum Command {
    /// Writes the publication queue: the new, the changed and the unchanged
    /// notes, and the notes to remove, with a count per list. It changes
    /// nothing in the vault and in the content store.
    Status {
        #[command(flatten)]
        places: Places,
    },

    /// Computes a publication plan, stores it on this device and writes it
    /// with its id. It changes nothing in the vault and in the content store.
    /// Without a path, the plan holds the changed notes only. Every plan holds
    /// the forced removals: the published notes that a guard excludes.
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

        /// A JSON file with the selection, in the place of the three options
        /// above: an object with the lists `include`, `hold` and `remove`,
        /// each one optional. A large publication holds more paths than the
        /// system takes as arguments of one command.
        #[arg(long, value_name = "FILE", conflicts_with_all = ["include", "hold", "remove"])]
        selection: Option<PathBuf>,
    },

    /// Applies exactly one plan, by its id: the published notes that a guard
    /// excludes leave the content store first, the cleaned notes and the
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

    /// Removes the lock of this device that a publication left when it
    /// stopped halfway (a crash, a power cut). Run it only when no
    /// publication runs. The next plan or publish puts the copy of the
    /// content store back. It writes whether a lock was there.
    Unlock {
        /// The folder of the copy of the content store on this device.
        #[arg(long)]
        content_store: PathBuf,
    },
}

fn device(places: &Places) -> Result<Device, String> {
    for (name, folder) in [
        ("vault", &places.vault),
        ("content store", &places.content_store),
    ] {
        if !folder.is_dir() {
            return Err(format!("the {name} is not a folder: {}", folder.display()));
        }
    }
    Ok(Device {
        vault: Vault::new(&places.vault),
        store: ContentStore::new(&places.content_store),
    })
}

/// The attachment storage. It is not checked here: a publication with no
/// upload, a takedown for example, never needs it. A note whose upload fails
/// is left out and reported.
fn storage(folder: &Path) -> AttachmentStorage {
    AttachmentStorage::new(folder)
}

/// The time of the clock in the canonical form: UTC, cut to the second. The
/// program reads the clock here, one time. The logic never does.
fn now() -> String {
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
            "the selection file {} must be an object with the lists \"include\", \"hold\" and \"remove\" of vault paths",
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
        .any(|key| !["include", "hold", "remove"].contains(&key.as_str()))
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
    Ok(Selection::new(
        &list("include")?,
        &list("hold")?,
        &list("remove")?,
    ))
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

fn run(command: Command) -> Result<Outcome, String> {
    let done = |output: String| Outcome { output, failed: 0 };
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
            selection,
        } => {
            let selection = match selection {
                Some(file) => selection_from_file(&file)?,
                None => Selection::new(&include, &hold, &remove),
            };
            let output = tool::plan(&device(&places)?, &selection)?;
            warn_when_offline(&output);
            Ok(done(output))
        }
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
        match outcome.failed {
            0 => Ok(()),
            1 => Err("1 note of the plan was left out: the report says why".to_owned()),
            count => Err(format!(
                "{count} notes of the plan were left out: the report says why"
            )),
        }
    });
    match written {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
