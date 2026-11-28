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

fn ticket_recording_result<T: Serialize>(
    result: Result<T, garcon_contract::ticket_validation::TicketValidationError>,
) -> Result<Value, CaseError> {
    let value =
        result.map_err(|error| CaseError::new("TicketValidationError", error.to_string()))?;
    Ok(serialized_record(value))
}

#[test]
fn garcon_commands_recordings() {
    use garcon_contract::chat_types::parse_chat_message;
    use garcon_contract::garcon_commands::*;
    assert_recording("garcon-commands", |function, args| match function {
        "extractGarconCommands" => {
            let input = unknown(function, args.first())?;
            let message = parse_chat_message(&input)
                .map_err(|error| CaseError::undeliverable(error.to_string()))?
                .ok_or_else(|| CaseError::undeliverable("expected a chat message"))?;
            let Some(output) = extract_garcon_commands(&message) else {
                return Ok(Value::Null);
            };
            Ok(json!({
                "message": output.message.map(|message| instance_record("AssistantMessage", message)),
                "commands": serialized_record(output.commands),
                "issues": serialized_record(output.issues),
            }))
        }
        "garconMessageContent" => {
            let value = unknown(function, args.first())?;
            let sender = if value.is_null() {
                None
            } else {
                Some(
                    garcon_contract::chat_id::parse_chat_id(&value)
                        .map_err(|error| CaseError::undeliverable(error.to_string()))?,
                )
            };
            Ok(json!(garcon_message_content(
                sender.as_ref(),
                required_text(function, args.get(1))?
            )))
        }
        "parseGarconMessage" => Ok(serialized_record(parse_garcon_message(required_text(
            function,
            args.first(),
        )?))),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn garcon_commands_keeps_unicode_prose_and_extracts_trailing_commands_in_document_order() {
    use garcon_contract::chat_types::{AssistantMessage, ChatMessage};
    use garcon_contract::garcon_commands::*;
    let message = ChatMessage::Assistant(AssistantMessage {
        timestamp: "now".into(),
        content: "\u{1f600} answer \r\n<garcon-send-message to=\"1787974832309199, 1787974832309199\" hide-sender=\"false\">\r\nmessage\r\n</garcon-send-message>\r\n<garcon-get-chat-id />\n\u{a0}".into(),
        questions: None,
    });
    let output = extract_garcon_commands(&message).unwrap();
    assert_eq!(output.message.as_ref().unwrap().content, "\u{1f600} answer");
    assert!(output.issues.is_empty());
    let [
        GarconEdgeCommand::SendMessage {
            recipients,
            hide_sender,
            body,
        },
        GarconEdgeCommand::GetChatId,
    ] = output.commands.as_slice()
    else {
        panic!("expected an ordered send and chat ID query");
    };
    assert_eq!(recipients.len(), 1);
    assert!(!hide_sender);
    assert_eq!(body, "message");

    let expected = pinned_bun_stdout(
        r#"import { extractGarconCommands } from "./common/garcon-commands.ts";
           console.log(JSON.stringify(extractGarconCommands(JSON.parse(process.argv[1]))));"#,
        &[&serde_json::to_string(&message).unwrap()],
    );
    assert_eq!(serde_json::to_string(&output).unwrap(), expected.trim_end());
}

#[test]
fn garcon_commands_keeps_an_unclosed_envelope_opaque() {
    use garcon_contract::chat_types::{AssistantMessage, ChatMessage};
    use garcon_contract::garcon_commands::*;
    let content = "Answer\n<garcon-send-message to=\"1787974832309199\" hide-sender=\"false\">\n<garcon-get-chat-id />";
    let result = extract_garcon_commands(&ChatMessage::Assistant(AssistantMessage {
        timestamp: "now".into(),
        content: content.into(),
        questions: None,
    }))
    .unwrap();
    assert_eq!(result.message.unwrap().content, content);
    assert!(result.commands.is_empty());
    assert_eq!(result.issues.len(), 1);
    assert_eq!(result.issues[0].command.as_str(), "send-message");
    assert_eq!(result.issues[0].edge, GarconCommandIssueEdge::Trailing);
}

#[test]
fn garcon_commands_preserves_a_large_comparison_heavy_remainder() {
    use garcon_contract::chat_types::{AssistantMessage, ChatMessage};
    use garcon_contract::garcon_commands::{GarconEdgeCommand, extract_garcon_commands};
    let command = "<garcon-start-agent ref=\"task\">Synthetic.</garcon-start-agent>";
    let prose = "Compare a<b. It doesn't work. ".repeat(64_000);
    let result = extract_garcon_commands(&ChatMessage::Assistant(AssistantMessage {
        timestamp: "now".into(),
        content: format!("{command}\n{prose}\n{command}"),
        questions: None,
    }))
    .unwrap();
    assert!(matches!(
        result.commands.as_slice(),
        [
            GarconEdgeCommand::StartAgent(_),
            GarconEdgeCommand::StartAgent(_)
        ]
    ));
    assert!(result.issues.is_empty());
    assert_eq!(result.message.unwrap().content, prose.trim_end());
}

#[test]
fn garcon_received_message_limits_utf8_bytes_and_preserves_replacement_characters() {
    use garcon_contract::garcon_commands::*;
    let padding = "\u{1f600}".repeat(GARCON_MESSAGE_BODY_MAX_BYTES / 4 - 1);
    let full = format!("{padding}\u{fffd}x");
    assert_eq!(
        parse_garcon_message(&garcon_message_content(None, &full))
            .unwrap()
            .body,
        full
    );
    assert!(parse_garcon_message(&garcon_message_content(None, &(full + "x"))).is_none());
}

#[test]
fn self_handoff_contract_recordings() {
    use garcon_contract::self_handoff_contracts::parse_self_handoff_run_command_request;
    assert_recording("self-handoff-contracts", |function, args| match function {
        "parseSelfHandoffRunCommandRequest" => {
            let value = unknown(function, args.first())?;
            parse_self_handoff_run_command_request(&value)
                .map(serialized_record)
                .map_err(|error| CaseError::new("CommandRequestValidationError", error.message))
        }
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn self_handoff_keeps_the_fork_validation_and_only_the_continuation_fields() {
    use garcon_contract::self_handoff_contracts::parse_self_handoff_run_command_request;
    let mut input = json!({
        "clientRequestId": " req ", "clientMessageId": " msg ",
        "sourceChatId": "1000000000000001", "chatId": "1000000000000002",
        "images": [{"data":"YWJj","name":"note.png","mimeType":"image/png"}],
        "model": "demo", "allowHandoffFork": true,
    });
    let expected = pinned_bun_stdout(
        r#"import { parseSelfHandoffRunCommandRequest } from "./common/self-handoff-contracts.ts";
           console.log(JSON.stringify(parseSelfHandoffRunCommandRequest(JSON.parse(process.argv[1]))));"#,
        &[&garcon_js::json::stringify(&input)],
    );
    let result = parse_self_handoff_run_command_request(&input).unwrap();
    assert_eq!(serde_json::to_string(&result).unwrap(), expected.trim_end());
    input["model"] = json!(42);
    assert_eq!(
        parse_self_handoff_run_command_request(&input).unwrap_err(),
        garcon_contract::chat_command_contracts::parse_fork_run_command_request(&input)
            .unwrap_err(),
    );
}

#[test]
fn ws_session_event_recordings() {
    use garcon_contract::ws_events::*;
    #[derive(serde::Deserialize)]
    #[serde(
        tag = "outcome",
        rename_all = "kebab-case",
        rename_all_fields = "camelCase"
    )]
    enum RecordedControl {
        Snapshot { chat_id: String, control: Value },
        NotFound { chat_id: String },
        Unavailable { chat_id: String },
    }

    assert_recording("ws-events", |function, args| match function {
        "parseServerWsMessage" => {
            let value = unknown(function, args.first())?;
            Ok(match parse_session_ws_message(&value) {
                Some(SessionWsMessage::ReconnectState(value)) => {
                    instance_record("ReconnectStateMessage", value)
                }
                Some(SessionWsMessage::WsFault(value)) => instance_record("WsFaultMessage", value),
                Some(SessionWsMessage::WsPong(value)) => instance_record("WsPongMessage", value),
                Some(SessionWsMessage::ClientRequestError(value)) => {
                    instance_record("ClientRequestErrorMessage", value)
                }
                None => Value::Null,
            })
        }
        "new ClientRequestErrorMessage" => Ok(instance_record(
            "ClientRequestErrorMessage",
            ClientRequestErrorMessage::new(
                required_text(function, args.first())?.to_owned(),
                required_text(function, args.get(1))?.to_owned(),
                typed_argument(function, args.get(2))?,
                required_text(function, args.get(3))?.to_owned(),
                typed_argument(function, args.get(4))?,
                text(function, args.get(5))?.map(str::to_owned),
            ),
        )),
        "new ReconnectStateMessage" => {
            let results: Vec<RecordedControl> = typed_argument(function, args.get(1))?;
            let results = results
                .into_iter()
                .map(|result| {
                    Ok(match result {
                        RecordedControl::Snapshot { chat_id, control } => {
                            ReconnectControlResult::Snapshot {
                                chat_id,
                                control: parse_chat_execution_control_state(&control)
                                    .map(Box::new)
                                    .ok_or_else(|| {
                                        CaseError::undeliverable("invalid execution control")
                                    })?,
                            }
                        }
                        RecordedControl::NotFound { chat_id } => {
                            ReconnectControlResult::NotFound { chat_id }
                        }
                        RecordedControl::Unavailable { chat_id } => {
                            ReconnectControlResult::Unavailable { chat_id }
                        }
                    })
                })
                .collect::<Result<_, CaseError>>()?;
            Ok(instance_record(
                "ReconnectStateMessage",
                ReconnectStateMessage::new(
                    typed_argument(function, args.first())?,
                    results,
                    required_text(function, args.get(2))?.to_owned(),
                    text(function, args.get(3))?.map(str::to_owned),
                ),
            ))
        }
        "new WsFaultMessage" => Ok(instance_record(
            "WsFaultMessage",
            WsFaultMessage::new(required_text(function, args.first())?.to_owned()),
        )),
        "new WsPongMessage" => Ok(instance_record(
            "WsPongMessage",
            WsPongMessage::new(
                required_text(function, args.first())?.to_owned(),
                garcon_js::Number(javascript_number(function, args.get(1))?),
                required_text(function, args.get(2))?.to_owned(),
                typed_argument(function, args.get(3))?,
                required_text(function, args.get(4))?.to_owned(),
            ),
        )),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn ws_session_event_wire_bytes_match_bun() {
    use garcon_contract::ws_events::parse_session_ws_message;
    let inputs = include_str!("inputs/common/ws-events.jsonl");
    let bun = pinned_bun_stdout(
        r#"import { parseServerWsMessage } from "./common/ws-events.ts";
           for (const line of process.argv[1].trimEnd().split("\n")) {
             console.log(JSON.stringify(parseServerWsMessage(JSON.parse(line).args[0])));
           }"#,
        &[inputs],
    );
    let expected: Vec<_> = bun.lines().collect();
    let inputs: Vec<_> = inputs.lines().collect();
    assert_eq!(expected.len(), inputs.len());
    for (input, expected) in inputs.into_iter().zip(expected) {
        let fixture: Value = garcon_js::json::from_str(input).unwrap();
        let actual = parse_session_ws_message(&fixture["args"][0]);
        assert_eq!(serde_json::to_string(&actual).unwrap(), expected, "{input}");
    }
}

#[test]
fn ws_session_event_reconnect_rejects_mixed_control_instance_identities() {
    use garcon_contract::chat_execution_control::empty_chat_execution_control_state;
    use garcon_contract::ws_events::{SessionWsMessage, parse_session_ws_message};
    let mut input = json!({
        "type":"reconnect-state",
        "serverInstanceId":"server-a",
        "processing":{"outcome":"snapshot","chats":[]},
        "controlResults":[{"chatId":"chat-1","outcome":"snapshot",
            "control":empty_chat_execution_control_state("server-a")}],
    });
    assert!(matches!(
        parse_session_ws_message(&input),
        Some(SessionWsMessage::ReconnectState(_))
    ));
    input["controlResults"][0]["control"]["serverInstanceId"] = json!("server-b");
    assert_eq!(parse_session_ws_message(&input), None);
}

#[test]
fn ws_session_event_client_request_error_strictly_validates_optional_fields() {
    use garcon_contract::ws_events::{SessionWsMessage, parse_session_ws_message};
    let valid = json!({
        "type":"client-request-error","clientRequestId":"req-1","requestType":"chat-reload",
        "code":"CHAT_RUNNING","message":"Chat is running","retryable":true,
    });
    assert!(matches!(
        parse_session_ws_message(&valid),
        Some(SessionWsMessage::ClientRequestError(message)) if message.chat_id.is_none()
    ));
    for (field, value) in [
        ("code", json!("UNKNOWN")),
        ("code", Value::Null),
        ("message", json!(42)),
        ("retryable", json!("false")),
        ("retryable", Value::Null),
        ("chatId", json!(42)),
        ("chatId", json!(" ")),
        ("chatId", Value::Null),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        assert_eq!(parse_session_ws_message(&invalid), None, "{invalid}");
    }
}

#[test]
fn garcon_command_rejection_recordings() {
    use garcon_contract::garcon_command_rejection::*;
    assert_recording("garcon-command-rejection", |function, args| {
        Ok(match function {
            "parseGarconCommandRejection" => json!(parse_garcon_command_rejection(required_text(
                function,
                args.first()
            )?)),
            "garconCommandIssueGuidance" => json!(garcon_command_issue_guidance(required_text(
                function,
                args.first()
            )?)),
            "garconCommandRejectionContent" => json!(garcon_command_rejection_content(
                unknown(function, args.first())?.as_ref()
            )),
            "garconCommandRejectionGuidance" => {
                let issues = unknown(function, args.first())?;
                let issues = issues
                    .as_array()
                    .ok_or_else(|| CaseError::undeliverable("expected a list of issues"))?;
                json!(garcon_command_rejection_guidance(
                    issues.iter().map(rejection_issue_command)
                ))
            }
            "garconCommandRejectionNotice" => {
                let issue = unknown(function, args.first())?;
                json!(garcon_command_rejection_notice(rejection_issue_command(
                    issue.as_ref()
                )))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn garcon_envelope_span_writes_javascript_number_text() {
    use garcon_contract::garcon_command_envelope::garcon_envelope_span_at;
    let command = "<garcon-schedule />";
    let input = format!("\u{1f600}{command}");
    let lines = pinned_bun_stdout(
        r#"import { garconEnvelopeSpanAt } from "./common/garcon-command-envelope.ts";
           for (const [content, start] of [[process.argv[1], 0], [process.argv[2], 2]]) {
             console.log(JSON.stringify(garconEnvelopeSpanAt(content, start, content.length)));
           }"#,
        &[command, &input],
    );
    let from_start = garcon_envelope_span_at(command, 0.0, command.len() as f64).unwrap();
    let after_astral = garcon_envelope_span_at(&input, 2.0, (command.len() + 2) as f64).unwrap();
    let actual = [
        serde_json::to_string(&from_start).unwrap(),
        serde_json::to_string(&after_astral).unwrap(),
    ];
    assert_eq!(actual.join("\n"), lines.trim_end());
}

#[test]
fn transcript_inter_agent_results_serialize_chat_identity_before_status() {
    use garcon_contract::transcript_notice_details::parse_transcript_notice_detail;
    let fixture = r#"{"type":"inter-agent-message-outcome","results":[{"chatId":"1000000000000001","status":"delivered","reason":"ignored"},{"chatId":"1000000000000002","status":"queued"},{"chatId":"1000000000000003","status":"failed","reason":"queue-full","secret":"ignored"}]}"#;
    let bun = pinned_bun_stdout(
        r#"import { parseTranscriptNoticeDetail } from "./common/transcript-notice-details.ts";
           console.log(JSON.stringify(parseTranscriptNoticeDetail(JSON.parse(process.argv[1]))));"#,
        &[fixture],
    );
    let wire = garcon_js::json::from_str(fixture).unwrap();
    let parsed = parse_transcript_notice_detail(&wire).unwrap();
    assert_eq!(serde_json::to_string(&parsed).unwrap(), bun.trim_end());
}

#[test]
fn ws_revision_invalidations_match_bun_field_order() {
    use garcon_contract::ws_revision_invalidations::*;
    let bun = pinned_bun_stdout(
        r#"import { TicketsInvalidatedMessage, PullRequestReviewsInvalidatedMessage } from "./common/ws-revision-invalidations.ts";
           console.log(JSON.stringify(new TicketsInvalidatedMessage(3)));
           console.log(JSON.stringify(new PullRequestReviewsInvalidatedMessage(4)));"#,
        &[],
    );
    let actual = [
        serde_json::to_string(&TicketsInvalidatedMessage::new(3)).unwrap(),
        serde_json::to_string(&PullRequestReviewsInvalidatedMessage::new(4)).unwrap(),
    ];
    assert_eq!(actual.join("\n"), bun.trim_end());
}

fn rejection_issue_command(issue: &Value) -> &str {
    issue["command"].as_str().unwrap_or("undefined")
}

#[test]
fn garcon_command_rejection_preserves_edge_candidates_and_deduplicates_guidance() {
    use garcon_contract::garcon_command_rejection::*;
    let issues = json!([
        {"command":"ticket-create","reason":"malformed","edge":"leading"},
        {"command":"ticket-update","reason":"malformed","edge":"trailing"}
    ]);
    let message = garcon_command_rejection_guidance(["ticket-create", "ticket-update"]);
    assert_eq!(
        message.matches(TICKET_COMMAND_REJECTION_GUIDANCE).count(),
        1
    );
    let mut rejection = json!({
        "sourceViewId":"11111111-1111-4111-8111-111111111111",
        "sourceOrdinal":2, "issues":issues, "message":message,
    });
    let parsed =
        parse_garcon_command_rejection(&garcon_command_rejection_content(&rejection)).unwrap();
    assert_eq!(parsed.issues[0].edge, GarconCommandIssueEdge::Leading);
    assert_eq!(parsed.issues[1].edge, GarconCommandIssueEdge::Trailing);
    rejection["issues"][1]["ref"] = json!("unexpected");
    assert!(
        parse_garcon_command_rejection(&garcon_command_rejection_content(&rejection)).is_none()
    );
}

#[test]
fn ticket_chat_recordings() {
    use garcon_contract::ticket_chat::*;
    assert_recording("ticket-chat", |function, args| match function {
        "ticketChatPromptError" => Ok(json!(ticket_chat_prompt_error(required_text(
            function,
            args.first()
        )?))),
        "renderTicketChatPrompt" => {
            let template = text(function, args.first())?;
            let ticket: TicketChatSubject = typed_argument(function, args.get(1))?;
            render_ticket_chat_prompt(template, &ticket)
                .map(|result| json!(result))
                .map_err(|error| CaseError::new("Error", error.to_string()))
        }
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn ticket_chat_expands_once_and_bounds_utf16_before_trimming() {
    use garcon_contract::ticket_chat::*;
    let mut ticket = TicketChatSubject {
        id: "G-7".into(),
        title: "{{ticket_description}}".into(),
        project: "Example".into(),
        description: "$& {{ticket_id}}".into(),
    };
    assert_eq!(
        render_ticket_chat_prompt(
            Some("{{ticket_id}} {{ticket_title}} {{ticket_description}}"),
            &ticket
        )
        .unwrap(),
        "G-7 {{ticket_description}} $& {{ticket_id}}",
    );
    ticket.description = "\u{1f600}".repeat((TICKET_CHAT_PROMPT_MAX_LENGTH - 4) / 2) + " ";
    let template = Some("{{ticket_id}}{{ticket_description}}");
    assert!(render_ticket_chat_prompt(template, &ticket).is_ok());
    ticket.description.push(' ');
    assert_eq!(
        render_ticket_chat_prompt(template, &ticket),
        Err(RenderTicketChatPromptError::ExpandedTooLong)
    );
}

#[test]
fn ticket_source_navigation_recordings() {
    use garcon_contract::ticket_source_navigation::parse_ticket_source_resolution;
    assert_recording(
        "ticket-source-navigation",
        |function, args| match function {
            "parseTicketSourceResolution" => ticket_recording_result(
                parse_ticket_source_resolution(unknown(function, args.first())?.as_ref()),
            ),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn ticket_source_navigation_disallows_an_extra_target_on_an_unavailable_outcome() {
    use garcon_contract::ticket_source_navigation::*;
    let mut wire = json!({"kind":"outcome-unavailable","chatId":"1000000000000001"});
    assert!(matches!(
        parse_ticket_source_resolution(&wire),
        Ok(TicketSourceResolution::OutcomeUnavailable { .. })
    ));
    wire["target"] = json!({"chatId":"1000000000000001","transcriptViewId":"11111111-1111-4111-8111-111111111111","ordinal":1});
    assert_eq!(
        parse_ticket_source_resolution(&wire)
            .unwrap_err()
            .to_string(),
        "Unexpected ticket field."
    );
}

#[test]
fn ticket_command_notice_recordings() {
    use garcon_contract::garcon_ticket_result::TicketCommandOutcome;
    use garcon_contract::ticket_command_notice::*;
    assert_recording("ticket-command-notice", |function, args| {
        let input = unknown(function, args.first())?;
        let wire = garcon_js::json::stringify(input.as_ref());
        let outcome: TicketCommandOutcome = garcon_js::json::from_str(&wire)
            .map_err(|error| CaseError::undeliverable(error.to_string()))?;
        Ok(match function {
            "ticketCommandNoticeParts" => json!(ticket_command_notice_parts(&outcome)),
            "ticketCommandNoticeText" => json!(ticket_command_notice_text(&outcome)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn ticket_command_notice_preserves_link_direction_and_quotes_failure_code() {
    use garcon_contract::garcon_ticket_result::parse_ticket_command_outcome;
    use garcon_contract::ticket_command_notice::*;
    let outcome = parse_ticket_command_outcome(&json!({
        "type":"ticket-command-outcome","requestViewId":"11111111-1111-4111-8111-111111111111","requestOrdinal":1,
        "command":"unlink","ref":"cleanup","ticketId":"G-1","context":{"link":{"kind":"blocks","targetId":"G-2"}},
        "status":"error","errorCode":"TICKET_NOT_FOUND",
    })).unwrap();
    assert_eq!(
        ticket_command_notice_text(&outcome),
        "Couldn't remove blocking link from G-1 to G-2: \"TICKET_NOT_FOUND\""
    );
    let ids: Vec<_> = ticket_command_notice_parts(&outcome)
        .into_iter()
        .filter_map(|part| match part {
            TicketNoticePart::Ticket { ticket_id } => Some(ticket_id),
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["G-1", "G-2"]);
}

#[test]
fn ws_revision_invalidation_recordings() {
    use garcon_contract::ws_revision_invalidations::*;
    assert_recording("ws-revision-invalidations", |function, args| {
        let argument = unknown(function, args.first())?;
        let revision = || {
            non_negative_int(&argument)
                .ok_or_else(|| CaseError::undeliverable("expected a safe nonnegative revision"))
        };
        Ok(match function {
            "isRevisionInvalidationType" => {
                json!(is_revision_invalidation_type(&argument).is_some())
            }
            "parseRevisionInvalidation" => parse_revision_invalidation(&argument).map_or(
                Value::Null,
                |message| match message {
                    RevisionInvalidationMessage::TicketsInvalidated(value) => {
                        instance_record("TicketsInvalidatedMessage", value)
                    }
                    RevisionInvalidationMessage::PullRequestReviewsInvalidated(value) => {
                        instance_record("PullRequestReviewsInvalidatedMessage", value)
                    }
                },
            ),
            "new TicketsInvalidatedMessage" => instance_record(
                "TicketsInvalidatedMessage",
                TicketsInvalidatedMessage::new(revision()?),
            ),
            "new PullRequestReviewsInvalidatedMessage" => instance_record(
                "PullRequestReviewsInvalidatedMessage",
                PullRequestReviewsInvalidatedMessage::new(revision()?),
            ),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn garcon_start_agent_recordings() {
    use garcon_contract::garcon_start_agent::parse_garcon_start_agent;
    assert_recording("garcon-start-agent", |function, args| match function {
        "parseGarconStartAgent" => Ok(json!(parse_garcon_start_agent(required_text(
            function,
            args.first()
        )?))),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn garcon_start_agent_preserves_literal_body_and_requires_a_model_for_explicit_selection() {
    use garcon_contract::garcon_start_agent::{
        GARCON_START_PROMPT_MAX_BYTES, parse_garcon_start_agent,
    };
    let command = |selection, body: &str| {
        format!("<garcon-start-agent ref=\"run\" {selection}>\n{body}\n</garcon-start-agent>")
    };
    let body = "  A &amp; B < C\n";
    let parsed =
        parse_garcon_start_agent(&command(r#"provider="A &amp; B" model="demo""#, body)).unwrap();
    assert_eq!(parsed.provider_id.as_deref(), Some("A & B"));
    assert_eq!(parsed.prompt, body);
    assert!(parsed.executor_id.is_none());
    assert!(parse_garcon_start_agent(&command(r#"provider="demo""#, body)).is_none());
    let allowed = "x".repeat(GARCON_START_PROMPT_MAX_BYTES);
    assert!(parse_garcon_start_agent(&command("", &allowed)).is_some());
    assert!(parse_garcon_start_agent(&command("", &(allowed + "x"))).is_none());
}

#[test]
fn garcon_resume_agent_recordings() {
    use garcon_contract::garcon_resume_agent::parse_garcon_resume_agent;
    assert_recording("garcon-resume-agent", |function, args| match function {
        "parseGarconResumeAgent" => Ok(json!(parse_garcon_resume_agent(required_text(
            function,
            args.first()
        )?))),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn garcon_resume_agent_keeps_nested_commands_in_literal_prompt() {
    use garcon_contract::garcon_resume_agent::parse_garcon_resume_agent;
    let nested = r#"<garcon-stop-agent chat-id="1000000000000001" />"#;
    let input = format!(
        "<garcon-resume-agent ref=\"sample\" chat-id=\"1000000000000001\">\n{nested}\n</garcon-resume-agent>"
    );
    let parsed = parse_garcon_resume_agent(&input).unwrap();
    assert_eq!(parsed.prompt, nested);
    assert!(!parsed.request.asynchronous);
    assert!(
        parse_garcon_resume_agent(&input.replace(r#"ref="sample""#, r#"ref="sample" fork="true""#))
            .is_none()
    );
}

#[test]
fn garcon_stop_agent_recordings() {
    use garcon_contract::garcon_stop_agent::parse_garcon_stop_agent;
    assert_recording("garcon-stop-agent", |function, args| match function {
        "parseGarconStopAgent" => Ok(json!(parse_garcon_stop_agent(required_text(
            function,
            args.first()
        )?))),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn garcon_stop_agent_requires_a_self_closing_command_and_exact_remove_flag() {
    use garcon_contract::garcon_stop_agent::parse_garcon_stop_agent;
    let command =
        |attribute| format!("<garcon-stop-agent chat-id=\"2000000000000000\" {attribute}/>");
    assert!(!parse_garcon_stop_agent(&command("")).unwrap().remove);
    assert!(
        parse_garcon_stop_agent(&command(r#"remove="true""#))
            .unwrap()
            .remove
    );
    assert!(parse_garcon_stop_agent(&command(r#"remove="True""#)).is_none());
    assert!(
        parse_garcon_stop_agent(
            r#"<garcon-stop-agent chat-id="2000000000000000"></garcon-stop-agent>"#
        )
        .is_none()
    );
}

#[test]
fn garcon_schedule_recordings() {
    use garcon_contract::garcon_schedule::*;
    assert_recording("garcon-schedule", |function, args| {
        let input = required_text(function, args.first())?;
        Ok(match function {
            "parseGarconSchedule" => serialized_record(parse_garcon_schedule(input)),
            "parseGarconScheduleInstant" => json!(parse_garcon_schedule_instant(input)),
            "garconScheduleActionContent" => json!(garcon_schedule_action_content(input)),
            "parseGarconScheduleAction" => json!(parse_garcon_schedule_action(input)),
            "scheduledPromptLabel" => json!(scheduled_prompt_label(input)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn garcon_schedule_applies_the_offset_before_comparing_inclusive_ends() {
    use garcon_contract::garcon_schedule::*;
    let input = r#"<garcon-schedule at="2030-01-02T09:00:00+02:00" every="1m" until="2030-01-02T07:00:00Z" />"#;
    let schedule = parse_garcon_schedule(input).unwrap();
    assert_eq!(schedule.interval_minutes, Some(1));
    assert_eq!(
        schedule.end_at_utc.as_deref(),
        Some("2030-01-02T07:00:00.000Z")
    );
    assert!(parse_garcon_schedule(&input.replace("07:00:00Z", "06:59:00Z")).is_none());
    assert!(parse_garcon_schedule_instant("2030-02-29T00:00:00Z").is_none());
    assert!(parse_garcon_schedule_instant("0000-01-01T00:00:00+00:01").is_none());
}

#[test]
fn garcon_schedule_frames_actions_and_does_not_split_label_surrogates() {
    use garcon_contract::garcon_schedule::*;
    use garcon_contract::scheduled_prompts::SCHEDULED_PROMPT_LABEL_MAX_LENGTH;
    let body = "A & B < C\n</garcon-schedule-action>\n&amp;lt;";
    let action = garcon_schedule_action_content(body);
    assert_eq!(parse_garcon_schedule_action(&action).unwrap().body, body);
    let prefix = "x".repeat(SCHEDULED_PROMPT_LABEL_MAX_LENGTH - 1);
    assert_eq!(
        scheduled_prompt_label(&format!("{prefix}\u{1f600} tail")),
        prefix
    );
}

#[test]
fn garcon_command_envelope_recordings() {
    use garcon_contract::garcon_command_envelope::*;
    assert_recording("garcon-command-envelope", |function, args| {
        let content = required_text(function, args.first())?;
        let offset = |index| javascript_number(function, args.get(index));
        Ok(match function {
            "new GarconEnvelopeScanner" => {
                let scanner = GarconEnvelopeScanner::new(content);
                markers::instance(
                    "GarconEnvelopeScanner",
                    serde_json::Map::from_iter([("content".to_owned(), json!(scanner.content()))]),
                )
            }
            "garconEnvelopeCommandAt" => json!(garcon_envelope_command_at(content, offset(1)?)),
            "garconEnvelopeSpanAt" => {
                serialized_record(garcon_envelope_span_at(content, offset(1)?, offset(2)?))
            }
            "garconEnvelopeOpenerEnd" => {
                let start = args
                    .get(1)
                    .filter(|value| !markers::is_undefined(value))
                    .map(|value| javascript_number(function, Some(value)))
                    .transpose()?
                    .unwrap_or(0.0);
                json!(garcon_envelope_opener_end(content, start))
            }
            "decodeGarconXmlText" => json!(decode_garcon_xml_text(content)),
            "escapeGarconXmlText" => json!(escape_garcon_xml_text(content)),
            "parseGarconCommandEnvelope"
            | "parseGarconXmlEnvelope"
            | "parseGarconPromptEnvelope" => {
                let name = required_text(function, args.get(1))?;
                let allowed: Vec<String> = typed_argument(function, args.get(2))?;
                json!(match function {
                    "parseGarconCommandEnvelope" =>
                        parse_garcon_command_envelope(content, name, &allowed),
                    "parseGarconXmlEnvelope" => parse_garcon_xml_envelope(content, name, &allowed),
                    _ => parse_garcon_prompt_envelope(content, name, &allowed),
                })
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn garcon_envelope_scanner_preserves_cache_boundaries_and_deep_nesting() {
    use garcon_contract::garcon_command_envelope::{
        GarconEnvelopeScanner, garcon_envelope_span_at,
    };
    let first = "<garcon-start-agent>First.</garcon-start-agent>";
    let second = "<garcon-resume-agent>Second.</garcon-resume-agent>";
    let content = format!("{first}\n{second}\n</garcon-start-agent>");
    let mut scanner = GarconEnvelopeScanner::new(&content);
    assert_eq!(
        scanner.span_at(0.0, first.len() as f64).unwrap().end,
        Some(first.len())
    );
    assert_eq!(
        scanner.span_at(0.0, content.len() as f64).unwrap().end,
        None
    );
    assert_eq!(
        scanner
            .span_at((first.len() + 1) as f64, content.len() as f64)
            .unwrap()
            .end,
        Some(first.len() + 1 + second.len())
    );
    assert_eq!(
        scanner
            .span_at(0.0, (first.len() + 1 + second.len()) as f64)
            .unwrap()
            .end,
        Some(first.len())
    );
    let nested = "<garcon-start-agent>".repeat(10_000) + &"</garcon-start-agent>".repeat(10_000);
    assert_eq!(
        garcon_envelope_span_at(&nested, 0.0, nested.len() as f64)
            .unwrap()
            .end,
        Some(nested.len())
    );
    assert_eq!(
        garcon_envelope_span_at(&nested, 0.0, (nested.len() - 1) as f64)
            .unwrap()
            .end,
        None
    );
}

#[test]
fn garcon_ticket_command_recordings() {
    use garcon_contract::garcon_ticket_command::*;
    assert_recording("garcon-ticket-command", |function, args| {
        Ok(match function {
            "isTicketReadAction" => json!(is_ticket_read_action(
                unknown(function, args.first())?.as_ref()
            )),
            "isTicketReadCommand" => json!(is_ticket_read_command(
                unknown(function, args.first())?.as_ref()
            )),
            "parseGarconTicketCommand" => json!(parse_garcon_ticket_command(required_text(
                function,
                args.first()
            )?)),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn garcon_ticket_command_decodes_entities_once_and_requires_mutation_correlation() {
    use garcon_contract::garcon_ticket_command::GarconTicketCommand;
    use garcon_contract::{
        garcon_ticket_command::parse_garcon_ticket_command, ticket_commands::TicketMutationPayload,
    };
    let command = r#"<garcon-ticket-comment ref="comment" ticket-id="G-1">Synthetic &lt;text&gt; &amp; &amp;lt;</garcon-ticket-comment>"#;
    let Some(GarconTicketCommand::Mutation(parsed)) = parse_garcon_ticket_command(command) else {
        panic!("expected mutation");
    };
    assert_eq!(parsed.reference, "comment");
    let TicketMutationPayload::Comment { body, .. } = parsed.payload else {
        panic!("expected comment");
    };
    assert_eq!(body, "Synthetic <text> & &lt;");
    assert!(parse_garcon_ticket_command(&command.replace(r#" ref="comment""#, "")).is_none());
    assert!(parse_garcon_ticket_command("<garcon-ticket-list />").is_some());
}

#[test]
fn garcon_agent_result_recordings() {
    use garcon_contract::garcon_agent_result::*;
    assert_recording("garcon-agent-result", |function, args| {
        if function == "parseGarconAgentResult" {
            return Ok(json!(parse_garcon_agent_result(required_text(
                function,
                args.first()
            )?)));
        }
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        match function {
            "parseAgentChildOutcome" => Ok(json!(parse_agent_child_outcome(value))),
            "garconAgentResultContent" => garcon_agent_result_content(value)
                .map(|v| json!(v))
                .map_err(|error| CaseError::new("Error", error.to_string())),
            "boundAgentChildResult" => Ok(serialized_record(bound_agent_child_result(value))),
            "agentChildOutcomeContent" => {
                let detail = parse_agent_child_outcome(value)
                    .ok_or_else(|| CaseError::unhandled(function))?;
                agent_child_outcome_content(&detail)
                    .map(|v| json!(v))
                    .map_err(|error| {
                        CaseError::new("CommandRequestValidationError", error.to_string())
                    })
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

fn synthetic_agent_result() -> Value {
    json!({
        "type":"agent-start-outcome","ref":"sample","async":false,"requestViewId":"00000000-0000-4000-8000-000000000001",
        "requestOrdinal":1,"status":"completed","chatId":"1000000000000001",
        "output":{"availability":"available","completeness":"complete","text":"Exact &lt; <body>\r"}
    })
}

#[test]
fn garcon_agent_result_preserves_framing_and_bounds_escaped_output() {
    use garcon_contract::garcon_agent_result::*;
    let mut detail = synthetic_agent_result();
    let xml = garcon_agent_result_content(&detail).unwrap();
    assert_eq!(json!(parse_garcon_agent_result(&xml).unwrap()), detail);
    detail["output"]["text"] = json!("&".repeat(GARCON_AGENT_OUTPUT_MAX_BYTES));
    assert!(parse_agent_child_outcome(&detail).is_none());
    let bounded = bound_agent_child_result(&detail);
    assert_eq!(
        bounded["output"],
        json!({"availability":"unavailable","reason":"too-large"})
    );
    assert!(parse_agent_child_outcome(&bounded).is_some());
}

#[test]
fn garcon_command_results_recordings() {
    use garcon_contract::garcon_command_results::*;
    assert_recording("garcon-command-results", |function, args| {
        if function == "parseGarconCommandResult" {
            return Ok(json!(parse_garcon_command_result(required_text(
                function,
                args.first()
            )?)));
        }
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        match function {
            "parseAgentCommandOutcome" => Ok(json!(parse_agent_command_outcome(value))),
            "garconCommandResultContent" => garcon_command_result_content(value)
                .map(|v| json!(v))
                .map_err(|error| CaseError::new("Error", error.to_string())),
            "agentCommandOutcomeTitle" | "agentCommandOutcomeContent" => {
                let detail = parse_agent_command_outcome(value)
                    .ok_or_else(|| CaseError::unhandled(function))?;
                if function == "agentCommandOutcomeTitle" {
                    Ok(json!(agent_command_outcome_title(&detail)))
                } else {
                    agent_command_outcome_content(&detail)
                        .map(|v| json!(v))
                        .map_err(|error| {
                            CaseError::new("CommandRequestValidationError", error.to_string())
                        })
                }
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn garcon_command_results_validate_recurrence_and_emit_standalone_schedule_envelopes() {
    use garcon_contract::garcon_command_results::*;
    let mut detail = json!({
        "type":"agent-schedule-outcome","requestViewId":"00000000-0000-4000-8000-000000000001",
        "requestOrdinal":1,"status":"created","scheduleId":"00000000-0000-4000-8000-000000000002",
        "nextRunAt":"2030-01-01T12:00:00.000Z","endAtUtc":"2030-01-01T12:00:00.000Z",
        "intervalMinutes":5,"busyBehavior":"queue"
    });
    let xml = garcon_command_result_content(&detail).unwrap();
    assert_eq!(json!(parse_garcon_command_result(&xml).unwrap()), detail);
    detail["intervalMinutes"] = Value::Null;
    assert!(parse_agent_command_outcome(&detail).is_none());
    assert_eq!(
        garcon_command_result_content(&detail)
            .unwrap_err()
            .to_string(),
        "Invalid agent command outcome"
    );
}

#[test]
fn garcon_ticket_result_recordings() {
    use garcon_contract::error_codes::ErrorCode;
    use garcon_contract::garcon_ticket_result::*;
    use garcon_contract::ticket_records::parse_ticket_write_result;
    assert_recording("garcon-ticket-result", |function, args| {
        if function == "parseGarconTicketResult" {
            return Ok(json!(parse_garcon_ticket_result(required_text(
                function,
                args.first()
            )?)));
        }
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        match function {
            "parseTicketErrorCode" => ticket_recording_result(
                parse_ticket_error_code(value).map(|v| ErrorCode::from(v).as_str()),
            ),
            "parseTicketCommandResult" => {
                ticket_recording_result(parse_ticket_command_result(value))
            }
            "ticketMutationReceipt" => {
                let write = parse_ticket_write_result(value)
                    .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                Ok(json!(ticket_mutation_receipt(&write)))
            }
            "ticketCommandContext" => match ticket_command_context(value) {
                Ok(Some(context)) => Ok(serialized_record(context)),
                Ok(None) => Ok(markers::undefined()),
                Err(error) => Err(CaseError::new("TicketValidationError", error.to_string())),
            },
            "garconTicketResultContent" => Ok(json!(garcon_ticket_result_content(value))),
            "ticketCommandOutcome" => Ok(serialized_record(ticket_command_outcome(value))),
            "parseTicketCommandOutcome" => Ok(json!(parse_ticket_command_outcome(value))),
            "parseStoredTicketCommandOutcome" => {
                Ok(json!(parse_stored_ticket_command_outcome(value)))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn garcon_ticket_result_notice_keeps_correlation_and_drops_private_result_fields() {
    use garcon_contract::garcon_ticket_result::*;
    let value = json!({
        "command":"read","ticketId":"G-1","requestViewId":"00000000-0000-4000-8000-000000000001",
        "requestOrdinal":4,"status":"error","errorCode":"TICKET_NOT_FOUND","message":"Not found."
    });
    let xml = garcon_ticket_result_content(&value);
    assert_eq!(json!(parse_garcon_ticket_result(&xml).unwrap()), value);
    let notice = ticket_command_outcome(&value);
    assert!(notice.get("message").is_none());
    assert_eq!(
        garcon_js::json::as_number(&notice["requestOrdinal"]),
        Some(4.0)
    );
    assert_eq!(
        serialized_record(parse_ticket_command_outcome(&notice).unwrap()),
        serialized_record(&notice)
    );
}

#[test]
fn transcript_notice_details_recordings() {
    use garcon_contract::transcript_notice_details::*;
    assert_recording("transcript-notice-details", |function, args| {
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        Ok(match function {
            "parseTranscriptNoticeDetail" => json!(parse_transcript_notice_detail(value)),
            "isCarryoverMigrationQuarantineNoticeDetail" => {
                json!(is_carryover_migration_quarantine_notice_detail(value))
            }
            "isPreambleApplicationNoticeDetail" => {
                json!(is_preamble_application_notice_detail(value))
            }
            "isPreambleSelectionChangedNoticeDetail" => {
                json!(is_preamble_selection_changed_notice_detail(value))
            }
            "isHandoffSummaryNoticeDetail" => json!(is_handoff_summary_notice_detail(value)),
            "isPublicationGapNoticeDetail" => json!(is_publication_gap_notice_detail(value)),
            "isChatIdDisclosureNoticeDetail" => json!(is_chat_id_disclosure_notice_detail(value)),
            "isChatIdDiscoveryFailureNoticeDetail" => {
                json!(is_chat_id_discovery_failure_notice_detail(value))
            }
            "isInterAgentMessageOutcomeNoticeDetail" => {
                json!(is_inter_agent_message_outcome_notice_detail(value))
            }
            "isInterAgentMessageReceivedNoticeDetail" => {
                json!(is_inter_agent_message_received_notice_detail(value))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn transcript_notice_details_identify_and_project_publication_gaps_and_quarantines() {
    use garcon_contract::transcript_notice_details::*;
    let parsed =
        parse_transcript_notice_detail(&json!({"type":"publication-gap","extra":"ignored"}));
    assert_eq!(parsed, Some(TranscriptNoticeDetail::PublicationGap));
    assert_eq!(json!(parsed), json!({"type":"publication-gap"}));
    let raw = json!({
        "type":"carryover-migration-quarantine","artifactId":"archive","errorCode":"FAILED","private":"ignored"
    });
    let parsed = parse_transcript_notice_detail(&raw).unwrap();
    assert!(matches!(
        parsed,
        TranscriptNoticeDetail::CarryoverMigrationQuarantine { .. }
    ));
    assert_eq!(
        json!(parsed),
        json!({"type":"carryover-migration-quarantine","artifactId":"archive","errorCode":"FAILED"})
    );
    assert!(
        parse_transcript_notice_detail(
            &json!({"type":"carryover-migration-quarantine","errorCode":"FAILED"})
        )
        .is_none()
    );
}

#[test]
fn ticket_commands_recordings() {
    use garcon_contract::ticket_commands::*;
    assert_recording("ticket-commands", |function, args| {
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        match function {
            "parseTicketPatch" => ticket_recording_result(parse_ticket_patch(value)),
            "parseMarkupTicketMutationPayload" => {
                ticket_recording_result(parse_markup_ticket_mutation_payload(value))
            }
            "parseTicketMutationPayload" => {
                ticket_recording_result(parse_ticket_mutation_payload(value))
            }
            "parseHttpTicketMutationRequest" => {
                ticket_recording_result(parse_http_ticket_mutation_request(value))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn ticket_query_recordings() {
    use garcon_contract::ticket_query::*;
    assert_recording("ticket-query", |function, args| {
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        match function {
            "parseTicketListQuery" => ticket_recording_result(parse_ticket_list_query(value)),
            "parseTicketReadQuery" => ticket_recording_result(parse_ticket_read_query(value)),
            "parseTicketCommentsQuery" => {
                ticket_recording_result(parse_ticket_comments_query(value))
            }
            "parseTicketHistoryQuery" => ticket_recording_result(parse_ticket_history_query(value)),
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn ticket_query_codecs_match_bun_url_search_params() {
    use garcon_contract::ticket_query::{ticket_query_params, ticket_search_params};
    let lines = pinned_bun_stdout(
        r#"import "./rust/garcon-contract/tests/oracles/ticket-query-oracle.ts";"#,
        &[],
    );
    let mut counts = (0, 0, 0);
    for line in lines.lines() {
        let row: Value = garcon_js::json::from_str(line).unwrap();
        let query = &row["query"];
        match row["kind"].as_str().unwrap() {
            "search" => {
                counts.0 += 1;
                let actual = ticket_search_params(query).unwrap();
                let pairs: Vec<_> = url::form_urlencoded::parse(actual.as_bytes()).collect();
                assert_eq!(json!(pairs), row["pairs"], "search pairs for {query}");
                assert_eq!(json!(actual), row["text"], "search bytes for {query}");
            }
            "parse" => match ticket_query_params(query.as_str().unwrap()) {
                Ok(actual) => {
                    counts.1 += 1;
                    let pairs: Vec<_> = actual.as_object().unwrap().iter().collect();
                    assert_eq!(
                        garcon_js::json::stringify(&json!(pairs)),
                        garcon_js::json::stringify(&row["pairs"]),
                        "parsed pairs for {query}",
                    );
                    assert_eq!(
                        json!(serde_json::to_string(&actual).unwrap()),
                        row["text"],
                        "parsed bytes for {query}",
                    );
                }
                Err(error) => {
                    counts.2 += 1;
                    assert_eq!(
                        json!({"name": "TicketValidationError", "message": error.to_string()}),
                        row["error"],
                        "parse error for {query}",
                    );
                }
            },
            kind => panic!("unexpected ticket query oracle operation: {kind}"),
        }
    }
    assert!(
        counts.0 >= 25 && counts.1 >= 25 && counts.2 >= 25,
        "{counts:?}"
    );
}

#[test]
fn ticket_records_recordings() {
    use garcon_contract::ticket_records::*;
    assert_recording("ticket-records", |function, args| {
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        match function {
            "parseTicket" => ticket_recording_result(parse_ticket(value)),
            "parseTicketComment" => ticket_recording_result(parse_ticket_comment(value)),
            "parseTicketActivity" => ticket_recording_result(parse_ticket_activity(value)),
            "parseTicketWriteResult" => ticket_recording_result(parse_ticket_write_result(value)),
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn ticket_stored_recordings() {
    use garcon_contract::ticket_stored::*;
    assert_recording("ticket-stored", |function, args| {
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        match function {
            "normalizeStoredTicketOwner" => {
                ticket_recording_result(normalize_stored_ticket_owner(value))
            }
            "normalizeStoredTicket" => ticket_recording_result(normalize_stored_ticket(value)),
            "normalizeStoredTicketActivity" => {
                ticket_recording_result(normalize_stored_ticket_activity(value))
            }
            "normalizeStoredTicketWriteResult" => {
                ticket_recording_result(normalize_stored_ticket_write_result(value))
            }
            "normalizeStoredTicketRequest" => {
                ticket_recording_result(normalize_stored_ticket_request(value))
            }
            "normalizeStoredTicketOutcome" => {
                ticket_recording_result(normalize_stored_ticket_outcome(value))
            }
            "normalizeStoredTicketResult" => {
                ticket_recording_result(normalize_stored_ticket_result(value))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn ticket_responses_recordings() {
    use garcon_contract::ticket_responses::*;
    assert_recording("ticket-responses", |function, args| {
        let value = unknown(function, args.first())?;
        let value = value.as_ref();
        match function {
            "parseTicketBootstrap" => ticket_recording_result(parse_ticket_bootstrap(value)),
            "parseTicketSummary" => ticket_recording_result(parse_ticket_summary(value)),
            "parseTicketPage" => ticket_recording_result(parse_ticket_page(value)),
            "parseTicketCommentView" => ticket_recording_result(parse_ticket_comment_view(value)),
            "parseTicketCommentsPage" => ticket_recording_result(parse_ticket_comments_page(value)),
            "parseTicketHistoryPage" => ticket_recording_result(parse_ticket_history_page(value)),
            "parseTicketDetail" => ticket_recording_result(parse_ticket_detail(value)),
            "parseTicketCounts" => ticket_recording_result(parse_ticket_counts(value)),
            "parseTicketFacets" => ticket_recording_result(parse_ticket_facets(value)),
            "parseTicketProjectDefault" => {
                ticket_recording_result(parse_ticket_project_default(value))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn ticket_stored_preserves_opaque_fields_as_javascript_json_text() {
    use garcon_contract::ticket_stored::normalize_stored_ticket;
    let wire = r#"{"assignee":{"kind":"user","username":"sample"},"payload":{"n":1.0,"big":9007199254740993,"exp21":1e21,"small":1e-7}}"#;
    let bun = pinned_bun_stdout(
        r#"import { normalizeStoredTicket } from "./common/ticket-stored.ts";
           console.log(JSON.stringify(normalizeStoredTicket(JSON.parse(process.argv[1]))));"#,
        &[wire],
    );
    let value = garcon_js::json::from_str(wire).unwrap();
    let stored = normalize_stored_ticket(&value).unwrap();
    assert_eq!(serde_json::to_string(&stored).unwrap(), bun.trim_end());
}

#[test]
fn ticket_commands_separate_transport_envelopes_and_preserve_omitted_markup_project() {
    use garcon_contract::ticket_commands::*;
    let payload = json!({"action":"create","input":{"title":"  A ticket  "}});
    let parsed = parse_markup_ticket_mutation_payload(&payload).unwrap();
    let MarkupTicketMutationPayload::Create { input } = parsed else {
        panic!("expected create");
    };
    assert_eq!(input.title, "A ticket");
    assert!(input.project.project.is_none());
    assert!(parse_ticket_mutation_payload(&payload).is_err());
    let mut request = json!({
        "requestId":"11111111-1111-4111-8111-111111111111",
        "expectedStoreId":"33333333-3333-4333-8333-333333333333",
        "payload":payload,
    });
    request["payload"]["input"]["project"] = json!("  Example release  ");
    let parsed = parse_http_ticket_mutation_request(&request).unwrap();
    let TicketMutationPayload::Create { input } = parsed.payload else {
        panic!("expected create");
    };
    assert_eq!(input.project.project, "Example release");
    request["actor"] = json!("forged");
    assert!(parse_http_ticket_mutation_request(&request).is_err());
}

#[test]
fn ticket_commands_only_close_via_close_and_distinguish_absence_from_null() {
    use garcon_contract::ticket_commands::*;
    assert_eq!(
        parse_ticket_patch(&json!({"status":"closed"}))
            .unwrap_err()
            .to_string(),
        "Use close to close a ticket.",
    );
    let patch = parse_ticket_patch(&json!({"title":"Trim ","assignee":null})).unwrap();
    assert!(patch.assignee.is_null());
    assert!(patch.parent_id.is_absent());
    assert_eq!(
        serde_json::to_value(patch).unwrap(),
        json!({"title":"Trim","assignee":null})
    );
}

#[test]
fn ticket_query_fences_mutable_continuations_and_leaves_immutable_history_unfenced() {
    use garcon_contract::ticket_query::*;
    assert!(parse_ticket_list_query(&json!({"beforeNumber":10})).is_err());
    assert!(parse_ticket_comments_query(&json!({"ticketId":"G-1","beforeSequence":10})).is_err());
    assert!(
        parse_ticket_read_query(&json!({"ticketId":"G-1","beforeCommentSequence":10})).is_err()
    );
    assert!(parse_ticket_read_query(&json!({
        "ticketId":"G-1","beforeCommentSequence":10,"expectedCollectionRevision":0,"commentLimit":0
    })).is_err());
    assert_eq!(
        parse_ticket_read_query(&json!({"ticketId":"G-1","commentLimit":0}))
            .unwrap()
            .comment_limit,
        Some(0),
    );
    let history =
        parse_ticket_history_query(&json!({"ticketId":"G-1","beforeSequence":10})).unwrap();
    assert_eq!(
        (history.before_sequence, history.limit),
        (Some(10), Some(50))
    );
    assert!(
        parse_ticket_history_query(&json!({"ticketId":"G-1","expectedCollectionRevision":2}))
            .is_err()
    );
}

fn synthetic_ticket_wire() -> Value {
    json!({
        "id":"G-1","number":1,"revision":1,"title":"Synthetic ticket","description":"Exact\nbody",
        "project":"Sample","status":"open","resolution":null,"priority":2,"labels":[],
        "assignee":null,"parentId":null,"createdAt":"2026-01-01T00:00:00.000Z",
        "updatedAt":"2026-01-01T00:00:00.000Z",
        "createdBy":{"kind":"user","username":"local","principalMode":"local","declaredChatId":null}
    })
}

#[test]
fn ticket_records_round_trip_typed_domain_records_and_reject_contradictions() {
    use garcon_contract::ticket_records::*;
    let mut ticket = synthetic_ticket_wire();
    let parsed = parse_ticket(&ticket).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), ticket);
    ticket["resolution"] = json!("done");
    assert_eq!(
        parse_ticket(&ticket).unwrap_err().to_string(),
        "Ticket status and resolution disagree."
    );
    ticket["number"] = json!(2);
    assert_eq!(
        parse_ticket(&ticket).unwrap_err().to_string(),
        "Ticket ID and number disagree."
    );
    assert_eq!(
        parse_ticket_comment(&json!({"deletedAt":null,"body":null}))
            .unwrap_err()
            .to_string(),
        "Comment body and tombstone disagree.",
    );
}

#[test]
fn ticket_records_serialize_comments_writes_and_link_activities_in_bun_field_order() {
    use garcon_contract::ticket_records::*;
    let ticket = synthetic_ticket_wire();
    let comment = json!({
        "id":"11111111-1111-4111-8111-111111111111","ticketId":ticket["id"],"sequence":1,"revision":2,
        "body":null,"deletedAt":ticket["updatedAt"],"author":ticket["createdBy"],
        "createdAt":ticket["createdAt"],"updatedAt":ticket["updatedAt"]
    });
    let write = json!({
        "success":true,"storeId":"33333333-3333-4333-8333-333333333333",
        "collectionRevision":2,"ticket":ticket,"comment":comment
    });
    let linked = json!({
        "sequence":1,"ticketId":ticket["id"],"at":ticket["createdAt"],"actor":ticket["createdBy"],
        "source":null,"action":"linked","kind":"blocks","sourceId":"G-1","targetId":"G-2"
    });
    let mut unlinked = linked.clone();
    unlinked["action"] = json!("unlinked");
    let arguments = [
        comment.clone(),
        write.clone(),
        linked.clone(),
        unlinked.clone(),
    ]
    .map(|value| value.to_string());
    let arguments = arguments.each_ref().map(String::as_str);
    let bun = pinned_bun_stdout(
        r#"import { parseTicketActivity, parseTicketComment, parseTicketWriteResult } from "./common/ticket-records.ts";
           for (const [index, parse] of [parseTicketComment, parseTicketWriteResult, parseTicketActivity, parseTicketActivity].entries()) {
             console.log(JSON.stringify(parse(JSON.parse(process.argv[index + 1]))));
           }"#,
        &arguments,
    );
    let actual = [
        serde_json::to_string(&parse_ticket_comment(&comment).unwrap()).unwrap(),
        serde_json::to_string(&parse_ticket_write_result(&write).unwrap()).unwrap(),
        serde_json::to_string(&parse_ticket_activity(&linked).unwrap()).unwrap(),
        serde_json::to_string(&parse_ticket_activity(&unlinked).unwrap()).unwrap(),
    ];
    assert_eq!(actual.join("\n"), bun.trim_end());
}

#[test]
fn ticket_stored_migrates_legacy_owners_without_rewriting_actor_identity() {
    use garcon_contract::ticket_stored::*;
    let legacy = json!({"kind":"user","username":"sample"});
    let value = json!({"action":"created","actor":legacy,"ticket":{"assignee":legacy}});
    let parsed = normalize_stored_ticket_activity(&value).unwrap();
    assert_eq!(parsed["actor"], legacy);
    assert_eq!(
        parsed["ticket"]["assignee"],
        json!({"kind":"user","ownerKey":"sample"})
    );
    let mixed = json!({"kind":"user","username":"sample","ownerKey":"not-the-same"});
    assert!(normalize_stored_ticket_owner(&mixed).is_err());
}

#[test]
fn ticket_responses_reject_inconsistent_detail_projections_and_continuations() {
    use garcon_contract::ticket_responses::*;
    let store_id = "33333333-3333-4333-8333-333333333333";
    let mut ticket = synthetic_ticket_wire();
    ticket["description"] = Value::Null;
    let mut detail = json!({
        "storeId":store_id,"collectionRevision":2,"ticket":ticket,"links":[],
        "comments":{"storeId":store_id,"collectionRevision":2,"items":[],"nextBeforeSequence":null}
    });
    let parsed = parse_ticket_detail(&detail).unwrap();
    assert!(parsed.ticket.description.is_none());
    detail["comments"]["collectionRevision"] = json!(3);
    assert_eq!(
        parse_ticket_detail(&detail).unwrap_err().to_string(),
        "Ticket detail projections disagree.",
    );
    assert!(
        parse_ticket_page(&json!({
            "storeId":store_id,"collectionRevision":2,"items":[],"nextBeforeNumber":1
        }))
        .is_err()
    );
}

fn required_text<'a>(function: &str, argument: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, argument)?.ok_or_else(|| CaseError::unhandled(function))
}

fn typed_argument<T: DeserializeOwned>(
    function: &str,
    argument: Option<&Value>,
) -> Result<T, CaseError> {
    serde_json::from_value(unknown(function, argument)?.into_owned())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

#[test]
fn garcon_command_text_recordings() {
    use garcon_contract::garcon_command_text::normalize_garcon_command_body;
    assert_recording("garcon-command-text", |function, args| match function {
        "normalizeGarconCommandBody" => Ok(json!(normalize_garcon_command_body(required_text(
            function,
            args.first()
        )?))),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn garcon_agent_request_recordings() {
    use garcon_contract::garcon_agent_request::parse_garcon_agent_request_options;
    assert_recording("garcon-agent-request", |function, args| match function {
        "parseGarconAgentRequestOptions" => Ok(json!(parse_garcon_agent_request_options(
            unknown(function, args.first())?.as_ref()
        ))),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn agent_start_progress_recordings() {
    use garcon_contract::agent_start_progress::parse_agent_start_progress_notice;
    assert_recording("agent-start-progress", |function, args| match function {
        "parseAgentStartProgressNotice" => Ok(json!(parse_agent_start_progress_notice(
            unknown(function, args.first())?.as_ref()
        ))),
        _ => Err(CaseError::unhandled(function)),
    });
}

#[test]
fn startup_progress_constants_match_bun() {
    use garcon_contract::agent_start_progress::*;
    let original = pinned_bun_stdout(
        r#"import * as progress from "./common/agent-start-progress.ts";
           console.log(JSON.stringify(progress.AGENT_START_PROGRESS_PHASES));
           console.log(JSON.stringify(progress.AGENT_START_PROGRESS_CONTENT));"#,
        &[],
    );
    let lines: Vec<_> = original.lines().collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(
        serde_json::to_string(&AGENT_START_PROGRESS_PHASES).unwrap(),
        lines[0]
    );
    let content: serde_json::Map<String, Value> = AGENT_START_PROGRESS_CONTENT
        .into_iter()
        .map(|(phase, text)| (phase.as_str().to_owned(), json!(text)))
        .collect();
    assert_eq!(serde_json::to_string(&content).unwrap(), lines[1]);
}

#[test]
fn start_selection_recordings() {
    use garcon_contract::settings::RemoteExecutionDefaults;
    use garcon_contract::start_selection::*;
    use garcon_js::json::Opaque;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Settings {
        execution_defaults: Option<RemoteExecutionDefaults>,
    }

    assert_recording("start-selection", |function, args| {
        let error = |error: StartSelectionError| {
            CaseError::new("StartSelectionError", error.message)
                .with_property("code", json!(error.code))
        };
        let argument = |index| unknown(function, args.get(index));
        let text_argument = |index| required_text(function, args.get(index));
        Ok(match function {
            "new StartSelectionError" => {
                let code = typed_argument(function, args.first())?;
                let error = StartSelectionError::new(code, text_argument(1)?);
                json!({"$": "error", "name": "StartSelectionError", "message": error.message, "properties": {"code": error.code}})
            }
            "requireCatalogAgent" => serialized_record(
                require_catalog_agent(argument(0)?.as_ref(), text_argument(1)?).map_err(error)?,
            ),
            "requireCatalogModels" => serialized_record(Opaque::from_value(Value::Array(
                require_catalog_models(argument(0)?.as_ref())
                    .map_err(error)?
                    .to_vec(),
            ))),
            "requireCatalogProvider" => {
                let input = argument(0)?;
                let providers = input
                    .as_array()
                    .ok_or_else(|| CaseError::undeliverable("expected a provider list"))?;
                let provider =
                    require_catalog_provider(providers, text_argument(1)?).map_err(error)?;
                serialized_record(Opaque::from_value(provider.clone()))
            }
            "resolveCatalogModelSelection" => serialized_record(
                resolve_catalog_model_selection(
                    argument(0)?.as_ref(),
                    argument(1)?.as_ref(),
                    argument(2)?.as_ref(),
                )
                .map_err(error)?,
            ),
            "resolveModelSelection" => {
                let request = typed_argument(function, args.get(2))?;
                serialized_record(
                    resolve_model_selection(argument(0)?.as_ref(), text_argument(1)?, &request)
                        .map_err(error)?,
                )
            }
            "validateExplicitModes" => {
                let request = typed_argument(function, args.get(2))?;
                validate_explicit_modes(argument(0)?.as_ref(), text_argument(1)?, &request)
                    .map_err(error)?;
                markers::undefined()
            }
            "resolveStartSelection" => {
                let settings: Settings = typed_argument(function, args.get(1))?;
                let request = typed_argument(function, args.get(2))?;
                serialized_record(
                    resolve_start_selection(
                        argument(0)?.as_ref(),
                        settings.execution_defaults.as_ref(),
                        &request,
                    )
                    .map_err(error)?,
                )
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn execution_defaults_recordings() {
    use garcon_contract::execution_defaults::*;
    use garcon_contract::settings::RemoteExecutionDefaults;

    assert_recording("execution-defaults", |function, args| {
        Ok(match function {
            "executionDefaultsForAgent" => {
                let defaults: Option<RemoteExecutionDefaults> =
                    typed_argument(function, args.first())?;
                serialized_record(execution_defaults_for_agent(
                    defaults.as_ref(),
                    required_text(function, args.get(1))?,
                ))
            }
            "normalizeSupportedPermissionMode" => {
                let supported: Vec<_> = typed_argument(function, args.get(1))?;
                json!(normalize_supported_permission_mode(
                    unknown(function, args.first())?.as_ref(),
                    &supported
                ))
            }
            "normalizeSupportedThinkingMode" => {
                let supported: Vec<_> = typed_argument(function, args.get(1))?;
                json!(normalize_supported_thinking_mode(
                    unknown(function, args.first())?.as_ref(),
                    &supported
                ))
            }
            "isPermissionModeSupported" => {
                let supported: Vec<_> = typed_argument(function, args.get(1))?;
                json!(is_permission_mode_supported(
                    typed_argument(function, args.first())?,
                    &supported
                ))
            }
            "isThinkingModeSupported" => {
                let supported: Vec<_> = typed_argument(function, args.get(1))?;
                json!(is_thinking_mode_supported(
                    typed_argument(function, args.first())?,
                    &supported
                ))
            }
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn execution_defaults_preserve_the_original_settings_wire_format() {
    use garcon_contract::execution_defaults::execution_defaults_for_agent;
    use garcon_contract::settings::RemoteExecutionDefaults;

    let input = include_str!("inputs/common/execution-defaults.jsonl")
        .lines()
        .last()
        .unwrap();
    let original = pinned_bun_stdout(
        r#"import { executionDefaultsForAgent } from "./common/execution-defaults.ts";
           console.log(JSON.stringify(executionDefaultsForAgent(...JSON.parse(Bun.argv.at(-1)).args)));"#,
        &[input],
    );
    #[derive(serde::Deserialize)]
    struct Call {
        args: (RemoteExecutionDefaults, String),
    }
    let Call {
        args: (defaults, agent_id),
    } = garcon_js::json::from_str(input).unwrap();
    assert_eq!(
        serde_json::to_string(&execution_defaults_for_agent(Some(&defaults), &agent_id)).unwrap(),
        original.trim_end()
    );
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
fn api_provider_template_recordings() {
    use garcon_contract::api_provider_templates::*;

    assert_recording("api-provider-templates", |function, args| {
        let protocol = typed_argument(function, args.first())?;
        Ok(match function {
            "templatesForProtocol" => json!(templates_for_protocol(protocol)),
            "apiProviderTemplate" => json!(api_provider_template(
                protocol,
                typed_argument(function, args.get(1))?
            )),
            _ => return Err(CaseError::unhandled(function)),
        })
    });
}

#[test]
fn provider_template_constants_match_bun() {
    use garcon_contract::api_provider_templates::API_PROVIDER_TEMPLATES;

    let original = pinned_bun_stdout(
        r#"import { API_PROVIDER_TEMPLATES } from "./common/api-provider-templates.ts";
           console.log(JSON.stringify(API_PROVIDER_TEMPLATES));"#,
        &[],
    );
    assert_eq!(
        serde_json::to_string(&*API_PROVIDER_TEMPLATES).unwrap(),
        original.trim_end()
    );
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
fn setting_updates_keep_javascript_index_key_order() {
    use garcon_contract::agent_integration::{
        AgentSettingDescriptor, parse_agent_settings_envelope,
    };
    use garcon_contract::agent_settings::with_agent_setting;
    use garcon_js::json::Opaque;

    let original = pinned_bun_stdout(
        r#"import { withAgentSetting } from "./common/agent-settings.ts";
           const file = Bun.file("rust/garcon-contract/tests/inputs/common/agent-settings.jsonl");
           for (const line of (await file.text()).trimEnd().split("\n")) {
             const { fn, args } = JSON.parse(line);
             if (fn === "withAgentSetting" && args[1].label === "Index or ordinary property")
               console.log(JSON.stringify(withAgentSetting(...args)));
           }"#,
        &[],
    );
    let calls = include_str!("inputs/common/agent-settings.jsonl")
        .lines()
        .map(|line| garcon_js::json::from_str::<Value>(line).unwrap())
        .filter(|call| {
            call["fn"] == "withAgentSetting"
                && call["args"][1]["label"] == "Index or ordinary property"
        });
    assert_eq!(original.lines().count(), 6);
    let mut checked = 0;
    for (call, expected) in calls.zip(original.lines()) {
        let args = &call["args"];
        let envelope = parse_agent_settings_envelope(&args[0]).unwrap();
        let descriptor = serde_json::from_value::<AgentSettingDescriptor>(args[1].clone()).unwrap();
        let updated =
            with_agent_setting(&envelope, &descriptor, &Opaque::from_value(args[2].clone()));
        let expected_value: Value = garcon_js::json::from_str(expected).unwrap();
        assert_eq!(
            updated
                .values
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            expected_value["values"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
        );
        assert_eq!(serde_json::to_string(&updated).unwrap(), expected);
        checked += 1;
    }
    assert_eq!(checked, 6);
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
