//! The deploy after a push in the command line program (issue 32, BUILD-02,
//! PUB-42): the files of the deploy in the copy, the deploy log, and the
//! deploys of the MCP server, which run in the background. The rules of the
//! deploy are in `deploy.rs`; the child process is `ChildProcess` of
//! `device.rs`.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};

use crate::deploy::{
    self, DeployFiles, DeployKind, DeployRecord, DeployReport, DeploySettings, TakedownMarker,
};
use crate::device::{ChildProcess, ContentStore};

/// A deploy of the site to run: its settings, and what it follows.
#[derive(Clone)]
pub struct Deploy {
    pub settings: DeploySettings,
    pub kind: DeployKind,
}

/// Sets the marker of a takedown right after its push, also with
/// `--no-deploy`: every later deploy then runs with `--takedown` until one
/// succeeds. A marker that cannot be written is a warning: the deploy after
/// the takedown still runs with `--takedown`.
pub fn mark_takedown(content_store: &Path) {
    if let Err(error) = ContentStore::new(content_store).set() {
        eprintln!("warning: the marker of the takedown could not be written: {error}");
    }
}

/// No files: a deploy with no copy of the content store deploys nothing.
struct NoFiles;

impl TakedownMarker for NoFiles {
    fn pending(&self) -> bool {
        false
    }
    fn set(&self) -> Result<(), String> {
        Ok(())
    }
    fn remove(&self) -> Result<(), String> {
        Ok(())
    }
}

impl DeployRecord for NoFiles {
    fn set_running(&self, _: bool) -> Result<(), String> {
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
/// The deploy report never holds it.
pub fn run_deploy(deploy: &Deploy) -> DeployReport {
    let store = store_of(&deploy.settings);
    let files: &dyn DeployFiles = match &store {
        Some(store) => store,
        None => &NoFiles,
    };
    let deployment = deploy::run_deploy(
        &ChildProcess::new(),
        files,
        &deploy.settings,
        deploy.kind,
        cfg!(windows),
    );
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
    deploy::last_text(store.last().as_deref(), busy || store.running())
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
                run_deploy(&deploy);
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
