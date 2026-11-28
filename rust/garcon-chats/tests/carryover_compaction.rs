use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    error::Error,
    process::Command,
    rc::Rc,
    sync::Arc,
};

use async_trait::async_trait;
use garcon_base::{domain_error::as_domain_error, keyed_lock::LockAborted};
use garcon_chats::{
    carryover::{
        compaction::{
            CarryOverCompaction, CarryOverCompactionAgents, CarryOverCompactionDeps,
            CarryOverCompactionInput, CarryOverCompactionOperation, CarryOverCompactionService,
            CompactionSelection,
        },
        context::{CreateCarriedContextInput, create_carried_context},
        outcome::{CarryOverOutcome, resolve_carry_over_outcome},
        prepared_store::{PreparedCarryover, PreparedCarryoverStore, TakePreparedCarryover},
    },
    token_fitting::{
        carryover::{
            CarryoverAssessment, CompactionDestination, CompactionPromptFit,
            CompactionPromptUnavailableReason,
        },
        client::{TokenFitting, TokenFittingError},
    },
};
use garcon_contract::{
    chat_modes::ThinkingMode,
    chat_types::ChatMessage,
    settings::{GenerationSelectionUiSettings, normalize_agent_switch_compaction_ui_settings},
    transcript_seed::CarriedContext,
};
use garcon_js::{Number, json};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

type Calls = Rc<RefCell<Vec<Value>>>;

struct Fitting {
    calls: Calls,
    has_history: bool,
    can_reduce: bool,
}

#[async_trait(?Send)]
impl TokenFitting for Fitting {
    async fn assess_carryover(
        &self,
        _: Arc<Vec<ChatMessage>>,
        _: Option<&CancellationToken>,
    ) -> Result<CarryoverAssessment, TokenFittingError> {
        self.calls.borrow_mut().push(json!(["assess"]));
        Ok(if self.has_history {
            CarryoverAssessment::NeedsCompaction
        } else {
            CarryoverAssessment::NoHistory
        })
    }

    async fn fit_compaction_prompt(
        &self,
        _: Arc<Vec<ChatMessage>>,
        _: CompactionDestination,
        window: f64,
        maximum: Option<f64>,
        _: Option<&CancellationToken>,
    ) -> Result<CompactionPromptFit, TokenFittingError> {
        self.calls.borrow_mut().push(json!([
            "fit",
            window as u32,
            maximum.map(|budget| budget as u32)
        ]));
        Ok(if maximum.is_some() && !self.can_reduce {
            CompactionPromptFit::Unavailable {
                reason: CompactionPromptUnavailableReason::PromptExceedsWindow,
            }
        } else {
            CompactionPromptFit::Fitted {
                prompt: if maximum.is_some() {
                    "reduced"
                } else {
                    "first"
                }
                .into(),
                entry_budget_tokens: Number(maximum.unwrap_or(101.0)),
            }
        })
    }

    async fn project_compacted_carryover(
        &self,
        _: Arc<Vec<ChatMessage>>,
        summary: String,
        _: Option<&CancellationToken>,
    ) -> Result<CarriedContext, TokenFittingError> {
        self.calls.borrow_mut().push(json!(["project", summary]));
        Ok(CarriedContext {
            prefix: format!("carry {summary}"),
            summary_truncated: None,
        })
    }
}

struct Agents {
    calls: Calls,
    uses_tools: bool,
    replies: RefCell<VecDeque<String>>,
}

#[async_trait(?Send)]
impl CarryOverCompactionAgents for Agents {
    async fn resolve_compaction_selection(
        &self,
        _: &GenerationSelectionUiSettings,
        _: Option<&CancellationToken>,
    ) -> Result<Option<CompactionSelection>, Box<dyn Error>> {
        Ok(Some(CompactionSelection {
            executor_id: "local".into(),
            agent_id: "claude".into(),
            model: "haiku".into(),
            thinking_mode: ThinkingMode::None,
            api_provider_id: None,
            model_endpoint_id: None,
            model_protocol: None,
        }))
    }

