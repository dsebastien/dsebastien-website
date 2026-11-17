//! Command line program of the publishing tool of the notes website.
//!
//! It is one of the two implementations of the publishing logic (ADR 0009).
//! The other one is in the Obsidian plugin (`apps/plugin`). For the same
//! input, both write the same bytes in the canonical form
//! (`documentation/Canonical Form.md`).

mod canonical;
mod order;
mod plan;

use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(version, about, arg_required_else_help = true)]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Computes a publication plan and writes it in the canonical form. It
    /// changes nothing in the vault and in the content store.
    Plan {
        /// The folder of the vault.
        #[arg(long)]
        vault: PathBuf,
    },
}

fn plan(vault: &Path) -> Result<String, Box<dyn Error>> {
    if !vault.is_dir() {
        return Err(format!("the vault is not a folder: {}", vault.display()).into());
    }
    let plan = serde_json::to_value(plan::compute_plan())?;
    Ok(canonical::to_canonical_json(&plan)?)
}

fn main() -> ExitCode {
    let result = match Arguments::parse().command {
        Command::Plan { vault } => plan(&vault),
    };
    match result {
        Ok(output) => {
            print!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
