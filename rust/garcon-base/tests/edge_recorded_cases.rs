//! Replays bindings that need the Fetch, crypto, or terminal APIs of Bun.

use std::error::Error;

use bytes::Bytes;
use garcon_base::domain_error::DomainError;
use garcon_base::errors::{ErrorInput, NamedError};
use garcon_base::{
    errors, http_body, http_error, portable_path, runtime_proof, server_runtime, terminal_framing,
};
use garcon_cases::{CaseError, javascript_number, markers, replay, round_tripped, text, unknown};
use garcon_contract::{
    error_codes::is_error_code,
    server_runtime::ServerRuntimeIdentity,
    terminal::{TerminalStreamServerPayload, parse_terminal_stream_server_message},
};
use garcon_interface::errors::{
    AgentCallError, AgentDeliveryOutcome, AgentIntegrationError, is_agent_integration_error_code,
};
use http::{Request, Response, header};
use http_body_util::Full;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn required_text<'a>(function: &str, value: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, value)?.ok_or_else(|| CaseError::unhandled(function))
}

fn runtime_state(
    function: &str,
    raw: &Value,
) -> Result<server_runtime::ServerRuntimeState, CaseError> {
    let identity = &raw["identity"];
    let schema_version = identity["schemaVersion"]
        .as_u64()
        .and_then(|number| u8::try_from(number).ok())
        .ok_or_else(|| CaseError::unhandled(function))?;
    let field = |key| required_text(function, identity.get(key)).map(str::to_owned);
    Ok(server_runtime::ServerRuntimeState {
        identity: ServerRuntimeIdentity {
            schema_version,
            instance_id: field("instanceId")?,
            workspace_dir: field("workspaceDir")?,
            started_at: field("startedAt")?,
        },
        local_capability: required_text(function, raw.get("localCapability"))?.to_owned(),
    })
}

