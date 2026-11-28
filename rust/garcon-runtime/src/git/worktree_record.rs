//! Ports `server/runtime/git/worktree-record.ts`.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub path: String,
    pub branch: String,
    pub name: String,
    pub is_main: bool,
}

pub fn compare_worktree_paths(left: &WorktreeRecord, right: &WorktreeRecord) -> Ordering {
    left.path.as_bytes().cmp(right.path.as_bytes())
}
