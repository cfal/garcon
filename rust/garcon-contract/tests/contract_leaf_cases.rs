use garcon_cases::{CaseError, javascript_number, markers, replay, round_tripped, text, unknown};
use garcon_contract::{
    agent_turn_receipt, chat_canvas, chat_clear, chat_details, chat_id, chat_input_command_parsing,
    chat_parent_contracts, chat_tags_contracts, command_request_validation,
    generation_test_contracts, git_name, handoff_timeouts, native_session_lookup, run_or_steer,
    runtime_shell, share_types, workspace_layout,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn json_value(result: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&result).unwrap()).unwrap()
}

fn wire(result: impl Serialize) -> Value {
    json!(serde_json::to_string(&result).unwrap())
}

fn typed<T: DeserializeOwned>(function: &str, value: &Value) -> Result<T, CaseError> {
    serde_json::from_value(value.clone()).map_err(|_| CaseError::unhandled(function))
}

fn run(unit: &str, dispatch: impl Fn(&str, &[Value]) -> Result<Value, CaseError>) {
    let cases = format!("{}/tests/cases/common/{unit}", env!("CARGO_MANIFEST_DIR"));
    let stats = replay(cases, dispatch);
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

fn required_text<'a>(function: &str, value: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, value)?.ok_or_else(|| CaseError::unhandled(function))
}

fn invalid_chat_id(error: chat_id::InvalidChatIdError) -> CaseError {
    use chat_id::InvalidChatIdValue;
    let message = error.to_string();
    let value = match error.value {
        InvalidChatIdValue::Undefined => markers::undefined(),
        InvalidChatIdValue::Number(number) => markers::number(number),
        InvalidChatIdValue::Json(value) => json_value(value),
    };
    CaseError::new("InvalidChatIdError", message).with_property("value", value)
}

#[test]
fn agent_model_option_cases_match() {
    use garcon_contract::agents::AgentModelOption;

    run("agent-model-option", |function, args| {
        if function != "writeOpenCodeModelOptions" {
            return Err(CaseError::unhandled(function));
        }
        let input = unknown(function, args.first())?;
        let options: Vec<AgentModelOption> = typed(function, &input)?;
        Ok(json_value(options))
    });
}

