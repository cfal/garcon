//! Replays against the port the cases the recorder took from the original
//! for each pure module. One recording per module, under `tests/cases/<name>`.

use std::borrow::Cow;
use std::rc::Rc;

use crate::support::*;
use garcon_agent_opencode::agents::opencode::compaction_routing::{
    OpenCodeCompactionPartRouteInput, adopt_open_code_compaction_part_route,
    compaction_boundary_row, compaction_event_trigger,
};
use garcon_agent_opencode::agents::opencode::jsonc;
use garcon_agent_opencode::agents::opencode::model_catalog::{
    configured_providers_from_result, connected_providers_from_list_result, models_from_providers,
};
use garcon_agent_opencode::agents::opencode::opencode_auth::{
    OpenCodeAuthRuntime, get_open_code_auth_status,
};
use garcon_agent_opencode::agents::opencode::operation_routes::OpenCodeOperationRoutes;
use garcon_agent_opencode::agents::opencode::permission_tool_converter::convert_opencode_permission_tool;
use garcon_agent_opencode::agents::opencode::permissions::{
    extract_permission_request, map_permission_decision, map_permission_mode,
};
use garcon_agent_opencode::agents::opencode::prompt::{build_prompt_body, parse_open_code_model};
use garcon_agent_opencode::agents::opencode::prompt_response::parse_open_code_prompt_response;
use garcon_agent_opencode::agents::opencode::questions::{
    OpenCodeQuestionDecision, extract_open_code_question_request, map_open_code_question_decision,
};
use garcon_agent_opencode::agents::opencode::sdk_result::{
    OpenCodeRequestScope, OpenCodeSdkResultError, create_open_code_request_scope,
    has_open_code_result_error, is_open_code_not_found_result, open_code_result_error_message,
    throw_open_code_result_error, with_open_code_request_scope,
};
use garcon_agent_opencode::agents::opencode::server_instance::{
    ServerEnvironment, build_open_code_server_env, merge_open_code_config_content,
};
use garcon_agent_opencode::agents::opencode::session_identity_plugin::path_to_file_url;
use garcon_agent_opencode::agents::opencode::sse_events::{
    OpenCodeSessionRetryStatus, SseEvent, extract_session_id, extract_text_parts,
    is_open_code_compaction_assistant, is_open_code_compaction_continuation_part,
    is_open_code_compaction_control_part, is_open_code_manual_compaction_control_part,
    open_code_assistant_terminal, open_code_retry_notice, open_code_retry_notice_text,
    open_code_session_retry_status, unwrap_global_event,
};
use garcon_agent_opencode::agents::opencode::thinking_variant::{
    resolve_open_code_thinking_variant, thinking_modes_from_variants,
};
use garcon_agent_opencode::agents::opencode::tool_use_converter::{
    convert_open_code_question_tool_use, convert_open_code_tool_use,
};
use garcon_agent_opencode::agents::opencode::turn_events::{
    ActivateTurnInput, accept_unique_open_code_turn_event, activate_open_code_session_turn,
    observe_open_code_steering_part, open_code_event_belongs_to_turn,
    open_code_turn_requires_provider_quiescence, relocate_open_code_session,
    should_warn_for_unrouted_open_code_event,
};
use garcon_agent_opencode::agents::opencode::turn_failure::{
    latest_open_code_prompt_terminal, open_code_provider_failure_row,
};
use garcon_agent_opencode::js::truthy;
use garcon_cases::{
    CaseError, javascript_number, markers, replay, round_tripped, text as string_argument,
};
use garcon_contract::chat_command_contracts::{
    PermissionDecisionPayload, PermissionDecisionResponse,
};
use garcon_contract::chat_message_coercion::as_ask_user_questions;
use garcon_contract::chat_types::CompactionTrigger;
use garcon_interface::native_message_source::get_native_message_source;
use garcon_js::{ManualClock, OptionalNullable};
use serde_json::{Map, Value, json};

const CASES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases");

