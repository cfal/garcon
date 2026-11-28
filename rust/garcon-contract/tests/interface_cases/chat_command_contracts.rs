use garcon_cases::{CaseError, markers, round_tripped, text, unknown};
use garcon_contract::{
    chat_command_contracts::*,
    chat_execution_command_parsing::{
        optional_agent_handoff_request, optional_agent_settings, optional_api_protocol,
        optional_permission_mode, optional_thinking_mode, required_agent_settings,
    },
    chat_fork_command_parsing::parse_handoff_fork_consent,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{bun::bun_fixtures, helpers::recorded_cases};

fn thrown(error: CommandRequestValidationError) -> CaseError {
    CaseError::new("CommandRequestValidationError", error.message)
}

fn wire(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn optional(value: Option<impl Serialize>) -> Value {
    value.map_or_else(markers::undefined, wire)
}

fn string<'a>(function: &str, value: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, value)?.ok_or_else(|| CaseError::unhandled(function))
}

fn main_dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "new CommandRequestValidationError" => {
            return Err(thrown(CommandRequestValidationError::new(string(
                function,
                args.first(),
            )?)));
        }
        "isCommandCorrelationIdWithinLimit" => {
            return Ok(json!(is_command_correlation_id_within_limit(string(
                function,
                args.first()
            )?)));
        }
        "isQueueEntryIdWithinLimit" => {
            return Ok(json!(is_queue_entry_id_within_limit(string(
                function,
                args.first()
            )?)));
        }
        "recordsStartupPreferences" => {
            let origin = unknown(function, args.first())?;
            let origin = garcon_js::json::from_str(&origin.to_string())
                .map_err(|_| CaseError::unhandled(function))?;
            return Ok(json!(records_startup_preferences(origin)));
        }
        _ => {}
    }
    let input = unknown(function, args.first())?;
    Ok(match function {
        "parseStartChatCommandRequest" => {
            wire(parse_start_chat_command_request(&input).map_err(thrown)?)
        }
        "parseAgentRunCommandRequest" => {
            wire(parse_agent_run_command_request(&input).map_err(thrown)?)
        }
        "parseAgentHandoffCommandRequest" => {
            wire(parse_agent_handoff_command_request(&input).map_err(thrown)?)
        }
        "parseForkChatCommandRequest" => {
            wire(parse_fork_chat_command_request(&input).map_err(thrown)?)
        }
        "parseDeleteChatCommandRequest" => {
            wire(parse_delete_chat_command_request(&input).map_err(thrown)?)
        }
        "parseForkRunCommandRequest" => {
            wire(parse_fork_run_command_request(&input).map_err(thrown)?)
        }
        "parseQueueEntryCreateCommandRequest" => {
            wire(parse_queue_entry_create_command_request(&input).map_err(thrown)?)
        }
        "parseQueueEntryReplaceCommandRequest" => {
            wire(parse_queue_entry_replace_command_request(&input).map_err(thrown)?)
        }
        "parseQueueEntryDeleteCommandRequest" => {
            wire(parse_queue_entry_delete_command_request(&input).map_err(thrown)?)
        }
        "parseQueueEntryMoveCommandRequest" => {
            wire(parse_queue_entry_move_command_request(&input).map_err(thrown)?)
        }
        "parseQueueEntrySteerCommandRequest" => {
            wire(parse_queue_entry_steer_command_request(&input).map_err(thrown)?)
        }
        "parseSteerCommandRequest" => wire(parse_steer_command_request(&input).map_err(thrown)?),
        "parseQueueMutationRequest" => wire(parse_queue_mutation_request(&input).map_err(thrown)?),
        "parseQueueResumeRequest" => wire(parse_queue_resume_request(&input).map_err(thrown)?),
        "parsePermissionDecisionCommandRequest" => {
            wire(parse_permission_decision_command_request(&input).map_err(thrown)?)
        }
        "parseAgentStopCommandRequest" => {
            wire(parse_agent_stop_command_request(&input).map_err(thrown)?)
        }
        "parseAgentInterruptAndSendCommandRequest" => {
            wire(parse_agent_interrupt_and_send_command_request(&input).map_err(thrown)?)
        }
        "parseCompactCommandRequest" => {
            wire(parse_compact_command_request(&input).map_err(thrown)?)
        }
        "parseProjectPathPatchRequest" => {
            wire(parse_project_path_patch_request(&input).map_err(thrown)?)
        }
        "normalizeAskUserQuestionDecisionResponse" => {
            wire(normalize_ask_user_question_decision_response(&input))
        }
        _ => return Err(CaseError::unhandled(function)),
    })
}

