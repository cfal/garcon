//! Replays the recordings of the `common/` modules ported by the interface
//! session (ADR-020). `bun rust/parity/cli.ts unit record <module> --tests
//! <its tests> --inputs tests/inputs/common/<module>.jsonl --out
//! tests/cases/common/<module>` writes each recording, and every case must
//! match here.

// The readers this replay does not call are read by the crate's other replay.
#[expect(
    dead_code,
    reason = "shared readers; `recorded_cases.rs` calls the rest"
)]
mod support;

use garcon_cases::{CaseError, Stats, markers, replay};
use garcon_contract::file_contracts::{
    directory_name_problem, is_file_revision, parse_create_directory_request,
    parse_directory_entry, parse_file_identity_response, parse_file_revision_response,
    parse_read_text_response, parse_save_text_request, parse_save_text_response,
};
use garcon_contract::git_error::{GitServiceError, is_git_service_error_code};
use garcon_contract::terminal::{
    TerminalErrorCode, TerminalMetadata, TerminalStreamClientMessage, TerminalStreamClientPayload,
    TerminalStreamServerMessage, TerminalStreamServerPayload, clone_terminal_metadata,
    parse_terminal_create_request, parse_terminal_create_response, parse_terminal_list_response,
    parse_terminal_metadata, parse_terminal_rename_request, parse_terminal_rename_response,
    parse_terminal_stream_client_message, parse_terminal_stream_server_message,
    parse_terminal_terminate_request, parse_terminal_terminate_response, terminal_id_for_message,
};
use garcon_contract::terminal_error::TerminalError;
use garcon_js::Number;
use serde_json::{Value, json};

fn assert_all_match(module: &str, stats: Stats) {
    // A wildcard would let the port return anything for that case.
    assert_eq!(
        stats.with_wildcards, 0,
        "{module}: the recording has wildcards"
    );
    assert_eq!(stats.passed, stats.total, "{module}: recorded cases differ");
}

/// A result the original returns as `null` where its parser refuses the value.
fn optional<T>(value: Option<T>, to_json: impl FnOnce(T) -> Value) -> Value {
    value.map_or(Value::Null, to_json)
}

/// A result that holds only plain JSON, as the original's `toEqual` sees it.
fn plain<T: serde::Serialize>(value: Option<T>) -> Value {
    value.map_or(Value::Null, |value| serde_json::to_value(&value).unwrap())
}

/// Adds a property the original leaves out when it has no value.
fn set_text(recorded: &mut Value, key: &str, value: Option<String>) {
    if let Some(value) = value {
        recorded[key] = Value::String(value);
    }
}

/// A JavaScript number as the recording holds it; negative zero is a marker.
fn number(value: Number) -> Value {
    markers::number(value.0)
}

fn dispatch_git_error(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isGitServiceErrorCode" => {
            let value = support::unknown(function, args.first())?;
            Ok(json!(is_git_service_error_code(&value).is_some()))
        }
        "new GitServiceError" => {
            let code = support::text(function, args.first())?;
            let message = support::text(function, args.get(1))?;
            match (code, message) {
                (Some(code), Some(message)) => match is_git_service_error_code(&json!(code)) {
                    Some(code) => {
                        let error = GitServiceError::new(code, message);
                        Err(CaseError::new("GitServiceError", error.message)
                            .with_property("code", code.as_str())
                            .with_property("status", error.status))
                    }
                    None => Err(CaseError::unhandled(function)),
                },
                _ => Err(CaseError::unhandled(function)),
            }
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn git_error_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/git-error"),
        dispatch_git_error,
    );
    assert_all_match("common/git-error.ts", stats);
}

fn terminal_metadata(metadata: &TerminalMetadata) -> Value {
    json!({
        "terminalId": metadata.terminal_id,
        "displaySequence": number(metadata.display_sequence),
        "title": metadata.title,
        "initialWorkingDirectory": metadata.initial_working_directory,
        "processStatus": metadata.process_status,
        "attachmentStatus": metadata.attachment_status,
        "createdAt": metadata.created_at,
        "exitCode": metadata.exit_code.map(number),
        "latestOutputSequence": number(metadata.latest_output_sequence),
    })
}

fn terminal_client_message(message: &TerminalStreamClientMessage) -> Value {
    let mut recorded = match &message.payload {
        TerminalStreamClientPayload::TerminalAttach {
            terminal_id,
            client_id,
            after_sequence,
            intent,
            attachment_epoch,
        } => {
            let mut recorded = json!({
                "type": "terminal-attach",
                "terminalId": terminal_id,
                "clientId": client_id,
                "afterSequence": number(*after_sequence),
                "intent": intent,
            });
            set_text(&mut recorded, "attachmentEpoch", attachment_epoch.clone());
            recorded
        }
        TerminalStreamClientPayload::TerminalInput { terminal_id, data } => json!({
            "type": "terminal-input",
            "terminalId": terminal_id,
            "data": data,
        }),
        TerminalStreamClientPayload::TerminalResize {
            terminal_id,
            cols,
            rows,
        } => json!({
            "type": "terminal-resize",
            "terminalId": terminal_id,
            "cols": number(*cols),
            "rows": number(*rows),
        }),
        TerminalStreamClientPayload::TerminalDetach { terminal_id } => json!({
            "type": "terminal-detach",
            "terminalId": terminal_id,
        }),
    };
    set_text(&mut recorded, "attachmentId", message.attachment_id.clone());
    recorded
}

