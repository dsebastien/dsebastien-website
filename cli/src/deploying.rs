//! The deploy after a push in the command line program (issue 32, BUILD-02,
//! PUB-42): the files of the deploy in the copy, the deploy log, and the
//! deploys of the MCP server, which run in the background. The rules of the
//! deploy are in `deploy.rs`; the child process is `ChildProcess` of
//! `device.rs`.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};

use crate::deploy::{
    self, DeployFiles, DeployKind, DeployRecord, DeployReport, DeploySettings, TakedownEntry,
    TakedownMarker,
};
use crate::device::{ChildProcess, ContentStore};
use crate::tool::Outcome;

/// A deploy of the site to run: its settings, and what it follows.
#[derive(Clone)]
pub struct Deploy {
    pub settings: DeploySettings,
    pub kind: DeployKind,
    /// The seal key of the vault in small hexadecimal digits, for the
    /// environment of the deploy (R104, rule 10 of the seal): the deploy
    /// checks the seal of the state that it builds. Never logged.
    pub seal_key: Option<String>,
}

/// True when the run journal says that the push of the run happened and the
/// commit of the copy is not the one before it.
fn pushed_anyway(store: &ContentStore, before: Option<&String>) -> bool {
    let step = store
        .load_journal()
        .ok()
        .flatten()
        .and_then(|journal| serde_json::from_str::<serde_json::Value>(&journal).ok())
        .and_then(|journal| {
            journal
                .get("step")
                .and_then(|step| step.as_str().map(str::to_owned))
        });
    step.as_deref() == Some("correct") && store.head().as_ref() != before
}

/// Runs a publication, an unpublish or a takedown. When it fails after its
/// push (the run journal says that the correction is owed, and the commit of
/// the copy moved), the push happened: the result is an outcome with no
/// output and the failure, so that the deploy still starts, and the message
/// says so. A takedown writes its entry in the marker of the takedowns before
/// its push, with the commit of the copy before it, then the commit of its
/// push after it, also with `--no-deploy`; the entry goes when nothing was
/// pushed. A marker that cannot be written is a warning.
pub fn pushing(
    content_store: &Path,
    takedown: bool,
    work: impl FnOnce() -> Result<Outcome, String>,
) -> Result<Outcome, String> {
    let store = ContentStore::new(content_store);
    let before = store.head();
    let entry = if takedown {
        TakedownMarker::add(&store, &TakedownEntry::Above(before.clone()))
            .map_err(|error| {
                eprintln!(
                    "warning: the marker of the takedown could not be written, so deploy with --takedown until a deploy succeeds: {error}"
                );
            })
            .ok()
    } else {
        None
    };
    let settle = |done: bool| {
        let Some(id) = &entry else {
            return;
        };
        let after = store.head();
        let written = if !done {
            TakedownMarker::remove(&store, id)
        } else if let Some(after) = after.filter(|after| Some(after) != before.as_ref()) {
            TakedownMarker::replace(&store, id, &TakedownEntry::Commit(after))
        } else {
            Ok(())
        };
        if let Err(error) = written {
            eprintln!("warning: the marker of the takedown could not be written: {error}");
        }
    };
    let error = match work() {
        Ok(outcome) => {
            settle(true);
            return Ok(outcome);
        }
        Err(error) => error,
    };
    if !pushed_anyway(&store, before.as_ref()) {
        settle(false);
        return Err(error);
    }
    settle(true);
    Ok(Outcome {
        output: String::new(),
        failure: Some(format!(
            "the push happened, so the deploy starts, but a later step of the run failed: {error}"
        )),
    })
}

/// No files: a deploy with no copy of the content store deploys nothing.
struct NoFiles;

