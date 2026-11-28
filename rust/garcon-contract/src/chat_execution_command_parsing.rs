//! Ports `common/chat-execution-command-parsing.ts`.

use garcon_js::OptionalNullable;
use serde_json::{Map, Value};

use crate::{
    agent_integration::{AgentSettingsEnvelope, parse_agent_settings_envelope},
    api_providers::ApiProtocol,
    chat_command_contracts::{AgentHandoffCommandRequest, AgentHandoffRequest, AgentHandoffTarget},
    chat_modes::{PermissionMode, ThinkingMode, is_permission_mode, is_thinking_mode},
    command_request_validation::{
        CommandRequestValidationError as ValidationError, optional_nullable_string,
        optional_string, request_record, required_chat_id, required_command_correlation_id,
        required_string,
    },
    executors::parse_executor_id,
};

pub fn parse_agent_handoff_command_request(
    value: &Value,
) -> Result<AgentHandoffCommandRequest, ValidationError> {
    let body = request_record(value)?;
    let handoff = optional_agent_handoff_request(body.get("handoff"))?
        .ok_or_else(|| ValidationError::new("handoff is required"))?;
    Ok(AgentHandoffCommandRequest {
        chat_id: required_chat_id(body, "chatId")?,
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        handoff,
    })
}

pub fn optional_agent_handoff_request(
    value: Option<&Value>,
) -> Result<Option<AgentHandoffRequest>, ValidationError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let handoff = request_record(value)?;
    let target = request_record(handoff.get("target").unwrap_or(&Value::Null))?;
    let raw_executor_id = target.get("executorId");
    let executor_id = parse_executor_id(raw_executor_id.unwrap_or(&Value::Null))
        .ok_or_else(|| ValidationError::new("handoff.target.executorId is invalid"))?;
    let project_path = optional_string(target, "projectPath", false)?;
    let agent_id = required_string(target, "agentId")?;
    let model = required_string(target, "model")?;
    let api_provider_id = nullable_string(target, "apiProviderId")?;
    let model_endpoint_id = nullable_string(target, "modelEndpointId")?;
    let model_protocol = optional_api_protocol(target.get("modelProtocol"))?;
    if model_endpoint_id.as_option().is_some() && api_provider_id.as_option().is_none() {
        return Err(ValidationError::new(
            "handoff.target.apiProviderId is required with modelEndpointId",
        ));
    }
    let permission_mode = optional_permission_mode(target.get("permissionMode"))?;
    let thinking_mode = optional_thinking_mode(target.get("thinkingMode"))?;
    let agent_settings =
        optional_agent_settings(target.get("agentSettings"), "handoff.target.agentSettings")?;
    if agent_settings
        .as_ref()
        .is_some_and(|settings| settings.owner_id != agent_id)
    {
        return Err(ValidationError::new(
            "handoff.target.agentSettings must be owned by handoff.target.agentId",
        ));
    }
    Ok(Some(AgentHandoffRequest {
        target: AgentHandoffTarget {
            executor_id: raw_executor_id.map(|_| executor_id),
            project_path: project_path.map(str::to_owned),
            agent_id: agent_id.to_owned(),
            model: model.to_owned(),
            api_provider_id,
            model_endpoint_id,
            model_protocol,
            permission_mode,
            thinking_mode,
            agent_settings,
        },
        expected_agent_ownership_epoch: required_string(handoff, "expectedAgentOwnershipEpoch")?
            .to_owned(),
    }))
}

pub fn optional_permission_mode(
    value: Option<&Value>,
) -> Result<Option<PermissionMode>, ValidationError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => is_permission_mode(value)
            .map(Some)
            .ok_or_else(|| ValidationError::new("permissionMode is invalid")),
    }
}

pub fn optional_thinking_mode(
    value: Option<&Value>,
) -> Result<Option<ThinkingMode>, ValidationError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => is_thinking_mode(value)
            .map(Some)
            .ok_or_else(|| ValidationError::new("thinkingMode is invalid")),
    }
}

pub fn optional_api_protocol(
    value: Option<&Value>,
) -> Result<OptionalNullable<ApiProtocol>, ValidationError> {
    match value {
        None => Ok(OptionalNullable::ABSENT),
        Some(Value::Null) => Ok(OptionalNullable::NULL),
        Some(Value::String(value)) if value == "anthropic-messages" => {
            Ok(OptionalNullable::some(ApiProtocol::AnthropicMessages))
        }
        Some(Value::String(value)) if value == "openai-compatible" => {
            Ok(OptionalNullable::some(ApiProtocol::OpenAiCompatible))
        }
        _ => Err(ValidationError::new("modelProtocol is invalid")),
    }
}

pub fn required_agent_settings(
    value: &Value,
    field: &str,
) -> Result<AgentSettingsEnvelope, ValidationError> {
    parse_agent_settings_envelope(value)
        .ok_or_else(|| ValidationError::new(format!("{field} is invalid")))
}

pub fn optional_agent_settings(
    value: Option<&Value>,
    field: &str,
) -> Result<Option<AgentSettingsEnvelope>, ValidationError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => required_agent_settings(value, field).map(Some),
    }
}

pub(crate) fn nullable_string(
    body: &Map<String, Value>,
    field: &str,
) -> Result<OptionalNullable<String>, ValidationError> {
    let value = optional_nullable_string(body, field)?;
    Ok(if value.is_absent() {
        OptionalNullable::ABSENT
    } else {
        OptionalNullable::from(value.as_deref().map(str::to_owned))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executors::LOCAL_EXECUTOR_ID;
    use serde_json::json;

    #[test]
    fn distinguishes_missing_null_and_invalid_handoff_executors() {
        let mut input = json!({"target":{"agentId":"codex","model":"fixture"},"expectedAgentOwnershipEpoch":"epoch"});
        let request = |input: &Value| {
            optional_agent_handoff_request(Some(input))
                .unwrap()
                .unwrap()
        };
        assert_eq!(request(&input).target.executor_id, None);
        input["target"]["executorId"] = Value::Null;
        assert_eq!(
            request(&input).target.executor_id.as_deref(),
            Some(LOCAL_EXECUTOR_ID)
        );
        input["target"]["executorId"] = json!("unknown");
        assert_eq!(
            optional_agent_handoff_request(Some(&input))
                .unwrap_err()
                .message,
            "handoff.target.executorId is invalid"
        );
    }
}
