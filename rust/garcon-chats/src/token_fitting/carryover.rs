//! Ports `server/controller/chats/token-fitting/carryover.ts`.

use std::borrow::Cow;

use garcon_contract::{
    chat_types::ChatMessage,
    handoff_sizing::{
        SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS, usable_handoff_token_budget,
    },
    transcript_seed::{
        CARRYOVER_INJECTION_MAX_CHARS, CarriedContext, CarriedContextBudgetTooSmall,
        CostedCarriedContext, ProjectionCostBudget, RECENT_TURNS_VERBATIM,
        create_carryover_transcript, create_carryover_transcript_within_cost,
        is_projectable_message, is_publication_gap_message,
    },
};
use garcon_js::{Number, utf16};
use serde::Serialize;

use super::budget::{TokenDocumentBudget, estimate_handoff_tokens, fit_estimated_token_document};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionDestination {
    pub agent_id: String,
    pub model: String,
    pub prompt: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CarryoverAssessment {
    NoHistory,
    Complete { context: CarriedContext },
    NeedsCompaction,
}

pub struct CompactionPromptInput<'a> {
    pub messages: &'a [ChatMessage],
    pub destination: &'a CompactionDestination,
    pub context_window_tokens: f64,
    pub maximum_entry_budget_tokens: Option<f64>,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompactionPromptUnavailableReason {
    RecentTurnsFillCarryover,
    HistoryInsideRecentTurns,
    RecentTurnsUnprojectable,
    PromptExceedsWindow,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CompactionPromptFit {
    Fitted {
        prompt: String,
        entry_budget_tokens: Number,
    },
    Unavailable {
        reason: CompactionPromptUnavailableReason,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum CompactionProjectionError {
    #[error(transparent)]
    Budget(#[from] CarriedContextBudgetTooSmall),
    #[error(
        "Agent-switch compaction produced a summary too large for the {CARRYOVER_INJECTION_MAX_CHARS} character carryover limit"
    )]
    SummaryTooLarge,
}

pub fn assess_carryover(
    messages: &[ChatMessage],
) -> Result<CarryoverAssessment, CarriedContextBudgetTooSmall> {
    let Some(complete) = create_carryover_transcript(messages, 0.0, None)? else {
        return Ok(CarryoverAssessment::NoHistory);
    };
    if estimate_handoff_tokens(&complete.prefix)
        <= SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS as usize
    {
        Ok(CarryoverAssessment::Complete { context: complete })
    } else {
        Ok(CarryoverAssessment::NeedsCompaction)
    }
}

struct FittedCompactionPrompt {
    older_history: CostedCarriedContext,
    prompt: String,
}

pub fn fit_compaction_prompt(
    input: CompactionPromptInput<'_>,
) -> Result<CompactionPromptFit, CarriedContextBudgetTooSmall> {
    use CompactionPromptUnavailableReason::*;

    let boundary = spine_start(input.messages);
    let spine = carryover_spine(input.messages, boundary);
    let older = &input.messages[..boundary];
    if create_carryover_transcript(&spine, CARRYOVER_INJECTION_MAX_CHARS as f64, Some("."))?
        .is_some_and(|context| context.summary_truncated == Some(true))
    {
        return Ok(CompactionPromptFit::Unavailable {
            reason: RecentTurnsFillCarryover,
        });
    }
    if !older.iter().any(is_projectable_message) {
        return Ok(CompactionPromptFit::Unavailable {
            reason: HistoryInsideRecentTurns,
        });
    }
    let Some(recent_context) = create_carryover_transcript(&spine, 0.0, None)? else {
        return Ok(CompactionPromptFit::Unavailable {
            reason: RecentTurnsUnprojectable,
        });
    };

    let fitted = fit_estimated_token_document(
        TokenDocumentBudget {
            usable_tokens: usable_handoff_token_budget(input.context_window_tokens),
            fixed_frame_tokens: estimate_handoff_tokens(&build_compaction_prompt(
                "",
                &recent_context.prefix,
                input.destination,
            )) as f64,
            maximum_entry_budget_tokens: input.maximum_entry_budget_tokens,
            minimum_entry_budget_tokens: Some(1.0),
        },
        |entry_budget| {
            let older_history = create_carryover_transcript_within_cost(
                older,
                ProjectionCostBudget {
                    maximum_cost: entry_budget,
                    cost: &|text| estimate_handoff_tokens(text) as f64,
                },
                None,
            )?;
            let prompt = build_compaction_prompt(
                &older_history.context.prefix,
                &recent_context.prefix,
                input.destination,
            );
            Some(FittedCompactionPrompt {
                older_history,
                prompt,
            })
        },
        |value| &value.prompt,
        |value| Some(value.older_history.admission_cost.0),
    );
    Ok(match fitted {
        Some(fitted) => CompactionPromptFit::Fitted {
            prompt: fitted.value.prompt,
            entry_budget_tokens: Number(fitted.entry_budget_tokens),
        },
        None => CompactionPromptFit::Unavailable {
            reason: PromptExceedsWindow,
        },
    })
}

pub fn spine_start(messages: &[ChatMessage]) -> usize {
    messages
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, message)| matches!(message, ChatMessage::User(_)))
        .nth(RECENT_TURNS_VERBATIM - 1)
        .map_or(0, |(index, _)| index)
}

pub fn project_compacted_carryover(
    messages: &[ChatMessage],
    summary: &str,
) -> Result<CarriedContext, CompactionProjectionError> {
    let spine = carryover_spine(messages, spine_start(messages));
    create_carryover_transcript(&spine, CARRYOVER_INJECTION_MAX_CHARS as f64, Some(summary))?
        .filter(|context| {
            context.summary_truncated != Some(true)
                && utf16::len(&context.prefix) <= CARRYOVER_INJECTION_MAX_CHARS
        })
        .ok_or(CompactionProjectionError::SummaryTooLarge)
}

fn carryover_spine(messages: &[ChatMessage], boundary: usize) -> Cow<'_, [ChatMessage]> {
    if let Some(gap) = messages[..boundary]
        .iter()
        .find(|message| is_publication_gap_message(message))
    {
        Cow::Owned(
            std::iter::once(gap)
                .chain(&messages[boundary..])
                .cloned()
                .collect(),
        )
    } else {
        Cow::Borrowed(&messages[boundary..])
    }
}

fn build_compaction_prompt(
    older_history: &str,
    recent_context: &str,
    destination: &CompactionDestination,
) -> String {
    let mut lines = vec![
        "Summarize the prior conversation below so another coding agent can continue the work."
            .into(),
        format!(
            "It will be continued by {} using {}.",
            destination.agent_id, destination.model
        ),
    ];
    if let Some(prompt) = destination
        .prompt
        .as_ref()
        .filter(|prompt| !prompt.is_empty())
    {
        lines.push(format!("Their next instruction is: {prompt}"));
    }
    lines.extend([
        "Bias the summary toward what that instruction needs.",
        "The conversation is split into older history and protected recent context.",
        "Use both sections to determine the current state and immediate next step.",
        "Recent completions, reversals, and blockers supersede older plans.",
        "The recent context will also accompany the summary, so account for it without repeating it in detail.",
        "",
        "Reply with a single <summary> element containing these sections in order:",
        "the original objective, decisions and constraints already established, files changed,",
        "the current state of the work, and the immediate next step.",
        "Do not include a <carried-context> element and do not repeat the transcript verbatim.",
        "",
        "<older-history>",
        older_history,
        "</older-history>",
        "",
        "<recent-context>",
        recent_context,
        "</recent-context>",
    ].into_iter().map(str::to_owned));
    lines.join("\n")
}
