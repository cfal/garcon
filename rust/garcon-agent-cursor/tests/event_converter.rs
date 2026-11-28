use garcon_agent_cursor::cursor_acp_event_converter::CursorAcpEventConverter;
use garcon_agents_common::acp::event_converter::{
    AcpCustomRequest, AcpEventConverter, AcpRetireReason, AcpSessionUpdateContext, as_object,
};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::chat_command_contracts::PermissionDecisionPayload;
use serde::Serialize;
use serde_json::{Value, json};

fn undeliverable(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

fn wire(result: impl Serialize) -> Result<Value, CaseError> {
    garcon_js::json::from_slice(&serde_json::to_vec(&result).map_err(undeliverable)?)
        .map_err(undeliverable)
}

#[test]
fn cursor_event_converter_matches_bun_on_original_runtime_inputs_and_traps() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/event-converter"),
        |function, args| {
            if function != "scriptedCursorEvents" {
                return Err(CaseError::unhandled(function));
            }
            let steps = unknown(function, args.first())?;
            let converter = CursorAcpEventConverter::default();
            let steps = steps
                .as_array()
                .ok_or_else(|| undeliverable("expected steps"))?;
            steps.iter().map(|step| {
            let id = || step[1].as_str().ok_or_else(|| undeliverable("expected session id"));
            let context = || {
                let field = |key| step[2].get(key).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| undeliverable(format!("missing {key}")));
                Ok::<_, CaseError>(AcpSessionUpdateContext { chat_id: field("chatId")?, session_id: field("sessionId")?, timestamp: field("timestamp")? })
            };
            match step[0].as_str().unwrap_or_default() {
                "beginTurn" => { converter.begin_turn(id()?); Ok(Value::Null) }
                "releaseSession" => { converter.release_session(id()?); Ok(Value::Null) }
                "endTurn" => wire(converter.end_turn(id()?, &context()?)),
                "fromSessionUpdate" => wire(converter.from_session_update(as_object(&step[1]), &context()?)),
                "permissionToolUse" => wire(converter.permission_tool_use(as_object(&step[1]), &context()?)),
                "customRequestToolUse" => {
                    let request = &step[1];
                    let text = |key| request.get(key).and_then(Value::as_str).ok_or_else(|| undeliverable(format!("missing {key}")));
                    let block = converter.custom_request_tool_use(&AcpCustomRequest {
                        method: text("method")?, permission_occurrence_id: text("permissionOccurrenceId")?, params: &request["params"],
                    }, &context()?);
                    let Some(block) = block else { return Ok(Value::Null); };
                    let decisions = step[3].as_array().into_iter().flatten().map(|decision| {
                        let decision: PermissionDecisionPayload = serde_json::from_value(decision.clone()).map_err(undeliverable)?;
                        Ok::<_, CaseError>((block.response_for_decision)(&decision))
                    }).collect::<Result<Vec<_>, _>>()?;
                    wire(json!({"tool":block.tool,"decisions":decisions,"cancelled":(block.response_for_cancellation)(AcpRetireReason::Cancelled)}))
                }
                method => Err(CaseError::unhandled(method)),
            }
        }).collect::<Result<Vec<_>, _>>().map(Value::Array)
        },
    );
}