fn terminal_server_message(message: &TerminalStreamServerMessage) -> Value {
    let mut recorded = match &message.payload {
        TerminalStreamServerPayload::TerminalAttached { terminal, replay } => json!({
            "type": "terminal-attached",
            "terminal": terminal_metadata(terminal),
            "replay": replay
                .iter()
                .map(|chunk| json!({ "sequence": number(chunk.sequence), "data": chunk.data }))
                .collect::<Vec<_>>(),
        }),
        TerminalStreamServerPayload::TerminalOutput {
            terminal_id,
            sequence,
            data,
        } => json!({
            "type": "terminal-output",
            "terminalId": terminal_id,
            "sequence": number(*sequence),
            "data": data,
        }),
        TerminalStreamServerPayload::TerminalReplayBatch {
            terminal_id,
            chunks,
        } => json!({
            "type": "terminal-replay-batch",
            "terminalId": terminal_id,
            "chunks": chunks
                .iter()
                .map(|chunk| json!({ "sequence": number(chunk.sequence), "dataBase64": chunk.data_base64 }))
                .collect::<Vec<_>>(),
        }),
        TerminalStreamServerPayload::TerminalOutputFragment {
            terminal_id,
            sequence,
            fragment_index,
            fragment_count,
            data_base64,
        } => json!({
            "type": "terminal-output-fragment",
            "terminalId": terminal_id,
            "sequence": number(*sequence),
            "fragmentIndex": number(*fragment_index),
            "fragmentCount": number(*fragment_count),
            "dataBase64": data_base64,
        }),
        TerminalStreamServerPayload::TerminalStatus { terminal } => json!({
            "type": "terminal-status",
            "terminal": terminal_metadata(terminal),
        }),
        TerminalStreamServerPayload::TerminalTakenOver {
            terminal_id,
            replacement_client_id,
        } => json!({
            "type": "terminal-taken-over",
            "terminalId": terminal_id,
            "replacementClientId": replacement_client_id,
        }),
        TerminalStreamServerPayload::TerminalTerminated { terminal_id } => json!({
            "type": "terminal-terminated",
            "terminalId": terminal_id,
        }),
        TerminalStreamServerPayload::TerminalReplayTruncated {
            terminal_id,
            first_sequence,
        } => json!({
            "type": "terminal-replay-truncated",
            "terminalId": terminal_id,
            "firstSequence": number(*first_sequence),
        }),
        TerminalStreamServerPayload::TerminalError {
            terminal_id,
            code,
            message,
        } => {
            let mut recorded = json!({
                "type": "terminal-error",
                "code": code,
                "message": message,
            });
            set_text(&mut recorded, "terminalId", terminal_id.clone());
            recorded
        }
    };
    set_text(&mut recorded, "attachmentId", message.attachment_id.clone());
    recorded
}

