//! The publication plan as data: the exact list of what one publication will
//! do. The TypeScript twin is `apps/plugin/src/publishing/plan.ts`.

use serde::Serialize;

use crate::order::sort_by_code_point;

/// The notes that one publication publishes, updates and removes, as vault
/// paths. Each list is sorted by path, in the order of the code points.
#[derive(Debug, Serialize)]
pub struct PublicationPlan {
    publish: Vec<String>,
    update: Vec<String>,
    remove: Vec<String>,
}

impl PublicationPlan {
    /// Makes a plan from its three lists. Each list is put in the order of the
    /// canonical form here, so that no caller can give a plan in another order.
    pub fn new(mut publish: Vec<String>, mut update: Vec<String>, mut remove: Vec<String>) -> Self {
        sort_by_code_point(&mut publish);
        sort_by_code_point(&mut update);
        sort_by_code_point(&mut remove);
        Self {
            publish,
            update,
            remove,
        }
    }
}

/// Computes the publication plan.
///
/// The skeleton finds nothing: every list is empty. The first slice reads the
/// vault, the manifest, the configuration and the selection.
pub fn compute_plan() -> PublicationPlan {
    PublicationPlan::new(Vec::new(), Vec::new(), Vec::new())
}