// The argument at `index` as JSON, and `null` where the original received
// `undefined` or nothing: for the functions the original typed `unknown`.
fn value(function: &str, args: &[Value], index: usize) -> Result<Value, CaseError> {
    unknown(function, args.get(index))
}

fn unknown(function: &str, argument: Option<&Value>) -> Result<Value, CaseError> {
    garcon_cases::unknown(function, argument).map(Cow::into_owned)
}

// A string argument, and the empty string for any other value.
fn text_arg(function: &str, args: &[Value], index: usize) -> Result<String, CaseError> {
    required(function, args.get(index)).map(|argument| text(&argument).to_owned())
}

fn required<'a>(function: &str, argument: Option<&'a Value>) -> Result<Cow<'a, Value>, CaseError> {
    round_tripped(function, argument)?.ok_or_else(|| CaseError::unhandled(function))
}

// The argument at `index` as the object it must be.
fn object(function: &str, args: &[Value], index: usize) -> Result<Map<String, Value>, CaseError> {
    required(function, args.get(index))?
        .as_object()
        .cloned()
        .ok_or_else(|| CaseError::unhandled(function))
}

fn plain_error(_function: &str, error: impl std::fmt::Display) -> CaseError {
    CaseError::new("Error", error.to_string())
}

// The one error `new Date(value).toISOString()` raises.
fn invalid_date(error: impl std::fmt::Display) -> CaseError {
    CaseError::new("RangeError", error.to_string())
}

