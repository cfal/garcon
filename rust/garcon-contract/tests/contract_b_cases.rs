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
    serde_json::to_value(value).map_err(|error| CaseError::undeliverable(error.to_string()))
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
