use garcon_agent_pi::{
    pi_rpc_client::PiRpcResponse,
    pi_rpc_protocol::{
        PiInputCommand, pi_compaction_message, pi_input_disposition, prepare_pi_rpc_prompt,
        resolve_pi_thinking_level,
    },
};
use garcon_cases::{CaseError, markers, replay, round_tripped};
use garcon_contract::agent_execution::AgentAttachment;
use garcon_interface::errors::AgentIntegrationError;
use garcon_js::json;
use serde::Serialize;
use serde_json::Value;

fn undeliverable(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

fn wire(result: impl Serialize) -> Result<Value, CaseError> {
    let bytes = serde_json::to_vec(&result).map_err(undeliverable)?;
    json::from_slice(&bytes).map_err(undeliverable)
}

fn integration_error(error: AgentIntegrationError) -> CaseError {
    CaseError::new("AgentIntegrationError", error.to_string())
        .with_property("code", error.code.as_str())
        .with_property("retryable", error.retryable)
}

#[test]
fn recorded_pi_rpc_protocol_matches() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/pi-rpc-protocol"),
        |function, args| {
            let input = |index| {
                round_tripped(function, args.get(index))
                    .map(|value| value.map_or(Value::Null, std::borrow::Cow::into_owned))
            };
            let required_text = |value: &Value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| undeliverable("expected a string"))
            };
            match function {
                "piInputDisposition" => {
                    let raw = input(0)?;
                    let response = PiRpcResponse {
                        id: required_text(&raw["id"])?,
                        command: required_text(&raw["command"])?,
                        success: raw["success"]
                            .as_bool()
                            .ok_or_else(|| undeliverable("expected success"))?,
                        error: raw["error"].as_str().map(str::to_owned),
                        data: raw.get("data").cloned().map(Into::into),
                    };
                    let command = match input(1)?.as_str() {
                        Some("prompt") => PiInputCommand::Prompt,
                        Some("steer") => PiInputCommand::Steer,
                        _ => return Err(undeliverable("expected prompt or steer")),
                    };
                    wire(pi_input_disposition(&response, command).map_err(|error| {
                        CaseError::new("PiRpcTransportError", error.to_string())
                            .with_property("writeAttempted", error.write_attempted)
                    })?)
                }
                "resolvePiThinkingLevel" => wire(resolve_pi_thinking_level(
                    &input(0)?,
                    serde_json::from_value(input(1)?).map_err(undeliverable)?,
                )),
                "piCompactionMessage" => {
                    let Some(message) =
                        pi_compaction_message(&input(0)?, &required_text(&input(1)?)?)
                    else {
                        return Ok(Value::Null);
                    };
                    let Value::Object(fields) = wire(message)? else {
                        return Err(undeliverable("expected a compaction message object"));
                    };
                    Ok(markers::instance("CompactionMessage", fields))
                }
                "preparePiRpcPrompt" => {
                    let request = input(0)?;
                    let permission_mode = serde_json::from_value(request["permissionMode"].clone())
                        .map_err(undeliverable)?;
                    let images: Vec<AgentAttachment> = request
                        .get("images")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(undeliverable)?
                        .unwrap_or_default();
                    wire(
                        prepare_pi_rpc_prompt(
                            &required_text(&request["command"])?,
                            permission_mode,
                            &images,
                        )
                        .map_err(integration_error)?,
                    )
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
