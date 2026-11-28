//! Replays the recordings of the `common/` modules ported in this crate
//! (ADR-020). `bun rust/parity/cli.ts unit record <module> --tests <its
//! tests> --inputs tests/inputs/common/<module>.jsonl --out tests/cases/common/<module>`
//! writes each recording, and every case must match here. Arguments are read
//! with the readers of `garcon_cases`.

use std::borrow::Cow;

use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, Stats, bigint, javascript_number, markers,
    replay, replay_with_options, round_tripped, text, unknown,
};
use garcon_contract::agent_integration::{
    is_agent_setting_label_key, is_agent_setting_option_description_key,
    is_agent_setting_option_label_key, parse_agent_settings_by_id, parse_agent_settings_envelope,
};
use garcon_contract::agents::{has_agent_execution_metadata, is_agent_id};
use garcon_contract::api_providers::{
    is_api_provider_id, is_api_provider_template_id, label_for_protocol,
};
use garcon_contract::attachments::{
    FileAttachmentMimeTypes, accepts_file_attachment_mime_type, chat_attachment_extension,
    chat_attachment_mime_type, has_file_attachment_support, is_image_attachment_mime_type,
    is_text_attachment_mime_type, is_valid_attachment_mime_type, is_video_attachment_mime_type,
};
use garcon_contract::chat_id::{
    InvalidChatIdError, InvalidChatIdValue, chat_id_created_at, chat_id_from_epoch_microseconds,
    chat_id_from_timestamp, legacy_chat_id_to_canonical, parse_chat_id_input,
};
use garcon_contract::chat_modes::{
    DEFAULT_PERMISSION_MODE, DEFAULT_THINKING_MODE, coerce_thinking_mode, is_permission_mode,
    is_thinking_mode, normalize_permission_mode, normalize_thinking_mode,
};
use garcon_contract::error_codes::is_error_code;
use garcon_contract::executor_path::is_within_executor_path;
use garcon_contract::executors::{
    effective_executor_id, is_executor_id, is_executor_secret, is_remote_executor_id,
    parse_create_executor_request, parse_executor_connection, parse_executor_id,
    parse_executor_snapshot, parse_executors, parse_update_executor_request,
};
use garcon_contract::input_format::{
    is_input_format_by_model, is_plain_text_input, literal_input_format,
};
use garcon_contract::json::{is_record, stable_json_stringify};
use garcon_contract::project_resolution::{
    ProjectTarget, is_project_unavailable_reason, parse_project_resolution_response,
    project_target_key,
};
use garcon_contract::{
    base_path, chat_plan, chat_stop, cli_presentation, cli_runtime_paths, client_chat_id,
    config_dir, server_runtime, tool_schedule,
};
use garcon_js::OptionalNullable;
use serde_json::{Map, Value, json};

#[test]
fn base_path_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/base-path"),
        |function, args| {
            let path = required_text(function, args.first())?;
            match function {
                "parseBasePath" => base_path::parse_base_path(path)
                    .map(as_json_value)
                    .map_err(|error| CaseError::new("Error", error.to_string())),
                "stripBasePath" => Ok(json!(base_path::strip_base_path(
                    path,
                    required_text(function, args.get(1))?,
                ))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_all_match("common/base-path.ts", stats);
}

#[test]
fn cli_runtime_paths_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/cli-runtime-paths"
        ),
        |function, args| {
            let path = required_text(function, args.first())?;
            let result = match function {
                "executorDataDirectory" => cli_runtime_paths::executor_data_directory(path),
                "cliGatewayRuntimeFile" => cli_runtime_paths::cli_gateway_runtime_file(path),
                "cliRuntimeFile" => {
                    let runtime: cli_runtime_paths::RuntimeKind =
                        serde_json::from_value(unknown(function, args.get(1))?.into_owned())
                            .map_err(|_| CaseError::unhandled(function))?;
                    cli_runtime_paths::cli_runtime_file(path, runtime)
                }
                _ => return Err(CaseError::unhandled(function)),
            };
            Ok(json!(result))
        },
    );
    assert_all_match("common/cli-runtime-paths.ts", stats);
}