#[test]
fn canvas_cases_match() {
    use chat_canvas::*;
    run("chat-canvas", |function, args| {
        let value = unknown(function, args.first())?;
        let error = |error: CanvasValidationError| match error {
            CanvasValidationError::InvalidChatId(error) => invalid_chat_id(error),
            _ => CaseError::new("Error", error.to_string()),
        };
        match function {
            "parseCanvasContent" => parse_canvas_content(&value).map(json_value).map_err(error),
            "parseChatCanvas" => parse_chat_canvas(&value).map(json_value).map_err(error),
            "parseCanvasList" => parse_canvas_list(&value).map(json_value).map_err(error),
            "canvasSummary" => Ok(json_value(canvas_summary(&typed(function, &value)?))),
            "isCanvasId" => Ok(json!(is_canvas_id(&value))),
            "isCanvasRevision" => Ok(json!(is_canvas_revision(&value).is_some())),
            "isCanvasSide" => Ok(json!(is_canvas_side(&value).is_some())),
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn chat_clear_cases_match() {
    run("chat-clear", |function, args| {
        let value = unknown(function, args.first())?;
        match function {
            "parseClearChatRequest" => chat_clear::parse_clear_chat_request(&value)
                .map(json_value)
                .map_err(command_error),
            "parseClearChatResponse" => chat_clear::parse_clear_chat_response(&value)
                .map(json_value)
                .map_err(|error| CaseError::new(error.name(), error.to_string())),
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

fn command_error(error: command_request_validation::CommandRequestValidationError) -> CaseError {
    CaseError::new("CommandRequestValidationError", error.to_string())
}

#[test]
fn chat_parent_cases_match() {
    run("chat-parent-contracts", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "parseSetChatParentRequest" => {
                json_value(chat_parent_contracts::parse_set_chat_parent_request(&value))
            }
            "parseSetChatParentResponse" => json_value(
                chat_parent_contracts::parse_set_chat_parent_response(&value),
            ),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn chat_tags_cases_match() {
    run("chat-tags-contracts", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "parseSetChatTagsRequest" => {
                json_value(chat_tags_contracts::parse_set_chat_tags_request(&value))
            }
            "parseSetChatTagsResponse" => {
                json_value(chat_tags_contracts::parse_set_chat_tags_response(&value))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn native_session_lookup_cases_match() {
    use native_session_lookup::*;
    run("native-session-lookup", |function, args| {
        let value = unknown(function, args.first())?;
        let error = |error: NativeSessionLookupValidationError| match error {
            NativeSessionLookupValidationError::ChatId(error) => invalid_chat_id(error),
            _ => CaseError::new("NativeSessionLookupValidationError", error.to_string()),
        };
        match function {
            "parseNativeSessionId" => parse_native_session_id(&value)
                .map(json_value)
                .map_err(error),
            "parseNativeSessionLookupRequest" => parse_native_session_lookup_request(&value)
                .map(json_value)
                .map_err(error),
            "parseNativeSessionLookupResponse" => parse_native_session_lookup_response(&value)
                .map(json_value)
                .map_err(error),
            "new NativeSessionLookupValidationError" => {
                let error =
                    NativeSessionLookupValidationError::new(required_text(function, args.first())?);
                Ok(
                    json!({"$":"error", "name":"NativeSessionLookupValidationError", "message":error.to_string(), "properties":{}}),
                )
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn agent_turn_receipt_cases_match() {
    use agent_turn_receipt::*;
    run("agent-turn-receipt", |function, args| {
        let value = unknown(function, args.first())?;
        match function {
            "parseAgentTurnReceipt" => {
                parse_agent_turn_receipt(&value)
                    .map(json_value)
                    .map_err(|error| {
                        CaseError::new("AgentTurnReceiptContractError", error.to_string())
                    })
            }
            "new AgentTurnReceiptContractError" => {
                let error =
                    AgentTurnReceiptContractError::new(required_text(function, args.first())?);
                Ok(
                    json!({"$":"error", "name":"AgentTurnReceiptContractError", "message":error.to_string(), "properties":{}}),
                )
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn contract_leaves_cases_match() {
    use chat_input_command_parsing::*;
    run("contract-leaves", |function, args| {
        let value = unknown(function, args.first())?;
        match function {
            "parseCommandQuestionReply" => {
                let body = value
                    .as_object()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let field = match required_text(function, args.get(1))? {
                    "command" => CommandQuestionReplyField::Command,
                    "content" => CommandQuestionReplyField::Content,
                    _ => return Err(CaseError::unhandled(function)),
                };
                parse_command_question_reply(body, field)
                    .map(|value| value.map_or_else(markers::undefined, json_value))
                    .map_err(command_error)
            }
            "rejectQuestionReply" => {
                let body = value
                    .as_object()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                reject_question_reply(body)
                    .map(|()| markers::undefined())
                    .map_err(command_error)
            }
            "parseCommandUserMessagePresentation" => {
                let value = round_tripped(function, args.first())?;
                parse_command_user_message_presentation(value.as_deref())
                    .map(|value| value.map_or_else(markers::undefined, json_value))
                    .map_err(command_error)
            }
            "renderRuntimeShell" => runtime_shell::render_runtime_shell(
                required_text(function, args.first())?,
                required_text(function, args.get(1))?,
            )
            .map(json_value)
            .map_err(|error| CaseError::new("Error", error.to_string())),
            "generationModelTestConfigurationKey" => {
                let body = value
                    .as_object()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                Ok(json!(
                    generation_test_contracts::generation_model_test_configuration_key(body)
                ))
            }
            "isGenerationTestTarget" => Ok(json!(
                generation_test_contracts::is_generation_test_target(&value).is_some()
            )),
            "isGenerateGitNameRequest" => Ok(json!(git_name::is_generate_git_name_request(&value))),
            "nextRunOrSteerRoute" => {
                let route = typed(function, &value)?;
                let status = javascript_number(function, args.get(1))?;
                let code = text(function, args.get(2))?;
                Ok(json_value(run_or_steer::next_run_or_steer_route(
                    route, status, code,
                )))
            }
            "handoffTimeouts" => Ok(json!([
                handoff_timeouts::AGENT_HANDOFF_HTTP_TIMEOUT_MS,
                handoff_timeouts::AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS
            ])),
            "workspaceLayoutWire" => Ok(wire(
                typed::<workspace_layout::PersistedWorkspaceLayoutV2>(function, &value)?,
            )),
            "publicSharedSnapshotWire" => Ok(wire(typed::<share_types::PublicSharedChatSnapshot>(
                function, &value,
            )?)),
            "chatDetailsWire" => Ok(wire(typed::<chat_details::ChatDetailsResponse>(
                function, &value,
            )?)),
            _ => Err(CaseError::unhandled(function)),
        }
    });
}
