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
mod deploy;
mod deploying;
mod device;
mod edits;
mod frontmatter;
mod frozen;
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
mod originals;
mod plan;
mod queue;
mod renames;
mod seal;
mod small_letters;
mod tool;
mod withdrawn;

use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Args, Parser, Subcommand};

use deploy::{DeployKind, DeploySettings, deployment_text, started_text};
use deploying::{Background, Deploy, last_of, pushing, run_deploy, takedown_waits};
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

/// The folders of a publication on this device.
#[derive(Args)]
struct Folders {
    /// The folder of the vault.
    #[arg(long)]
    vault: PathBuf,

    /// The folder of the copy of the content store on this device: a git
    /// clone whose `origin` is the content store.
    #[arg(long)]
    content_store: PathBuf,

    /// The folder of the rename journals that the plugin writes in the vault
    /// (one file per device). By default, the folder
    /// `plugins/dsebastien-vault-publish/renames` of every configuration
    /// folder of the vault (each folder at its root whose name starts with a
    /// dot).
    #[arg(long, value_name = "FOLDER")]
    renames: Option<PathBuf>,
}

/// The places of a publication on this device: its folders and the program
/// of the Starter Kit.
#[derive(Args)]
struct Places {
    #[command(flatten)]
    folders: Folders,

    /// The command line program of the Obsidian Starter Kit, which gives the
    /// note type of each note (`osk-cli recognize`). The default is the
    /// program that the plugin installs in the vault:
    /// `.obsidian/plugins/obsidian-starter-kit-plugin/osk-cli`
    /// (`osk-cli-windows-x64.exe` on Windows).
    #[arg(long, value_name = "PROGRAM")]
    osk_cli: Option<PathBuf>,
}

/// The settings of the deploy of the site after a push, on this device
/// (issue 32, BUILD-02, PUB-42). Without the folder of the site code or the
/// target file, nothing is deployed, and the deploy report says which one is
/// missing.
#[derive(Args)]
struct DeployPlaces {
    /// The folder of a clean clone of the repository of the site, on its
    /// branch main, used only for deploys. The deploy runs
    /// `bun run deploy --from-main` there, which pulls it first. Use the same
    /// clone as the plugin of this machine: the lock of the deploys is in it.
    #[arg(long, value_name = "FOLDER")]
    site_code: Option<PathBuf>,

    /// The private target file of the deployment (the names of the host).
    #[arg(long, value_name = "FILE")]
    deploy_target: Option<PathBuf>,

    /// The private env file with the token of the deployment, which bun reads
    /// (`bun --env-file=<file>`). Without it, the token comes from the
    /// environment.
    #[arg(long, value_name = "FILE")]
    deploy_env_file: Option<PathBuf>,

    /// The bun program. The default is `bun` of the path of the system.
    #[arg(long, value_name = "PROGRAM")]
    bun: Option<PathBuf>,

    /// The time limit of the deploy, in minutes: after it, the deploy stops
    /// with the programs that it started, and fails. From 1 to 1440 (24
    /// hours); the default is 30.
    #[arg(long, value_name = "MINUTES")]
    deploy_timeout: Option<u64>,
}

/// The deploy after the push of a publication, an unpublish or a takedown.
#[derive(Args)]
struct DeployAfterPush {
    #[command(flatten)]
    places: DeployPlaces,

    /// Pushes with no deploy: the deploy report is not written. The command
    /// `deploy` deploys later.
    #[arg(long)]
    no_deploy: bool,
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

        /// The vault path of a forced removal, or of a published note that
        /// would lose a file under a guard (guardedAttachments), that the
        /// author named: a publication of the command line program or of the
        /// MCP server applies a plan only when accept names every such path
        /// of the plan. It changes nothing in the plan. Give the option one
        /// time per note.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        accept: Vec<String>,