#[test]
fn config_dir_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/config-dir"),
        |function, args| {
            let value = text(function, args.first())?;
            let result = match function {
                "resolveHomeDirectory" => {
                    config_dir::resolve_home_directory(value, text(function, args.get(1))?)
                }
                "resolveConfigDirectory" => {
                    let environment = object(function, args.get(1))?.unwrap_or_default();
                    let environment = config_dir::ConfigDirectoryEnvironment {
                        garcon_config_dir: environment
                            .get("GARCON_CONFIG_DIR")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        home: environment
                            .get("HOME")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    };
                    config_dir::resolve_config_directory(
                        value,
                        &environment,
                        text(function, args.get(2))?,
                    )
                }
                _ => return Err(CaseError::unhandled(function)),
            };
            result
                .map(as_json_value)
                .map_err(|error| CaseError::new("Error", error.to_string()))
        },
    );
    assert_all_match("common/config-dir.ts", stats);
}

#[test]
fn client_chat_id_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/client-chat-id"
        ),
        |function, args| {
            if function != "createClientChatIds" {
                return Err(CaseError::unhandled(function));
            }
            let values = unknown(function, args.first())?;
            let observations = values
                .as_array()
                .ok_or_else(|| CaseError::unhandled(function))?;
            let mut generator = client_chat_id::ClientChatIdGenerator::default();
            let clock = garcon_js::ManualClock::new(1_783_725_900_000);
            let ids = observations
                .iter()
                .map(|value| {
                    let observed = if value.is_null() {
                        None
                    } else {
                        Some(javascript_number(function, Some(value))?)
                    };
                    generator.create(observed, &clock).map_err(invalid_chat_id)
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(as_json_value(ids))
        },
    );
    assert_all_match("common/client-chat-id.ts", stats);
}

#[test]
fn server_runtime_contract_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/server-runtime"
        ),
        |function, args| {
            use server_runtime::*;
            if function == "new ServerRuntimeContractError" {
                let error = ServerRuntimeContractError::new(required_text(function, args.first())?);
                return Err(CaseError::new(
                    "ServerRuntimeContractError",
                    error.to_string(),
                ));
            }
            if function == "runtimeProofPayload" {
                return Ok(json!(runtime_proof_payload(
                    required_text(function, args.first())?,
                    required_text(function, args.get(1))?,
                )));
            }
            let value = unknown(function, args.first())?;
            let result = match function {
                "parseCliContext" => parse_cli_context(&value).map(as_json_value),
                "parseServerRuntimeProbe" => parse_server_runtime_probe(&value).map(as_json_value),
                "parseServerRuntimeDescriptor" => {
                    parse_server_runtime_descriptor(&value).map(as_json_value)
                }
                "parseCliRuntimeDescriptor" => {
                    parse_cli_runtime_descriptor(&value).map(as_json_value)
                }
                "isLocalCapability" => Ok(json!(is_local_capability(&value))),
                "isRuntimeProbeChallenge" => Ok(json!(is_runtime_probe_challenge(&value))),
                _ => return Err(CaseError::unhandled(function)),
            };
            result.map_err(|error| CaseError::new("ServerRuntimeContractError", error.to_string()))
        },
    );
    assert_all_match("common/server-runtime.ts", stats);
}

#[test]
fn chat_plan_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/chat-plan"),
        |function, args| {
            let value = unknown(function, args.first())?;
            let to_result = |value: Option<Value>| value.unwrap_or_else(markers::undefined);
            let result = match function {
                "coerceTodoItems" => chat_plan::coerce_todo_items(&value).map(as_json_value),
                "coercePlanSteps" => chat_plan::coerce_plan_steps(&value).map(as_json_value),
                "asCursorPlanTodos" => chat_plan::as_cursor_plan_todos(&value).map(as_json_value),
                "asCursorPlanPhases" => chat_plan::as_cursor_plan_phases(&value).map(as_json_value),
                _ => return Err(CaseError::unhandled(function)),
            };
            Ok(to_result(result))
        },
    );
    assert_all_match("common/chat-plan.ts", stats);
}

