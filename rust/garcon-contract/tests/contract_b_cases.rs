//! ADR-020 recordings for the browser WebSocket and controller contracts.

use garcon_cases::{CaseError, markers, replay, round_tripped, text, unknown};
use serde_json::{Value, json};

use garcon_contract::chat_execution_control::{
    ChatExecutionControlState, empty_chat_execution_control_state,
    parse_chat_execution_control_state, parse_execution_control_server_instance_id,
};
use garcon_contract::queue_state::{
    ChatQueueState, empty_chat_queue_state, parse_chat_queue_state, parse_queue_pause,
};
use garcon_contract::ws_auth::{
    bearer_token_from_web_socket_protocol_header, parse_web_socket_protocol_header,
    web_socket_protocol_header_contains, web_socket_protocols_for_auth,
};
use garcon_contract::ws_value_parsing::{
    self, NonNegativeSafeInteger, canonical_chat_id, non_negative_int, required_path, required_str,
};

fn assert_recording(
    module: &str,
    dispatcher: impl FnMut(&str, &[Value]) -> Result<Value, CaseError>,
) {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/cases/common")
        .join(module);
    let stats = replay(fixture, dispatcher);
    assert_eq!(stats.with_wildcards, 0, "{module}: unexpected wildcard");
    assert_eq!(stats.passed, stats.total, "{module}: recording differs");
}

fn required_text<'a>(function: &str, argument: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, argument)?.ok_or_else(|| CaseError::unhandled(function))
}

#[test]
fn ws_auth_recordings() {
    assert_recording("ws-auth", |function, args| {
        let header = text(function, args.first())?;
        Ok(match function {
            "webSocketProtocolsForAuth" => json!(web_socket_protocols_for_auth(header)),
            "parseWebSocketProtocolHeader" => json!(parse_web_socket_protocol_header(header)),
            "webSocketProtocolHeaderContains" => {
                json!(web_socket_protocol_header_contains(
                    header,
                    required_text(function, args.get(1))?
                ))
            }
            "bearerTokenFromWebSocketProtocolHeader" => {
                json!(bearer_token_from_web_socket_protocol_header(header))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

fn integer_record(value: NonNegativeSafeInteger) -> Value {
    if value.is_negative_zero() {
        markers::number(-0.0)
    } else {
        json!(value.get())
    }
}

#[test]
fn ws_value_parsing_recordings() {
    assert_recording("ws-value-parsing", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "str" => json!(ws_value_parsing::str(&value)),
            "requiredStr" => json!(required_str(&value)),
            "requiredPath" => json!(required_path(&value)),
            "nonNegativeInt" => non_negative_int(&value).map_or(Value::Null, integer_record),
            "canonicalChatId" => json!(canonical_chat_id(&value)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

fn queue_record(queue: &ChatQueueState) -> Value {
    let mut value = json!(queue);
    value["reorderRevision"] = integer_record(queue.reorder_revision);
    value
}

#[test]
fn queue_state_recordings() {
    assert_recording("queue-state", |function, args| {
        Ok(match function {
            "emptyChatQueueState" => queue_record(&empty_chat_queue_state()),
            "parseChatQueueState" => {
                parse_chat_queue_state(unknown(function, args.first())?.as_ref())
                    .as_ref()
                    .map_or(Value::Null, queue_record)
            }
            "parseQueuePause" => {
                let value = round_tripped(function, args.first())?;
                match parse_queue_pause(value.as_deref()) {
                    None => markers::undefined(),
                    Some(pause) => json!(pause),
                }
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

fn execution_control_record(control: &ChatExecutionControlState) -> Value {
    let mut value = json!(control);
    value["queue"] = queue_record(&control.queue);
    value["version"] = integer_record(control.version);
    value
}

#[test]
fn chat_execution_control_recordings() {
    assert_recording("chat-execution-control", |function, args| {
        Ok(match function {
            "emptyChatExecutionControlState" => execution_control_record(
                &empty_chat_execution_control_state(required_text(function, args.first())?),
            ),
            "parseExecutionControlServerInstanceId" => {
                json!(parse_execution_control_server_instance_id(
                    unknown(function, args.first())?.as_ref()
                ))
            }
            "parseChatExecutionControlState" => {
                parse_chat_execution_control_state(unknown(function, args.first())?.as_ref())
                    .as_ref()
                    .map_or(Value::Null, execution_control_record)
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}
