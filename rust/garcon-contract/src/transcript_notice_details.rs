//! Ports `common/transcript-notice-details.ts`.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;

use crate::agent_start_progress::{
    AgentStartProgressNoticeDetail, parse_agent_start_progress_notice,
};
use crate::chat_id::{ChatId, parse_chat_id};
use crate::garcon_command_results::{AgentCommandOutcomeNoticeDetail, parse_agent_command_outcome};
use crate::garcon_ticket_result::{TicketCommandOutcome, parse_ticket_command_outcome};
use crate::preambles::{PREAMBLE_MAX_COUNT, is_preamble_id, normalize_preamble_title};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppliedPreambleReference {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatIdDiscoveryFailureReason {
    Disabled,
    DeliveryFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InterAgentMessageFailureReason {
    Disabled,
    SelfSend,
    TargetNotFound,
    TargetUnavailable,
    QueueFull,
    ProviderRejected,
    DeliveryUnknown,
    ServerShuttingDown,
    DeliveryFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum InterAgentMessageResult {
    Delivered {
        chat_id: ChatId,
    },
    Queued {
        chat_id: ChatId,
    },
    Failed {
        chat_id: ChatId,
        reason: InterAgentMessageFailureReason,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TranscriptNoticeDetail {
    PreambleApplication {
        preambles: Vec<AppliedPreambleReference>,
    },
    PreambleSelectionChanged {
        preambles: Vec<AppliedPreambleReference>,
    },
    CarryoverMigrationQuarantine {
        artifact_id: String,
        error_code: String,
    },
    HandoffSummary,
    PublicationGap,
    ChatIdDisclosure,
    ChatIdDiscoveryFailure {
        reason: ChatIdDiscoveryFailureReason,
    },
    InterAgentMessageOutcome {
        results: Vec<InterAgentMessageResult>,
    },
    InterAgentMessageReceived {
        from_chat_id: Option<ChatId>,
    },
    #[serde(untagged)]
    AgentStartProgress(AgentStartProgressNoticeDetail),
    #[serde(untagged)]
    AgentCommandOutcome(AgentCommandOutcomeNoticeDetail),
    #[serde(untagged)]
    TicketCommandOutcome(TicketCommandOutcome),
}

fn has_type(value: &Value, kind: &str) -> bool {
    value.is_object() && value["type"] == kind
}

pub fn is_carryover_migration_quarantine_notice_detail(value: &Value) -> bool {
    has_type(value, "carryover-migration-quarantine")
        && value["artifactId"].as_str().is_some_and(|s| !s.is_empty())
        && value["errorCode"].as_str().is_some_and(|s| !s.is_empty())
}

fn preamble_references(value: &Value, min_count: usize) -> Option<Vec<AppliedPreambleReference>> {
    let entries = value["preambles"]
        .as_array()
        .filter(|entries| (min_count..=PREAMBLE_MAX_COUNT).contains(&entries.len()))?;
    let mut seen = HashSet::with_capacity(entries.len());
    entries
        .iter()
        .map(|entry| {
            let raw = entry.as_object()?;
            let id = entry["id"].as_str()?;
            if !is_preamble_id(&entry["id"]) || !seen.insert(id) {
                return None;
            }
            let title = normalize_preamble_title(&entry["title"])?;
            if entry["title"] != title
                || raw
                    .keys()
                    .any(|key| !matches!(key.as_str(), "id" | "title"))
            {
                return None;
            }
            Some(AppliedPreambleReference {
                id: id.to_owned(),
                title,
            })
        })
        .collect()
}

fn parse_preamble_references(
    value: &Value,
    kind: &str,
    min_count: usize,
) -> Option<Vec<AppliedPreambleReference>> {
    let raw = value.as_object()?;
    if value["type"] != kind
        || raw
            .keys()
            .any(|key| !matches!(key.as_str(), "type" | "preambles"))
    {
        return None;
    }
    preamble_references(value, min_count)
}

pub fn is_preamble_application_notice_detail(value: &Value) -> bool {
    parse_preamble_references(value, "preamble-application", 1).is_some()
}

pub fn is_preamble_selection_changed_notice_detail(value: &Value) -> bool {
    parse_preamble_references(value, "preamble-selection-changed", 0).is_some()
}

pub fn is_handoff_summary_notice_detail(value: &Value) -> bool {
    has_type(value, "handoff-summary")
}

pub fn is_publication_gap_notice_detail(value: &Value) -> bool {
    has_type(value, "publication-gap")
}

pub fn is_chat_id_disclosure_notice_detail(value: &Value) -> bool {
    has_type(value, "chat-id-disclosure")
}

fn discovery_failure_reason(value: &Value) -> Option<ChatIdDiscoveryFailureReason> {
    if !has_type(value, "chat-id-discovery-failure") {
        return None;
    }
    match value["reason"].as_str()? {
        "disabled" => Some(ChatIdDiscoveryFailureReason::Disabled),
        "delivery-failed" => Some(ChatIdDiscoveryFailureReason::DeliveryFailed),
        _ => None,
    }
}

pub fn is_chat_id_discovery_failure_notice_detail(value: &Value) -> bool {
    discovery_failure_reason(value).is_some()
}

fn inter_agent_failure_reason(value: &Value) -> Option<InterAgentMessageFailureReason> {
    use InterAgentMessageFailureReason::*;
    match value.as_str()? {
        "disabled" => Some(Disabled),
        "self-send" => Some(SelfSend),
        "target-not-found" => Some(TargetNotFound),
        "target-unavailable" => Some(TargetUnavailable),
        "queue-full" => Some(QueueFull),
        "provider-rejected" => Some(ProviderRejected),
        "delivery-unknown" => Some(DeliveryUnknown),
        "server-shutting-down" => Some(ServerShuttingDown),
        "delivery-failed" => Some(DeliveryFailed),
        _ => None,
    }
}

fn parse_inter_agent_results(value: &Value) -> Option<Vec<InterAgentMessageResult>> {
    if !has_type(value, "inter-agent-message-outcome") {
        return None;
    }
    let entries = value["results"]
        .as_array()
        .filter(|entries| (1..=16).contains(&entries.len()))?;
    let mut seen = HashSet::with_capacity(entries.len());
    entries
        .iter()
        .map(|candidate| {
            let candidate = candidate.as_object()?;
            let raw_chat_id = candidate.get("chatId")?;
            if !seen.insert(raw_chat_id.as_str()?) {
                return None;
            }
            let chat_id = parse_chat_id(raw_chat_id).ok()?;
            match candidate.get("status")?.as_str()? {
                "delivered" => Some(InterAgentMessageResult::Delivered { chat_id }),
                "queued" => Some(InterAgentMessageResult::Queued { chat_id }),
                "failed" => Some(InterAgentMessageResult::Failed {
                    chat_id,
                    reason: inter_agent_failure_reason(candidate.get("reason")?)?,
                }),
                _ => None,
            }
        })
        .collect()
}

pub fn is_inter_agent_message_outcome_notice_detail(value: &Value) -> bool {
    parse_inter_agent_results(value).is_some()
}

fn parse_inter_agent_message_sender(value: &Value) -> Option<Option<ChatId>> {
    if !has_type(value, "inter-agent-message-received") {
        return None;
    }
    let chat_id = value.get("fromChatId")?;
    if chat_id.is_null() {
        return Some(None);
    }
    parse_chat_id(chat_id).ok().map(Some)
}

pub fn is_inter_agent_message_received_notice_detail(value: &Value) -> bool {
    parse_inter_agent_message_sender(value).is_some()
}

pub fn parse_transcript_notice_detail(value: &Value) -> Option<TranscriptNoticeDetail> {
    use TranscriptNoticeDetail::*;
    if is_publication_gap_notice_detail(value) {
        return Some(PublicationGap);
    }
    if let Some(progress) = parse_agent_start_progress_notice(value) {
        return Some(AgentStartProgress(progress));
    }
    if let Some(outcome) = parse_agent_command_outcome(value) {
        return Some(AgentCommandOutcome(outcome));
    }
    if let Some(outcome) = parse_ticket_command_outcome(value) {
        return Some(TicketCommandOutcome(outcome));
    }
    if let Some(preambles) = parse_preamble_references(value, "preamble-application", 1) {
        return Some(PreambleApplication { preambles });
    }
    if let Some(preambles) = parse_preamble_references(value, "preamble-selection-changed", 0) {
        return Some(PreambleSelectionChanged { preambles });
    }
    if is_carryover_migration_quarantine_notice_detail(value) {
        return Some(CarryoverMigrationQuarantine {
            artifact_id: value["artifactId"].as_str()?.to_owned(),
            error_code: value["errorCode"].as_str()?.to_owned(),
        });
    }
    if is_handoff_summary_notice_detail(value) {
        return Some(HandoffSummary);
    }
    if is_chat_id_disclosure_notice_detail(value) {
        return Some(ChatIdDisclosure);
    }
    if let Some(reason) = discovery_failure_reason(value) {
        return Some(ChatIdDiscoveryFailure { reason });
    }
    if let Some(results) = parse_inter_agent_results(value) {
        return Some(InterAgentMessageOutcome { results });
    }
    if let Some(from_chat_id) = parse_inter_agent_message_sender(value) {
        return Some(InterAgentMessageReceived { from_chat_id });
    }
    None
}
