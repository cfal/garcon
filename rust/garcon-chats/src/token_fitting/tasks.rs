//! Carryover tasks from `token-fitting/tasks.ts`. The fork-handoff unit adds
//! handoff-artifact rendering from stored ledger rows.

use std::sync::Arc;

use garcon_base::keyed_lock::LockAborted;
use garcon_contract::{chat_types::ChatMessage, transcript_seed::CarriedContext};
use tokio_util::sync::CancellationToken;

use super::carryover::{
    CarryoverAssessment, CompactionDestination, CompactionProjectionError, CompactionPromptFit,
    CompactionPromptInput, assess_carryover, fit_compaction_prompt, project_compacted_carryover,
};

pub(super) enum TokenFittingTask {
    AssessCarryover,
    ProjectCompactedCarryover {
        summary: String,
    },
    FitCompactionPrompt {
        destination: CompactionDestination,
        context_window_tokens: f64,
        maximum_entry_budget_tokens: Option<f64>,
    },
}

pub(super) struct TokenFittingJob {
    pub task: TokenFittingTask,
    pub messages: Arc<Vec<ChatMessage>>,
}

pub(super) enum TokenFittingResult {
    Assessment(CarryoverAssessment),
    Prompt(CompactionPromptFit),
    Context(CarriedContext),
}

#[derive(Debug, thiserror::Error)]
pub enum TokenFittingTaskError {
    #[error(transparent)]
    Aborted(#[from] LockAborted),
    #[error(transparent)]
    Projection(#[from] CompactionProjectionError),
    #[error("Token fitting worker sent an invalid event")]
    InvalidEvent,
}

pub(super) fn run_token_fitting_task(
    job: TokenFittingJob,
    stop: &CancellationToken,
) -> Result<TokenFittingResult, TokenFittingTaskError> {
    if stop.is_cancelled() {
        return Err(LockAborted.into());
    }
    let result = match job.task {
        TokenFittingTask::AssessCarryover => TokenFittingResult::Assessment(
            assess_carryover(&job.messages).map_err(CompactionProjectionError::from)?,
        ),
        TokenFittingTask::FitCompactionPrompt {
            destination,
            context_window_tokens,
            maximum_entry_budget_tokens,
        } => TokenFittingResult::Prompt(
            fit_compaction_prompt(CompactionPromptInput {
                messages: &job.messages,
                destination: &destination,
                context_window_tokens,
                maximum_entry_budget_tokens,
            })
            .map_err(CompactionProjectionError::from)?,
        ),
        TokenFittingTask::ProjectCompactedCarryover { summary } => {
            TokenFittingResult::Context(project_compacted_carryover(&job.messages, &summary)?)
        }
    };
    if stop.is_cancelled() {
        return Err(LockAborted.into());
    }
    Ok(result)
}
