use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use garcon_agents_common::acp::event_converter::as_object;
use garcon_agents_common::acp::runtime_helpers::{
    automatic_permission_choice, build_env_fallback, build_prompt_fallback,
    fallback_permission_tool_use, permission_cancelled_outcome, permission_choice_outcome,
    permission_outcome, unless_settled,
};
use garcon_agents_common::acp::runtime_types::AcpExecutionRequest;
use garcon_agents_common::execution::runtime_events::runtime_operation;
use garcon_cases::{CaseError, markers, replay, round_tripped, text, unknown};
use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio::task::LocalSet;
use tokio::time::{advance, timeout};

fn typed<T: DeserializeOwned>(function: &str, argument: Option<&Value>) -> Result<T, CaseError> {
    serde_json::from_value(unknown(function, argument)?.into_owned())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn required_text<'a>(function: &str, argument: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, argument)?.ok_or_else(|| CaseError::undeliverable("expected a string"))
}

fn wire(value: impl Serialize) -> Result<Map<String, Value>, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    garcon_js::json::from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn request(command: String) -> AcpExecutionRequest {
    AcpExecutionRequest {
        chat_id: "chat-1".to_owned(),
        project_path: "/work".to_owned(),
        model: "default".to_owned(),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        operation: runtime_operation("turn-1".to_owned(), Rc::new(|_| ())),
        execution_admission: None,
        command,
        images: None,
        env_overrides: Default::default(),
    }
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "permissionChoiceOutcome" => {
            let options = unknown(function, args.first())?;
            let options: Vec<_> = options
                .as_array()
                .ok_or_else(|| CaseError::undeliverable("expected a permission option array"))?
                .iter()
                .map(as_object)
                .collect();
            Ok(permission_choice_outcome(
                &options,
                typed(function, args.get(1))?,
            ))
        }
        "automaticPermissionChoice" => {
            let mode = typed(function, args.first())?;
            let kind = round_tripped(function, args.get(1))?;
            let policy = unknown(function, args.get(2))?;
            let accept_edits = policy
                .get("acceptsEditsOnClient")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(json!(automatic_permission_choice(
                mode,
                kind.as_deref(),
                accept_edits
            )))
        }
        "permissionOutcome" => Ok(permission_outcome(required_text(function, args.first())?)),
        "permissionCancelledOutcome" => Ok(permission_cancelled_outcome()),
        "buildPromptFallback" => {
            let argument = unknown(function, args.first())?;
            let command = argument
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| CaseError::undeliverable("expected a command"))?;
            Ok(Value::Array(build_prompt_fallback(&request(
                command.to_owned(),
            ))))
        }
        "fallbackPermissionToolUse" => {
            let tool_call = unknown(function, args.first())?;
            let fields = wire(fallback_permission_tool_use(
                as_object(&tool_call),
                required_text(function, args.get(1))?,
                required_text(function, args.get(2))?,
            ))?;
            Ok(markers::instance("UnknownToolUseMessage", fields))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn recorded_acp_runtime_helper_cases_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/acp-runtime-helpers"
        ),
        dispatch,
    );
}

#[test]
fn the_explicit_environment_overrides_take_precedence() {
    let mut request = request(String::new());
    request
        .env_overrides
        .insert("PATH".to_owned(), "synthetic-path".to_owned());
    assert_eq!(
        build_env_fallback(&request)
            .get("PATH")
            .and_then(Option::as_deref),
        Some("synthetic-path"),
    );
}

#[tokio::test(start_paused = true)]
async fn unless_settled_clears_the_timer_or_fires_at_the_deadline() {
    LocalSet::new()
        .run_until(timeout(Duration::from_secs(1), async {
            for settled_before_deadline in [true, false] {
                let (settle, settled) = oneshot::channel();
                let calls = Rc::new(Cell::new(0));
                let timer = unless_settled(async { settled.await.unwrap() }, 10.0, {
                    let calls = Rc::clone(&calls);
                    move || calls.set(calls.get() + 1)
                });
                advance(Duration::from_millis(9)).await;
                tokio::task::yield_now().await;
                assert_eq!(calls.get(), 0);
                if settled_before_deadline {
                    settle.send(()).unwrap();
                }
                advance(Duration::from_millis(1)).await;
                timer.await.unwrap();
                assert_eq!(calls.get(), u32::from(!settled_before_deadline));
            }
        }))
        .await
        .expect("settlement timers must complete");
}