#[test]
fn server_runtime_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/server-runtime"
        ),
        |function, args| match function {
            "listeningServerUrl" | "advertisedServerUrl" => {
                let address = required_text(function, args.first())?;
                let port = javascript_number(function, args.get(1))?;
                Ok(json!(if function == "listeningServerUrl" {
                    server_runtime::listening_server_url(address, port)
                } else {
                    server_runtime::advertised_server_url(address, port)
                }))
            }
            "createServerRuntimeProof" => {
                let state = unknown(function, args.first())?;
                server_runtime::create_server_runtime_proof(
                    &runtime_state(function, &state)?,
                    required_text(function, args.get(1))?,
                )
                .map(|result| json!(result))
                .map_err(|error| CaseError::new("Error", error.to_string()))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn portable_path_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/portable-path"
        ),
        |function, args| {
            if function == "isCanonicalExecutorPath"
                && let Some(input) = args
                    .first()
                    .filter(|value| markers::kind(value) == Some("utf16"))
            {
                let units = serde_json::from_value::<Vec<u16>>(input["value"].clone())
                    .map_err(|_| CaseError::unhandled(function))?;
                return Ok(json!(portable_path::is_canonical_executor_path_utf16(
                    &units
                )));
            }
            let input = required_text(function, args.first())?;
            match function {
                "isCanonicalExecutorPath" => {
                    Ok(json!(portable_path::is_canonical_executor_path(input)))
                }
                "parentExecutorPath" => Ok(json!(portable_path::parent_executor_path(input))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn errors_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/errors"
        ),
        |function, args| {
            let named;
            let value;
            let input = if let Some(error) = args
                .first()
                .filter(|value| markers::kind(value) == Some("error"))
            {
                named = NamedError {
                    name: required_text(function, error.get("name"))?.to_owned(),
                    message: required_text(function, error.get("message"))?.to_owned(),
                    code: error["properties"]["code"].as_str().map(str::to_owned),
                };
                ErrorInput::Error(&named)
            } else {
                value = round_tripped(function, args.first())?;
                value
                    .as_deref()
                    .map_or(ErrorInput::Undefined, ErrorInput::Json)
            };
            match function {
                "errorMessage" => Ok(json!(errors::error_message(
                    input,
                    text(function, args.get(1))?
                ))),
                "hasNodeErrorCode" => Ok(json!(errors::has_node_error_code(
                    input,
                    required_text(function, args.get(1))?
                ))),
                "diagnosticErrorCode" => Ok(json!(errors::diagnostic_error_code(input))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

fn http_response(function: &str, response: Response<Bytes>) -> Result<Value, CaseError> {
    let field = |key| {
        response
            .headers()
            .get(key)
            .and_then(|value| value.to_str().ok())
    };
    let text = std::str::from_utf8(response.body()).map_err(|_| CaseError::unhandled(function))?;
    Ok(json!({
        "status": response.status().as_u16(),
        "contentType": field(header::CONTENT_TYPE),
        "cacheControl": field(header::CACHE_CONTROL),
        "body": text,
    }))
}

fn http_error_case_error(error: http_error::JsonErrorResponseError) -> CaseError {
    let name = match error {
        http_error::JsonErrorResponseError::InvalidStatus(_) => "RangeError",
        http_error::JsonErrorResponseError::Serialize(_) => "Error",
    };
    CaseError::new(name, error.to_string())
}

fn dispatch_unknown_http_error(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let spec = unknown(function, args.first())?;
    let kind = required_text(function, spec.get("kind"))?;
    let status = args
        .get(1)
        .map(|arg| javascript_number(function, Some(arg)))
        .transpose()?;
    let error: Box<dyn Error> = match kind {
        "unknown" => {
            let response = http_error::json_error_from_unknown(
                ErrorInput::Json(&spec["value"]),
                status,
                None,
                None,
            )
            .map_err(http_error_case_error)?;
            return http_response(function, response);
        }
        "call" | "integration" => {
            let code = is_agent_integration_error_code(&spec["code"])
                .ok_or_else(|| CaseError::unhandled(function))?;
            let message = required_text(function, spec.get("message"))?;
            if kind == "call" {
                let outcome = match spec["outcome"].as_str() {
                    Some("not-dispatched") => AgentDeliveryOutcome::NotDispatched,
                    Some("rejected") => AgentDeliveryOutcome::Rejected,
                    Some("unknown") => AgentDeliveryOutcome::Unknown,
                    _ => return Err(CaseError::unhandled(function)),
                };
                Box::new(AgentCallError::with_code(outcome, message, code))
            } else {
                let retryable = spec["retryable"]
                    .as_bool()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                Box::new(AgentIntegrationError::new(code, message, retryable, None))
            }
        }
        "domain" => {
            let code =
                is_error_code(&spec["code"]).ok_or_else(|| CaseError::unhandled(function))?;
            let status = spec["status"]
                .as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .ok_or_else(|| CaseError::unhandled(function))?;
            let retryable = spec["retryable"]
                .as_bool()
                .ok_or_else(|| CaseError::unhandled(function))?;
            Box::new(DomainError::new(
                code,
                required_text(function, spec.get("message"))?,
                status,
                retryable,
            ))
        }
        "error" => Box::new(std::io::Error::other(
            required_text(function, spec.get("message"))?.to_owned(),
        )),
        _ => return Err(CaseError::unhandled(function)),
    };
    let response =
        http_error::json_error_from_unknown(ErrorInput::Error(error.as_ref()), status, None, None)
            .map_err(http_error_case_error)?;
    http_response(function, response)
}

fn terminal_wire(
    message: &garcon_contract::terminal::TerminalStreamServerMessage,
) -> Result<Value, CaseError> {
    let wire = terminal_framing::serialize_terminal_message(message)
        .map_err(|e| CaseError::new("Error", e.to_string()))?;
    Ok(json!({
        "digest": format!("{:x}", Sha256::digest(wire.payload.as_bytes())),
        "byteLength": wire.byte_length,
    }))
}

#[test]
fn edge_parity_cases_match() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/edge-parity"
        ),
        |function, args| match function {
            "jsonBodyFixture" => {
                let content_type = text(function, args.first())?;
                let body = text(function, args.get(1))?.unwrap_or_default();
                http_body::parse_json_text_body(content_type, body)
                    .map_err(|error| CaseError::new("MalformedJsonError", error.to_string()))
            }
            "jsonBytesBodyFixture" => {
                let content_type = required_text(function, args.first())?;
                let body = required_text(function, args.get(1))?;
                let request = Request::builder()
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Full::new(Bytes::copy_from_slice(body.as_bytes())))
                    .map_err(|error| CaseError::new("Error", error.to_string()))?;
                runtime
                    .block_on(http_body::parse_json_body(request))
                    .map_err(|error| match error {
                        http_body::JsonBodyError::Malformed(error) => {
                            CaseError::new("MalformedJsonError", error.to_string())
                        }
                        http_body::JsonBodyError::Read(never) => match never {},
                    })
            }
            "bearerFixture" => {
                let mut request = Request::builder();
                if let Some(authorization) = text(function, args.first())? {
                    request = request.header(header::AUTHORIZATION, authorization);
                }
                let request = request
                    .body(())
                    .map_err(|error| CaseError::new("Error", error.to_string()))?;
                Ok(json!(http_body::get_token_from_request(&request)))
            }
            "jsonErrorFixture" => {
                let response = http_error::json_error(
                    required_text(function, args.first())?,
                    javascript_number(function, args.get(1))?,
                    text(function, args.get(2))?,
                    args.get(3).and_then(Value::as_bool),
                    text(function, args.get(4))?.map(str::to_owned),
                )
                .map_err(http_error_case_error)?;
                http_response(function, response)
            }
            "unknownHttpErrorFixture" => dispatch_unknown_http_error(function, args),
            "runtimeProofFixture" => {
                let raw = unknown(function, args.first())?;
                let state = runtime_state(function, &raw)?;
                let url = url::Url::parse(required_text(function, args.get(1))?)
                    .map_err(|error| CaseError::new("TypeError", error.to_string()))?;
                let response = runtime_proof::runtime_proof_response(&state, &url)
                    .map_err(|error| CaseError::new("Error", error.to_string()))?;
                http_response(function, response)
            }
            "terminalFrameFixture" => {
                let message = unknown(function, args.first())?;
                let mut message = parse_terminal_stream_server_message(&message)
                    .ok_or_else(|| CaseError::unhandled(function))?;
                if let (TerminalStreamServerPayload::TerminalOutput { data, .. }, Some(repeat)) =
                    (&mut message.payload, args.get(1).and_then(Value::as_u64))
                {
                    *data = data.repeat(repeat as usize);
                }
                let mut wire = terminal_wire(&message)?;
                let frames = terminal_framing::expand_terminal_message_for_delivery(&message)
                    .map_err(|error| CaseError::new("Error", error.to_string()))?;
                wire["frames"] = json!(
                    frames
                        .iter()
                        .map(terminal_wire)
                        .collect::<Result<Vec<_>, _>>()?
                );
                Ok(wire)
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}
