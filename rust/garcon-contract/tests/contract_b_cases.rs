//! ADR-020 recordings for the browser WebSocket and controller contracts.

use garcon_cases::{CaseError, markers, replay, round_tripped, text, unknown};
use serde::Serialize;
use serde_json::{Value, json};

use garcon_contract::chat_execution_control::{
    empty_chat_execution_control_state, parse_chat_execution_control_state,
    parse_execution_control_server_instance_id,
};
use garcon_contract::queue_state::{
    empty_chat_queue_state, parse_chat_queue_state, parse_queue_pause,
};
use garcon_contract::ws_auth::{
    bearer_token_from_web_socket_protocol_header, parse_web_socket_protocol_header,
    web_socket_protocol_header_contains, web_socket_protocols_for_auth,
};
use garcon_contract::ws_requests::{
    ChatReloadCancelRequest, ChatReloadRequest, ChatSubscribeRequest, ClientWsMessage,
    ReconnectStateQueryRequest, WsPingRequest, parse_client_ws_message,
};
use garcon_contract::ws_value_parsing::{
    self, canonical_chat_id, non_negative_int, required_path, required_str,
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
fn auth_recordings() {
    use garcon_contract::auth::*;

    assert_recording("auth", |function, args| {
        let value = unknown(function, args.first())?;
        let error = |error: AuthValidationError| CaseError::new("Error", error.to_string());
        Ok(match function {
            "validateUsername" => json!(validate_username(&value).map_err(error)?),
            "validatePassword" => json!(validate_password(&value).map_err(error)?),
            "parseChangeUsernameRequest" => {
                json!(parse_change_username_request(&value).map_err(error)?)
            }
            "parseChangePasswordRequest" => {
                json!(parse_change_password_request(&value).map_err(error)?)
            }
            "parseLoginRequest" => json!(parse_login_request(&value).map_err(error)?),
            "parseRegisterRequest" => json!(parse_register_request(&value).map_err(error)?),
            "parseAuthUser" => json!(parse_auth_user(&value).map_err(error)?),
            "parseAuthSessionResponse" => {
                json!(parse_auth_session_response(&value).map_err(error)?)
            }
            "parseAuthUserResponse" => json!(parse_auth_user_response(&value).map_err(error)?),
            "parseAuthStatusResponse" => json!(parse_auth_status_response(&value).map_err(error)?),
            "parseAuthTokenIdentity" => json!(parse_auth_token_identity(&value)),
            "isAuthSessionId" => json!(is_auth_session_id(&value)),
            "new AuthValidationError" => {
                let value = AuthValidationError::new(required_text(function, args.first())?);
                json!({"$": "error", "name": "Error", "message": value.to_string(), "properties": {}})
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
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

fn instance_record(name: &str, value: impl Serialize) -> Value {
    let encoded = serde_json::to_string(&value).expect("message is serializable");
    let fields = garcon_js::json::from_str(&encoded).expect("message serializes to an object");
    markers::instance(name, fields)
}

fn client_ws_message_record(message: ClientWsMessage) -> Value {
    match message {
        ClientWsMessage::ReconnectStateQuery(value) => {
            instance_record("ReconnectStateQueryRequest", value)
        }
        ClientWsMessage::ChatSubscribe(value) => instance_record("ChatSubscribeRequest", value),
        ClientWsMessage::ChatReload(value) => instance_record("ChatReloadRequest", value),
        ClientWsMessage::ChatReloadCancel(value) => {
            instance_record("ChatReloadCancelRequest", value)
        }
        ClientWsMessage::WsPing(value) => instance_record("WsPingRequest", value),
    }
}

#[test]
fn ws_requests_recordings() {
    assert_recording("ws-requests", |function, args| match function {
        "parseClientWsMessage" => {
            let result = parse_client_ws_message(unknown(function, args.first())?.as_ref())
                .map_err(|error| CaseError::new("TypeError", error.to_string()))?;
            Ok(result.map_or(Value::Null, client_ws_message_record))
        }
        "new ChatReloadCancelRequest" => {
            let chat_id = text(function, args.first())?.map(str::to_owned);
            let request_id = text(function, args.get(1))?.map(str::to_owned);
            Ok(instance_record(
                "ChatReloadCancelRequest",
                ChatReloadCancelRequest::new(chat_id, request_id),
            ))
        }
        _ => {
            let value = unknown(function, args.first())?;
            let object = value
                .as_object()
                .ok_or_else(|| CaseError::unhandled(function))?;
            Ok(match function {
                "ReconnectStateQueryRequest.fromJson" => instance_record(
                    "ReconnectStateQueryRequest",
                    ReconnectStateQueryRequest::from_json(object),
                ),
                "ChatSubscribeRequest.fromJson" => ChatSubscribeRequest::from_json(object)
                    .map_or(Value::Null, |value| {
                        instance_record("ChatSubscribeRequest", value)
                    }),
                "ChatReloadRequest.fromJson" => {
                    instance_record("ChatReloadRequest", ChatReloadRequest::from_json(object))
                }
                "ChatReloadCancelRequest.fromJson" => instance_record(
                    "ChatReloadCancelRequest",
                    ChatReloadCancelRequest::from_json(object),
                ),
                "WsPingRequest.fromJson" => {
                    instance_record("WsPingRequest", WsPingRequest::from_json(object))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        }
    });
}

#[test]
fn ws_value_parsing_recordings() {
    assert_recording("ws-value-parsing", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "str" => json!(ws_value_parsing::str(&value)),
            "requiredStr" => json!(required_str(&value)),
            "requiredPath" => json!(required_path(&value)),
            "nonNegativeInt" => json!(non_negative_int(&value)),
            "canonicalChatId" => json!(canonical_chat_id(&value)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn queue_state_recordings() {
    assert_recording("queue-state", |function, args| {
        Ok(match function {
            "emptyChatQueueState" => json!(empty_chat_queue_state()),
            "parseChatQueueState" => json!(parse_chat_queue_state(
                unknown(function, args.first())?.as_ref()
            )),
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

#[test]
fn chat_execution_control_recordings() {
    assert_recording("chat-execution-control", |function, args| {
        Ok(match function {
            "emptyChatExecutionControlState" => json!(empty_chat_execution_control_state(
                required_text(function, args.first())?
            )),
            "parseExecutionControlServerInstanceId" => {
                json!(parse_execution_control_server_instance_id(
                    unknown(function, args.first())?.as_ref()
                ))
            }
            "parseChatExecutionControlState" => json!(parse_chat_execution_control_state(
                unknown(function, args.first())?.as_ref()
            )),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn chat_title_contracts_recordings() {
    use garcon_contract::chat_title_contracts::*;
    assert_recording("chat-title-contracts", |function, args| {
        Ok(match function {
            "isChatTitleWithinLimit" => {
                json!(is_chat_title_within_limit(required_text(
                    function,
                    args.first()
                )?))
            }
            "fitDerivedChatTitle" => json!(fit_derived_chat_title(
                required_text(function, args.first())?,
                required_text(function, args.get(1))?,
            )),
            "parseUpdateChatTitleRequest" => {
                json!(parse_update_chat_title_request(
                    unknown(function, args.first())?.as_ref()
                ))
            }
            "parseUpdateChatTitleResponse" => {
                json!(parse_update_chat_title_response(
                    unknown(function, args.first())?.as_ref()
                ))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}
