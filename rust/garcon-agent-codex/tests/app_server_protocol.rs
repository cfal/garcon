use garcon_agent_codex::app_server::protocol::{
    CodexProtocolError, parse_thread_items_list_response, parse_thread_turns_list_response,
};
use garcon_cases::{CaseError, replay, unknown};
use garcon_js::json::from_slice;
use serde::Serialize;
use serde_json::{Value, json};

fn encoded(result: Result<impl Serialize, CodexProtocolError>) -> Value {
    match result {
        Ok(response) => from_slice(&serde_json::to_vec(&response).unwrap()).unwrap(),
        Err(error) => {
            json!({"$":"error","name":"Error","message":error.to_string(),"properties":{}})
        }
    }
}

#[test]
fn app_server_protocol_matches_recorded_parsers() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/app-server-protocol"
        ),
        |name, args| {
            let value = unknown(name, args.first())?;
            match name {
                "parseThreadTurnsListResponse" => {
                    Ok(encoded(parse_thread_turns_list_response(&value)))
                }
                "parseThreadItemsListResponse" => {
                    Ok(encoded(parse_thread_items_list_response(&value)))
                }
                _ => Err(CaseError::unhandled(name)),
            }
        },
    );
}