#[test]
fn thinking_variant_cases_match() {
    replay(
        format!("{CASES}/thinking-variant"),
        |function, args| match function {
            "thinkingModesFromVariants" => {
                let variants = unknown(function, args.first())?;
                Ok(match thinking_modes_from_variants(&variants) {
                    Some(modes) => {
                        json!(modes.iter().map(|mode| mode.as_str()).collect::<Vec<_>>())
                    }
                    None => markers::undefined(),
                })
            }
            "resolveOpenCodeThinkingVariant" => {
                let mode = string_argument(function, args.first())?;
                let declared = match round_tripped(function, args.get(1))? {
                    Some(declared) => Some(
                        declared
                            .as_array()
                            .ok_or_else(|| CaseError::unhandled(function))?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect::<Vec<_>>(),
                    ),
                    None => None,
                };
                Ok(
                    resolve_open_code_thinking_variant(mode, declared.as_deref())
                        .map_or_else(markers::undefined, Value::String),
                )
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn prompt_cases_match() {
    replay(format!("{CASES}/prompt"), |function, args| match function {
        "parseOpenCodeModel" => {
            let model = parse_open_code_model(string_argument(function, args.first())?);
            Ok(match model {
                Some(model) => {
                    json!({ "providerID": model.provider_id, "modelID": model.model_id })
                }
                None => Value::Null,
            })
        }
        "buildPromptBody" => {
            let attachments = round_tripped(function, args.get(3))?;
            let attachments = match attachments.as_deref() {
                None => &[][..],
                Some(Value::Array(attachments)) => attachments.as_slice(),
                Some(_) => return Err(CaseError::unhandled(function)),
            };
            Ok(Value::Object(build_prompt_body(
                &text_arg(function, args, 0)?,
                string_argument(function, args.get(1))?,
                &text_arg(function, args, 2)?,
                attachments,
                string_argument(function, args.get(4))?,
            )))
        }
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn sdk_result_cases_match() {
    replay(
        format!("{CASES}/sdk-result"),
        |function, args| match function {
            "createOpenCodeRequestScope" => {
                let scope =
                    create_open_code_request_scope(string_argument(function, args.first())?);
                let mut result = Map::new();
                if let Some(directory) = scope.directory {
                    result.insert("directory".to_owned(), Value::String(directory));
                }
                Ok(Value::Object(result))
            }
            "withOpenCodeRequestScope" => {
                let scope = object(function, args, 1)?;
                let scope = OpenCodeRequestScope {
                    directory: scope
                        .get("directory")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                };
                Ok(Value::Object(with_open_code_request_scope(
                    object(function, args, 0)?,
                    &scope,
                )))
            }
            "openCodeResultErrorMessage" => Ok(Value::String(open_code_result_error_message(
                &value(function, args, 0)?,
                &text_arg(function, args, 1)?,
            ))),
            "hasOpenCodeResultError" => Ok(json!(has_open_code_result_error(&value(
                function, args, 0
            )?))),
            "isOpenCodeNotFoundResult" => Ok(json!(is_open_code_not_found_result(&value(
                function, args, 0
            )?))),
            "throwOpenCodeResultError" => {
                let fallback = text_arg(function, args, 1)?;
                throw_open_code_result_error(&value(function, args, 0)?, &fallback)
                    .map(|()| markers::undefined())
                    .map_err(sdk_result_error)
            }
            "new OpenCodeSdkResultError" => {
                let status = optional_number(function, args.get(1))?;
                let failure = OpenCodeSdkResultError::new(&text_arg(function, args, 0)?, status);
                Err(sdk_result_error(failure))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

fn optional_number(function: &str, argument: Option<&Value>) -> Result<Option<f64>, CaseError> {
    match argument {
        None | Some(Value::Null) => Ok(None),
        Some(argument) => Ok(Some(javascript_number(function, Some(argument))?)),
    }
}

fn sdk_result_error(failure: OpenCodeSdkResultError) -> CaseError {
    sdk_result_error_with(failure.message, failure.status)
}

fn sdk_result_error_with(message: String, status: Option<f64>) -> CaseError {
    CaseError::new("OpenCodeSdkResultError", message)
        .with_property("status", status.map_or(Value::Null, |status| json!(status)))
}

fn sse_event_value(event: &SseEvent) -> Value {
    json!({ "type": event.kind, "properties": event.properties })
}

#[test]
fn prompt_response_cases_match() {
    replay(
        format!("{CASES}/prompt-response"),
        |function, args| match function {
            "parseOpenCodePromptResponse" => {
                let session_id = text_arg(function, args, 1)?;
                let parsed =
                    parse_open_code_prompt_response(&value(function, args, 0)?, &session_id)
                        .map_err(|failure| plain_error(function, failure))?;
                let mut result = json!({
                    "messageId": parsed.message_id,
                    "responseParentId": parsed.response_parent_id,
                    "messageEvent": sse_event_value(&parsed.message_event),
                    "parts": parsed.parts,
                    "isCompaction": parsed.is_compaction,
                });
                if let Some(final_response) = parsed.final_response {
                    result
                        .as_object_mut()
                        .expect("the result is an object")
                        .insert(
                            "finalResponse".to_owned(),
                            json!({
                                "messageId": final_response.message_id,
                                "response": message_value(&final_response.response),
                            }),
                        );
                }
                Ok(result)
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

// The runtime facts a recorded state names, read by truthiness as the
// original reads them; a fact the state leaves out is a missing method.
struct RecordedRuntime<'a>(&'a Value);

impl OpenCodeAuthRuntime for RecordedRuntime<'_> {
    fn is_available(&self) -> Option<bool> {
        self.0.get("isAvailable").map(truthy)
    }

    fn is_temporarily_unavailable(&self) -> Option<bool> {
        self.0.get("isTemporarilyUnavailable").map(truthy)
    }

    fn get_unavailable_retry_after_ms(&self) -> Option<f64> {
        self.0
            .get("getUnavailableRetryAfterMs")
            .and_then(garcon_js::json::as_number)
    }

    fn get_unavailable_reason(&self) -> Option<String> {
        self.0
            .get("getUnavailableReason")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

#[test]
fn opencode_auth_cases_match() {
    replay(
        format!("{CASES}/opencode-auth"),
        |function, args| match function {
            "authStatus" => {
                let state = unknown(function, args.first())?;
                let runtime = RecordedRuntime(&state);
                Ok(message_value(&get_open_code_auth_status(Some(&runtime))))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

// A recorded environment: a variable the state leaves as `undefined` is
// absent, `null` stays `null`, and a string is its value.
fn environment(state: &Map<String, Value>) -> ServerEnvironment {
    state
        .iter()
        .map(|(key, value)| {
            let value = match value {
                Value::String(value) => OptionalNullable::some(value.clone()),
                Value::Null => OptionalNullable::NULL,
                _ => OptionalNullable::ABSENT,
            };
            (key.clone(), value)
        })
        .collect()
}

// The environment as the recorder writes it: a property the original left
// `undefined` is a marker, and one it set to `null` is `null`.
fn environment_value(environment: &ServerEnvironment) -> Value {
    let mut state = Map::new();
    for (key, value) in environment {
        let value = match value.as_option() {
            Some(value) => Value::String(value.clone()),
            None if value.is_null() => Value::Null,
            None => markers::undefined(),
        };
        state.insert(key.clone(), value);
    }
    javascript_object(state)
}

#[test]
fn server_instance_cases_match() {
    replay(
        format!("{CASES}/server-instance"),
        |function, args| match function {
            "mergeOpenCodeConfigContent" => merge_open_code_config_content(
                string_argument(function, args.first())?,
                &text_arg(function, args, 1)?,
            )
            .map(Value::String)
            .map_err(|failure| plain_error(function, failure)),
            "buildOpenCodeServerEnv" => {
                let base_env = environment(&object(function, args, 0)?);
                build_open_code_server_env(
                    Some(&base_env),
                    string_argument(function, args.get(1))?,
                    string_argument(function, args.get(2))?,
                )
                .map(|built| environment_value(&built))
                .map_err(|failure| plain_error(function, failure))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn jsonc_cases_match() {
    replay(format!("{CASES}/jsonc"), |function, args| match function {
        "parseJsonc" => {
            let (parsed, errors) = jsonc::parse(
                &text_arg(function, args, 0)?,
                jsonc::ParseOptions {
                    disallow_comments: false,
                    allow_trailing_comma: true,
                    allow_empty_content: false,
                },
            );
            Ok(json!({
                "count": errors.len(),
                "first": errors.first().map_or(Value::Null, |first| json!({
                    "offset": first.offset,
                    "length": first.length,
                    "code": first.code.name(),
                })),
                "hasValue": parsed.is_some(),
                "value": parsed.map_or_else(markers::undefined, |parsed| {
                    let mut value = parsed;
                    garcon_js::json::normalize(&mut value);
                    value
                }),
            }))
        }
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn node_url_cases_match() {
    replay(
        format!("{CASES}/node-url"),
        |function, args| match function {
            "fileUrl" => Ok(Value::String(path_to_file_url(&text_arg(
                function, args, 0,
            )?))),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn turn_events_cases_match() {
    replay(
        format!("{CASES}/turn-events"),
        |function, args| match function {
            "turnRequiresQuiescence" => {
                let turn = build_turn(&unknown(function, args.first())?, None);
                Ok(json!(open_code_turn_requires_provider_quiescence(&turn)))
            }
            "shouldWarnForUnroutedOpenCodeEvent" => {
                let event_type = text_arg(function, args, 0)?;
                let managed = *required(function, args.get(1))? == Value::Bool(true);
                Ok(json!(should_warn_for_unrouted_open_code_event(
                    &event_type,
                    managed
                )))
            }
            "eventBelongsToTurn" => {
                let published: Published = Rc::default();
                let turn = build_turn(
                    &unknown(function, args.first())?,
                    Some(Rc::clone(&published)),
                );
                let event = event(&unknown(function, args.get(1))?);
                let event_belongs = open_code_event_belongs_to_turn(&turn, &event);
                let published = published.borrow().clone();
                Ok(json!({
                    "belongs": event_belongs,
                    "published": published,
                    "turn": snapshot_turn(&turn),
                }))
            }
            "observeSteeringPart" => {
                let session = build_session(&unknown(function, args.first())?);
                let event = event(&unknown(function, args.get(1))?);
                let part_id = observe_open_code_steering_part(&session, &event);
                Ok(json!({
                    "partId": part_id,
                    "turn": snapshot_turn(&session.borrow().turn),
                }))
            }
            "acceptTurnEvent" => {
                let turn = build_turn(&unknown(function, args.first())?, None);
                let event = event(&unknown(function, args.get(1))?);
                let logger = recording_logger();
                let accepted = accept_unique_open_code_turn_event(&turn, &event, logger.as_ref());
                let log = logger.lines.borrow().clone();
                Ok(json!({ "accepted": accepted, "turn": snapshot_turn(&turn), "log": log }))
            }
            "activateSessionTurn" => {
                let session = build_session(&unknown(function, args.first())?);
                let input = object(function, args, 1)?;
                activate_open_code_session_turn(
                    &session,
                    ActivateTurnInput {
                        chat_id: text(input.get("chatId").unwrap_or(&Value::Null)).to_owned(),
                        model: input
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        thinking_variant: input
                            .get("thinkingVariant")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        permission_mode: permission_mode(input.get("permissionMode")),
                        directory: input
                            .get("directory")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        turn: build_turn(input.get("turn").unwrap_or(&Value::Null), None),
                    },
                    FIXED_NOW as f64,
                );
                Ok(snapshot_session(&session))
            }
            "relocateSession" => {
                let session = build_session(&unknown(function, args.first())?);
                let directory = text_arg(function, args, 1)?;
                relocate_open_code_session(&session, &directory, FIXED_NOW as f64);
                Ok(json!({ "now": FIXED_NOW, "session": snapshot_session(&session) }))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn turn_failure_cases_match() {
    replay(
        format!("{CASES}/turn-failure"),
        |function, args| match function {
            "latestTerminal" => {
                let turn = build_turn(&unknown(function, args.first())?, None);
                Ok(latest_open_code_prompt_terminal(&turn)
                    .map(|terminal| terminal_value(&terminal))
                    .unwrap_or(Value::Null))
            }
            "providerFailureRow" => {
                let turn = build_turn(&unknown(function, args.get(2))?, None);
                let row = open_code_provider_failure_row(
                    &text_arg(function, args, 0)?,
                    string_argument(function, args.get(1))?,
                    &turn,
                    &ManualClock::new(FIXED_NOW),
                );
                Ok(json!({
                    "row": message_value(&row.value),
                    "source": get_native_message_source(&row)
                        .map(|source| message_value(&source))
                        .unwrap_or(Value::Null),
                    "turn": snapshot_turn(&turn),
                }))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn compaction_routing_cases_match() {
    replay(
        format!("{CASES}/compaction-routing"),
        |function, args| match function {
            "boundaryRow" => {
                let event = event(&unknown(function, args.first())?);
                let trigger = match text_arg(function, args, 1)?.as_str() {
                    "manual" => CompactionTrigger::Manual,
                    _ => CompactionTrigger::Auto,
                };
                Ok(compaction_boundary_row(&event, trigger)
                    .map_err(invalid_date)?
                    .map(|boundary| {
                        json!({
                            "row": message_value(&boundary.row),
                            "summaryMessageId": boundary.summary_message_id,
                        })
                    })
                    .unwrap_or(Value::Null))
            }
            "eventTrigger" => {
                let event = event(&unknown(function, args.first())?);
                let turn = build_turn(&unknown(function, args.get(1))?, None);
                Ok(match compaction_event_trigger(&event, &turn) {
                    Some(CompactionTrigger::Manual) => json!("manual"),
                    Some(CompactionTrigger::Auto) => json!("auto"),
                    None => Value::Null,
                })
            }
            "adoptPartRoute" => {
                let session_id = text_arg(function, args, 2)?;
                let state = unknown(function, args.first())?;
                let logger = recording_logger();
                let routes = OpenCodeOperationRoutes::new(logger.clone());
                let session = (!state.is_null()).then(|| build_session(&state));
                if let Some(session) = &session {
                    let data = session.borrow();
                    routes
                        .register(
                            &session_id,
                            &data.chat_id,
                            data.turn.clone(),
                            true,
                            data.permission_mode,
                            data.directory.clone(),
                        )
                        .map_err(|failure| plain_error(function, failure))?;
                }
                let event = event(&unknown(function, args.get(1))?);
                let route =
                    adopt_open_code_compaction_part_route(OpenCodeCompactionPartRouteInput {
                        event: &event,
                        logger: logger.as_ref(),
                        operation_routes: &routes,
                        session: session.as_ref(),
                        session_id: &session_id,
                    });
                let resolvable = route.as_ref().is_some_and(|route| {
                    routes
                        .resolve(&session_id, &event)
                        .is_some_and(|resolved| Rc::ptr_eq(&resolved, route))
                });
                let log = logger.lines.borrow().clone();
                Ok(json!({
                    "adopted": route.is_some(),
                    "resolvable": resolvable,
                    "idle": routes.idle(),
                    "turn": session.map(|session| snapshot_turn(&session.borrow().turn)),
                    "log": log,
                }))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn sse_events_cases_match() {
    replay(
        format!("{CASES}/sse-events"),
        |function, args| {
            match function {
            "unwrapGlobalEvent" => Ok(unwrap_global_event(&value(function, args, 0)?)
                .map(|event| json!({
                    "id": event.id.map_or_else(markers::undefined, Value::String),
                    "type": event.kind,
                    "properties": event.properties.map_or_else(markers::undefined, Value::Object),
                }))
                .unwrap_or(Value::Null)),
            "openCodeAssistantTerminal" => Ok(open_code_assistant_terminal(&event(&value(
                function, args, 0,
            )?))
            .map(|terminal| terminal_value(&terminal))
            .unwrap_or(Value::Null)),
            "isOpenCodeCompactionAssistant" => Ok(json!(is_open_code_compaction_assistant(
                &value(function, args, 0)?
            ))),
            "isOpenCodeCompactionControlPart" => Ok(json!(is_open_code_compaction_control_part(
                &event(&value(function, args, 0)?)
            ))),
            "isOpenCodeManualCompactionControlPart" => Ok(json!(
                is_open_code_manual_compaction_control_part(&event(&value(function, args, 0)?))
            )),
            "isOpenCodeCompactionContinuationPart" => Ok(json!(
                is_open_code_compaction_continuation_part(&event(&value(function, args, 0)?))
            )),
            "extractSessionId" => {
                Ok(extract_session_id(&event(&value(function, args, 0)?))
                    .unwrap_or_else(markers::undefined))
            }
            "openCodeSessionRetryStatus" => {
                let status = open_code_session_retry_status(&event(&value(function, args, 0)?))
                    .map_err(invalid_date)?;
                Ok(status
                    .map(|status| retry_status_value(&status))
                    .unwrap_or(Value::Null))
            }
            "openCodeRetryNoticeText" => {
                let status = recorded_retry_status(function, &object(function, args, 0)?)?;
                Ok(Value::String(open_code_retry_notice_text(&status)))
            }
            "openCodeRetryNotice" => {
                let notice = open_code_retry_notice(&event(&value(function, args, 0)?))
                    .map_err(invalid_date)?;
                Ok(notice
                    .map(|notice| {
                        json!({
                            "key": notice.key,
                            "title": notice.title,
                            "content": notice.content,
                        })
                    })
                    .unwrap_or(Value::Null))
            }
            "extractTextParts" => Ok(Value::String(extract_text_parts(&unknown(
                function,
                args.first(),
            )?))),
            _ => Err(CaseError::unhandled(function)),
        }
        },
    );
}

fn retry_status_value(status: &OpenCodeSessionRetryStatus) -> Value {
    json!({ "attempt": status.attempt, "message": status.message, "nextAttemptAt": status.next_attempt_at })
}

fn recorded_retry_status(
    function: &str,
    status: &Map<String, Value>,
) -> Result<OpenCodeSessionRetryStatus, CaseError> {
    Ok(OpenCodeSessionRetryStatus {
        attempt: javascript_number(function, status.get("attempt"))?,
        message: text(status.get("message").unwrap_or(&Value::Null)).to_owned(),
        next_attempt_at: status
            .get("nextAttemptAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

#[test]
fn permissions_cases_match() {
    replay(
        format!("{CASES}/permissions"),
        |function, args| match function {
            "mapPermissionDecision" => Ok(Value::from(map_permission_decision(
                round_tripped(function, args.first())?.as_deref(),
            ))),
            "extractPermissionRequest" => {
                let request = extract_permission_request(&event(&value(function, args, 0)?));
                Ok(request
                    .map(|request| {
                        json!({
                            "requestId": request.request_id,
                            "toolInput": Value::Object(request.tool_input),
                        })
                    })
                    .unwrap_or(Value::Null))
            }
            "mapPermissionMode" => {
                let rules: Vec<Value> = map_permission_mode(&text_arg(function, args, 0)?)
                    .into_iter()
                    .map(|rule| json!({ "permission": rule.permission, "pattern": rule.pattern, "action": rule.action }))
                    .collect();
                Ok(Value::Array(rules))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn permission_tool_converter_cases_match() {
    replay(
        format!("{CASES}/permission-tool-converter"),
        |function, args| match function {
            "convertOpencodePermissionTool" => {
                let message = convert_opencode_permission_tool(
                    &text_arg(function, args, 0)?,
                    &text_arg(function, args, 1)?,
                    &value(function, args, 2)?,
                );
                Ok(tool_use_instance(&message))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn event_converter_cases_match() {
    use garcon_agent_opencode::agents::opencode::event_converter::convert_open_code_event_to_chat_messages;
    use garcon_interface::native_message_source::get_native_message_revision_source;

    replay(format!("{CASES}/event-converter"), |function, args| {
        if function != "convertEvents" {
            return Err(CaseError::unhandled(function));
        }
        let input = value(function, args, 0)?;
        let events = input
            .as_array()
            .ok_or_else(|| CaseError::unhandled(function))?;
        let turn = build_turn(&json!({}), None);
        let logger = recording_logger();
        let clock = ManualClock::new(FIXED_NOW);
        let results = events
            .iter()
            .map(|input| {
                convert_open_code_event_to_chat_messages(
                    &event(input),
                    &turn,
                    logger.as_ref(),
                    &clock,
                )
                .map(|rows| {
                    rows.iter()
                        .map(|row| {
                            json!({
                                "row": message_value(row),
                                        "source": get_native_message_revision_source(row),
                            })
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();
        let log = logger.lines.borrow().clone();
        Ok(json!({ "results": results, "turn": snapshot_turn(&turn), "log": log }))
    });
}

#[test]
fn history_loader_cases_match() {
    use garcon_agent_opencode::agents::opencode::history_loader::{
        convert_open_code_stored_messages, latest_open_code_stored_activity_at,
    };
    use garcon_base::event_loop::EventLoopSteps;
    use garcon_interface::native_message_source::get_native_message_revision_source;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let stats = replay(format!("{CASES}/history-loader"), |function, args| {
        if function != "convertHistory" {
            return Err(CaseError::unhandled(function));
        }
        let input = value(function, args, 0)?;
        let messages = input
            .as_array()
            .ok_or_else(|| CaseError::unhandled(function))?;
        let clock = ManualClock::new(FIXED_NOW);
        let (rows, activity) = runtime.block_on(async {
            let mut steps = EventLoopSteps::new("opencode-history-conversion");
            let rows = convert_open_code_stored_messages(messages, &mut steps, &clock).await;
            (
                rows,
                latest_open_code_stored_activity_at(messages, &clock).await,
            )
        });
        let rows: Vec<_> = rows
            .iter()
            .map(|row| {
                json!({
                    "row": message_value(row),
                    "source": get_native_message_revision_source(row),
                })
            })
            .collect();
        Ok(json!({"rows": rows, "lastActivity": activity}))
    });
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn tool_result_converter_cases_match() {
    use garcon_agent_opencode::agents::opencode::tool_result_converter::normalize_open_code_tool_result_content;

    replay(
        format!("{CASES}/tool-result-converter"),
        |function, args| {
            if function != "normalizeOpenCodeToolResultContent" {
                return Err(CaseError::unhandled(function));
            }
            Ok(message_value(&normalize_open_code_tool_result_content(
                &value(function, args, 0)?,
                &value(function, args, 1)?,
            )))
        },
    );
}

#[test]
fn tool_use_converter_cases_match() {
    use garcon_cases::{ReplayOptions, ResultOrderException, replay_with_options};

    let order_exceptions =
        ["convertOpenCodeToolUse", "convertOpenCodeQuestionToolUse"].map(|function| {
            ResultOrderException {
                function,
                path: "$.result.fields.questions[*]",
                reason: "The shared parser writes header before allowMultiple",
            }
        });
    replay_with_options(
        format!("{CASES}/tool-use-converter"),
        ReplayOptions {
            result_order_exceptions: &order_exceptions,
            ..Default::default()
        },
        |function, args| match function {
            "convertOpenCodeToolUse" => Ok(tool_use_instance(&convert_open_code_tool_use(
                &text_arg(function, args, 0)?,
                &value(function, args, 1)?,
            ))),
            "convertOpenCodeQuestionToolUse" => Ok(convert_open_code_question_tool_use(
                &text_arg(function, args, 0)?,
                &text_arg(function, args, 1)?,
                &value(function, args, 2)?,
            )
            .as_ref()
            .map(tool_use_instance)
            .unwrap_or(Value::Null)),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn questions_cases_match() {
    replay(
        format!("{CASES}/questions"),
        |function, args| match function {
            "extractOpenCodeQuestionRequest" => {
                let request =
                    extract_open_code_question_request(&event(&value(function, args, 0)?));
                Ok(request
                    .map(|request| {
                        json!({
                            "requestId": request.request_id,
                            "toolCallId": request.tool_call_id,
                            "questions": request.questions,
                        })
                    })
                    .unwrap_or(Value::Null))
            }
            "mapOpenCodeQuestionDecision" => {
                let questions = as_ask_user_questions(&unknown(function, args.first())?);
                let decision = object(function, args, 1)?;
                let response = decision
                    .get("response")
                    .filter(|response| response.is_object())
                    .map(|response| PermissionDecisionResponse::Provider(response.clone().into()));
                let payload = PermissionDecisionPayload {
                    allow: decision.get("allow") == Some(&Value::Bool(true)),
                    always_allow: decision.get("alwaysAllow").and_then(Value::as_bool),
                    response,
                };
                map_open_code_question_decision(&questions, &payload)
                    .map(|decision| match decision {
                        OpenCodeQuestionDecision::Reply { answers } => {
                            json!({ "kind": "reply", "answers": answers })
                        }
                        OpenCodeQuestionDecision::Reject => json!({ "kind": "reject" }),
                    })
                    .map_err(|failure| plain_error(function, failure))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn model_catalog_cases_match() {
    replay(
        format!("{CASES}/model-catalog"),
        |function, args| match function {
            "configuredProvidersFromResult" => Ok(json!(configured_providers_from_result(&value(
                function, args, 0
            )?))),
            "connectedProvidersFromListResult" => Ok(json!(connected_providers_from_list_result(
                &value(function, args, 0)?
            ))),
            "modelsFromProviders" => {
                let providers = required(function, args.first())?;
                let providers: Vec<&Value> = providers
                    .as_array()
                    .ok_or_else(|| CaseError::unhandled(function))?
                    .iter()
                    .collect();
                let models: Vec<Value> = models_from_providers(&providers)
                    .into_iter()
                    .map(|model| {
                        let mut value = Map::new();
                        value.insert("value".to_owned(), Value::String(model.value));
                        value.insert("label".to_owned(), Value::String(model.label));
                        if let Some(supports_images) = model.supports_images {
                            value.insert("supportsImages".to_owned(), json!(supports_images));
                        }
                        if let Some(thinking_modes) = model.thinking_modes {
                            value.insert(
                                "thinkingModes".to_owned(),
                                json!(
                                    thinking_modes
                                        .iter()
                                        .map(|mode| mode.as_str())
                                        .collect::<Vec<_>>()
                                ),
                            );
                        }
                        Value::Object(value)
                    })
                    .collect();
                Ok(Value::Array(models))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