#[test]
fn chat_stop_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/chat-stop"),
        |function, args| {
            let outcome: chat_stop::ChatStopOutcome =
                serde_json::from_value(args.first().cloned().unwrap_or(Value::Null))
                    .map_err(|_| CaseError::unhandled(function))?;
            match function {
                "isStopSatisfied" => Ok(json!(chat_stop::is_stop_satisfied(outcome))),
                "isAbortAcknowledged" => Ok(json!(chat_stop::is_abort_acknowledged(outcome))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_all_match("common/chat-stop.ts", stats);
}

#[test]
fn cli_presentation_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/cli-presentation"
        ),
        |function, args| {
            use cli_presentation::*;
            if function == "normalizeCliHexColor" {
                let value = required_text(function, args.first())?;
                return Ok(json!(normalize_cli_hex_color(value)));
            }
            let value = unknown(function, args.first())?;
            Ok(match function {
                "isCliPresentationStyle" => json!(is_cli_presentation_style(&value).is_some()),
                "isCliPresetPresentationStyle" => {
                    json!(is_cli_preset_presentation_style(&value).is_some())
                }
                "isHexColor" => json!(is_hex_color(&value)),
                "isCliCustomStyle" => json!(is_cli_custom_style(&value).is_some()),
                "isCliPresentation" => json!(is_cli_presentation(&value).is_some()),
                "isCliRowFormat" => json!(is_cli_row_format(&value).is_some()),
                "isCliBodyDisclosure" => json!(is_cli_body_disclosure(&value).is_some()),
                "coerceDurableCliBodyDisclosure" => {
                    json!(coerce_durable_cli_body_disclosure(&value))
                }
                "coerceDurableCliPresentation" => json!(coerce_durable_cli_presentation(&value)),
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
    assert_all_match("common/cli-presentation.ts", stats);
}

#[test]
fn tool_schedule_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/tool-schedule"
        ),
        |function, args| {
            use tool_schedule::*;
            let value = unknown(function, args.first())?;
            let request = parse_tool_schedule_request(&value);
            if function == "parseToolScheduleRequest" {
                return Ok(json!(request));
            }
            let request = request.ok_or_else(|| CaseError::unhandled(function))?;
            Ok(match function {
                "hasSchedulePrompt" => json!(has_schedule_prompt(&request)),
                "toolScheduleTitle" => json!(tool_schedule_title(&request)),
                "toolScheduleOptions" => json!(tool_schedule_options(&request)),
                "toolScheduleDetails" => json!(tool_schedule_details(&request)),
                "describeToolSchedule" => json!(describe_tool_schedule(&request)),
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
    assert_all_match("common/tool-schedule.ts", stats);
}

fn assert_all_match(module: &str, stats: Stats) {
    // A wildcard would let the port return anything for that case.
    assert_eq!(
        stats.with_wildcards, 0,
        "{module}: the recording has wildcards"
    );
    assert_eq!(stats.passed, stats.total, "{module}: recorded cases differ");
}

/// An argument the original typed `string`. One that is absent or `null` is
/// no string the port's parameter can hold, so the case is not handled.
fn required_text<'a>(function: &str, argument: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, argument)?.ok_or_else(|| CaseError::unhandled(function))
}

/// An argument the original typed as an object, or `None` where it received
/// `undefined` or no argument.
fn object<'a>(
    function: &str,
    argument: Option<&'a Value>,
) -> Result<Option<Cow<'a, Map<String, Value>>>, CaseError> {
    match round_tripped(function, argument)? {
        None => Ok(None),
        Some(Cow::Borrowed(Value::Object(entries))) => Ok(Some(Cow::Borrowed(entries))),
        Some(Cow::Owned(Value::Object(entries))) => Ok(Some(Cow::Owned(entries))),
        _ => Err(CaseError::unhandled(function)),
    }
}

fn invalid_chat_id(error: InvalidChatIdError) -> CaseError {
    let message = error.to_string();
    let value = match error.value {
        InvalidChatIdValue::Undefined => markers::undefined(),
        InvalidChatIdValue::Number(number) => markers::number(number),
        InvalidChatIdValue::Json(value) => as_json_value(value),
    };
    CaseError::new("InvalidChatIdError", message).with_property("value", value)
}

fn chat_id_result(
    chat_id: Result<garcon_contract::chat_id::ChatId, CaseError>,
) -> Result<Value, CaseError> {
    chat_id.map(|chat_id| json!(chat_id.as_str()))
}

fn dispatch_chat_id(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "new InvalidChatIdError" => {
            let value = round_tripped(function, args.first())?;
            Err(invalid_chat_id(InvalidChatIdError::new(
                InvalidChatIdValue::from_json(value.as_deref()),
            )))
        }
        "parseChatId" => {
            let value = round_tripped(function, args.first())?;
            chat_id_result(parse_chat_id_input(value.as_deref()).map_err(invalid_chat_id))
        }
        "chatIdFromEpochMicroseconds" => chat_id_result(
            chat_id_from_epoch_microseconds(bigint(function, args.first())?)
                .map_err(invalid_chat_id),
        ),
        "chatIdFromTimestamp" => {
            let epoch_ms = javascript_number(function, args.first())?;
            let micros_within_ms = javascript_number(function, args.get(1))?;
            chat_id_result(
                chat_id_from_timestamp(epoch_ms, micros_within_ms).map_err(invalid_chat_id),
            )
        }
        "chatIdCreatedAt" => chat_id_created_at(required_text(function, args.first())?)
            .map(|epoch_ms| {
                markers::marker(
                    "date",
                    json!(garcon_js::to_iso_string(epoch_ms).expect("a chat ID is a valid Date")),
                )
            })
            .map_err(invalid_chat_id),
        "legacyChatIdToCanonical" => {
            let value = round_tripped(function, args.first())?;
            legacy_chat_id_to_canonical(value.as_deref().unwrap_or(&Value::Null))
                .map(|chat_id| chat_id.map_or(Value::Null, |chat_id| json!(chat_id.as_str())))
                .map_err(invalid_chat_id)
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn chat_id_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/chat-id"),
        dispatch_chat_id,
    );
    assert_all_match("common/chat-id.ts", stats);
}

fn as_json_value<T: serde::Serialize>(value: T) -> Value {
    let text = serde_json::to_string(&value).expect("a contract type serializes");
    garcon_js::json::from_str(&text).expect("a contract type serializes to JSON")
}

fn dispatch_executors(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "effectiveExecutorId" => Ok(json!(effective_executor_id(text(function, args.first())?))),
        "isRemoteExecutorId" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_remote_executor_id(&value)))
        }
        "isExecutorSecret" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_executor_secret(&value)))
        }
        "isExecutorId" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_executor_id(&value)))
        }
        "parseExecutorId" => {
            let value = unknown(function, args.first())?;
            Ok(parse_executor_id(&value).map_or(Value::Null, |id| json!(id)))
        }
        "parseCreateExecutorRequest" => {
            let value = round_tripped(function, args.first())?;
            Ok(
                parse_create_executor_request(value.as_deref().unwrap_or(&Value::Null))
                    .map_or(Value::Null, as_json_value),
            )
        }
        "parseUpdateExecutorRequest" => {
            let value = round_tripped(function, args.first())?;
            Ok(
                parse_update_executor_request(value.as_deref().unwrap_or(&Value::Null))
                    .map_or(Value::Null, as_json_value),
            )
        }
        "parseExecutorSnapshot" => {
            let value = round_tripped(function, args.first())?;
            Ok(
                parse_executor_snapshot(value.as_deref().unwrap_or(&Value::Null))
                    .map_or(Value::Null, as_json_value),
            )
        }
        "parseExecutors" => {
            let value = round_tripped(function, args.first())?;
            Ok(parse_executors(value.as_deref().unwrap_or(&Value::Null))
                .map_or(Value::Null, as_json_value))
        }
        "parseExecutorConnection" => {
            let value = round_tripped(function, args.first())?;
            Ok(
                parse_executor_connection(value.as_deref().unwrap_or(&Value::Null))
                    .map_or(Value::Null, as_json_value),
            )
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn executors_cases_match() {
    const CALLER_ORDER: &str = "pass-through of the request's object; key order is the caller's";
    let stats = replay_with_options(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/executors"),
        ReplayOptions {
            result_order_exceptions: &[
                ResultOrderException {
                    function: "parseUpdateExecutorRequest",
                    path: "$.result.connection",
                    reason: CALLER_ORDER,
                },
                ResultOrderException {
                    function: "parseExecutorSnapshot",
                    path: "$.result",
                    reason: CALLER_ORDER,
                },
                ResultOrderException {
                    function: "parseExecutors",
                    path: "$.result[*]",
                    reason: CALLER_ORDER,
                },
            ],
            ..Default::default()
        },
        dispatch_executors,
    );
    assert_all_match("common/executors.ts", stats);
}

fn dispatch_json(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isRecord" => {
            let value = round_tripped(function, args.first())?;
            Ok(json!(is_record(value.as_deref().unwrap_or(&Value::Null))))
        }
        "stableJsonStringify" => {
            let value = round_tripped(function, args.first())?;
            let value = value.ok_or_else(|| CaseError::unhandled(function))?;
            Ok(json!(stable_json_stringify(&value)))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn json_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/json"),
        dispatch_json,
    );
    assert_all_match("common/json.ts", stats);
}

