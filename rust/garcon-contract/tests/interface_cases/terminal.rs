//! The recorded cases of `common/terminal.ts`.

use garcon_cases::{CaseError, unknown};
use garcon_contract::terminal::{
    clone_terminal_metadata, parse_terminal_create_request, parse_terminal_create_response,
    parse_terminal_list_response, parse_terminal_metadata, parse_terminal_rename_request,
    parse_terminal_rename_response, parse_terminal_stream_client_message,
    parse_terminal_stream_server_message, parse_terminal_terminate_request,
    parse_terminal_terminate_response, terminal_id_for_message,
};
use serde::Serialize;
use serde_json::Value;

use super::helpers;

fn wire(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn dispatch_terminal(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let value = unknown(function, args.first())?;
    let result = match function {
        "parseTerminalCreateRequest" => wire(parse_terminal_create_request(&value)),
        "parseTerminalTerminateRequest" => wire(parse_terminal_terminate_request(&value)),
        "parseTerminalRenameRequest" => wire(parse_terminal_rename_request(&value)),
        "parseTerminalListResponse" => wire(parse_terminal_list_response(&value)),
        "parseTerminalMetadata" => wire(parse_terminal_metadata(&value)),
        "parseTerminalCreateResponse" => wire(parse_terminal_create_response(&value)),
        "parseTerminalTerminateResponse" => wire(parse_terminal_terminate_response(&value)),
        "parseTerminalRenameResponse" => wire(parse_terminal_rename_response(&value)),
        "parseTerminalStreamClientMessage" => wire(parse_terminal_stream_client_message(&value)),
        "parseTerminalStreamServerMessage" => wire(parse_terminal_stream_server_message(&value)),
        "terminalIdForMessage" => wire(terminal_id_for_message(
            &parse_terminal_stream_server_message(&value)
                .ok_or_else(|| CaseError::unhandled(function))?,
        )),
        "cloneTerminalMetadata" => wire(clone_terminal_metadata(
            &parse_terminal_metadata(&value).ok_or_else(|| CaseError::unhandled(function))?,
        )),
        _ => return Err(CaseError::unhandled(function)),
    };
    Ok(result)
}

#[test]
fn terminal_cases_match() {
    helpers::recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/terminal"),
        "common/terminal.ts",
        dispatch_terminal,
    );
}
