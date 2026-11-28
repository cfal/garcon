//! Event wiring calls settlement on its per-chat task queue after transcript
//! rows have been published, before the public terminal lifecycle events.

use std::{error::Error, rc::Rc};

use async_trait::async_trait;
use garcon_base::errors::{ErrorInput, error_metadata};
use garcon_contract::{
    agents::AgentExecutionPolicy, chat_stop::ChatStopOutcome,
    command_output::CommandWorkingDirectory,
};
use serde::Serialize;

use crate::{
    chat_execution_control_operations::ChatExecutionControlOperations,
    chat_execution_control_transitions::FailurePauseCause,
    execution_attempt::QueueExecutionAttempt,
    execution_ownership::{AdmissionAbortReason, ExecutionOwnership},
    turn_identity::{TurnCommandType, TurnIdentity, TurnReceiptOwner},
    types::{ExecutionOperationResult, execution_error_input},
};

pub trait ProducerLeaseState {
    fn closed(&self) -> bool;
}

#[derive(Clone)]
pub struct TurnExecutionSnapshot {
    pub agent_id: String,
    pub executor_id: String,
    pub project_path: String,
    pub transcript_view_id: String,
    pub producer_lease: Rc<dyn ProducerLeaseState>,
}

#[derive(Clone, Default)]
pub struct TurnEventMetadata {
    pub client_request_id: Option<String>,
    pub client_message_id: Option<String>,
    pub command_type: Option<TurnCommandType>,
    pub upstream_request_id: Option<String>,
    pub turn_id: Option<String>,
    pub agent_ownership_epoch: Option<String>,
    pub turn_owner: Option<TurnReceiptOwner>,
    pub entry_ids: Option<Vec<String>>,
    pub execution_snapshot: Option<TurnExecutionSnapshot>,
    pub working_directory: Option<CommandWorkingDirectory>,
}

