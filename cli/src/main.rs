//! Command line program of the publishing tool of the notes website.
//!
//! It is one of the two implementations of the publishing logic (ADR 0009).
//! The other one is in the Obsidian plugin (`apps/plugin`). For the same
//! input, both write the same bytes in the canonical form
//! (`documentation/Canonical Form.md`).

mod canonical;
mod clean;
mod configuration;
mod device;
mod frontmatter;
mod guards;
mod hash;
mod manifest;
mod order;
mod plan;
mod tool;

use std::io::{self, ErrorKind, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Args, Parser, Subcommand};

use device::{ContentStore, Vault};
use tool::Device;

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
    /// Computes a publication plan, stores it on this device and writes it
    /// with its id. It changes nothing in the vault and in the content store.
    Plan {
        #[command(flatten)]
        places: Places,

        /// The vault path of a note to publish. Give the option one time per
        /// note.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        include: Vec<String>,
    },

    /// Applies exactly one plan, by its id: the cleaned notes and the manifest
    /// go to the content store in one commit, the commit is pushed, and the
    /// `public_note` property of the published notes is corrected.
    Publish {
        #[command(flatten)]
        places: Places,

        /// The id that the `plan` command gave.
        #[arg(long, value_name = "ID")]
        plan: String,

        /// The time of the run, in UTC and to the second, for example
        /// 2031-04-01T08:00:00Z. The default is the time of the clock.
        #[arg(long)]
        time: Option<String>,
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

fn run(command: Command) -> Result<String, String> {
    match command {
        Command::Plan { places, include } => tool::plan(&device(&places)?, &include),
        Command::Publish { places, plan, time } => {
            tool::publish(&device(&places)?, &plan, &time.unwrap_or_else(now))
        }
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
    let written = run(Arguments::parse().command)
        .and_then(|output| write_output(&output).map_err(|error| error.to_string()));
    match written {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
