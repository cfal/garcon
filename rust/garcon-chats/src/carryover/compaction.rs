//! Ports `server/controller/chats/carryover/compaction.ts`.

use std::{error::Error, rc::Rc, sync::Arc};

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError,
    log::{Logger, create_logger},
};
use garcon_contract::{
    api_providers::ApiProtocol,
    chat_modes::ThinkingMode,
    chat_row_contracts::CHAT_ROW_CONTENT_MAX_BYTES,
    chat_types::ChatMessage,
    error_codes::ErrorCode,
    executors::ExecutorId,
    handoff_sizing::DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS,
    settings::{AgentSwitchCompactionUiSettings, GenerationSelectionUiSettings},
    transcript_seed::CARRYOVER_INJECTION_MAX_CHARS,
};
use garcon_js::trim;
use tokio_util::sync::CancellationToken;

use crate::token_fitting::{
    budget::{COMPACTION_QUERY_ATTEMPTS, reduced_compaction_entry_budget},
    carryover::{
        CarryoverAssessment, CompactionDestination, CompactionPromptFit,
        CompactionPromptUnavailableReason,
    },
    client::TokenFitting,
};

use super::{outcome::CarryOverOutcome, page_codec::check_signal};

pub const CARRYOVER_COMPACTION_TIMEOUT_MS: u64 = 15 * 60_000;
pub const CARRYOVER_COMPACTION_STARTED_NOTICE: &str =
    "Compacting earlier chat history. This could take a while depending on the agent and model.";

const SUMMARY_OPEN: &str = "<summary>";
const SUMMARY_CLOSE: &str = "</summary>";

#[derive(Debug, Clone)]
pub struct CompactionSelection {
    pub executor_id: ExecutorId,
    pub agent_id: String,
    pub model: String,
    pub thinking_mode: ThinkingMode,
    pub api_provider_id: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub model_protocol: Option<ApiProtocol>,
}

#[async_trait(?Send)]
pub trait CarryOverCompactionAgents {
    async fn resolve_compaction_selection(
        &self,
        selection: &GenerationSelectionUiSettings,
        signal: Option<&CancellationToken>,
    ) -> Result<Option<CompactionSelection>, Box<dyn Error>>;

    fn single_query_runs_tools_without_permission(&self, agent_id: &str, executor_id: &str)
    -> bool;

    /// Retries only executor session loss, without modifying the fitted prompt
    /// or consuming a size-reduction attempt. Each query gets its own timeout.
    async fn run_single_query_with_session_loss_retry(
        &self,
        prompt: &str,
        selection: &CompactionSelection,
        timeout_ms: u64,
        signal: Option<&CancellationToken>,
    ) -> Result<String, Box<dyn Error>>;
}

type CompactionSettings =
    dyn Fn() -> Result<Option<AgentSwitchCompactionUiSettings>, Box<dyn Error>>;
type CompactionStarted = dyn Fn(&str) -> Result<(), Box<dyn Error>>;
pub type CompactionStartedObserver<'a> = dyn Fn() -> Result<(), Box<dyn Error>> + 'a;

pub struct CarryOverCompactionDeps {
    pub agents: Rc<dyn CarryOverCompactionAgents>,
    pub fitting: Rc<dyn TokenFitting>,
    pub get_compaction_settings: Rc<CompactionSettings>,
    pub on_compaction_started: Option<Rc<CompactionStarted>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CarryOverCompactionOperation {
    AgentSwitch,
    FreshStart,
}

pub struct CarryOverCompactionInput<'a> {
    pub on_compaction_started: Option<&'a CompactionStartedObserver<'a>>,
    pub operation: CarryOverCompactionOperation,
    pub chat_id: &'a str,
    pub messages: Arc<Vec<ChatMessage>>,
    pub destination: CompactionDestination,
    pub signal: Option<&'a CancellationToken>,
}