    fn single_query_runs_tools_without_permission(
        &self,
        agent_id: &str,
        executor_id: &str,
    ) -> bool {
        self.calls
            .borrow_mut()
            .push(json!(["gate", agent_id, executor_id]));
        self.uses_tools
    }

    async fn run_single_query_with_session_loss_retry(
        &self,
        prompt: &str,
        _: &CompactionSelection,
        timeout_ms: u64,
        _: Option<&CancellationToken>,
    ) -> Result<String, Box<dyn Error>> {
        self.calls
            .borrow_mut()
            .push(json!(["query", prompt, timeout_ms]));
        self.replies
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| "unexpected extra query".into())
    }
}

#[tokio::test]
async fn compaction_progress_permission_gate_and_retry_trace_match_bun() {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/carryover-compaction.ts"
        ))
        .env("GARCON_LOG_LEVEL", "error")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Vec<Value> = json::from_slice(&output.stdout).unwrap();
    for probe in oracle {
        let name = probe["name"].as_str().unwrap().to_owned();
        let calls: Calls = Rc::default();
        let replies: &[&str] = match name.as_str() {
            "retry" => &[
                "unframed summary",
                "\u{feff}<summary>Objective & next step\nKeep spacing</summary>\u{00a0}",
            ],
            "failed" => &[
                "<summary>\u{00a0}</summary>",
                "<summary>first <summary\u{00a0}nested></summary>",
            ],
            "reduced-does-not-fit" => &["bad prompt output"],
            "no-history" | "disabled" | "unsafe" => &[],
            _ => panic!("unexpected original case {name}"),
        };
        let service = CarryOverCompactionService::new(CarryOverCompactionDeps {
            agents: Rc::new(Agents {
                calls: calls.clone(),
                uses_tools: name == "unsafe",
                replies: RefCell::new(replies.iter().map(|reply| (*reply).to_owned()).collect()),
            }),
            fitting: Rc::new(Fitting {
                calls: calls.clone(),
                has_history: name != "no-history",
                can_reduce: name != "reduced-does-not-fit",
            }),
            get_compaction_settings: {
                let calls = calls.clone();
                let enabled = name != "disabled";
                Rc::new(move || {
                    calls.borrow_mut().push(json!(["settings"]));
                    Ok(normalize_agent_switch_compaction_ui_settings(&json!({
                        "enabled": enabled, "agentId": "claude", "model": "haiku", "contextWindowTokens": 200_000,
                    })))
                })
            },
            on_compaction_started: Some({
                let calls = calls.clone();
                Rc::new(move |_| {
                    calls
                        .borrow_mut()
                        .push(json!(["unexpected-global-progress"]));
                    Ok(())
                })
            }),
        });
        let started = || {
            calls.borrow_mut().push(json!(["started"]));
            Ok(())
        };
        let outcome = service
            .plan_for(CarryOverCompactionInput {
                on_compaction_started: Some(&started),
                operation: if name == "disabled" {
                    CarryOverCompactionOperation::FreshStart
                } else {
                    CarryOverCompactionOperation::AgentSwitch
                },
                chat_id: "synthetic",
                messages: Arc::default(),
                destination: CompactionDestination {
                    agent_id: "codex".into(),
                    model: "next".into(),
                    prompt: Some("continue".into()),
                },
                signal: None,
            })
            .await;
        let result = match outcome {
            Ok(outcome) => {
                let resolved = resolve_carry_over_outcome(outcome.clone());
                json!({ "outcome": outcome, "resolved": resolved })
            }
            Err(error) => {
                let domain = as_domain_error(error.as_ref()).unwrap();
                json!({ "code": domain.code.as_str(), "message": domain.message, "status": domain.status, "retryable": domain.retryable })
            }
        };
        assert_eq!(
            serde_json::to_vec(&result).unwrap(),
            serde_json::to_vec(&probe["result"]).unwrap(),
            "{name}: {result}"
        );
        assert_eq!(
            Value::Array(calls.borrow().clone()),
            probe["calls"],
            "{name}"
        );
    }
}

