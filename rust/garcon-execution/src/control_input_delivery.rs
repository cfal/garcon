use std::{error::Error, rc::Rc};

use async_trait::async_trait;
use garcon_contract::error_codes::ErrorCode;
use tokio_util::sync::CancellationToken;

use crate::{
    execution_errors::execution_domain_error,
    types::{CapturedControlOffer, CapturedSteerTarget, ExecutionOperationResult},
};

pub type ControlRunReserved<'a> = Box<dyn FnOnce(&str) -> ExecutionOperationResult<()> + 'a>;

#[derive(Clone, Copy)]
pub struct ControlInputSignal<'a> {
    pub token: &'a CancellationToken,
    pub reason: &'a dyn Fn() -> Box<dyn Error>,
}

impl ControlInputSignal<'_> {
    fn check(self) -> ExecutionOperationResult<()> {
        if self.token.is_cancelled() {
            Err((self.reason)())
        } else {
            Ok(())
        }
    }
}

#[async_trait(?Send)]
pub trait ControlInputDeliveryOptions {
    async fn capture_target(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<Option<CapturedSteerTarget>>;
    async fn deliver_steer(
        &self,
        chat_id: &str,
        content: &str,
        transcript_view_id: &str,
        target: &CapturedSteerTarget,
    ) -> ExecutionOperationResult<()>;
    async fn schedule_run(
        &self,
        chat_id: &str,
        content: &str,
        transcript_view_id: &str,
        on_reserved: ControlRunReserved<'_>,
    ) -> ExecutionOperationResult<()>;
}

pub struct ControlInputDelivery {
    options: Rc<dyn ControlInputDeliveryOptions>,
}

impl ControlInputDelivery {
    pub fn new(options: Rc<dyn ControlInputDeliveryOptions>) -> Self {
        Self { options }
    }

    pub async fn offer_to_captured_target(
        &self,
        chat_id: &str,
        content: &str,
        transcript_view_id: &str,
        target: &CapturedSteerTarget,
        signal: ControlInputSignal<'_>,
    ) -> ExecutionOperationResult<CapturedControlOffer> {
        signal.check()?;
        if target.provider_target.is_some() {
            match self
                .options
                .deliver_steer(chat_id, content, transcript_view_id, target)
                .await
            {
                Ok(()) => return Ok(CapturedControlOffer::Delivered),
                Err(error) => {
                    signal.check()?;
                    if !is_definitive_control_non_delivery(error.as_ref()) {
                        return Err(error);
                    }
                }
            }
        }
        Ok(CapturedControlOffer::AfterTurn {
            attempt: target.attempt.clone(),
        })
    }

    pub async fn deliver(
        &self,
        chat_id: &str,
        content: &str,
        transcript_view_id: &str,
        emitting_run_id: Option<&str>,
        signal: ControlInputSignal<'_>,
        on_control_run: ControlRunReserved<'_>,
    ) -> ExecutionOperationResult<()> {
        signal.check()?;
        let target = if let Some(run_id) = emitting_run_id {
            self.options
                .capture_target(chat_id)
                .await?
                .filter(|target| target.turn_id == run_id)
        } else {
            None
        };
        if let Some(target) = target {
            match self
                .offer_to_captured_target(chat_id, content, transcript_view_id, &target, signal)
                .await?
            {
                CapturedControlOffer::Delivered => return Ok(()),
                CapturedControlOffer::AfterTurn { attempt } => {
                    tokio::select! {
                        biased;
                        () = signal.token.cancelled() => return Err((signal.reason)()),
                        () = attempt.wait_until_settled() => {},
                    }
                }
            }
        }
        signal.check()?;
        self.options
            .schedule_run(chat_id, content, transcript_view_id, on_control_run)
            .await
    }
}

fn is_definitive_control_non_delivery(error: &(dyn Error + 'static)) -> bool {
    execution_domain_error(error).is_some_and(|domain| {
        matches!(
            domain.code,
            ErrorCode::STEER_TURN_UNAVAILABLE
                | ErrorCode::STEER_TURN_CHANGED
                | ErrorCode::STEER_TURN_NOT_STEERABLE
                | ErrorCode::OPERATION_UNSUPPORTED
                | ErrorCode::EXECUTOR_UNAVAILABLE
                | ErrorCode::STEER_NOT_DELIVERED
        )
    })
}
