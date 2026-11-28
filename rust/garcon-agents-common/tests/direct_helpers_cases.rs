use garcon_agents_common::direct::{
    errors::classify_direct_integration_error, reasoning_effort::resolve_direct_explicit_effort,
    response_media_type::is_json_response, router::direct_endpoint_fingerprint,
    runtime_types::DirectEndpointRuntime, single_query_options::direct_single_query_timeout_ms,
    strip_think_blocks::strip_think_blocks,
};
use garcon_agents_common::shared::attachments::{
    AttachmentInput, append_text_attachment_context, attachment_document_block,
    fits_inline_text_attachment, parse_attachment_data_url,
};
use garcon_cases::{CaseError, markers::undefined, replay, round_tripped, unknown};
use garcon_contract::agent_execution::AgentEndpointSelection;
use garcon_interface::errors::AgentIntegrationError;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn typed<T: DeserializeOwned>(function: &str, value: Option<&Value>) -> Result<T, CaseError> {
    let value = round_tripped(function, value)?
        .ok_or_else(|| CaseError::undeliverable("expected the original typed argument"))?;
    serde_json::from_value(value.into_owned())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    garcon_js::json::from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    data: String,
    name: Option<String>,
    mime_type: Option<String>,
}

impl Attachment {
    fn input(&self) -> AttachmentInput<'_> {
        AttachmentInput {
            data: &self.data,
            name: self.name.as_deref(),
            mime_type: self.mime_type.as_deref(),
        }
    }
}

#[derive(Deserialize)]
struct Endpoint {
    selection: AgentEndpointSelection,
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryOptions {
    timeout_ms: Option<f64>,
}

#[test]
fn recorded_direct_helpers_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/direct-helpers"),
        |function, args| {
            let first = args.first();
            match function {
                "stripReasoning" => Ok(json!(strip_think_blocks(&typed::<String>(
                    function, first
                )?))),
                "explicitEffort" => {
                    let effort = resolve_direct_explicit_effort(unknown(function, first)?.as_ref());
                    effort.map_or_else(|| Ok(undefined()), wire)
                }
                "queryTimeout" => {
                    let options: QueryOptions = typed(function, first)?;
                    Ok(json!(direct_single_query_timeout_ms(options.timeout_ms)))
                }
                "routeFingerprint" => {
                    let endpoint: Endpoint = typed(function, first)?;
                    Ok(json!(direct_endpoint_fingerprint(&DirectEndpointRuntime {
                        selection: endpoint.selection,
                        credential: endpoint.credential,
                    })))
                }
                "attachmentData" => wire(parse_attachment_data_url(Some(&typed::<String>(
                    function, first,
                )?))),
                "inlineAttachment" => Ok(json!(fits_inline_text_attachment(
                    typed::<Attachment>(function, first)?.input()
                ))),
                "attachmentDocument" => wire(attachment_document_block(
                    typed::<Attachment>(function, first)?.input(),
                )),
                "attachmentContext" => {
                    let attachments: Vec<Attachment> = typed(function, args.get(1))?;
                    Ok(json!(append_text_attachment_context(
                        &typed::<String>(function, first)?,
                        attachments.iter().map(Attachment::input)
                    )))
                }
                "jsonMediaType" => Ok(json!(is_json_response(
                    typed::<Option<String>>(function, first)?.as_deref()
                ))),
                "classifyFailure" => {
                    let error =
                        classify_direct_integration_error(typed::<String>(function, first)?.into());
                    let error = error
                        .downcast_ref::<AgentIntegrationError>()
                        .ok_or_else(|| {
                            CaseError::undeliverable("provider error was not classified")
                        })?;
                    Ok(
                        json!({"code": error.code.as_str(), "message": error.message, "retryable": error.retryable}),
                    )
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