impl TakedownMarker for NoFiles {
    fn entries(&self) -> Result<Vec<(String, TakedownEntry)>, String> {
        Ok(Vec::new())
    }
    fn add(&self, _: &TakedownEntry) -> Result<String, String> {
        Ok(String::new())
    }
    fn replace(&self, _: &str, _: &TakedownEntry) -> Result<(), String> {
        Ok(())
    }
    fn remove(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn is_ancestor(&self, _: &str, _: &str) -> Option<bool> {
        None
    }
}

impl DeployRecord for NoFiles {
    fn started(&self, _: u32) -> Result<(), String> {
        Ok(())
    }
    fn ended(&self, _: u32) -> Result<(), String> {
        Ok(())
    }
    fn running(&self) -> bool {
        false
    }
    fn save_last(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn last(&self) -> Option<String> {
        None
    }
}

/// The copy of the settings, when it is set.
fn store_of(settings: &DeploySettings) -> Option<ContentStore> {
    settings
        .content_store
        .as_deref()
        .filter(|copy| !copy.as_os_str().is_empty())
        .map(ContentStore::new)
}

/// Runs the deploy, and keeps its whole output in the deploy log of the copy:
/// it can name the address of a removed note, so it goes to no other place.
/// The deploy report never holds it. The program waits for it in a terminal:
/// Ctrl-C stops it, and its report says so.
pub fn run_deploy(deploy: &Deploy) -> DeployReport {
    deploy_by(
        deploy,
        &ChildProcess::with_ctrl_c().with_seal_key(deploy.seal_key.clone()),
    )
}

fn deploy_by(deploy: &Deploy, child: &ChildProcess) -> DeployReport {
    let store = store_of(&deploy.settings);
    let files: &dyn DeployFiles = match &store {
        Some(store) => store,
        None => &NoFiles,
    };
    let deployment = deploy::run_deploy(child, files, &deploy.settings, deploy.kind, cfg!(windows));
    if let (false, Some(store)) = (deployment.output.is_empty(), &store) {
        match store.save_deploy_log(&deployment.output) {
            Ok(()) => eprintln!(
                "the whole output of the deploy is in {}",
                store.deploy_log().display()
            ),
            Err(error) => eprintln!("warning: the output of the deploy is not kept: {error}"),
        }
    }
    deployment.report
}

/// The last deploy report of the record of the copy, and whether a deploy
/// runs (`deploy` with `last`). It starts no deploy.
pub fn last_of(content_store: &Path, busy: bool) -> String {
    let store = ContentStore::new(content_store);
    deploy::last_text(
        store.last().as_deref(),
        busy || store.running(),
        deploy::takedown_waits(&store),
    )
}

/// True when a takedown of the copy waits for its deploy.
pub fn takedown_waits(content_store: &Path) -> bool {
    deploy::takedown_waits(&ContentStore::new(content_store))
}

#[derive(Default)]
struct Queue {
    /// True while the worker runs a deploy.
    running: bool,
    /// The deploy that waits for the end of the current one.
    pending: Option<Deploy>,
}

/// The deploys of the MCP server, in the background: the server answers at
/// once and never waits for a build. One deploy runs at a time, in the order
/// of the pushes: a push during a deploy gets one more deploy after it, which
/// covers every push that came meanwhile (with `--takedown` when one of them
/// asked for it).
#[derive(Default)]
pub struct Background {
    queue: Arc<Mutex<Queue>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Background {
    /// Starts the deploy, or adds it to the deploy that waits.
    pub fn start(&self, deploy: Deploy) {
        {
            let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
            if queue.running {
                let merged = match queue.pending.take() {
                    Some(waiting) => Deploy {
                        settings: deploy.settings,
                        seal_key: deploy.seal_key,
                        kind: DeployKind {
                            push: if waiting.kind.push == "ok" || deploy.kind.push == "ok" {
                                "ok"
                            } else {
                                "skipped"
                            },
                            takedown: waiting.kind.takedown || deploy.kind.takedown,
                        },
                    },
                    None => deploy,
                };
                queue.pending = Some(merged);
                return;
            }
            queue.running = true;
        }
        let shared = Arc::clone(&self.queue);
        let handle = thread::spawn(move || {
            let mut next = Some(deploy);
            while let Some(deploy) = next {
                // In the background: Ctrl-C stops the server, as before.
                deploy_by(
                    &deploy,
                    &ChildProcess::new().with_seal_key(deploy.seal_key.clone()),
                );
                let mut queue = shared.lock().unwrap_or_else(PoisonError::into_inner);
                next = queue.pending.take();
                if next.is_none() {
                    queue.running = false;
                }
            }
        });
        let old = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace(handle);
        // The old worker has ended: it set `running` to false.
        if let Some(old) = old {
            let _ = old.join();
        }
    }

    /// True while a deploy of this server runs or waits.
    pub fn busy(&self) -> bool {
        self.queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
    }

    /// Waits for the end of the deploys of this server, so that the program
    /// never ends in the middle of one.
    pub fn wait(&self) {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}