#[async_trait(?Send)]
pub trait CarryOverCompaction {
    async fn plan_for(
        &self,
        input: CarryOverCompactionInput<'_>,
    ) -> Result<CarryOverOutcome, Box<dyn Error>>;
}

pub struct CarryOverCompactionService {
    deps: CarryOverCompactionDeps,
}

enum Selection {
    Disabled,
    Unresolved,
    Resolved {
        selection: CompactionSelection,
        context_window_tokens: f64,
    },
}

impl CarryOverCompactionService {
    pub fn new(deps: CarryOverCompactionDeps) -> Self {
        Self { deps }
    }

    async fn selection(
        &self,
        signal: Option<&CancellationToken>,
    ) -> Result<Selection, Box<dyn Error>> {
        let Some(settings) = (self.deps.get_compaction_settings)()?
            .filter(|settings| settings.enabled == Some(true))
        else {
            return Ok(Selection::Disabled);
        };
        let Some(selection) = self
            .deps
            .agents
            .resolve_compaction_selection(&settings.selection, signal)
            .await?
            .filter(|selection| !selection.agent_id.is_empty() && !selection.model.is_empty())
        else {
            return Ok(Selection::Unresolved);
        };
        Ok(Selection::Resolved {
            selection,
            context_window_tokens: f64::from(
                settings
                    .context_window_tokens
                    .unwrap_or(DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS),
            ),
        })
    }

    async fn plan(
        &self,
        input: &CarryOverCompactionInput<'_>,
    ) -> Result<CarryOverOutcome, Box<dyn Error>> {
        match self
            .deps
            .fitting
            .assess_carryover(Arc::clone(&input.messages), input.signal)
            .await?
        {
            CarryoverAssessment::NoHistory => return Ok(CarryOverOutcome::NoHistory),
            CarryoverAssessment::Complete { context } => {
                return Ok(CarryOverOutcome::Complete { context });
            }
            CarryoverAssessment::NeedsCompaction => (),
        }

        let (selection, context_window_tokens) = match self.selection(input.signal).await {
            Ok(Selection::Resolved {
                selection,
                context_window_tokens,
            }) => (selection, context_window_tokens),
            Ok(Selection::Disabled) => return Err(compaction_required(input.operation).into()),
            Ok(Selection::Unresolved) => {
                return Err(compaction_unavailable(
                    input.operation,
                    "no generation-capable agent and model could be resolved",
                    DEFAULT_ADVICE,
                )
                .into());
            }
            Err(error) => {
                check_signal(input.signal)?;
                return Err(compaction_unavailable(
                    input.operation,
                    &format!("the configured model could not be resolved ({error})"),
                    DEFAULT_ADVICE,
                )
                .into());
            }
        };
        if self
            .deps
            .agents
            .single_query_runs_tools_without_permission(&selection.agent_id, &selection.executor_id)
        {
            return Err(compaction_unavailable(
                input.operation,
                &format!(
                    "{} runs one-shot queries without a permission gate",
                    selection.agent_id
                ),
                DEFAULT_ADVICE,
            )
            .into());
        }

        let fit = |budget| {
            self.deps.fitting.fit_compaction_prompt(
                Arc::clone(&input.messages),
                input.destination.clone(),
                context_window_tokens,
                budget,
                input.signal,
            )
        };
        let (first_prompt, first_budget) = match fit(None).await? {
            CompactionPromptFit::Fitted {
                prompt,
                entry_budget_tokens,
            } => (prompt, entry_budget_tokens.0),
            CompactionPromptFit::Unavailable { reason } => {
                return Err(compaction_prompt_unavailable(input.operation, reason).into());
            }
        };
        let mut first_prompt = Some(first_prompt);
        let mut last_failure: Box<dyn Error> =
            std::io::Error::other("Compaction did not run").into();
        for attempt in 0..COMPACTION_QUERY_ATTEMPTS {
            check_signal(input.signal)?;
            let (prompt, entry_budget_tokens) = if let Some(prompt) = first_prompt.take() {
                if let Some(started) = input.on_compaction_started {
                    started()?;
                } else if let Some(started) = &self.deps.on_compaction_started {
                    started(input.chat_id)?;
                }
                (prompt, first_budget)
            } else {
                match fit(Some(reduced_compaction_entry_budget(first_budget))).await? {
                    CompactionPromptFit::Fitted {
                        prompt,
                        entry_budget_tokens,
                    } => (prompt, entry_budget_tokens.0),
                    CompactionPromptFit::Unavailable { .. } => {
                        last_failure =
                            std::io::Error::other("the reduced compaction prompt does not fit")
                                .into();
                        break;
                    }
                }
            };
            let result = async {
                let raw = self
                    .deps
                    .agents
                    .run_single_query_with_session_loss_retry(
                        &prompt,
                        &selection,
                        CARRYOVER_COMPACTION_TIMEOUT_MS,
                        input.signal,
                    )
                    .await?;
                let summary = tokio::task::spawn_blocking(move || {
                    validate_compaction_summary(&raw).map(str::to_owned)
                })
                .await??;
                let context = self
                    .deps
                    .fitting
                    .project_compacted_carryover(
                        Arc::clone(&input.messages),
                        summary.clone(),
                        input.signal,
                    )
                    .await?;
                Ok::<_, Box<dyn Error>>(CarryOverOutcome::Compacted { context, summary })
            }
            .await;
            match result {
                Ok(outcome) => return Ok(outcome),
                Err(error) => {
                    check_signal(input.signal)?;
                    create_logger("chats:carryover-compaction").warn(&format!(
                        "Compaction attempt failed: chatId={} attempt={} contextWindowTokens={context_window_tokens} entryBudgetTokens={entry_budget_tokens} reason={error}",
                        input.chat_id, attempt + 1,
                    ));
                    last_failure = error;
                }
            }
        }
        Err(compaction_failed(input.operation, last_failure).into())
    }
}