        /// A JSON file with the selection, in the place of the four options
        /// above: an object with the lists `include`, `hold` and `remove` of
        /// paths and `pair` of objects with `from` and `to`, each one
        /// optional. A large publication holds more paths than the system
        /// takes as arguments of one command.
        #[arg(long, value_name = "FILE", conflicts_with_all = ["include", "hold", "remove", "pair", "accept"])]
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
    /// fails. After the push, it deploys the site and writes the deploy
    /// report after the publication report; a failed deploy never changes
    /// the exit code.
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

        #[command(flatten)]
        deploy: DeployAfterPush,

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
    /// writes the publication report, then deploys the site and writes the
    /// deploy report.
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

        /// The vault path of a forced removal, or of a published note that
        /// would lose a file under a guard, that the author named: the
        /// unpublish applies its plan only when accept names every such path.
        /// Give the option one time per note.
        #[arg(long, value_name = "PATH", allow_hyphen_values = true)]
        accept: Vec<String>,

        #[command(flatten)]
        deploy: DeployAfterPush,

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
    /// After the push, it deploys the site with `--takedown` and writes the
    /// deploy report. In the vault, it reads only the named notes, to remove
    /// their `public_note` property (on a device with no copy of the vault,
    /// an empty folder works), and the rename journals, to name the old path
    /// of a note whose move waits for a publication when it refuses a path.
    Takedown {
        #[command(flatten)]
        folders: Folders,

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

        /// The deploy after the takedown runs with `--takedown`: it deletes
        /// the files of the takedown from the object storage, also when the
        /// build or the deploy fails.
        #[command(flatten)]
        deploy: DeployAfterPush,
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
    /// publish, unpublish, takedown, guards, deny, allow, ignore, unignore,
    /// confirm-state (as `confirm_store_state`) and unlock. The places of this
    /// device are
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

        /// The deploy after the push of the tools publish, unpublish and
        /// takedown, whose deploy report comes as the last text of their
        /// result, and of the tool deploy.
        #[command(flatten)]
        deploy: DeployAfterPush,

        /// The name of this device, for the message of the commit. The
        /// default is the name of the host.
        #[arg(long, value_name = "NAME")]
        device: Option<String>,
    },

    /// Runs the deploy of the site again, with no publication, for example
    /// after a deploy that failed (issue 32). With no option, it runs with
    /// `--takedown` while a takedown of this device waits for a deploy that
    /// succeeds (`.git/vault-publish/takedowns/` of the copy): `bun run deploy --from-main` in
    /// the folder of the site code, from the copy of the content store and
    /// the attachment storage. It writes the deploy report (the object
    /// `deployment`), and ends with an error when the deploy did not succeed.
    /// The whole output of the deploy is in `.git/vault-publish/deploy.log` of
    /// the copy, for the author only.
    Deploy {
        /// The folder of the copy of the content store on this device.
        #[arg(long)]
        content_store: PathBuf,

        /// The folder of the attachment storage.
        #[arg(long, value_name = "FOLDER")]
        attachment_storage: PathBuf,

        #[command(flatten)]
        places: DeployPlaces,

        /// Runs the deploy with `--takedown`: it deletes the files of the
        /// notes taken down from the object storage. A deploy runs with
        /// `--takedown` anyway while a takedown of this device waits for a
        /// deploy that succeeds (an entry in `.git/vault-publish/takedowns/`
        /// of the copy).
        #[arg(long, conflicts_with = "last")]
        takedown: bool,

        /// Starts no deploy: writes the last deploy report of this device
        /// (`deployment`, from `.git/vault-publish/deploy-report.json` of the
        /// copy, absent when there is none) and whether a deploy runs
        /// (`running`).
        #[arg(long)]
        last: bool,
    },