fn dispatch_terminal(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    // Each parser takes `unknown`, which reads `undefined` as any other non-record.
    let argument = |function: &str| support::unknown(function, args.first());
    match function {
        "parseTerminalCreateRequest" => {
            let value = argument(function)?;
            Ok(optional(parse_terminal_create_request(&value), |request| {
                let mut recorded = json!({ "requestId": request.request_id });
                set_text(&mut recorded, "executorId", request.executor_id);
                set_text(
                    &mut recorded,
                    "expectedTerminalRuntimeId",
                    request.expected_terminal_runtime_id,
                );
                recorded["requestedInitialWorkingDirectory"] =
                    json!(request.requested_initial_working_directory);
                recorded
            }))
        }
        "parseTerminalTerminateRequest" => {
            let value = argument(function)?;
            Ok(optional(
                parse_terminal_terminate_request(&value),
                |request| json!({ "terminalId": request.terminal_id, "requestId": request.request_id }),
            ))
        }
        "parseTerminalRenameRequest" => {
            let value = argument(function)?;
            Ok(optional(
                parse_terminal_rename_request(&value),
                |request| json!({ "terminalId": request.terminal_id, "title": request.title }),
            ))
        }
        "parseTerminalListResponse" => {
            let value = argument(function)?;
            Ok(optional(parse_terminal_list_response(&value), |response| {
                let mut recorded = json!({
                    "success": true,
                    "terminals": response
                        .terminals
                        .iter()
                        .map(terminal_metadata)
                        .collect::<Vec<_>>(),
                });
                set_text(
                    &mut recorded,
                    "terminalRuntimeId",
                    response.terminal_runtime_id,
                );
                set_text(&mut recorded, "attachmentEpoch", response.attachment_epoch);
                recorded
            }))
        }
        "parseTerminalMetadata" => {
            let value = argument(function)?;
            Ok(optional(parse_terminal_metadata(&value), |metadata| {
                terminal_metadata(&metadata)
            }))
        }
        "parseTerminalCreateResponse" => {
            let value = argument(function)?;
            Ok(optional(
                parse_terminal_create_response(&value),
                |response| json!({ "success": true, "terminal": terminal_metadata(&response.terminal) }),
            ))
        }
        "parseTerminalTerminateResponse" => {
            let value = argument(function)?;
            Ok(optional(
                parse_terminal_terminate_response(&value),
                |response| {
                    let mut recorded =
                        json!({ "success": true, "terminalId": response.terminal_id });
                    match &response.terminal {
                        None => recorded["terminal"] = Value::Null,
                        Some(terminal) => recorded["terminal"] = terminal_metadata(terminal),
                    }
                    recorded
                },
            ))
        }
        "parseTerminalRenameResponse" => {
            let value = argument(function)?;
            Ok(optional(
                parse_terminal_rename_response(&value),
                |response| json!({ "success": true, "terminalId": response.terminal_id, "title": response.title }),
            ))
        }
        "parseTerminalStreamClientMessage" => {
            let value = argument(function)?;
            Ok(optional(
                parse_terminal_stream_client_message(&value),
                |message| terminal_client_message(&message),
            ))
        }
        "parseTerminalStreamServerMessage" => {
            let value = argument(function)?;
            Ok(optional(
                parse_terminal_stream_server_message(&value),
                |message| terminal_server_message(&message),
            ))
        }
        "terminalIdForMessage" => {
            let message = typed(function, args, parse_terminal_stream_server_message)?;
            Ok(json!(terminal_id_for_message(&message)))
        }
        "cloneTerminalMetadata" => {
            let metadata = typed(function, args, parse_terminal_metadata)?;
            Ok(terminal_metadata(&clone_terminal_metadata(&metadata)))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

/// The recorded argument as the typed value the original takes, read with
/// the parser its own module validates with. An argument that parser refuses
/// cannot be handed to the port and is not handled.
fn typed<T>(
    function: &str,
    args: &[Value],
    parse: fn(&Value) -> Option<T>,
) -> Result<T, CaseError> {
    let value = support::unknown(function, args.first())?;
    parse(&value).ok_or_else(|| CaseError::unhandled(function))
}

#[test]
#[ignore = "waits for recorder guards"]
fn terminal_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/terminal"),
        dispatch_terminal,
    );
    assert_all_match("common/terminal.ts", stats);
}
fn dispatch_terminal_error(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "new TerminalError" => {
            let code = typed(function, args, |value| {
                serde_json::from_value::<TerminalErrorCode>(value.clone()).ok()
            })?;
            let message = support::text(function, args.get(1))?
                .ok_or_else(|| CaseError::unhandled(function))?;
            let unhandled = || CaseError::unhandled(function);
            let error = match args.get(2) {
                // The default status applies only where the original received `undefined`.
                None => TerminalError::new(code, message),
                value if value.is_some_and(markers::is_undefined) => {
                    TerminalError::new(code, message)
                }
                Some(value) => TerminalError::with_status(
                    code,
                    message,
                    u16::try_from(value.as_u64().ok_or_else(unhandled)?)
                        .map_err(|_| unhandled())?,
                ),
            };
            Err(CaseError::new("TerminalError", error.message)
                .with_property("code", error.code.as_str())
                .with_property("status", error.status))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn terminal_error_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/terminal-error"
        ),
        dispatch_terminal_error,
    );
    assert_all_match("common/terminal-error.ts", stats);
}
fn dispatch_file_contracts(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    // Each parser takes `unknown`, which reads `undefined` as any other non-record.
    let argument = |function: &str| support::unknown(function, args.first());
    match function {
        "isFileRevision" => {
            let value = argument(function)?;
            Ok(json!(is_file_revision(&value)))
        }
        "directoryNameProblem" => {
            // The original takes a typed string.
            let name = support::text(function, args.first())?
                .ok_or_else(|| CaseError::unhandled(function))?;
            Ok(optional(directory_name_problem(name), |problem| {
                json!(problem)
            }))
        }
        "parseFileRevisionResponse" => {
            let value = argument(function)?;
            Ok(plain(parse_file_revision_response(&value)))
        }
        "parseReadTextResponse" => {
            let value = argument(function)?;
            Ok(plain(parse_read_text_response(&value)))
        }
        "parseSaveTextRequest" => {
            let value = argument(function)?;
            Ok(plain(parse_save_text_request(&value)))
        }
        "parseCreateDirectoryRequest" => {
            let value = argument(function)?;
            Ok(plain(parse_create_directory_request(&value)))
        }
        "parseDirectoryEntry" => {
            let value = argument(function)?;
            Ok(plain(parse_directory_entry(&value)))
        }
        "parseSaveTextResponse" => {
            let value = argument(function)?;
            Ok(plain(parse_save_text_response(&value)))
        }
        "parseFileIdentityResponse" => {
            let value = argument(function)?;
            Ok(plain(parse_file_identity_response(&value)))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn file_contracts_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/file-contracts"
        ),
        dispatch_file_contracts,
    );
    assert_all_match("common/file-contracts.ts", stats);
}
