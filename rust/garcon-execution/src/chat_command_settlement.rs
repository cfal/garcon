use std::{error::Error, rc::Rc};

use async_trait::async_trait;
use garcon_contract::{chat_command_contracts::SteerDeliveryOutcome, error_codes::ErrorCode};
use garcon_js::json::Opaque;
use serde_json::{Map, Value};

use crate::{
    command_ledger::{
        CommandLedger, CommandLedgerChange as Change, CommandLedgerDetail as Detail,
        CommandLedgerStatus as Status, CommandTerminalStatus, PRE_SCHEDULE_FAILURE_ERROR_CODE,
    },
    execution_errors::execution_domain_error,
    runtime_router_errors::public_dispatch_failure,
    types::{
        AcceptedExecutionCommand, CommandSettlementPort, ExecutionOperationResult,
        PreScheduleFailure, QueueEntryMutationError,
    },
};

pub struct ChatCommandSettlement {
    ledger: Rc<CommandLedger>,
}

impl ChatCommandSettlement {
    pub fn new(ledger: Rc<CommandLedger>) -> Self {
        Self { ledger }
    }
}

#[async_trait(?Send)]
impl CommandSettlementPort for ChatCommandSettlement {
    async fn mark_scheduled(
        &self,
        command: &AcceptedExecutionCommand,
        turn_id: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        self.ledger
            .update(
                &command.key,
                [
                    Change::Status(Status::Scheduled),
                    Change::TurnId(turn_id.map(str::to_owned)),
                    Change::Detail(Detail::ForkPreparation(None)),
                ],
            )
            .await?;
        Ok(())
    }

    async fn mark_pre_schedule_failure(
        &self,
        command: &AcceptedExecutionCommand,
        failure: PreScheduleFailure<'_>,
    ) -> ExecutionOperationResult<()> {
        let code = if failure.retryable {
            Some(PRE_SCHEDULE_FAILURE_ERROR_CODE)
        } else {
            execution_domain_error(failure.error).map(|domain| domain.code.as_str())
        };
        let mut patch = vec![
            Change::Status(Status::Failed),
            Change::Detail(Detail::Error(Some(failure.error.to_string()))),
            Change::Detail(Detail::ErrorCode(code.map(str::to_owned))),
            Change::Payload(Opaque::from_value(Value::Object(Map::new()))),
            Change::Detail(Detail::RetainedPrivateTerminal(Some(true))),
        ];
        if !failure.preserve_fork_preparation {
            patch.push(Change::Detail(Detail::ForkPreparation(None)));
        }
        self.ledger.update(&command.key, patch).await?;
        Ok(())
    }

    async fn settle_queue_mutation(
        &self,
        command: &AcceptedExecutionCommand,
        entry_id: &str,
    ) -> ExecutionOperationResult<()> {
        self.ledger
            .update(
                &command.key,
                [
                    Change::Status(Status::Finished),
                    Change::EntryId(Some(entry_id.into())),
                ],
            )
            .await?;
        Ok(())
    }

    async fn settle_queue_mutation_failure(
        &self,
        command: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
    ) -> ExecutionOperationResult<()> {
        let mutation = error.downcast_ref::<QueueEntryMutationError>();
        self.ledger
            .update(
                &command.key,
                [
                    Change::Status(if mutation.is_some() {
                        Status::Rejected
                    } else {
                        Status::Failed
                    }),
                    Change::Detail(Detail::Error(Some(error.to_string()))),
                    Change::Detail(Detail::ErrorCode(Some(
                        mutation
                            .map_or(PRE_SCHEDULE_FAILURE_ERROR_CODE, |error| {
                                error.domain.code.as_str()
                            })
                            .into(),
                    ))),
                ],
            )
            .await?;
        Ok(())
    }

    async fn settle_steer_success(
        &self,
        command: &AcceptedExecutionCommand,
        turn_id: &str,
    ) -> ExecutionOperationResult<()> {
        self.ledger
            .update(
                &command.key,
                [
                    Change::Status(Status::Finished),
                    Change::TurnId(Some(turn_id.into())),
                    Change::EntryId(command.entry_id.clone()),
                    Change::Detail(Detail::Error(None)),
                    Change::Detail(Detail::ErrorCode(None)),
                    Change::Detail(Detail::DeliveryOutcome(None)),
                ],
            )
            .await?;
        Ok(())
    }

    async fn settle_steer_failure(
        &self,
        command: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
        delivery_outcome: Option<SteerDeliveryOutcome>,
    ) -> ExecutionOperationResult<()> {
        let domain = execution_domain_error(error);
        self.ledger
            .update(
                &command.key,
                [
                    Change::Status(if domain.is_some_and(|domain| domain.status < 500) {
                        Status::Rejected
                    } else {
                        Status::Failed
                    }),
                    Change::Detail(Detail::Error(Some(error.to_string()))),
                    Change::Detail(Detail::ErrorCode(Some(
                        domain
                            .map_or(ErrorCode::INTERNAL_ERROR, |domain| domain.code)
                            .as_str()
                            .into(),
                    ))),
                    Change::EntryId(command.entry_id.clone()),
                    Change::Detail(Detail::DeliveryOutcome(delivery_outcome)),
                ],
            )
            .await?;
        Ok(())
    }

    async fn settle_operation_failure(
        &self,
        command: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
    ) -> ExecutionOperationResult<()> {
        let dispatch_failure = public_dispatch_failure(error);
        self.ledger
            .settle_terminal(
                &command.key,
                CommandTerminalStatus::Failed,
                [
                    Change::Detail(Detail::Error(Some(dispatch_failure.error))),
                    Change::Detail(Detail::ErrorCode(Some(
                        dispatch_failure.error_code.as_str().into(),
                    ))),
                ],
            )
            .await?;
        Ok(())
    }

    async fn settle_duplicate_input(
        &self,
        command: &AcceptedExecutionCommand,
    ) -> ExecutionOperationResult<()> {
        self.ledger
            .settle_terminal(&command.key, CommandTerminalStatus::Finished, [])
            .await?;
        Ok(())
    }
}