#[test]
fn error_codes_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/error-codes"
        ),
        |function, args| match function {
            "isErrorCode" => {
                let value = unknown(function, args.first())?;
                Ok(json!(is_error_code(&value).is_some()))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_all_match("common/error-codes.ts", stats);
}

#[test]
fn executor_path_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/executor-path"
        ),
        |function, args| match function {
            "isWithinExecutorPath" => {
                let root = text(function, args.first())?;
                let candidate = text(function, args.get(1))?;
                match (root, candidate) {
                    (Some(root), Some(candidate)) => {
                        Ok(json!(is_within_executor_path(root, candidate)))
                    }
                    _ => Err(CaseError::unhandled(function)),
                }
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_all_match("common/executor-path.ts", stats);
}

/// The file types an agent accepts, as the original receives them: `"any"`,
/// an array of MIME types, or another text.
fn file_attachment_mime_types(
    function: &str,
    argument: Option<&Value>,
) -> Result<FileAttachmentMimeTypes, CaseError> {
    match unknown(function, argument)?.as_ref() {
        Value::String(supported) => Ok(if supported == "any" {
            FileAttachmentMimeTypes::Any
        } else {
            FileAttachmentMimeTypes::Text(supported.to_owned())
        }),
        Value::Array(supported) => {
            let types = supported
                .iter()
                .map(|mime_type| {
                    mime_type
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| CaseError::unhandled(function))
                })
                .collect::<Result<Vec<String>, CaseError>>()?;
            Ok(FileAttachmentMimeTypes::Listed(types))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

fn dispatch_attachments(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "chatAttachmentMimeType" => {
            let file = object(function, args.first())?;
            let file = file
                .as_deref()
                .ok_or_else(|| CaseError::unhandled(function))?;
            let name = required_text(function, file.get("name"))?;
            let declared_type = file.get("type").and_then(Value::as_str);
            Ok(json!(chat_attachment_mime_type(name, declared_type)))
        }
        "chatAttachmentExtension" => required_text(function, args.first()).map(|mime_type| {
            chat_attachment_extension(mime_type).map_or(Value::Null, |extension| json!(extension))
        }),
        "isValidAttachmentMimeType" => Ok(json!(is_valid_attachment_mime_type(required_text(
            function,
            args.first()
        )?))),
        "isImageAttachmentMimeType" => Ok(json!(is_image_attachment_mime_type(required_text(
            function,
            args.first()
        )?))),
        "isTextAttachmentMimeType" => Ok(json!(is_text_attachment_mime_type(required_text(
            function,
            args.first()
        )?))),
        "isVideoAttachmentMimeType" => Ok(json!(is_video_attachment_mime_type(required_text(
            function,
            args.first()
        )?))),
        "acceptsFileAttachmentMimeType" => {
            let supported = file_attachment_mime_types(function, args.first())?;
            let mime_type = required_text(function, args.get(1))?;
            Ok(json!(accepts_file_attachment_mime_type(
                &supported, mime_type
            )))
        }
        "hasFileAttachmentSupport" => Ok(json!(has_file_attachment_support(
            &file_attachment_mime_types(function, args.first())?
        ))),
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn attachments_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/attachments"
        ),
        dispatch_attachments,
    );
    assert_all_match("common/attachments.ts", stats);
}

fn dispatch_input_format(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isInputFormatByModel" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_input_format_by_model(&value)))
        }
        "literalInputFormat" => {
            let formats = object(function, args.first())?;
            let formats = formats
                .as_deref()
                .ok_or_else(|| CaseError::unhandled(function))?;
            let model = required_text(function, args.get(1))?;
            let formats = garcon_js::json::Opaque::from_value(Value::Object(formats.clone()));
            Ok(as_json_value(literal_input_format(&formats, model)))
        }
        "isPlainTextInput" => {
            let message = object(function, args.first())?;
            let metadata = message
                .as_deref()
                .and_then(|message| message.get("metadata"));
            Ok(json!(is_plain_text_input(metadata)))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

/// A project target as the original receives it. The original tells a chat
/// target from a path by `kind === 'chat'` alone, so a target of any other
/// kind is a path target.
fn project_target(function: &str, target: &Map<String, Value>) -> Result<ProjectTarget, CaseError> {
    let executor_id = match target.get("executorId") {
        None => OptionalNullable::ABSENT,
        Some(Value::Null) => OptionalNullable::NULL,
        Some(executor_id) => executor_id
            .as_str()
            .map(|executor_id| OptionalNullable::some(executor_id.to_owned()))
            .ok_or_else(|| CaseError::unhandled(function))?,
    };
    let project_path = required_text(function, target.get("projectPath"))?.to_owned();
    if target.get("kind").and_then(Value::as_str) == Some("chat") {
        let chat_id = required_text(function, target.get("chatId"))?.to_owned();
        Ok(ProjectTarget::Chat {
            chat_id,
            executor_id,
            project_path,
        })
    } else {
        Ok(ProjectTarget::Path {
            executor_id,
            project_path,
        })
    }
}

fn dispatch_project_resolution(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "projectTargetKey" => {
            let target = object(function, args.first())?;
            let target = target
                .as_deref()
                .ok_or_else(|| CaseError::unhandled(function))?;
            Ok(json!(project_target_key(&project_target(
                function, target
            )?)))
        }
        "isProjectUnavailableReason" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_project_unavailable_reason(&value).is_some()))
        }
        "parseProjectResolutionResponse" => {
            let value = unknown(function, args.first())?;
            Ok(parse_project_resolution_response(&value).map_or(Value::Null, as_json_value))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn project_resolution_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/project-resolution"
        ),
        dispatch_project_resolution,
    );
    assert_all_match("common/project-resolution.ts", stats);
}