fn prepared(epoch: &str) -> PreparedCarryover {
    PreparedCarryover {
        chat_id: "chat-1".into(),
        transcript_view_id: "view-1".into(),
        target_agent_id: "synthetic".into(),
        target_executor_id: "local".into(),
        target_ownership_epoch: epoch.into(),
        client_request_id: "request-1".into(),
        result: CarryOverOutcome::Complete {
            context: CarriedContext {
                prefix: "prepared".into(),
                summary_truncated: None,
            },
        },
    }
}

fn context_input(signal: Option<&CancellationToken>) -> CreateCarriedContextInput<'_> {
    CreateCarriedContextInput {
        on_compaction_started: None,
        chat_id: "chat-1",
        agent_id: "synthetic",
        executor_id: None,
        ownership_epoch: Some("epoch-1"),
        model: None,
        transcript_view_id: "view-1",
        destination_prompt: "synthetic prompt",
        client_request_id: Some("request-1"),
        signal,
    }
}

#[derive(Default)]
struct Plan(Cell<usize>);

#[async_trait(?Send)]
impl CarryOverCompaction for Plan {
    async fn plan_for(
        &self,
        input: CarryOverCompactionInput<'_>,
    ) -> Result<CarryOverOutcome, Box<dyn Error>> {
        assert!(matches!(
            input.operation,
            CarryOverCompactionOperation::FreshStart
        ));
        assert_eq!(input.destination.agent_id, "synthetic");
        assert_eq!(input.destination.model, "");
        assert_eq!(
            input.destination.prompt.as_deref(),
            Some("synthetic prompt")
        );
        self.0.set(self.0.get() + 1);
        Ok(CarryOverOutcome::NoHistory)
    }
}

#[tokio::test]
async fn uses_matching_prepared_context_once_and_discards_an_ownership_mismatch() {
    let store = PreparedCarryoverStore::default();
    let expected = prepared("epoch-1");
    let result = expected.result.clone();
    store.deposit(expected);
    let signal = CancellationToken::new();
    signal.cancel();
    let error = create_carried_context(
        context_input(Some(&signal)),
        || async { panic!("cancelled start must not read") },
        &store,
        None,
    )
    .await
    .unwrap_err();
    assert!(error.is::<LockAborted>());
    assert_eq!(
        create_carried_context(
            context_input(None),
            || async { panic!("prepared start must not read") },
            &store,
            None
        )
        .await
        .unwrap(),
        result,
    );
    store.deposit(prepared("stale"));
    let plan = Plan::default();
    assert_eq!(
        create_carried_context(
            context_input(None),
            || async { Ok(Vec::new()) },
            &store,
            Some(&plan)
        )
        .await
        .unwrap(),
        CarryOverOutcome::NoHistory
    );
    assert_eq!(plan.0.get(), 1);
    assert!(
        store
            .take(TakePreparedCarryover {
                chat_id: "chat-1",
                transcript_view_id: "view-1",
                target_agent_id: "synthetic",
                target_executor_id: None,
                target_ownership_epoch: Some("stale"),
                client_request_id: Some("request-1"),
            })
            .is_none()
    );
}

#[tokio::test]
async fn does_not_plan_when_history_fails_or_cancellation_arrives_during_the_read() {
    let store = PreparedCarryoverStore::default();
    let plan = Plan::default();
    let signal = CancellationToken::new();
    let error = create_carried_context(
        context_input(Some(&signal)),
        || async {
            signal.cancel();
            Ok(Vec::new())
        },
        &store,
        Some(&plan),
    )
    .await
    .unwrap_err();
    assert!(error.is::<LockAborted>());
    let error = create_carried_context(
        context_input(None),
        || async { Err(std::io::Error::other("Synthetic unavailable transcript").into()) },
        &store,
        Some(&plan),
    )
    .await
    .unwrap_err();
    assert!(error.is::<std::io::Error>());
    assert_eq!(plan.0.get(), 0);
}