#[async_trait(?Send)]
impl CarryOverCompaction for CarryOverCompactionService {
    async fn plan_for(
        &self,
        input: CarryOverCompactionInput<'_>,
    ) -> Result<CarryOverOutcome, Box<dyn Error>> {
        let result = self.plan(&input).await;
        let messages = input.messages;
        tokio::task::spawn_blocking(move || drop(messages));
        result
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CompactionSummaryError {
    #[error("Agent-switch compaction must return exactly one <summary> element")]
    Framing,
    #[error("Agent-switch compaction returned an empty <summary>")]
    Empty,
    #[error("Agent-switch compaction returned more than one <summary> element")]
    Multiple,
    #[error(
        "Agent-switch compaction returned a summary larger than {CHAT_ROW_CONTENT_MAX_BYTES} UTF-8 bytes"
    )]
    TooLarge,
}

fn validate_compaction_summary(raw: &str) -> Result<&str, CompactionSummaryError> {
    // Rust text is well-formed. The JSON boundary handles lone surrogates.
    let Some(inner) = trim(raw)
        .strip_prefix(SUMMARY_OPEN)
        .and_then(|tail| tail.strip_suffix(SUMMARY_CLOSE))
    else {
        return Err(CompactionSummaryError::Framing);
    };
    let inner = trim(inner);
    if inner.is_empty() {
        return Err(CompactionSummaryError::Empty);
    }
    if inner.match_indices('<').any(|(index, _)| {
        let after_open = &inner[index + 1..];
        after_open
            .strip_prefix('/')
            .unwrap_or(after_open)
            .strip_prefix("summary")
            .and_then(|after_name| after_name.chars().next())
            .is_some_and(|character| {
                matches!(character, '/' | '>')
                    || trim(character.encode_utf8(&mut [0; 4])).is_empty()
            })
    }) {
        return Err(CompactionSummaryError::Multiple);
    }
    if inner.len() > CHAT_ROW_CONTENT_MAX_BYTES {
        return Err(CompactionSummaryError::TooLarge);
    }
    Ok(inner)
}

