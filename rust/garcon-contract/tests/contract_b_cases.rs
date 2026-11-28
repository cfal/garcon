//! ADR-020 recordings for the browser WebSocket and controller contracts.

use garcon_cases::{CaseError, javascript_number, markers, replay, round_tripped, text, unknown};
use serde::Serialize;
use serde::de::DeserializeOwned;
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

use garcon_contract::handoff_sizing::{
    is_handoff_context_window_tokens, parse_agent_switch_context_window_tokens,
    usable_handoff_token_budget,
};
use garcon_contract::hidden_bash_command_patterns::{
    HiddenBashCommandPattern, dedupe_hidden_bash_command_patterns,
    is_hidden_bash_command_pattern_mode, parse_hidden_bash_command_patterns,
    validate_hidden_bash_command_pattern,
};
use garcon_contract::settings::{
    default_execution_defaults, generation_selection_executor_error,
    normalize_agent_switch_compaction_ui_settings, normalize_chat_title_ui_settings,
    normalize_commit_message_ui_settings, normalize_prompt_refinement_ui_settings,
    normalize_remote_feature_settings, normalize_remote_settings_snapshot,
    normalize_ticket_chat_ui_settings, parse_executor_project_preferences,
    parse_executor_project_preferences_patch,
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
fn chat_row_contracts_recordings() {
    use garcon_contract::chat_row_contracts::*;
    use garcon_contract::command_request_validation::CommandRequestValidationError;

    assert_recording("chat-row-contracts", |function, args| {
        let value = unknown(function, args.first())?;
        let error = |error: CommandRequestValidationError| {
            CaseError::new("CommandRequestValidationError", error.message)
        };
        Ok(match function {
            "parseChatRowContent" => json!(parse_chat_row_content(&value).map_err(error)?),
            "parseChatRowTitle" => optional_record(parse_chat_row_title(&value).map_err(error)?),
            "parseAddChatRowRequest" => json!(parse_add_chat_row_request(&value).map_err(error)?),
            "parseChatRowTargetResponse" => json!(parse_chat_row_target_response(&value)),
            "parseAddChatRowResponse" => json!(parse_add_chat_row_response(&value)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
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

fn optional_record<T: Serialize>(value: Option<T>) -> Value {
    value.map_or_else(markers::undefined, |value| json!(value))
}

#[test]
fn settings_recordings() {
    assert_recording("settings", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "parseExecutorProjectPreferencesPatch" => {
                json!(parse_executor_project_preferences_patch(&value))
            }
            "parseExecutorProjectPreferences" => json!(parse_executor_project_preferences(&value)),
            "generationSelectionExecutorError" => {
                json!(generation_selection_executor_error(&value))
            }
            "normalizeChatTitleUiSettings" => {
                optional_record(normalize_chat_title_ui_settings(&value))
            }
            "normalizeAgentSwitchCompactionUiSettings" => {
                optional_record(normalize_agent_switch_compaction_ui_settings(&value))
            }
            "normalizeCommitMessageUiSettings" => {
                optional_record(normalize_commit_message_ui_settings(&value))
            }
            "normalizePromptRefinementUiSettings" => {
                optional_record(normalize_prompt_refinement_ui_settings(&value))
            }
            "normalizeTicketChatUiSettings" => {
                optional_record(normalize_ticket_chat_ui_settings(&value))
            }
            "normalizeRemoteFeatureSettings" => json!(normalize_remote_feature_settings(&value)),
            "defaultExecutionDefaults" => json!(default_execution_defaults()),
            "normalizeRemoteSettingsSnapshot" => {
                let snapshot = normalize_remote_settings_snapshot(&value)
                    .map_err(|error| CaseError::new("Error", error.to_string()))?;
                let encoded = serde_json::to_string(&snapshot).expect("snapshot is serializable");
                garcon_js::json::from_str(&encoded).expect("snapshot serializes to JSON")
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn handoff_sizing_recordings() {
    assert_recording("handoff-sizing", |function, args| {
        Ok(match function {
            "parseAgentSwitchContextWindowTokens" => json!(
                parse_agent_switch_context_window_tokens(unknown(function, args.first())?.as_ref())
            ),
            "isHandoffContextWindowTokens" => json!(is_handoff_context_window_tokens(
                unknown(function, args.first())?.as_ref()
            )),
            "usableHandoffTokenBudget" => markers::number(usable_handoff_token_budget(
                javascript_number(function, args.first())?,
            )),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

fn hidden_pattern_entries(value: &Value) -> Option<Vec<HiddenBashCommandPattern>> {
    value
        .as_array()?
        .iter()
        .map(|entry| {
            Some(HiddenBashCommandPattern {
                pattern: entry.get("pattern")?.as_str()?.to_owned(),
                mode: is_hidden_bash_command_pattern_mode(entry.get("mode")?)?,
            })
        })
        .collect()
}

#[test]
fn hidden_bash_command_patterns_recordings() {
    assert_recording("hidden-bash-command-patterns", |function, args| {
        let value = unknown(function, args.first())?;
        Ok(match function {
            "isHiddenBashCommandPatternMode" => {
                json!(is_hidden_bash_command_pattern_mode(&value).is_some())
            }
            "validateHiddenBashCommandPattern" => {
                let pattern = required_text(function, args.first())?;
                let mode =
                    is_hidden_bash_command_pattern_mode(unknown(function, args.get(1))?.as_ref())
                        .ok_or_else(|| CaseError::unhandled(function))?;
                json!(validate_hidden_bash_command_pattern(pattern, mode))
            }
            "dedupeHiddenBashCommandPatterns" => {
                let entries =
                    hidden_pattern_entries(&value).ok_or_else(|| CaseError::unhandled(function))?;
                json!(dedupe_hidden_bash_command_patterns(&entries))
            }
            "parseHiddenBashCommandPatterns" => json!(parse_hidden_bash_command_patterns(&value)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

fn pinned_bun_stdout(script: &str, arguments: &[&str]) -> String {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("bun")
        .current_dir(root)
        .args([
            "-e",
            &format!(
                "if (Bun.version !== '1.4.3') throw new Error('expected Bun 1.4.3');\n{script}"
            ),
            "--",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn agent_wire_fixtures() -> String {
    pinned_bun_stdout(
        r#"import "./rust/garcon-contract/tests/inputs/common/agent-wire.ts";"#,
        &[],
    )
}

fn verify_wire_round_trip<T: DeserializeOwned + Serialize>(wire: &str) {
    let value: T = garcon_js::json::from_str(wire).expect("DTO accepts the original shape");
    assert_eq!(serde_json::to_string(&value).unwrap(), wire);
}

#[test]
fn model_catalog_round_trips_bun_json() {
    use garcon_contract::model_catalog::*;
    let fixtures = pinned_bun_stdout(
        r#"import "./rust/garcon-contract/tests/inputs/common/model-catalog-wire.ts";"#,
        &[],
    );
    let lines: Vec<_> = fixtures.lines().collect();
    assert_eq!(lines.len(), 4);
    assert_eq!(
        serde_json::to_string(CATALOG_INSTANCE_HEADER).unwrap(),
        lines[0]
    );
    assert_eq!(serde_json::to_string(LOGIN_AGENT_QUERY).unwrap(), lines[1]);
    for line in &lines[2..4] {
        verify_wire_round_trip::<ModelCatalogResponse>(line);
    }
}

#[test]
fn models_recordings() {
    use garcon_contract::models::is_codex_sol_model;
    assert_recording("models", |function, args| match function {
        "isCodexSolModel" => Ok(json!(is_codex_sol_model(text(function, args.first())?))),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn model_constants_match_bun() {
    use garcon_contract::models::*;
    let original = pinned_bun_stdout(
        r#"import * as models from "./common/models.ts";
           console.log(JSON.stringify(models));"#,
        &[],
    );
    let original: Value = garcon_js::json::from_str(&original).unwrap();
    assert_eq!(
        original,
        json!({
            "CLAUDE_MODELS": CLAUDE_MODELS,
            "GPT_6_ASTRA_MODEL": GPT_6_ASTRA_MODEL,
            "GPT_6_2_SOL_MODEL": GPT_6_2_SOL_MODEL,
            "GPT_6_2_ASTRA_MODEL": GPT_6_2_ASTRA_MODEL,
            "GPT_6_1_SOL_MODEL": GPT_6_1_SOL_MODEL,
            "GPT_6_1_TERRA_MODEL": GPT_6_1_TERRA_MODEL,
            "GPT_6_SOL_MODEL": GPT_6_SOL_MODEL,
            "GPT_6_LUNA_MODEL": GPT_6_LUNA_MODEL,
            "CODEX_MODELS": CODEX_MODELS,
            "AMP_MODELS": AMP_MODELS,
            "FACTORY_MODELS": FACTORY_MODELS,
            "PI_MODELS": PI_MODELS,
            "OPENROUTER_MODELS": OPENROUTER_MODELS,
            "ALIBABA_CLOUD_MODELS": ALIBABA_CLOUD_MODELS,
            "FIREWORKS_MODELS": FIREWORKS_MODELS,
            "GEMINI_MODELS": GEMINI_MODELS,
            "TOGETHER_MODELS": TOGETHER_MODELS,
            "ZAI_MODELS": ZAI_MODELS,
        })
    );
}

#[test]
fn model_routing_recordings() {
    use garcon_contract::model_routing::*;
    assert_recording("model-routing", |function, args| {
        let endpoint_id = required_text(function, args.first())?;
        let model = required_text(function, args.get(1))?;
        Ok(match function {
            "endpointModelOptionValue" => json!(endpoint_model_option_value(endpoint_id, model)),
            "rawModelFromEndpointOptionValue" => {
                json!(raw_model_from_endpoint_option_value(endpoint_id, model))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn agent_execution_dtos_round_trip_bun_json() {
    use garcon_contract::agent_execution::*;
    let fixtures = agent_wire_fixtures();
    let lines: Vec<_> = fixtures.lines().collect();
    assert_eq!(lines.len(), 16);
    verify_wire_round_trip::<AgentAttachment>(lines[0]);
    verify_wire_round_trip::<AgentCredentialReference>(lines[1]);
    for line in &lines[2..4] {
        verify_wire_round_trip::<AgentEndpointSelection>(line);
    }
    for line in &lines[4..6] {
        verify_wire_round_trip::<AgentAuthStatus>(line);
    }
}

#[test]
fn agent_auth_dtos_round_trip_bun_json() {
    use garcon_contract::agent_auth::*;
    let fixtures = agent_wire_fixtures();
    let lines: Vec<_> = fixtures.lines().collect();
    assert_eq!(lines.len(), 16);
    verify_wire_round_trip::<AgentDeviceAuthInfo>(lines[6]);
    for line in &lines[7..9] {
        verify_wire_round_trip::<AgentAuthLoginLaunchResult>(line);
    }
    for line in &lines[9..13] {
        verify_wire_round_trip::<AgentAuthLoginStatus>(line);
    }
    verify_wire_round_trip::<AgentAuthLoginCompleteResult>(lines[13]);
    verify_wire_round_trip::<AgentAuthLoginHttpStatus>(lines[14]);
    assert_eq!(
        serde_json::to_string(LOGIN_INSTANCE_QUERY).unwrap(),
        lines[15]
    );
}

fn serialized_record(value: impl Serialize) -> Value {
    let encoded = serde_json::to_string(&value).expect("contract is serializable");
    garcon_js::json::from_str(&encoded).expect("contract serializes to JSON")
}

#[test]
fn agent_settings_recordings() {
    use garcon_contract::agent_integration::{
        AgentSettingDescriptor, parse_agent_settings_envelope,
    };
    use garcon_contract::agent_settings::*;
    use garcon_js::json::Opaque;

    assert_recording("agent-settings", |function, args| {
        let envelope = |index| {
            parse_agent_settings_envelope(unknown(function, args.get(index))?.as_ref()).ok_or_else(
                || CaseError::undeliverable("expected a parsed agent settings envelope"),
            )
        };
        let descriptor = || {
            serde_json::from_value::<AgentSettingDescriptor>(
                unknown(function, args.get(1))?.into_owned(),
            )
            .map_err(|error| CaseError::undeliverable(error.to_string()))
        };
        Ok(match function {
            "createEmptyAgentSettings" => serialized_record(create_empty_agent_settings(
                required_text(function, args.first())?,
            )),
            "normalizeAgentSettings" => {
                let value = round_tripped(function, args.get(1))?;
                let value = match value.as_deref() {
                    None | Some(Value::Null) => None,
                    Some(_) => Some(envelope(1)?),
                };
                serialized_record(normalize_agent_settings(
                    required_text(function, args.first())?,
                    value.as_ref(),
                    &envelope(2)?,
                ))
            }
            "cloneAgentSettings" => serialized_record(clone_agent_settings(&envelope(0)?)),
            "settingValue" => setting_value(&envelope(0)?, &descriptor()?)
                .map_or_else(markers::undefined, serialized_record),
            "withAgentSetting" => {
                let envelope = envelope(0)?;
                let value = Opaque::from_value(unknown(function, args.get(2))?.into_owned());
                serialized_record(with_agent_setting(&envelope, &descriptor()?, &value))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn cloned_agent_settings_preserve_javascript_json_text() {
    use garcon_contract::agent_integration::parse_agent_settings_envelope;
    use garcon_contract::agent_settings::clone_agent_settings;
    let input = r#"{"ownerId":"sample","schemaVersion":1,"values":{"one":1.0,"big":9007199254740993,"exp21":1e21,"negativeZero":-0}}"#;
    let original = pinned_bun_stdout(
        r#"import { cloneAgentSettings } from "./common/agent-settings.ts";
           console.log(JSON.stringify(cloneAgentSettings(JSON.parse(Bun.argv.at(-1)))));"#,
        &[input],
    );
    let value = garcon_js::json::from_str(input).unwrap();
    let envelope = parse_agent_settings_envelope(&value).unwrap();
    assert_eq!(
        serde_json::to_string(&clone_agent_settings(&envelope)).unwrap(),
        original.trim_end()
    );
}

#[test]
fn settings_preserves_agent_values_as_javascript_json_text() {
    let input = r#"{
        "version":1,
        "ui":{},
        "uiEffective":{},
        "paths":{"pinnedProjectPaths":[],"browseStartPath":"","recentProjectPaths":[]},
        "pinnedChatIds":[],
        "recentAgentSettings":[],
        "executionDefaults":{
            "global":{
                "permissionMode":"default",
                "thinkingMode":"none",
                "agentSettingsById":{
                    "codex":{"ownerId":"codex","schemaVersion":1,
                        "values":{"one":1.0,"big":9007199254740993,"exp21":1e21,"negativeZero":-0}}
                }
            },
            "byAgent":{}
        },
        "projectBasePath":"",
        "telegram":{"botTokenAvailable":false,"recipientLinked":false,"pendingLink":false}
    }"#;
    let original = pinned_bun_stdout(
        r#"import { normalizeRemoteSettingsSnapshot } from "./common/settings.ts";
           const snapshot = normalizeRemoteSettingsSnapshot(JSON.parse(Bun.argv.at(-1)));
           console.log(JSON.stringify(snapshot.executionDefaults.global.agentSettingsById.codex.values));"#,
        &[input],
    );
    let input = garcon_js::json::from_str(input).unwrap();
    let snapshot = normalize_remote_settings_snapshot(&input).unwrap().unwrap();
    let settings = &snapshot.execution_defaults.global.agent_settings_by_id["codex"];
    assert_eq!(
        serde_json::to_string(&settings.values).unwrap(),
        original.trim_end()
    );
}

#[test]
fn generation_prompt_constants_match_bun() {
    use garcon_contract::generation_prompts::*;
    let original = pinned_bun_stdout(
        r#"import * as prompts from "./common/generation-prompts.ts";
           console.log(JSON.stringify(prompts));"#,
        &[],
    );
    let original: Value = garcon_js::json::from_str(&original).unwrap();
    assert_eq!(
        original,
        json!({
            "GENERATION_PROMPT_TEMPLATE_MAX_LENGTH": GENERATION_PROMPT_TEMPLATE_MAX_LENGTH,
            "COMMIT_MESSAGE_FILES_TOKEN": COMMIT_MESSAGE_FILES_TOKEN,
            "COMMIT_MESSAGE_DIFF_TOKEN": COMMIT_MESSAGE_DIFF_TOKEN,
            "PROMPT_REFINEMENT_USER_PROMPT_TOKEN": PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
            "DEFAULT_COMMIT_MESSAGE_PROMPT": DEFAULT_COMMIT_MESSAGE_PROMPT,
            "DEFAULT_PROMPT_REFINEMENT_PROMPT": DEFAULT_PROMPT_REFINEMENT_PROMPT,
        })
    );
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