    /// Confirms the state of the content store (R104). The tool trusts only
    /// the state that a commit of the tool sealed: after a commit that no tool
    /// wrote (a push of someone else, an edit by hand), a run stops and says
    /// what differs. When you made or accept every change, confirm the last
    /// commit that the message names. It takes the lock of the device, stops
    /// when the copy is behind the content store or when its last commit is
    /// not `--head`, and writes one sealed commit with no change of a file,
    /// which it pushes. It writes `confirmed` and the `difference` that it
    /// confirmed; with a state that is already sealed, it writes nothing and
    /// `confirmed` is false.
    ConfirmState {
        #[command(flatten)]
        folders: Folders,

        /// The last commit of the copy, as the difference names it: the 40 or
        /// 64 small hexadecimal digits of a commit.
        #[arg(long, value_name = "COMMIT")]
        head: String,

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
    /// publication runs. The next plan, publish or takedown puts the copy of the
    /// content store back. It writes whether a lock was there.
    Unlock {
        /// The folder of the copy of the content store on this device.
        #[arg(long)]
        content_store: PathBuf,
    },
}

fn device(places: &Places) -> Result<Device, String> {
    device_of(&places.folders, places.osk_cli.as_deref())
}

/// The device of the folders of a publication. A takedown asks no Starter
/// Kit: it gets the default program, which it never runs.
fn device_of(folders: &Folders, osk_cli: Option<&Path>) -> Result<Device, String> {
    device_at(
        &folders.vault,
        &folders.content_store,
        osk_cli,
        folders.renames.as_deref(),
    )
}

/// The device of a vault and a copy of the content store.
fn device_at(
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
    // Without a folder, the journals of every configuration folder (R82).
    let renames = renames.map_or_else(
        || renames::RenameJournals::of_vault(vault.to_path_buf()),
        |folder| renames::RenameJournals::new(folder.to_path_buf()),
    );
    Ok(Device {
        vault: Vault::new(vault),
        store: ContentStore::new(content_store),
        renames,
        note_types: note_types::StarterKit::new(&program, vault),
        main_site: originals::MainSite::network(),
        seal: seal::SealSource::new(vault),
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

/// The name of the host, as `os.hostname()` of Node gives it (the system
/// call gethostname): the default name of the device, and the computer of the
/// lock of the device, which the plugin compares with its own (R81). The
/// program reads it here. The logic never does.
pub(crate) fn host_name() -> String {
    let name = gethostname::gethostname()
        .to_string_lossy()
        .trim()
        .to_owned();
    if name.is_empty() {
        "unknown device".to_owned()
    } else {
        name
    }
}

/// Reads a selection from a JSON file: an object with the lists `include`,
/// `hold` and `remove` of vault paths, each one optional.
fn selection_from_file(file: &Path) -> Result<Selection, String> {
    let wrong = || {
        format!(
            "the selection file {} must be an object with the lists \"include\", \"hold\", \"remove\" and \"accept\" of vault paths, and \"pair\" of objects with \"from\" and \"to\"",
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
        .any(|key| !["accept", "include", "hold", "pair", "remove"].contains(&key.as_str()))
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
        &list("accept")?,
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

/// A takedown that waits for its deploy (issue 32): `status` says so on the
/// error output, outside its report.
fn warn_when_takedown_waits(content_store: &Path) {
    if takedown_waits(content_store) {
        eprintln!(
            "warning: a takedown waits for a deploy that succeeds, and its notes can still be live: every deploy runs with --takedown until then (dsebastien-vault-publish deploy)"
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

/// A plan says that `configuration.json` changed since the last publication,
/// not only through the edits of the tool (issue 108, GATE-07): it says so on
/// the error output too.
fn warn_when_configuration_changed(plan: &str) {
    let changed = json::parse_json(plan)
        .ok()
        .and_then(|plan| {
            plan.get("configurationChanged")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false);
    if changed {
        eprintln!(
            "warning: configuration.json changed since the last publication, and not only through the edits of the tool: read the deny list before the publication (configurationChanged)"
        );
    }
}

/// A plan of the command line program refreshes no frozen list (PUB-101,
/// R71), the page drops a live query block (REN-14), and the plan holds a
/// note that links a file above the size limit of an attachment (issue 72):
/// it says so on the error output too, one line per held note and file.
fn warn_about_lists(plan: &str) {
    let Ok(plan) = json::parse_json(plan) else {
        return;
    };
    let count = |key: &str| {
        plan.get(key)
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len)
    };
    let not_refreshed = count("listsNotRefreshed");
    if not_refreshed > 0 {
        eprintln!(
            "warning: {not_refreshed} notes of the plan have Dataview lists that the command line program does not refresh: they are published as saved (listsNotRefreshed). Make the plan in Obsidian to refresh them"
        );
    }
    let live = count("liveQueries");
    if live > 0 {
        eprintln!(
            "warning: {live} notes of the plan have a live Dataview or Bases block, which the page does not show (liveQueries)"
        );
    }
    // One line per note and file above the size limit (issue 72).
    for item in plan
        .get("tooLarge")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let text = |key: &str| {
            item.get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
        };
        let size = item
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        eprintln!(
            "warning: \"{}\" is held: it links \"{}\" ({size} bytes), above the size limit of an attachment (tooLarge)",
            text("path"),
            text("file")
        );
    }
}

/// The absolute form of a folder of the options, or the folder as it is
/// when the system cannot give one.
fn absolute(folder: &Path) -> PathBuf {
    if folder.as_os_str().is_empty() {
        return PathBuf::new();
    }
    std::path::absolute(folder).unwrap_or_else(|_| folder.to_path_buf())
}

/// The deploy settings of the options, with the folders of the publication.
fn deploy_settings(
    places: &DeployPlaces,
    content_store: &Path,
    attachment_storage: &Path,
) -> DeploySettings {
    DeploySettings {
        site_code: places.site_code.clone(),
        target: places.deploy_target.clone(),
        env_file: places.deploy_env_file.clone(),
        bun: places.bun.clone(),
        // As the publication accepts them: a relative folder is a folder of
        // the working folder of the program.
        content_store: Some(absolute(content_store)),
        attachments: Some(absolute(attachment_storage)),
        timeout_minutes: places.deploy_timeout,
    }
}

/// The seal key of the device for the environment of the deploy (R104,
/// rule 10 of the seal), or `None` when it has no valid key.
fn deploy_seal_key(device: &Device) -> Option<String> {
    device.seal.key().ok().map(|key| seal::key_hex(&key))
}

/// The deploy after a push, or `None` with `--no-deploy`.
fn deploy_after(
    options: &DeployAfterPush,
    content_store: &Path,
    attachment_storage: &Path,
    takedown: bool,
    device: &Device,
) -> Option<Deploy> {
    (!options.no_deploy).then(|| Deploy {
        settings: deploy_settings(&options.places, content_store, attachment_storage),
        kind: DeployKind {
            push: "ok",
            takedown,
        },
        seal_key: deploy_seal_key(device),
    })
}

/// The `deploy` command and tool: the deploy report as the output, and a
/// failure when the deploy did not succeed.
fn deploy_again(settings: DeploySettings, takedown: bool) -> Outcome {
    // No vault: the deploy reads the seal key of its own environment.
    let report = run_deploy(&Deploy {
        settings,
        kind: DeployKind {
            push: "skipped",
            takedown,
        },
        seal_key: None,
    });
    Outcome {
        output: deployment_text(&report),
        failure: (!report.succeeded()).then(|| {
            report
                .error
                .clone()
                .unwrap_or_else(|| "the deploy did not succeed".to_owned())
        }),
    }
}

/// The `deploy` command: the last deploy report with `--last`, else the
/// deploy again, which it waits for.
fn deploy_command(
    content_store: &Path,
    attachment_storage: &Path,
    places: &DeployPlaces,
    takedown: bool,
    last: bool,
) -> Outcome {
    if last {
        return Outcome::of(last_of(content_store, false));
    }
    deploy_again(
        deploy_settings(places, content_store, attachment_storage),
        takedown,
    )
}

/// What the `mcp` command needs for the deploy of its tools.
struct McpDeploy<'a> {
    options: &'a DeployAfterPush,
    content_store: &'a Path,
    attachment_storage: &'a Path,
    background: &'a Background,
}

/// Runs the call of a tool of the MCP server, as the command of the same name
/// does, with the deploy after a push. The server never waits for a build:
/// the deploy runs in the background, the last text is the report of a deploy
/// that started, and the tool `deploy` with `last` reads the result later.
fn operate(
    device: &Device,
    attachment_storage: &AttachmentStorage,
    name: &str,
    call: &mcp::Call,
    deploy: &McpDeploy,
) -> Result<mcp::ToolOutcome, String> {
    if let mcp::Call::Deploy { takedown, last } = call {
        if *last {
            return Ok(Outcome::of(last_of(deploy.content_store, deploy.background.busy())).into());
        }
        let kind = DeployKind {
            push: "skipped",
            takedown: *takedown,
        };
        deploy.background.start(Deploy {
            settings: deploy_settings(
                &deploy.options.places,
                deploy.content_store,
                deploy.attachment_storage,
            ),
            kind,
            seal_key: deploy_seal_key(device),
        });
        return Ok(Outcome::of(started_text(kind)).into());
    }
    if *call == mcp::Call::Status && takedown_waits(deploy.content_store) {
        return Ok(mcp::ToolOutcome {
            outcome: run_tool(device, attachment_storage, name, call)?,
            deploy: Some(deploy::takedown_waits_text()),
        });
    }
    let takedown = matches!(call, mcp::Call::Takedown { .. });
    let pushed = matches!(
        call,
        mcp::Call::Publish { .. } | mcp::Call::Unpublish { .. } | mcp::Call::Takedown { .. }
    );
    let outcome = if pushed {
        pushing(deploy.content_store, takedown, || {
            run_tool(device, attachment_storage, name, call)
        })?
    } else {
        run_tool(device, attachment_storage, name, call)?
    };
    let after = deploy_after(
        deploy.options,
        deploy.content_store,
        deploy.attachment_storage,
        takedown,
        device,
    )
    .filter(|_| pushed);
    let deploy = after.map(|after| {
        let text = started_text(after.kind);
        deploy.background.start(after);
        text
    });
    Ok(mcp::ToolOutcome { outcome, deploy })
}

/// Runs the call of a tool of the MCP server but `deploy`, as the command of
/// the same name does.
fn run_tool(
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
            accept,
        } => tool::plan(device, &Selection::new(include, hold, remove, pair, accept)).map(done),
        mcp::Call::Publish { plan } => tool::publish(device, attachment_storage, plan, &run),
        mcp::Call::Unpublish { paths, accept } => {
            tool::unpublish(device, attachment_storage, paths, accept, &run)
        }
        mcp::Call::Takedown { paths } => tool::takedown(device, attachment_storage, paths, &run),
        mcp::Call::Guards => tool::guards(device).map(done),
        mcp::Call::Edit { action, path } => tool::edit(device, action, path, &run).map(done),
        mcp::Call::ConfirmStoreState { head } => tool::confirm_state(device, head, &run).map(done),
        mcp::Call::Unlock => tool::unlock(&device.store).map(done),
        mcp::Call::Deploy { .. } => Err("deploy is no command of the publishing logic".to_owned()),
    }
}

/// Serves the MCP server over the standard input and output (`mcp`).
fn serve(
    places: &Places,
    attachment_storage: &Path,
    name: Option<String>,
    deploy: &DeployAfterPush,
) -> Result<(), String> {
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
    let background = Background::default();
    let deploy = McpDeploy {
        options: deploy,
        content_store: &places.folders.content_store,
        attachment_storage,
        background: &background,
    };
    let mut operations =
        |call: &mcp::Call| operate(&device(places)?, &storage, &name, call, &deploy);
    let served = mcp::serve(
        io::stdin().lock(),
        io::stdout().lock(),
        &info,
        &mut operations,
    )
    .map_err(|error| error.to_string());
    // The program never ends in the middle of a deploy.
    background.wait();
    served
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

/// Confirms the state of the content store from the command line
/// (`confirm-state`).
fn run_confirm_state(
    folders: &Folders,
    head: &str,
    time: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    tool::confirm_state(
        &device_of(folders, None)?,
        head,
        &command_line_run(&time.unwrap_or_else(now), &name.unwrap_or_else(host_name)),
    )
}

/// Removes the lock of the device (`unlock`).
fn unlock(content_store: &Path) -> Result<String, String> {
    if !content_store.is_dir() {
        return Err(format!(
            "the content store is not a folder: {}",
            content_store.display()
        ));
    }
    tool::unlock(&ContentStore::new(content_store))
}

/// A plan of the command line, with its warnings on the error output.
fn run_plan(places: &Places, selection: &Selection) -> Result<String, String> {
    let output = tool::plan(&device(places)?, selection)?;
    warn_when_offline(&output);
    warn_when_configuration_changed(&output);
    warn_about_lists(&output);
    Ok(output)
}

/// The run of a command of the command line program.
fn command_line_run<'a>(time: &'a str, device: &'a str) -> Run<'a> {
    Run {
        time,
        device,
        face: "command-line",
    }
}

/// A publication of the command line, then the deploy.
fn run_publish(
    places: &Places,
    attachment_storage: &Path,
    plan: &str,
    run: &Run,
    deploy: &DeployAfterPush,
) -> Result<Ran, String> {
    let device = device(places)?;
    Ok(Ran {
        outcome: pushing(&places.folders.content_store, false, || {
            tool::publish(&device, &storage(attachment_storage), plan, run)
        })?,
        deploy: deploy_after(
            deploy,
            &places.folders.content_store,
            attachment_storage,
            false,
            &device,
        ),
    })
}

/// An unpublish of the command line (the paths, and the paths that the
/// author accepts), then the deploy.
fn run_unpublish(
    places: &Places,
    attachment_storage: &Path,
    (paths, accept): (&[String], &[String]),
    run: &Run,
    deploy: &DeployAfterPush,
) -> Result<Ran, String> {
    let device = device(places)?;
    Ok(Ran {
        outcome: pushing(&places.folders.content_store, false, || {
            tool::unpublish(&device, &storage(attachment_storage), paths, accept, run)
        })?,
        deploy: deploy_after(
            deploy,
            &places.folders.content_store,
            attachment_storage,
            false,
            &device,
        ),
    })
}

/// A takedown of the command line: the marker of the takedown right after
/// its push, then the deploy with `--takedown`.
fn run_takedown(
    device: &Device,
    content_store: &Path,
    attachment_storage: &Path,
    paths: &[String],
    run: &Run,
    deploy: &DeployAfterPush,
) -> Result<Ran, String> {
    let outcome = pushing(content_store, true, || {
        tool::takedown(device, &storage(attachment_storage), paths, run)
    })?;
    Ok(Ran {
        outcome,
        deploy: deploy_after(deploy, content_store, attachment_storage, true, device),
    })
}

/// What a command gives: its outcome, and the deploy to run after its output
/// (issue 32).
struct Ran {
    outcome: Outcome,
    deploy: Option<Deploy>,
}

impl From<Outcome> for Ran {
    fn from(outcome: Outcome) -> Self {
        Self {
            outcome,
            deploy: None,
        }
    }
}

fn run(command: Command) -> Result<Ran, String> {
    let done = |output: String| Ran::from(Outcome::of(output));
    match command {
        Command::Status { places } => {
            let output = tool::status(&device(&places)?)?;
            warn_when_behind(&output);
            warn_when_takedown_waits(&places.folders.content_store);
            Ok(done(output))
        }
        Command::Plan {
            places,
            include,
            hold,
            remove,
            pair,
            accept,
            selection,
        } => match selection {
            Some(file) => run_plan(&places, &selection_from_file(&file)?),
            None => run_plan(
                &places,
                &Selection::new(&include, &hold, &remove, &pairings_of(&pair), &accept),
            ),
        }
        .map(done),
        Command::Unpublish {
            places,
            attachment_storage,
            path,
            accept,
            deploy,
            time,
            device: name,
        } => run_unpublish(
            &places,
            &attachment_storage,
            (&path, &accept),
            &command_line_run(&time.unwrap_or_else(now), &name.unwrap_or_else(host_name)),
            &deploy,
        ),
        Command::Takedown {
            folders,
            attachment_storage,
            path,
            time,
            device: name,
            deploy,
        } => run_takedown(
            &device_of(&folders, None)?,
            &folders.content_store,
            &attachment_storage,
            &path,
            &command_line_run(&time.unwrap_or_else(now), &name.unwrap_or_else(host_name)),
            &deploy,
        ),
        Command::Guards {
            vault,
            content_store,
        } => tool::guards(&device_at(&vault, &content_store, None, None)?).map(done),
        Command::Deny { edit } => run_edit("deny", edit).map(Ran::from),
        Command::Allow { edit } => run_edit("allow", edit).map(Ran::from),
        Command::Ignore { edit } => run_edit("ignore", edit).map(Ran::from),
        Command::Unignore { edit } => run_edit("unignore", edit).map(Ran::from),
        Command::Mcp {
            places,
            attachment_storage,
            deploy,
            device: name,
        } => serve(&places, &attachment_storage, name, &deploy).map(|()| done(String::new())),
        Command::Deploy {
            content_store,
            attachment_storage,
            places,
            takedown,
            last,
        } => {
            Ok(deploy_command(&content_store, &attachment_storage, &places, takedown, last).into())
        }
        Command::ConfirmState {
            folders,
            head,
            time,
            device: name,
        } => run_confirm_state(&folders, &head, time, name).map(done),
        Command::Unlock { content_store } => unlock(&content_store).map(done),
        Command::Publish {
            places,
            attachment_storage,
            plan,
            deploy,
            time,
            device: name,
        } => run_publish(
            &places,
            &attachment_storage,
            &plan,
            &command_line_run(&time.unwrap_or_else(now), &name.unwrap_or_else(host_name)),
            &deploy,
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
    let written = run(Arguments::parse().command).and_then(|ran| {
        write_output(&ran.outcome.output).map_err(|error| error.to_string())?;
        // The publication is done at the push: the deploy report comes after
        // its report, as its own object, and a failed deploy never changes
        // the exit code of the publication (PUB-42).
        if let Some(deploy) = &ran.deploy {
            let report = run_deploy(deploy);
            write_output(&deployment_text(&report)).map_err(|error| error.to_string())?;
            if !report.succeeded() {
                eprintln!(
                    "warning: the publication is done, but nothing new is live: {}",
                    report
                        .error
                        .as_deref()
                        .unwrap_or("the deploy did not succeed")
                );
            }
        }
        // The report is written. The exit code says that it names a failure.
        ran.outcome.failure.map_or(Ok(()), Err)
    });
    let code = match written {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    };
    // After its report, a program that a Ctrl-C reached stops as Ctrl-C
    // stops a program (issue 126).
    device::stop_after_ctrl_c();
    code
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
            // The MCP tool has the name of the action: the command says what it does.
            .map(|name| {
                if name == "confirm-state" {
                    "confirm_store_state".to_owned()
                } else {
                    name
                }
            })
            .collect();
        commands.sort_unstable();
        let mut tools = mcp::TOOL_NAMES.to_vec();
        tools.sort_unstable();
        assert_eq!(commands, tools);
    }
}