const DEFAULT_ADVICE: &str = "Choose a different compaction model in Settings.";

fn compaction_required(operation: CarryOverCompactionOperation) -> DomainError {
    use CarryOverCompactionOperation::*;
    DomainError::new(
        ErrorCode::CARRYOVER_COMPACTION_REQUIRED,
        match operation {
            AgentSwitch => {
                "This chat's history is too large to carry directly. Enable agent-switch compaction in Settings to switch agents during long chats."
            }
            FreshStart => {
                "This chat's history is too large to carry directly. Enable agent-switch compaction in Settings to restart long chats with their history."
            }
        },
        422,
        false,
    )
}

fn compaction_prompt_unavailable(
    operation: CarryOverCompactionOperation,
    reason: CompactionPromptUnavailableReason,
) -> DomainError {
    use CompactionPromptUnavailableReason::*;
    let reason = match reason {
        RecentTurnsFillCarryover => format!(
            "the most recent turns already fill the {CARRYOVER_INJECTION_MAX_CHARS} character carryover limit"
        ),
        HistoryInsideRecentTurns => {
            return compaction_unavailable(
                operation,
                "the complete history is inside the newest-three-turn verbatim spine and exceeds the 100,000 estimated-token uncompacted carry limit",
                match operation {
                    CarryOverCompactionOperation::AgentSwitch => {
                        "Continue with the current agent or start a new chat."
                    }
                    CarryOverCompactionOperation::FreshStart => "Start a new chat to continue.",
                },
            );
        }
        RecentTurnsUnprojectable => "the protected recent history could not be projected".into(),
        PromptExceedsWindow => "the compaction prompt does not fit the configured window".into(),
    };
    compaction_unavailable(operation, &reason, DEFAULT_ADVICE)
}

fn did_not_start(operation: CarryOverCompactionOperation) -> &'static str {
    match operation {
        CarryOverCompactionOperation::AgentSwitch => "The agent switch was not performed.",
        CarryOverCompactionOperation::FreshStart => "No fresh agent session was started.",
    }
}

fn compaction_unavailable(
    operation: CarryOverCompactionOperation,
    reason: &str,
    advice: &str,
) -> DomainError {
    let outcome = did_not_start(operation);
    DomainError::new(
        ErrorCode::CARRYOVER_COMPACTION_UNAVAILABLE,
        format!("Agent-switch compaction is unavailable: {reason}. {outcome} {advice}"),
        422,
        false,
    )
}

fn compaction_failed(
    operation: CarryOverCompactionOperation,
    failure: Box<dyn Error>,
) -> DomainError {
    let outcome = did_not_start(operation);
    DomainError::new(
        ErrorCode::CARRYOVER_COMPACTION_FAILED,
        format!("Agent-switch compaction failed after two attempts ({failure}). {outcome} Try again, reduce the configured context window, or choose a different compaction model in Settings."),
        502, true,
    ).with_cause(failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_framing_before_size_and_keeps_the_exact_utf8_limit() {
        let content = "\u{1f642}".repeat(CHAT_ROW_CONTENT_MAX_BYTES / 4);
        let at_limit = format!("<summary>{content}</summary>");
        assert_eq!(validate_compaction_summary(&at_limit), Ok(content.as_str()));
        let too_large = format!("<summary>{content}x</summary>");
        assert_eq!(
            validate_compaction_summary(&too_large),
            Err(CompactionSummaryError::TooLarge)
        );
        let multiple = format!("<summary>{content}<summary/>x</summary>");
        assert_eq!(
            validate_compaction_summary(&multiple),
            Err(CompactionSummaryError::Multiple)
        );
        assert_eq!(
            validate_compaction_summary("<summary>valid \u{fffd}</summary>"),
            Ok("valid \u{fffd}")
        );
    }
}
