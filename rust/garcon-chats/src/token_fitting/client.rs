//! Carryover client of `token-fitting/client.ts`. The fork-handoff unit
//! adds the separate handoff-artifact rendering operation.

use std::sync::Arc;

use async_trait::async_trait;
use garcon_contract::{chat_types::ChatMessage, transcript_seed::CarriedContext};
use tokio_util::sync::CancellationToken;

use crate::task_worker::{TaskWorker, TaskWorkerError};

use super::{
    carryover::{CarryoverAssessment, CompactionDestination, CompactionPromptFit},
    tasks::{
        TokenFittingJob, TokenFittingResult, TokenFittingTask, TokenFittingTaskError,
        run_token_fitting_task,
    },
};

pub type TokenFittingError = TaskWorkerError<TokenFittingTaskError>;

#[async_trait(?Send)]
pub trait TokenFitting {
    async fn assess_carryover(
        &self,
        messages: Arc<Vec<ChatMessage>>,
        signal: Option<&CancellationToken>,
    ) -> Result<CarryoverAssessment, TokenFittingError>;

    async fn fit_compaction_prompt(
        &self,
        messages: Arc<Vec<ChatMessage>>,
        destination: CompactionDestination,
        context_window_tokens: f64,
        maximum_entry_budget_tokens: Option<f64>,
        signal: Option<&CancellationToken>,
    ) -> Result<CompactionPromptFit, TokenFittingError>;

    async fn project_compacted_carryover(
        &self,
        messages: Arc<Vec<ChatMessage>>,
        summary: String,
        signal: Option<&CancellationToken>,
    ) -> Result<CarriedContext, TokenFittingError>;
}

pub struct TokenFittingWorker {
    worker: TaskWorker<TokenFittingJob, TokenFittingResult, TokenFittingTaskError>,
}

impl Default for TokenFittingWorker {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenFittingWorker {
    pub fn new() -> Self {
        Self {
            worker: TaskWorker::new("token-fitting", "Token fitting", run_token_fitting_task),
        }
    }

    pub fn close(&self) {
        self.worker.close();
    }
}

#[async_trait(?Send)]
impl TokenFitting for TokenFittingWorker {
    async fn assess_carryover(
        &self,
        messages: Arc<Vec<ChatMessage>>,
        signal: Option<&CancellationToken>,
    ) -> Result<CarryoverAssessment, TokenFittingError> {
        match self
            .worker
            .run(
                TokenFittingJob {
                    task: TokenFittingTask::AssessCarryover,
                    messages,
                },
                signal,
            )
            .await?
        {
            TokenFittingResult::Assessment(assessment) => Ok(assessment),
            _ => Err(TaskWorkerError::Task(TokenFittingTaskError::InvalidEvent)),
        }
    }

    async fn fit_compaction_prompt(
        &self,
        messages: Arc<Vec<ChatMessage>>,
        destination: CompactionDestination,
        context_window_tokens: f64,
        maximum_entry_budget_tokens: Option<f64>,
        signal: Option<&CancellationToken>,
    ) -> Result<CompactionPromptFit, TokenFittingError> {
        let task = TokenFittingTask::FitCompactionPrompt {
            destination,
            context_window_tokens,
            maximum_entry_budget_tokens,
        };
        match self
            .worker
            .run(TokenFittingJob { task, messages }, signal)
            .await?
        {
            TokenFittingResult::Prompt(prompt) => Ok(prompt),
            _ => Err(TaskWorkerError::Task(TokenFittingTaskError::InvalidEvent)),
        }
    }

    async fn project_compacted_carryover(
        &self,
        messages: Arc<Vec<ChatMessage>>,
        summary: String,
        signal: Option<&CancellationToken>,
    ) -> Result<CarriedContext, TokenFittingError> {
        let task = TokenFittingTask::ProjectCompactedCarryover { summary };
        match self
            .worker
            .run(TokenFittingJob { task, messages }, signal)
            .await?
        {
            TokenFittingResult::Context(context) => Ok(context),
            _ => Err(TaskWorkerError::Task(TokenFittingTaskError::InvalidEvent)),
        }
    }
}
