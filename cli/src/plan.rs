//! The publication plan as data: the exact list of what one publication will
//! do. The TypeScript twin is `apps/plugin/src/publishing/plan.ts`.

use serde::Serialize;

/// The notes that one publication publishes, updates and removes, as vault
/// paths. Each list is sorted by path, in the order of the code points.
#[derive(Debug, Serialize)]
pub struct PublicationPlan {
    pub publish: Vec<String>,
    pub update: Vec<String>,
    pub remove: Vec<String>,
}

/// Computes the publication plan.
///
/// The skeleton finds nothing: every list is empty. The first slice reads the
/// vault, the manifest, the configuration and the selection.
pub fn compute_plan() -> PublicationPlan {
    PublicationPlan {
        publish: Vec::new(),
        update: Vec::new(),
        remove: Vec::new(),
    }
}
