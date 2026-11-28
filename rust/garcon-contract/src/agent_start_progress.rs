//! Ports common/agent-start-progress.ts.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentStartProgressPhase {
    PreparingContext,
    CompactingContext,
    StartingAgent,
    Started,
    Failed,
    Interrupted,
}

use AgentStartProgressPhase::*;

pub const AGENT_START_PROGRESS_PHASES: [AgentStartProgressPhase; 6] = [
    PreparingContext,
    CompactingContext,
    StartingAgent,
    Started,
    Failed,
    Interrupted,
];

impl AgentStartProgressPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            PreparingContext => "preparing-context",
            CompactingContext => "compacting-context",
            StartingAgent => "starting-agent",
            Started => "started",
            Failed => "failed",
            Interrupted => "interrupted",
        }
    }
}

pub const AGENT_START_PROGRESS_CONTENT: [(AgentStartProgressPhase, &str); 6] = [
    (PreparingContext, "Context preparation started."),
    (CompactingContext, "Compacting inherited context."),
    (StartingAgent, "Context ready; starting agent."),
    (Started, "Agent started."),
    (
        Failed,
        "Agent startup failed. The chat and task have been retained.",
    ),
    (Interrupted, "Agent startup was interrupted."),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentStartProgressNoticeKind {
    AgentStartProgress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AgentStartProgressNoticeDetail {
    #[serde(rename = "type")]
    pub kind: AgentStartProgressNoticeKind,
    pub phase: AgentStartProgressPhase,
}

pub fn parse_agent_start_progress_notice(value: &Value) -> Option<AgentStartProgressNoticeDetail> {
    let record = value.as_object()?;
    if record.get("type")?.as_str()? != "agent-start-progress"
        || record.keys().any(|key| key != "type" && key != "phase")
    {
        return None;
    }
    let phase = record.get("phase")?.as_str()?;
    let phase = AGENT_START_PROGRESS_PHASES
        .iter()
        .copied()
        .find(|candidate| candidate.as_str() == phase)?;
    Some(AgentStartProgressNoticeDetail {
        kind: AgentStartProgressNoticeKind::AgentStartProgress,
        phase,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_each_milestone_without_retaining_private_fields() {
        for phase in AGENT_START_PROGRESS_PHASES {
            let detail = json!({"type":"agent-start-progress","phase":phase.as_str()});
            assert_eq!(json!(parse_agent_start_progress_notice(&detail)), detail);
        }
        assert_eq!(
            parse_agent_start_progress_notice(
                &json!({"type":"agent-start-progress","phase":"unknown"})
            ),
            None
        );
        assert_eq!(
            parse_agent_start_progress_notice(
                &json!({"type":"agent-start-progress","phase":"started","runId":"private"})
            ),
            None
        );
    }
}