#[test]
fn input_format_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/input-format"
        ),
        dispatch_input_format,
    );
    assert_all_match("common/input-format.ts", stats);
}

/// The fallback a recorded call names, or the original's default when the
/// call names none.
fn mode_fallback<T: Copy>(
    function: &str,
    argument: Option<&Value>,
    default: T,
    read: fn(&Value) -> Option<T>,
) -> Result<T, CaseError> {
    match round_tripped(function, argument)? {
        None => Ok(default),
        Some(fallback) => read(&fallback).ok_or_else(|| CaseError::unhandled(function)),
    }
}

fn dispatch_chat_modes(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let value = unknown(function, args.first())?;
    match function {
        "isPermissionMode" => Ok(json!(is_permission_mode(&value).is_some())),
        "isThinkingMode" => Ok(json!(is_thinking_mode(&value).is_some())),
        "normalizePermissionMode" => {
            let fallback = mode_fallback(
                function,
                args.get(1),
                DEFAULT_PERMISSION_MODE,
                is_permission_mode,
            )?;
            Ok(json!(normalize_permission_mode(&value, fallback).as_str()))
        }
        "coerceThinkingMode" => {
            Ok(coerce_thinking_mode(&value).map_or(Value::Null, |mode| json!(mode.as_str())))
        }
        "normalizeThinkingMode" => {
            let fallback = mode_fallback(
                function,
                args.get(1),
                DEFAULT_THINKING_MODE,
                is_thinking_mode,
            )?;
            Ok(json!(normalize_thinking_mode(&value, fallback).as_str()))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn chat_modes_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/chat-modes"),
        dispatch_chat_modes,
    );
    assert_all_match("common/chat-modes.ts", stats);
}

fn dispatch_agents(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let value = unknown(function, args.first())?;
    match function {
        "isAgentId" => Ok(json!(is_agent_id(&value))),
        "hasAgentExecutionMetadata" => Ok(json!(has_agent_execution_metadata(&value))),
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn agents_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/agents"),
        dispatch_agents,
    );
    assert_all_match("common/agents.ts", stats);
}

fn dispatch_api_providers(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isApiProviderId" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_api_provider_id(&value)))
        }
        "isApiProviderTemplateId" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_api_provider_template_id(&value).is_some()))
        }
        "labelForProtocol" => Ok(json!(label_for_protocol(required_text(
            function,
            args.first()
        )?))),
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn api_providers_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/api-providers"
        ),
        dispatch_api_providers,
    );
    assert_all_match("common/api-providers.ts", stats);
}

fn dispatch_agent_integration(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let value = unknown(function, args.first())?;
    match function {
        "isAgentSettingLabelKey" => Ok(json!(is_agent_setting_label_key(&value).is_some())),
        "isAgentSettingOptionLabelKey" => {
            Ok(json!(is_agent_setting_option_label_key(&value).is_some()))
        }
        "isAgentSettingOptionDescriptionKey" => Ok(json!(
            is_agent_setting_option_description_key(&value).is_some()
        )),
        "parseAgentSettingsEnvelope" => {
            Ok(parse_agent_settings_envelope(&value).map_or(Value::Null, as_json_value))
        }
        "parseAgentSettingsById" => {
            Ok(parse_agent_settings_by_id(&value).map_or(Value::Null, as_json_value))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn agent_integration_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/agent-integration"
        ),
        dispatch_agent_integration,
    );
    assert_all_match("common/agent-integration.ts", stats);
}
