//! The pure lifecycle binding for an already allocated ownership epoch.
//! Callers that need to allocate the epoch do so before invoking the helper.

use garcon_contract::preambles::PendingPreambleBoundary;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecyclePreambleBoundaryKind {
    NewChat,
    Fork,
    Continuation,
    AgentSwitch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleBoundaryBinding {
    pub agent_ownership_epoch: String,
    pub pending_preamble_boundary: PendingPreambleBoundary,
}

pub fn create_preamble_boundary_binding(
    kind: LifecyclePreambleBoundaryKind,
    epoch: String,
) -> PreambleBoundaryBinding {
    let ownership_epoch = epoch.clone();
    let pending_preamble_boundary = match kind {
        LifecyclePreambleBoundaryKind::NewChat => {
            PendingPreambleBoundary::NewChat { ownership_epoch }
        }
        LifecyclePreambleBoundaryKind::Fork => PendingPreambleBoundary::Fork { ownership_epoch },
        LifecyclePreambleBoundaryKind::Continuation => {
            PendingPreambleBoundary::Continuation { ownership_epoch }
        }
        LifecyclePreambleBoundaryKind::AgentSwitch => {
            PendingPreambleBoundary::AgentSwitch { ownership_epoch }
        }
    };
    PreambleBoundaryBinding {
        agent_ownership_epoch: epoch,
        pending_preamble_boundary,
    }
}