impl TurnEventMetadata {
    fn identity(&self) -> TurnIdentity {
        TurnIdentity {
            turn_id: self.turn_id.clone(),
            client_request_id: self.client_request_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkingDirectorySettlement {
    Settled,
    Failed { message: String },
}

#[async_trait(?Send)]
pub trait WorkingDirectorySettlementPort {
    async fn settle(
        &self,
        chat_id: &str,
        turn: &TurnEventMetadata,
        is_current: &dyn Fn() -> bool,
    ) -> ExecutionOperationResult<WorkingDirectorySettlement>;
}

#[async_trait(?Send)]
pub trait InterruptAgentTurnHost {
    async fn abort_session(&self, chat_id: &str) -> ExecutionOperationResult<bool>;
    fn retire(
        &self,
        chat_id: &str,
        attempt: &Rc<QueueExecutionAttempt>,
        reason: &AdmissionAbortReason,
    ) -> ExecutionOperationResult<()>;
}

#[async_trait(?Send)]
pub trait TerminalSettlementHost {
    fn execution_policy(&self, chat_id: &str) -> ExecutionOperationResult<AgentExecutionPolicy>;
    fn retire(
        &self,
        chat_id: &str,
        attempt: &Rc<QueueExecutionAttempt>,
    ) -> ExecutionOperationResult<()>;
    async fn check_idle(&self, chat_id: &str) -> ExecutionOperationResult<()>;
}

#[async_trait(?Send)]
pub trait TerminalSettlementControl {
    async fn pause_after_failure(
        &self,
        chat_id: &str,
        cause: &FailurePauseCause,
    ) -> ExecutionOperationResult<()>;
}

#[async_trait(?Send)]
impl TerminalSettlementControl for ChatExecutionControlOperations {
    async fn pause_after_failure(
        &self,
        chat_id: &str,
        cause: &FailurePauseCause,
    ) -> ExecutionOperationResult<()> {
        ChatExecutionControlOperations::pause_after_failure(self, chat_id, cause).await
    }
}

pub struct TerminalSettlementDependencies<'a> {
    pub ownership: &'a ExecutionOwnership,
    pub control: &'a dyn TerminalSettlementControl,
    pub working_directory: Option<&'a dyn WorkingDirectorySettlementPort>,
    pub host: &'a dyn TerminalSettlementHost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTurnSettlementOutcome {
    Finished,
    Failed,
}

pub async fn interrupt_agent_turn(
    ownership: &ExecutionOwnership,
    host: &dyn InterruptAgentTurnHost,
    chat_id: &str,
) -> ExecutionOperationResult<ChatStopOutcome> {
    let attempt = ownership.attempt(chat_id);
    if attempt
        .as_ref()
        .is_some_and(|attempt| attempt.has_terminal_commit())
    {
        return Ok(ChatStopOutcome::AlreadyIdle);
    }
    let interruption: AdmissionAbortReason = Rc::new(Box::new(std::io::Error::other(
        "Turn interrupted by the user",
    )));
    if attempt.is_some() {
        ownership.abort_admission(chat_id, &interruption);
    }
    let acknowledged = host.abort_session(chat_id).await?;
    if !acknowledged && attempt.is_none() {
        return Ok(ChatStopOutcome::AlreadyIdle);
    }
    if let Some(attempt) = attempt
        && ownership.is_current_attempt(chat_id, &attempt)
    {
        host.retire(chat_id, &attempt, &interruption)?;
    }
    Ok(ChatStopOutcome::InterruptRequested)
}

pub async fn settle_agent_turn(
    deps: TerminalSettlementDependencies<'_>,
    chat_id: &str,
    turn: Option<&TurnEventMetadata>,
    outcome: AgentTurnSettlementOutcome,
) -> ExecutionOperationResult<WorkingDirectorySettlement> {
    let identity = turn.map(TurnEventMetadata::identity);
    let Some(attempt) = deps
        .ownership
        .attempt(chat_id)
        .filter(|attempt| attempt.matches(identity.as_ref()))
    else {
        deps.host.check_idle(chat_id).await?;
        return Ok(WorkingDirectorySettlement::Settled);
    };
    let is_current = || deps.ownership.is_current_attempt(chat_id, &attempt);
    let settlement = if let (Some(turn), Some(port)) = (turn, deps.working_directory) {
        match port.settle(chat_id, turn, &is_current).await {
            Ok(settlement) => settlement,
            Err(error) => WorkingDirectorySettlement::Failed {
                message: format!(
                    "Command completion could not be synchronized: {}",
                    string_error(error.as_ref())
                ),
            },
        }
    } else {
        WorkingDirectorySettlement::Settled
    };
    if !is_current() {
        return Ok(settlement);
    }
    let settlement_failed = matches!(settlement, WorkingDirectorySettlement::Failed { .. });
    if outcome == AgentTurnSettlementOutcome::Failed || settlement_failed {
        if let Some(entry_id) = attempt.entry_id.as_ref().filter(|id| !id.is_empty()) {
            deps.control
                .pause_after_failure(
                    chat_id,
                    &FailurePauseCause::QueuedTurnFailed {
                        entry_id: entry_id.clone(),
                    },
                )
                .await?;
        } else if (deps.host.execution_policy(chat_id)? == AgentExecutionPolicy::Literal
            || settlement_failed)
            && let Some(turn_id) = turn
                .and_then(|turn| turn.turn_id.as_ref())
                .filter(|id| !id.is_empty())
        {
            deps.control
                .pause_after_failure(
                    chat_id,
                    &FailurePauseCause::TurnFailed {
                        turn_id: turn_id.clone(),
                    },
                )
                .await?;
        }
    }
    if is_current() {
        deps.host.retire(chat_id, &attempt)?;
    }
    Ok(settlement)
}

fn string_error(error: &(dyn Error + 'static)) -> String {
    let name = match execution_error_input(error) {
        ErrorInput::Diagnostic(error) => error.diagnostic_metadata().name,
        _ => error_metadata(error).name,
    };
    let message = error.to_string();
    if message.is_empty() {
        name.to_owned()
    } else {
        format!("{name}: {message}")
    }
}
