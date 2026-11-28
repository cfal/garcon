//! The recorded cases of `common/terminal.ts`.

use garcon_cases::{CaseError, unknown};
use garcon_contract::terminal::{
    TerminalMetadata, TerminalStreamClientMessage, TerminalStreamClientPayload,
    TerminalStreamServerMessage, TerminalStreamServerPayload, clone_terminal_metadata,
    parse_terminal_create_request, parse_terminal_create_response, parse_terminal_list_response,
    parse_terminal_metadata, parse_terminal_rename_request, parse_terminal_rename_response,
    parse_terminal_stream_client_message, parse_terminal_stream_server_message,
    parse_terminal_terminate_request, parse_terminal_terminate_response, terminal_id_for_message,
};
use serde_json::{Value, json};

use super::helpers::{self, optional, set_text, typed};

fn terminal_metadata(metadata: &TerminalMetadata) -> Value {
    json!({
        "terminalId": metadata.terminal_id,
        "displaySequence": helpers::number(metadata.display_sequence),
        "title": metadata.title,
        "initialWorkingDirectory": metadata.initial_working_directory,
        "processStatus": metadata.process_status,
        "attachmentStatus": metadata.attachment_status,
        "createdAt": metadata.created_at,
        "exitCode": metadata.exit_code.map(helpers::number),
        "latestOutputSequence": helpers::number(metadata.latest_output_sequence),
    })
}

fn terminal_client_message(message: &TerminalStreamClientMessage) -> Value {
    let number = helpers::number;
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
    let number = helpers::number;
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
    let argument = |function: &str| unknown(function, args.first());
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
                    "success": response.success,
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
                |response| json!({ "success": response.success, "terminal": terminal_metadata(&response.terminal) }),
            ))
        }
        "parseTerminalTerminateResponse" => {
            let value = argument(function)?;
            Ok(optional(
                parse_terminal_terminate_response(&value),
                |response| {
                    let mut recorded =
                        json!({ "success": response.success, "terminalId": response.terminal_id });
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
                |response| json!({ "success": response.success, "terminalId": response.terminal_id, "title": response.title }),
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

#[test]
fn terminal_cases_match() {
    helpers::recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/terminal"),
        "common/terminal.ts",
        dispatch_terminal,
    );
}
