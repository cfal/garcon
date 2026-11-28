use std::{cell::Cell, rc::Rc};

use async_trait::async_trait;
use garcon_base::{domain_error::DomainError, executor_disconnect::as_agent_call_error};
use garcon_contract::error_codes::ErrorCode;
use garcon_interface::{
    errors::AgentDeliveryOutcome,
    services::{AgentSteerFailureOutcome, AgentSteerRejectionReason, AgentSteerResult},
};

use crate::{
    accepted_input_handler::AcceptedSteerDelivery,
    execution_errors::execution_domain_error,
    execution_ownership::ExecutionOwnership,
    session_types::AgentSteerOptions,
    steering_errors::{SteerDeliveryError, SteerDeliveryFailureOutcome, steer_turn_changed_error},
    types::{
        AcceptedSteerOutcome, AgentTurnRunnerPort, CapturedSteerTarget, ExecutionOperationResult,
        UserInputAdmissionOptions, UserInputCommandType,
    },
};

#[async_trait(?Send)]
pub trait SteerInputDeliveryHost {
    fn is_shutting_down(&self) -> bool;
    async fn admit_input(
        &self,
        chat_id: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool>;
    fn discard_prepared_input(
        &self,
        chat_id: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()>;
}

pub struct SteerInputDeliveryOptions {
    pub turn_runner: Rc<dyn AgentTurnRunnerPort>,
    pub ownership: Rc<ExecutionOwnership>,
    pub host: Rc<dyn SteerInputDeliveryHost>,
}

pub struct SteerInputDelivery {
    options: SteerInputDeliveryOptions,
    new_id: Box<dyn Fn() -> String>,
}

impl SteerInputDelivery {
    pub fn new(options: SteerInputDeliveryOptions, new_id: impl Fn() -> String + 'static) -> Self {
        Self {
            options,
            new_id: Box::new(new_id),
        }
    }

    pub async fn capture_target(
        &self,
        chat_id: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<Option<CapturedSteerTarget>> {
        let Some(mut captured) = self.capture_attempt(chat_id, deadline) else {
            return Ok(None);
        };
        captured.provider_target = self
            .options
            .turn_runner
            .capture_steer_target(chat_id, deadline)
            .await?;
        Ok(Some(captured))
    }

    pub async fn capture_control_target(
        &self,
        chat_id: &str,
        deadline: Option<f64>,
    ) -> Option<CapturedSteerTarget> {
        let mut captured = self.capture_attempt(chat_id, deadline)?;
        // Capture cannot send input; fallback still waits for the captured attempt.
        captured.provider_target = self
            .options
            .turn_runner
            .capture_steer_target(chat_id, deadline)
            .await
            .ok()
            .flatten();
        Some(captured)
    }

    fn capture_attempt(&self, chat_id: &str, deadline: Option<f64>) -> Option<CapturedSteerTarget> {
        let attempt = self.options.ownership.attempt(chat_id)?;
        let identity = attempt.identity();
        if attempt.is_settled() {
            return None;
        }
        Some(CapturedSteerTarget {
            attempt,
            turn_id: identity.turn_id.filter(|id| !id.is_empty())?,
            client_request_id: identity.client_request_id,
            provider_target: None,
            deadline,
        })
    }

    pub async fn deliver(
        &self,
        input: AcceptedSteerDelivery<'_>,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome> {
        let AcceptedSteerDelivery {
            chat_id,
            content,
            provider_content,
            options,
            target,
            after_pending_registered,
            user_message_presentation,
        } = input;
        let mut inserted = false;
        let result: ExecutionOperationResult<_> = async {
            self.assert_target(chat_id, target)?;
            if target.provider_target.is_none() {
                return Err(Box::new(steer_turn_not_ready_error()) as Box<dyn std::error::Error>);
            }
            inserted = self
                .options
                .host
                .admit_input(
                    chat_id,
                    content,
                    &UserInputAdmissionOptions {
                        client_request_id: Some(options.client_request_id.clone()),
                        client_message_id: Some(options.client_message_id.clone()),
                        transcript_view_id: Some(options.transcript_view_id.clone()),
                        turn_id: Some(target.turn_id.clone()),
                        command_type: Some(UserInputCommandType::Steer),
                        question_reply: options.question_reply.clone(),
                        user_message_presentation,
                        ..Default::default()
                    },
                )
                .await?;
            if inserted {
                after_pending_registered(target.turn_id.clone()).await?;
                self.deliver_to_provider(chat_id, provider_content, &options, target)
                    .await?;
            }
            Ok(AcceptedSteerOutcome {
                turn_id: target.turn_id.clone(),
                duplicate: !inserted,
            })
        }
        .await;
        let result = result.map_err(|error| {
            let domain = execution_domain_error(error.as_ref());
            let admitted_question_with_stale_target = inserted
                && options.question_reply.is_some()
                && domain.is_some_and(|error| {
                    matches!(
                        error.code,
                        ErrorCode::STEER_TURN_CHANGED | ErrorCode::STEER_TURN_UNAVAILABLE
                    )
                });
            if domain.is_none() || admitted_question_with_stale_target {
                Box::new(SteerDeliveryError::new(
                    error,
                    SteerDeliveryFailureOutcome::NotSent,
                ))
            } else {
                error
            }
        });
        if inserted {
            self.options
                .host
                .discard_prepared_input(chat_id, Some(&options.client_message_id))?;
        }
        result
    }

    pub async fn deliver_control(
        &self,
        chat_id: &str,
        content: &str,
        transcript_view_id: &str,
        target: &CapturedSteerTarget,
    ) -> ExecutionOperationResult<()> {
        let client_message_id = (self.new_id)();
        self.deliver_to_provider(
            chat_id,
            content,
            &AgentSteerOptions {
                question_reply: None,
                client_request_id: client_message_id.clone(),
                client_message_id,
                transcript_view_id: transcript_view_id.into(),
            },
            target,
        )
        .await
    }

    async fn deliver_to_provider(
        &self,
        chat_id: &str,
        content: &str,
        options: &AgentSteerOptions,
        target: &CapturedSteerTarget,
    ) -> ExecutionOperationResult<()> {
        self.assert_target(chat_id, target)?;
        let prepared = Cell::new(false);
        let result = self
            .options
            .turn_runner
            .steer_input(
                chat_id,
                content,
                options,
                target.provider_target.as_ref(),
                Box::new(|| {
                    Box::pin(async {
                        self.assert_target(chat_id, target)?;
                        prepared.set(true);
                        Ok(())
                    })
                }),
                target.deadline,
            )
            .await;
        match result {
            Ok(AgentSteerResult::Accepted) if prepared.get() => Ok(()),
            Ok(AgentSteerResult::Accepted) => Err(Box::new(SteerDeliveryError::new(
                Box::new(std::io::Error::other(
                    "Agent accepted steering without preparing delivery",
                )),
                SteerDeliveryFailureOutcome::Unknown,
            ))),
            Ok(AgentSteerResult::Rejected { reason, .. }) => {
                Err(Box::new(steer_rejection_error(reason)))
            }
            Ok(AgentSteerResult::Failed { outcome, message }) => {
                Err(Box::new(SteerDeliveryError::new(
                    Box::new(std::io::Error::other(message)),
                    match outcome {
                        AgentSteerFailureOutcome::NotSent => SteerDeliveryFailureOutcome::NotSent,
                        AgentSteerFailureOutcome::Unknown => SteerDeliveryFailureOutcome::Unknown,
                    },
                )))
            }
            Err(error) if execution_domain_error(error.as_ref()).is_some() => Err(error),
            Err(error) => {
                let uncertain = as_agent_call_error(error.as_ref()).map_or_else(
                    || prepared.get(),
                    |error| error.outcome == AgentDeliveryOutcome::Unknown,
                );
                Err(Box::new(SteerDeliveryError::new(
                    error,
                    if uncertain {
                        SteerDeliveryFailureOutcome::Unknown
                    } else {
                        SteerDeliveryFailureOutcome::NotSent
                    },
                )))
            }
        }
    }

    fn assert_target(
        &self,
        chat_id: &str,
        target: &CapturedSteerTarget,
    ) -> Result<(), DomainError> {
        if self.options.host.is_shutting_down() {
            return Err(DomainError::new(
                ErrorCode::SERVER_SHUTTING_DOWN,
                "The server is shutting down",
                503,
                false,
            ));
        }
        if !self
            .options
            .ownership
            .is_current_attempt(chat_id, &target.attempt)
            || target.attempt.is_settled()
        {
            return Err(steer_turn_changed_error());
        }
        let identity = target.attempt.identity();
        if identity.turn_id.as_deref() != Some(target.turn_id.as_str())
            || identity.client_request_id != target.client_request_id
        {
            return Err(steer_turn_changed_error());
        }
        Ok(())
    }
}

fn steer_turn_not_ready_error() -> DomainError {
    DomainError::new(
        ErrorCode::STEER_TURN_UNAVAILABLE,
        "The active turn cannot take steering input yet",
        409,
        false,
    )
}

fn steer_rejection_error(reason: AgentSteerRejectionReason) -> DomainError {
    use AgentSteerRejectionReason::*;
    let (code, message, status) = match reason {
        NoActiveTurn => (
            ErrorCode::STEER_TURN_UNAVAILABLE,
            "There is no active turn to steer",
            409,
        ),
        TurnChanged => return steer_turn_changed_error(),
        TurnNotSteerable => (
            ErrorCode::STEER_TURN_NOT_STEERABLE,
            "This kind of active turn cannot be steered",
            409,
        ),
        InvalidInput => (
            ErrorCode::VALIDATION_FAILED,
            "The steering input is invalid",
            400,
        ),
        ProviderRejected => (
            ErrorCode::STEER_PROVIDER_REJECTED,
            "The agent rejected this steering input",
            409,
        ),
    };
    DomainError::new(code, message, status, false)
}
