//! Ports `common/workspace-layout.ts`.

use garcon_js::Number;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspaceLayoutV2 {
    pub version: u8,
    pub root: PersistedWorkspaceLayoutNode,
    pub unplaced_terminal_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum PersistedWorkspaceSurfaceRef {
    Chat {
        chat_id: Option<String>,
    },
    Singleton {
        kind: PersistedWorkspaceSingletonKind,
    },
    Terminal {
        terminal_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PersistedWorkspaceSingletonKind {
    Git,
    GitHistory,
    GitCompare,
    PullRequests,
    Files,
    Commit,
    ChatMap,
    ChatCanvas,
    ChatBoard,
    Tickets,
    Usage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspacePartitionDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PersistedWorkspaceLayoutNode {
    Window {
        id: String,
        order: Vec<PersistedWorkspaceSurfaceRef>,
        active: Option<PersistedWorkspaceSurfaceRef>,
        mru: Vec<PersistedWorkspaceSurfaceRef>,
    },
    Partition {
        id: String,
        direction: WorkspacePartitionDirection,
        ratio: Number,
        children: [Box<PersistedWorkspaceLayoutNode>; 2],
    },
}