#[test]
fn chat_command_contract_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-command-contracts"
        ),
        "common/chat-command-contracts.ts",
        main_dispatch,
    );
}

#[test]
fn chat_execution_command_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-execution-command-parsing"
        ),
        "common/chat-execution-command-parsing.ts",
        |function, args| {
            let input = round_tripped(function, args.first())?;
            let value = input.as_deref();
            let field = || string(function, args.get(1));
            Ok(match function {
                "parseAgentHandoffCommandRequest" => wire(
                    parse_agent_handoff_command_request(value.unwrap_or(&Value::Null))
                        .map_err(thrown)?,
                ),
                "optionalAgentHandoffRequest" => {
                    optional(optional_agent_handoff_request(value).map_err(thrown)?)
                }
                "optionalApiProtocol" => {
                    let protocol = optional_api_protocol(value).map_err(thrown)?;
                    if protocol.is_absent() {
                        markers::undefined()
                    } else {
                        wire(protocol)
                    }
                }
                "optionalPermissionMode" => {
                    optional(optional_permission_mode(value).map_err(thrown)?)
                }
                "optionalThinkingMode" => optional(optional_thinking_mode(value).map_err(thrown)?),
                "requiredAgentSettings" => wire(
                    required_agent_settings(value.unwrap_or(&Value::Null), field()?)
                        .map_err(thrown)?,
                ),
                "optionalAgentSettings" => {
                    optional(optional_agent_settings(value, field()?).map_err(thrown)?)
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}

#[test]
fn chat_fork_command_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-fork-command-parsing"
        ),
        "common/chat-fork-command-parsing.ts",
        |function, args| {
            let input = unknown(function, args.first())?;
            Ok(match function {
                "parseForkChatCommandRequest" => {
                    wire(parse_fork_chat_command_request(&input).map_err(thrown)?)
                }
                "parseDeleteChatCommandRequest" => {
                    wire(parse_delete_chat_command_request(&input).map_err(thrown)?)
                }
                "parseHandoffForkConsent" => {
                    let body = input
                        .as_object()
                        .ok_or_else(|| CaseError::unhandled(function))?;
                    optional(parse_handoff_fork_consent(body).map_err(thrown)?)
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}

#[test]
fn wire_matches_bun_parser_field_order_and_permission_response_json() {
    let fixtures = garcon_js::json::parse(&bun_fixtures("chat-command-wire-fixtures.ts")).unwrap();
    let requests = fixtures["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 6);
    for (index, request) in requests.iter().enumerate() {
        let input = garcon_js::json::parse(request["input"].as_str().unwrap()).unwrap();
        let actual = match index {
            0 => serde_json::to_string(&parse_start_chat_command_request(&input).unwrap()),
            1 => serde_json::to_string(&parse_agent_run_command_request(&input).unwrap()),
            2 => serde_json::to_string(&parse_agent_handoff_command_request(&input).unwrap()),
            3 => serde_json::to_string(&parse_fork_chat_command_request(&input).unwrap()),
            4 => serde_json::to_string(&parse_queue_entry_move_command_request(&input).unwrap()),
            5 => serde_json::to_string(&parse_permission_decision_command_request(&input).unwrap()),
            _ => unreachable!(),
        }
        .unwrap();
        assert_eq!(
            actual,
            request["parsed"].as_str().unwrap(),
            "request fixture {index}"
        );
    }

    let input = garcon_js::json::parse(requests[5]["input"].as_str().unwrap()).unwrap();
    let command = parse_permission_decision_command_request(&input).unwrap();
    let decision = PermissionDecisionPayload {
        allow: command.allow,
        always_allow: Some(command.always_allow),
        response: command.response,
    };
    assert_eq!(
        serde_json::to_string(&decision).unwrap(),
        fixtures["decision"].as_str().unwrap()
    );
    let decoded: PermissionDecisionPayload =
        garcon_js::json::from_str(fixtures["rawDecision"].as_str().unwrap()).unwrap();
    assert_eq!(
        serde_json::to_string(&decoded).unwrap(),
        fixtures["providerDecision"].as_str().unwrap()
    );
}
