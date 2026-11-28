use garcon_contract::{
    agent_turn_receipt::{
        AgentTurnInterruptionReason, AgentTurnOutput, AgentTurnOutputAvailable,
        AgentTurnOutputCompleteness, AgentTurnOutputUnavailable, AgentTurnOutputUnavailableReason,
        AgentTurnReceipt, AgentTurnReceiptBase, CompletedAgentTurnReceipt, FailedAgentTurnReceipt,
        InterruptedAgentTurnReceipt, PendingAgentTurnReceipt,
    },
    error_codes::{ErrorCode, is_error_code},
};
use serde::Serialize;
use serde_json::Value;

use crate::command_ledger::{
    CommandLedgerRecord, CommandLedgerStatus, CommandTurnResult, InterruptionReason,
    UnavailableTurnResultReason,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AgentTurnReceiptProjection {
    Found { receipt: AgentTurnReceipt },
    Expired,
}

pub fn project_agent_turn_receipt(record: &CommandLedgerRecord) -> AgentTurnReceiptProjection {
    if matches!(
        record.turn_result(),
        Some(CommandTurnResult::Unavailable {
            reason: UnavailableTurnResultReason::Expired,
        })
    ) {
        return AgentTurnReceiptProjection::Expired;
    }
    let base = AgentTurnReceiptBase {
        chat_id: record.chat_id.clone(),
        turn_id: record.turn_id.clone().unwrap_or_default(),
        client_request_id: record.client_request_id.clone(),
        accepted_at: record.accepted_at.clone(),
        updated_at: record.updated_at.clone(),
    };
    let Some(settled_at) = record.public_terminal_at().filter(|at| !at.is_empty()) else {
        return AgentTurnReceiptProjection::Found {
            receipt: AgentTurnReceipt::Pending(PendingAgentTurnReceipt::new(base)),
        };
    };
    let receipt = if let Some(reason) = record.interruption_reason() {
        let reason = match reason {
            InterruptionReason::UserStop => AgentTurnInterruptionReason::UserStop,
            InterruptionReason::ChatDeleted => AgentTurnInterruptionReason::ChatDeleted,
        };
        AgentTurnReceipt::Interrupted(InterruptedAgentTurnReceipt::new(
            base,
            settled_at.clone(),
            reason,
        ))
    } else if matches!(
        record.status,
        CommandLedgerStatus::Failed | CommandLedgerStatus::Rejected
    ) {
        AgentTurnReceipt::Failed(FailedAgentTurnReceipt::new(
            base,
            settled_at.clone(),
            record
                .error()
                .cloned()
                .unwrap_or_else(|| "Agent turn failed".into()),
            record
                .error_code()
                .and_then(|code| is_error_code(&Value::String(code.clone())))
                .unwrap_or(ErrorCode::INTERNAL_ERROR),
        ))
    } else {
        AgentTurnReceipt::Completed(CompletedAgentTurnReceipt::new(
            base,
            settled_at.clone(),
            project_output(record),
        ))
    };
    AgentTurnReceiptProjection::Found { receipt }
}

fn project_output(record: &CommandLedgerRecord) -> AgentTurnOutput {
    use AgentTurnOutputUnavailableReason as OutputReason;
    use UnavailableTurnResultReason as LedgerReason;
    let unavailable =
        |reason| AgentTurnOutput::Unavailable(AgentTurnOutputUnavailable::new(reason));
    if record.status != CommandLedgerStatus::Finished || record.interruption_reason().is_some() {
        return unavailable(OutputReason::NoFinalResponse);
    }
    match record.turn_result() {
        None => unavailable(OutputReason::NoFinalResponse),
        Some(CommandTurnResult::Unavailable { reason }) => unavailable(match reason {
            LedgerReason::NoFinalResponse | LedgerReason::Expired => OutputReason::NoFinalResponse,
            LedgerReason::TooLarge => OutputReason::TooLarge,
            LedgerReason::RetentionPressure => OutputReason::RetentionPressure,
        }),
        Some(CommandTurnResult::Available { text, .. }) => AgentTurnOutput::Available(
            AgentTurnOutputAvailable::new(AgentTurnOutputCompleteness::Complete, text.clone()),
        ),
    }
}
