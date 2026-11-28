use garcon_agent_antigravity::antigravity_acp_event_converter::{
    AntigravityAcpEventConverter, split_executor_error,
};
use garcon_agents_common::acp::event_converter::{
    AcpEventConverter, AcpRuntimeBoundary, AcpSessionUpdateContext, as_object,
};
use garcon_cases::{CaseError, replay, text, unknown};
use serde::Serialize;
use serde_json::{Value, json};

#[path = "support/event_text_runs.rs"]
mod event_text_runs;

fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    garcon_js::json::from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn string(value: &Value) -> Result<&str, CaseError> {
    value
        .as_str()
        .ok_or_else(|| CaseError::undeliverable("expected a string"))
}

fn context(value: &Value) -> Result<AcpSessionUpdateContext, CaseError> {
    Ok(AcpSessionUpdateContext {
        chat_id: string(&value["chatId"])?.to_owned(),
        session_id: string(&value["sessionId"])?.to_owned(),
        timestamp: string(&value["timestamp"])?.to_owned(),
    })
}

fn boundary(value: &Value) -> Result<AcpRuntimeBoundary, CaseError> {
    Ok(match string(&value["kind"])? {
        "stderr" => AcpRuntimeBoundary::Stderr,
        "permission-request" => AcpRuntimeBoundary::PermissionRequest {
            tool_call_id: string(&value["toolCallId"])?.to_owned(),
        },
        "permission-settlement" => AcpRuntimeBoundary::PermissionSettlement {
            tool_call_id: string(&value["toolCallId"])?.to_owned(),
        },
        other => {
            return Err(CaseError::undeliverable(format!(
                "unknown ACP boundary {other}"
            )));
        }
    })
}

fn scripted_events(steps: &[Value]) -> Result<Value, CaseError> {
    let converter = AntigravityAcpEventConverter::default();
    steps
        .iter()
        .map(|step| match string(&step[0])? {
            "beginTurn" => {
                converter.begin_turn(string(&step[1])?);
                Ok(Value::Null)
            }
            "fromSessionUpdate" => {
                wire(converter.from_session_update(as_object(&step[1]), &context(&step[2])?))
            }
            "permissionToolUse" => {
                wire(converter.permission_tool_use(as_object(&step[1]), &context(&step[2])?))
            }
            "endTurn" => wire(converter.end_turn(string(&step[1])?, &context(&step[2])?)),
            "flushPending" => {
                wire(converter.flush_pending(&context(&step[1])?, &boundary(&step[2])?))
            }
            "takeTurnFailure" => Ok(json!(converter.take_turn_failure(string(&step[1])?))),
            "releaseSession" => {
                converter.release_session(string(&step[1])?);
                Ok(Value::Null)
            }
            other => Err(CaseError::undeliverable(format!(
                "unknown ACP event step {other}"
            ))),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "scriptedAntigravityEvents" => {
            let steps = unknown(function, args.first())?;
            let steps = event_text_runs::unpack(steps.into_owned())?;
            scripted_events(
                steps
                    .as_array()
                    .ok_or_else(|| CaseError::undeliverable("expected event steps"))?,
            )
            .map(event_text_runs::pack)
        }
        "splitExecutorError" => {
            let chunk = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("expected text"))?;
            let result = split_executor_error(chunk);
            Ok(json!({"text": result.text, "failure": result.failure}))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn recorded_antigravity_event_converter_cases_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/event-converter"),
        dispatch,
    );
}
